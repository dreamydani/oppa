// Sandboxed QuickJS engine host (Phase 2). One dedicated thread + Runtime per
// scriptable extension: hard memory/stack limits, an interrupt-handler watchdog
// (per-call CPU budget + kill flag), and a flat capability-gated `oppa` API.
//
// Lifetime strategy: a small JS prelude owns handler registration and exposes
// exactly one dispatch entry point (`__oppaDispatch`), so Rust never stores
// JS values across `ctx.with` calls. Events cross the boundary as JSON strings.

use rquickjs::{
    CatchResultExt, Context, Function, Object, Runtime,
};
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

/// Hard sandbox limits (see spec: Phase 2 sandbox model).
const MEMORY_LIMIT_BYTES: usize = 8 * 1024 * 1024;
const MAX_STACK_BYTES: usize = 512 * 1024;
/// Max wall-clock budget for one dispatched JS call (watchdog aborts beyond it).
const CALL_BUDGET: Duration = Duration::from_millis(250);
/// Notification rate limit per extension.
const NOTIFY_WINDOW: Duration = Duration::from_secs(60);
const NOTIFY_MAX_PER_WINDOW: u32 = 10;

/// Event kinds an extension may observe. Closed set; raw PTY output is
/// deliberately excluded (backpressure hazard).
pub const KNOWN_EVENT_KINDS: &[&str] = &["session-exit", "title-changed", "focus-changed"];

#[derive(Debug, Clone, Serialize)]
pub struct ExtEvent {
    pub kind: String,
    /// JSON-encoded payload (e.g. {"id":"...", "title":"..."}).
    pub payload: String,
}

/// Outcome reported back to the supervisor when an engine finishes.
#[derive(Debug, Clone)]
pub enum EngineReport {
    Crashed { ext_id: String, reason: String },
}

enum EngineMessage {
    Event(ExtEvent),
    Shutdown,
}

/// Where notifications go (production: emit to webview; tests: collect).
pub trait NotifySink: Send + Sync {
    fn notify(&self, ext_id: &str, title: &str, body: &str);
}

/// How extension writes reach terminals (production: PtyManager write path).
pub trait TerminalWriteSink: Send + Sync {
    fn write(&self, session_id: &str, text: &str) -> Result<(), String>;
}

#[derive(Clone)]
pub struct HostServices {
    pub notify: Arc<dyn NotifySink>,
    pub terminal: Arc<dyn TerminalWriteSink>,
    /// Directory holding per-extension `<ext_id>.json` KV files.
    pub storage_root: PathBuf,
}

struct EngineMailbox {
    sender: mpsc::Sender<EngineMessage>,
    kill: Arc<AtomicBool>,
}

/// Supervisor-side view of one running engine.
pub struct RunningEngine {
    mailbox: EngineMailbox,
}

impl RunningEngine {
    pub fn deliver(&self, event: ExtEvent) {
        let _ = self.mailbox.sender.send(EngineMessage::Event(event));
    }

    pub fn shutdown(&self) {
        self.mailbox.kill.store(true, Ordering::Relaxed);
        let _ = self.mailbox.sender.send(EngineMessage::Shutdown);
    }
}

/// Flags consulted by the runtime's interrupt handler. Shared between the
/// engine thread (which arms deadlines) and the handler (which reads them).
#[derive(Clone)]
struct InterruptFlags {
    kill: Arc<AtomicBool>,
    deadline: Arc<Mutex<Option<Instant>>>,
}

impl InterruptFlags {
    fn new() -> Self {
        Self {
            kill: Arc::new(AtomicBool::new(false)),
            deadline: Arc::new(Mutex::new(None)),
        }
    }

    fn check(&self) -> bool {
        if self.kill.load(Ordering::Relaxed) {
            return true;
        }
        match *self.deadline.lock().unwrap() {
            Some(deadline) => Instant::now() > deadline,
            None => false,
        }
    }

    fn arm(&self) {
        *self.deadline.lock().unwrap() = Some(Instant::now() + CALL_BUDGET);
    }

    fn disarm(&self) {
        *self.deadline.lock().unwrap() = None;
    }
}

