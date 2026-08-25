
// Supervisor for running extension engines: owns one RunningEngine per active
// scriptable extension, fans host events out to all of them, and pumps crash
// reports to a caller-supplied callback. Tauri-free core; the production
// sinks (webview notify + PTY-manager writer) live here too since they are
// thin adapters over AppHandle.

use super::host::{
    spawn_engine, EngineReport, ExtEvent, HostServices, NotifySink, RunningEngine,
    TerminalWriteSink,
};
use std::collections::HashMap;
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
#[cfg(test)]
use std::time::Instant;

pub struct ExtensionHostService {
    engines: Mutex<HashMap<String, RunningEngine>>,
    services: HostServices,
    report_tx: Sender<EngineReport>,
}

impl ExtensionHostService {
    /// Create the service and start its crash-report pump thread. Every report
    /// is handed to `on_report` exactly once, in arrival order.
    pub fn new(services: HostServices, on_report: impl Fn(EngineReport) + Send + 'static) -> Self {
        let (report_tx, report_rx) = mpsc::channel::<EngineReport>();
        std::thread::Builder::new()
            .name("ext-report-pump".into())
            .spawn(move || {
                while let Ok(report) = report_rx.recv() {
                    on_report(report);
                }
            })
            .ok();
        Self {
            engines: Mutex::new(HashMap::new()),
            services,
            report_tx,
        }
    }

    /// Start an engine for this extension. A no-op when already running so
    /// repeated enable calls stay idempotent.
    pub fn start(&self, ext_id: &str, capabilities: Vec<String>, entry_source: String) {
        let mut engines = self.engines.lock().unwrap();
        if engines.contains_key(ext_id) {
            return;
        }
        let engine = spawn_engine(
            ext_id.to_string(),
            capabilities,
            entry_source,
            self.services.clone(),
            self.report_tx.clone(),
        );
        engines.insert(ext_id.to_string(), engine);
    }

    pub fn stop(&self, ext_id: &str) {
        if let Some(engine) = self.engines.lock().unwrap().remove(ext_id) {
            engine.shutdown();
        }
    }

    /// Deliver an event to every running engine. Engines without a registered
    /// handler for the kind ignore it (JS-side dispatch is a no-op).
    pub fn broadcast(&self, kind: &str, payload_json: String) {
        let event = ExtEvent {
            kind: kind.to_string(),
            payload: payload_json,
        };
        for engine in self.engines.lock().unwrap().values() {
            engine.deliver(event.clone());
        }
    }

    pub fn is_running(&self, ext_id: &str) -> bool {
        self.engines.lock().unwrap().contains_key(ext_id)
    }

    /// Stop every engine — used on window close.
    pub fn stop_all(&self) {
        let mut engines = self.engines.lock().unwrap();
        for (_, engine) in engines.drain() {
            engine.shutdown();
        }
    }
}

// ---- production sinks -------------------------------------------------------

/// Forwards extension notifications to the webview as `extensions:notify`.
pub struct WebviewNotifySink(pub tauri::AppHandle);

impl NotifySink for WebviewNotifySink {
    fn notify(&self, ext_id: &str, title: &str, body: &str) {
        use tauri::Emitter;
        #[derive(Clone, serde::Serialize)]
        struct Payload<'a> {
            id: &'a str,
            title: &'a str,
            body: &'a str,
        }
        let _ = self.0.emit(
            "extensions:notify",
            Payload {
                id: ext_id,
                title,
                body,
            },
        );
    }
}

/// Routes `oppa.writeTerminal` through the live PTY manager write path.
pub struct ManagerTerminalWriter(pub tauri::AppHandle);

impl TerminalWriteSink for ManagerTerminalWriter {
    fn write(&self, session_id: &str, text: &str) -> Result<(), String> {
        use tauri::Manager;
        let manager = self
            .0
            .try_state::<crate::pty::manager::PtyManager>()
            .ok_or_else(|| "pty manager unavailable".to_string())?;
        manager
            .write(session_id, text.as_bytes())
            .map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::host::EngineReport;
    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::Duration;

    struct SilentNotify;
    impl NotifySink for SilentNotify {
        fn notify(&self, _: &str, _: &str, _: &str) {}
    }

    struct RejectingTerminal;
    impl TerminalWriteSink for RejectingTerminal {
        fn write(&self, _: &str, _: &str) -> Result<(), String> {
            Err("test".into())
        }
    }

    fn test_services() -> HostServices {
        HostServices {
            notify: Arc::new(SilentNotify),
            terminal: Arc::new(RejectingTerminal),
            storage_root: std::env::temp_dir().join(format!(
                "oppa-ext-svc-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            )),
        }
    }

    #[test]
    fn crash_reports_reach_the_callback_with_extension_id() {
        let reports: Arc<StdMutex<Vec<EngineReport>>> = Arc::new(StdMutex::new(Vec::new()));
        let sink = reports.clone();

        let service = ExtensionHostService::new(test_services(), move |report| {
            sink.lock().unwrap().push(report);
        });

        // Activation throws immediately -> crash report.
        service.start("boom.ext", vec![], "throw new Error('kaboom');".into());

        let deadline = Instant::now() + Duration::from_secs(3);
        while reports.lock().unwrap().is_empty() {
            assert!(
                Instant::now() < deadline,
                "no crash report within 3s"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        let first = reports.lock().unwrap()[0].clone();
        match &first {
            EngineReport::Crashed { ext_id, reason } => {
                assert_eq!(ext_id, "boom.ext");
                assert!(reason.contains("kaboom"), "{reason}");
            }
        }
    }

    #[test]
    fn start_is_idempotent_and_stop_prevents_delivery() {
        let service = ExtensionHostService::new(test_services(), |_| {});
        let entry = "oppa.on('session-exit', () => {});";
        service.start("calm.ext", vec!["events".into()], entry.into());
        service.start("calm.ext", vec!["events".into()], entry.into());
        assert!(service.is_running("calm.ext"));

        service.stop("calm.ext");
        assert!(!service.is_running("calm.ext"));

        // Broadcasting afterwards must not panic even with zero engines.
        service.broadcast("session-exit", r#"{"id":"x"}"#.into());
    }

    #[test]
    fn stop_all_shuts_everything_down() {
        let service = ExtensionHostService::new(test_services(), |_| {});
        let entry = "oppa.on('title-changed', () => {});";
        service.start("a.ext", vec!["events".into()], entry.into());
        service.start("b.ext", vec!["events".into()], entry.into());

        service.stop_all();
        assert!(!service.is_running("a.ext"));
        assert!(!service.is_running("b.ext"));
    }
}