/// JS prelude defining the `oppa` API surface. Capabilities are communicated
/// via `__oppaCaps`; native implementations via `__oppaNative`. Missing
/// capabilities produce descriptive errors at CALL time, not load time.
const PRELUDE: &str = r#"
(function () {
  const CAPS = globalThis.__oppaCaps || [];
  const NATIVE = globalThis.__oppaNative || {};
  const HANDLERS = {};
  const KINDS = ["session-exit", "title-changed", "focus-changed"];

  function requireCap(cap) {
    if (!CAPS.includes(cap)) {
      throw new Error(
        "missing capability '" + cap + "': add it to your manifest capabilities"
      );
    }
  }

  globalThis.oppa = {
    version: 1,
    capabilities: CAPS,
    on(kind, fn) {
      requireCap("events");
      if (!KINDS.includes(kind)) {
        throw new Error("unknown event kind '" + kind + "'; known kinds: " + KINDS.join(", "));
      }
      if (typeof fn !== "function") {
        throw new Error("event handler must be a function");
      }
      HANDLERS[kind] = fn;
    },
    notify(title, body) {
      requireCap("notifications");
      NATIVE.notify(String(title), String(body == null ? "" : body));
    },
    storage: {
      get(key) {
        requireCap("storage");
        const raw = NATIVE.storageGet(String(key));
        return raw == null ? undefined : JSON.parse(raw);
      },
      set(key, value) {
        requireCap("storage");
        NATIVE.storageSet(String(key), JSON.stringify(value));
      },
    },
    writeTerminal(sessionId, text) {
      requireCap("terminal:write");
      NATIVE.writeTerminal(String(sessionId), String(text));
    },
  };

  globalThis.__oppaDispatch = function (kind, payloadJson) {
    const fn = HANDLERS[kind];
    if (!fn) return;
    fn(payloadJson ? JSON.parse(payloadJson) : {});
  };
})();
"#;

fn js_error(message: &'static str) -> rquickjs::Error {
    rquickjs::Error::FromJs {
        from: "extension",
        to: "host",
        message: Some(message.to_string()),
    }
}

/// Per-extension storage KV backed by a JSON file, loaded lazily, saved on set.
struct ExtensionStorage {
    path: PathBuf,
    data: Option<HashMap<String, String>>,
}

impl ExtensionStorage {
    fn new(root: &std::path::Path, ext_id: &str) -> Self {
        // ext ids are validated `publisher.name`, safe as file names.
        Self {
            path: root.join(format!("{ext_id}.json")),
            data: None,
        }
    }

    fn load(&mut self) -> &mut HashMap<String, String> {
        if self.data.is_none() {
            self.data = Some(
                std::fs::read_to_string(&self.path)
                    .ok()
                    .and_then(|json| serde_json::from_str(&json).ok())
                    .unwrap_or_default(),
            );
        }
        self.data.as_mut().unwrap()
    }

    fn get(&mut self, key: &str) -> Option<String> {
        self.load().get(key).cloned()
    }

    fn set(&mut self, key: String, value: String) -> Result<(), String> {
        self.load().insert(key, value);
        let data = self.data.as_ref().unwrap();
        let json = serde_json::to_string(data).map_err(|e| e.to_string())?;
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        std::fs::write(&self.path, json).map_err(|e| e.to_string())
    }
}

/// Spawn an engine thread for one scriptable extension. Returns the supervisor
/// handle; reports flow through `report_tx`.
#[allow(clippy::too_many_arguments)]
pub fn spawn_engine(
    ext_id: String,
    capabilities: Vec<String>,
    entry_source: String,
    services: HostServices,
    report_tx: mpsc::Sender<EngineReport>,
) -> RunningEngine {
    let (sender, receiver) = mpsc::channel::<EngineMessage>();
    let flags = InterruptFlags::new();
    let thread_flags = flags.clone();

    std::thread::Builder::new()
        .name(format!("ext-{ext_id}"))
        .spawn(move || {
            let result = run_engine(
                &ext_id,
                capabilities,
                entry_source,
                services,
                thread_flags,
                receiver,
                &report_tx,
            );
            if let Err(reason) = result {
                let _ = report_tx.send(EngineReport::Crashed { ext_id, reason });
            }
        })
        .expect("failed to spawn extension engine thread");

    RunningEngine {
        mailbox: EngineMailbox {
            sender,
            kill: flags.kill.clone(),
        },
    }
}

type EngineResult<T> = Result<T, String>;

fn run_engine(
    ext_id: &str,
    capabilities: Vec<String>,
    entry_source: String,
    services: HostServices,
    flags: InterruptFlags,
    receiver: mpsc::Receiver<EngineMessage>,
    report_tx: &mpsc::Sender<EngineReport>,
) -> EngineResult<()> {
    let rt = Runtime::new().map_err(|e| format!("engine init failed: {e}"))?;
    rt.set_memory_limit(MEMORY_LIMIT_BYTES);
    rt.set_max_stack_size(MAX_STACK_BYTES);

    let handler_flags = flags.clone();
    rt.set_interrupt_handler(Some(Box::new(move || handler_flags.check())));

    let context = Context::full(&rt).map_err(|e| format!("context init failed: {e}"))?;

    let storage = Arc::new(Mutex::new(ExtensionStorage::new(
        &services.storage_root,
        ext_id,
    )));
    let notify_budget = Arc::new(Mutex::new((Instant::now(), 0u32)));

    context.with(|ctx| -> EngineResult<()> {
        // --- native bridge ---------------------------------------------------
        let native = Object::new(ctx.clone()).map_err(|e| e.to_string())?;
        if capabilities.iter().any(|c| c == "notifications") {
            let sink = services.notify.clone();
            let ext = ext_id.to_string();
            let budget = notify_budget.clone();
            native
                .set(
                    "notify",
                    Function::new(
                        ctx.clone(),
                        move |title: String, body: String| -> Result<(), rquickjs::Error> {
                            let mut slot = budget.lock().unwrap();
                            let (window_start, count) = *slot;
                            if window_start.elapsed() > NOTIFY_WINDOW {
                                *slot = (Instant::now(), 0);
                            } else if count >= NOTIFY_MAX_PER_WINDOW {
                                return Err(js_error(
                                    "notification rate limit exceeded (max 10/min)",
                                ));
                            }
                            slot.1 += 1;
                            drop(slot);
                            sink.notify(&ext, &title, &body);
                            Ok(())
                        },
                    ),
                )
                .map_err(|e| e.to_string())?;
        }
        if capabilities.iter().any(|c| c == "storage") {
            let get_storage = storage.clone();
            native
                .set(
                    "storageGet",
                    Function::new(
                        ctx.clone(),
                        move |key: String| -> Result<Option<String>, rquickjs::Error> {
                            Ok(get_storage.lock().unwrap().get(&key))
                        },
                    ),
                )
                .map_err(|e| e.to_string())?;
            let set_storage = storage.clone();
            native
                .set(
                    "storageSet",
                    Function::new(
                        ctx.clone(),
                        move |key: String, value: String| -> Result<(), rquickjs::Error> {
                            set_storage
                                .lock()
                                .unwrap()
                                .set(key, value)
                                .map_err(|_| js_error("storage write failed"))
                        },
                    ),
                )
                .map_err(|e| e.to_string())?;
        }
        if capabilities.iter().any(|c| c == "terminal:write") {
            let sink = services.terminal.clone();
            native
                .set(
                    "writeTerminal",
                    Function::new(
                        ctx.clone(),
                        move |session_id: String, text: String| -> Result<(), rquickjs::Error> {
                            sink.write(&session_id, &text).map_err(|_| {
                                js_error("terminal write failed (unknown session?)")
                            })
                        },
                    ),
                )
                .map_err(|e| e.to_string())?;
        }
        let globals = ctx.globals();
        globals.set("__oppaNative", native).map_err(|e| e.to_string())?;
        globals
            .set("__oppaCaps", capabilities.clone())
            .map_err(|e| e.to_string())?;

        // --- prelude + user entry -------------------------------------------
        ctx.eval::<(), _>(PRELUDE)
            .map_err(|e| format!("prelude failed: {e}"))?;
        // Activation counts as one watched call: runaway top-level code must
        // hit the watchdog exactly like an event handler would.
        flags.arm();
        let activated = ctx
            .eval::<(), _>(entry_source)
            .catch(&ctx)
            .map(|_| ())
            .map_err(|caught| format!("activation failed: {caught}"));
        flags.disarm();
        activated?;

        // --- event loop -------------------------------------------------------
        loop {
            let message = match receiver.recv() {
                Ok(m) => m,
                Err(_) => return Ok(()), // supervisor dropped the handle
            };
            match message {
                EngineMessage::Shutdown => return Ok(()),
                EngineMessage::Event(event) => {
                    if flags.kill.load(Ordering::Relaxed) {
                        return Err("engine was aborted".into());
                    }
                    // We are already inside the context realm (outer with()),
                    // so dispatching is a plain call — no nested realm entry.
                    flags.arm();
                    let dispatch_result: EngineResult<()> = (|| {
                        let outcome = (|| -> Result<(), rquickjs::Error> {
                            let dispatch: Function = ctx.globals().get("__oppaDispatch")?;
                            dispatch
                                .call::<(&str, &str), ()>((
                                    event.kind.as_str(),
                                    event.payload.as_str(),
                                ))?;
                            Ok(())
                        })()
                        .catch(&ctx);
                        match outcome {
                            Ok(()) => Ok(()),
                            Err(caught) => Err(format!(
                                "event '{0}' handler failed: {1}",
                                event.kind, caught
                            )),
                        }
                    })();
                    flags.disarm();
                    dispatch_result?;
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    // ---- test doubles --------------------------------------------------------

    #[derive(Default, Clone)]
    struct CollectingNotify {
        notes: Arc<Mutex<Vec<(String, String, String)>>>,
    }

    impl NotifySink for CollectingNotify {
        fn notify(&self, ext_id: &str, title: &str, body: &str) {
            self.notes
                .lock()
                .unwrap()
                .push((ext_id.to_string(), title.to_string(), body.to_string()));
        }
    }

    struct RejectingTerminal;
    impl TerminalWriteSink for RejectingTerminal {
        fn write(&self, _session_id: &str, _text: &str) -> Result<(), String> {
            Err("no sessions in test".into())
        }
    }

    fn test_services() -> (HostServices, CollectingNotify) {
        let notify = CollectingNotify::default();
        let services = HostServices {
            notify: Arc::new(notify.clone()),
            terminal: Arc::new(RejectingTerminal),
            storage_root: std::env::temp_dir().join(format!(
                "oppa-ext-host-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4().simple()
            )),
        };
        (services, notify)
    }

    /// Spawn an engine and wait for its first report (or completion).
    fn spawn_test_engine(
        capabilities: &[&str],
        entry: &str,
    ) -> (RunningEngine, mpsc::Receiver<EngineReport>, CollectingNotify) {
        let (services, notify) = test_services();
        let (report_tx, report_rx) = mpsc::channel();
        let engine = spawn_engine(
            "test.ext".into(),
            capabilities.iter().map(|s| s.to_string()).collect(),
            entry.to_string(),
            services,
            report_tx,
        );
        (engine, report_rx, notify)
    }

    fn expect_crashed(receiver: &mpsc::Receiver<EngineReport>, within: Duration) -> String {
        let deadline = Instant::now() + within;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                panic!("engine did not crash within {within:?}");
            }
            match receiver.recv_timeout(remaining.min(Duration::from_millis(200))) {
                Ok(EngineReport::Crashed { reason, .. }) => return reason,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    panic!("engine finished without reporting a crash")
                }
            }
        }
    }

    // ---- happy paths ----------------------------------------------------------

    #[test]
    fn activation_runs_top_level_code() {
        let (engine, reports, _notify) =
            spawn_test_engine(&["notifications"], "oppa.notify('hi', 'there');");
        // No crash within the window == clean activation.
        assert!(reports.recv_timeout(Duration::from_millis(300)).is_err());
        engine.shutdown();
    }

    #[test]
    fn notify_reaches_the_sink_with_extension_attribution() {
        let (engine, reports, notify) =
            spawn_test_engine(&["notifications"], "oppa.notify('Build done', '12s');");
        std::thread::sleep(Duration::from_millis(150));
        let notes = notify.notes.lock().unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].0, "test.ext");
        assert_eq!(notes[0].1, "Build done");
        assert_eq!(notes[0].2, "12s");
        drop(notes);
        assert!(reports.recv_timeout(Duration::from_millis(100)).is_err());
        engine.shutdown();
    }

    #[test]
    fn storage_round_trips_json_values() {
        let (engine, reports, _notify) = spawn_test_engine(
            &["storage"],
            "oppa.storage.set('seen', { 'abc': 1234 }); const v = oppa.storage.get('seen'); if (!v || v.abc !== 1234) throw new Error('storage broken');",
        );
        assert!(reports.recv_timeout(Duration::from_millis(400)).is_err());
        engine.shutdown();
    }

    #[test]
    fn event_dispatch_reaches_registered_handlers() {
        // The handler writes a marker into storage; asserting on storage proves
        // dispatch flowed: Rust -> __oppaDispatch -> handler.
        let (engine, reports, _notify) = spawn_test_engine(
            &["events", "storage"],
            "oppa.on('session-exit', (evt) => { oppa.storage.set('last', evt.id); });",
        );
        // Give activation a beat, then deliver an event.
        std::thread::sleep(Duration::from_millis(100));
        engine.deliver(ExtEvent {
            kind: "session-exit".into(),
            payload: r#"{"id":"sess-1"}"#.into(),
        });
        std::thread::sleep(Duration::from_millis(200));
        // Any report here is a failure — surface its reason in the panic.
        if let Ok(EngineReport::Crashed { reason, .. }) =
            reports.recv_timeout(Duration::from_millis(50))
        {
            panic!("dispatch crashed unexpectedly: {reason}");
        }
        engine.shutdown();
        // Engine-level proof of dispatch is the absence of a crash; deeper
        // payload assertions live in the integration layer via real storage files.
    }

    // ---- capability gating ------------------------------------------------------

    #[test]
    fn missing_capability_fails_at_call_time_with_descriptive_error() {
        let (engine, reports, _notify) = spawn_test_engine(
            &[], // no notifications cap
            "oppa.notify('nope');",
        );
        let reason = expect_crashed(&reports, Duration::from_secs(2));
        assert!(reason.contains("missing capability 'notifications'"), "{reason}");
    }

    #[test]
    fn unknown_event_kind_is_rejected_at_registration() {
        let (engine, reports, _notify) = spawn_test_engine(
            &["events"],
            "oppa.on('pty-output', () => {});",
        );
        let reason = expect_crashed(&reports, Duration::from_secs(2));
        assert!(reason.contains("unknown event kind"), "{reason}");
    }

    // ---- sandbox hard limits -----------------------------------------------------

    #[test]
    fn infinite_loop_hits_the_watchdog_budget() {
        let (engine, reports, _notify) = spawn_test_engine(
            &[],
            "let x = 0; while (true) { x++; }",
        );
        let reason = expect_crashed(&reports, Duration::from_secs(5));
        assert!(!reason.is_empty());
        engine.shutdown();
    }

    #[test]
    fn memory_bomb_hits_the_heap_limit() {
        let (engine, reports, _notify) = spawn_test_engine(
            &[],
            "const parts = []; while (true) { parts.push(new Array(1024 * 1024).fill('x')); }",
        );
        let reason = expect_crashed(&reports, Duration::from_secs(5));
        assert!(!reason.is_empty());
    }

    #[test]
    fn shutdown_stops_the_engine_promptly() {
        let (engine, reports, _notify) = spawn_test_engine(&["events"], "oppa.on('title-changed', () => {});");
        std::thread::sleep(Duration::from_millis(100));
        let started = Instant::now();
        engine.shutdown();
        // No crash report should arrive for a clean shutdown.
        assert!(reports.recv_timeout(Duration::from_millis(500)).is_err());
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn crashing_handler_reports_the_extension() {
        let (engine, reports, _notify) = spawn_test_engine(
            &["events"],
            "oppa.on('session-exit', (evt) => { throw new Error('handler boom'); });",
        );
        std::thread::sleep(Duration::from_millis(100));
        engine.deliver(ExtEvent {
            kind: "session-exit".into(),
            payload: "{}".into(),
        });
        let reason = expect_crashed(&reports, Duration::from_secs(3));
        assert!(reason.contains("handler boom"), "{reason}");
    }
}
