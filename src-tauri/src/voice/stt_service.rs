// Dictation lifecycle service — behavior port of Orca's `stt-service.ts`.
// Single-owner gating, warm-engine reuse across sessions with the same
// model+hotwords, 60 s start/stop timeouts, 1 h idle teardown. Blocking
// sherpa work runs on a per-session worker thread fed by an mpsc channel;
// the Tauri async runtime only awaits joins with timeouts.

use crate::voice::model_catalog::get_catalog_model;
use crate::voice::stt_audio_resample::{resample_to_16k, STT_SAMPLE_RATE};
use crate::voice::stt_engine::{
    EngineLoader, EngineSession, LoadedEngine, SherpaEngineLoader, SttEvent,
};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const START_DICTATION_TIMEOUT: Duration = Duration::from_secs(60);
pub const STOP_DICTATION_TIMEOUT: Duration = Duration::from_secs(60);
pub const IDLE_WORKER_TEARDOWN: Duration = Duration::from_secs(60 * 60);

/// Test seam: `OPPA_VOICE_*_MS` env overrides keep CI fast without touching
/// production defaults.
fn env_timeout_ms(name: &str, fallback: Duration) -> Duration {
    std::env::var(name)
        .ok()
        .and_then(|raw| raw.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or(fallback)
}

pub fn start_timeout() -> Duration {
    env_timeout_ms("OPPA_VOICE_START_TIMEOUT_MS", START_DICTATION_TIMEOUT)
}

pub fn stop_timeout() -> Duration {
    env_timeout_ms("OPPA_VOICE_STOP_TIMEOUT_MS", STOP_DICTATION_TIMEOUT)
}

pub fn idle_timeout() -> Duration {
    env_timeout_ms("OPPA_VOICE_IDLE_MS", IDLE_WORKER_TEARDOWN)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SttError {
    AlreadyActive,
    UnknownModel(String),
    ModelNotReady(String),
    StartTimeout,
    StopTimeout,
    Engine(String),
}

impl std::fmt::Display for SttError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SttError::AlreadyActive => write!(f, "dictation_already_active"),
            SttError::UnknownModel(id) => write!(f, "unknown_model:{id}"),
            SttError::ModelNotReady(reason) => write!(f, "model_not_ready:{reason}"),
            SttError::StartTimeout => write!(f, "start_timeout"),
            SttError::StopTimeout => write!(f, "stop_timeout"),
            SttError::Engine(reason) => write!(f, "engine:{reason}"),
        }
    }
}

#[derive(Clone)]
pub struct SttEmitter(Arc<dyn Fn(SttEvent) + Send + Sync>);

impl SttEmitter {
    pub fn new(emit: impl Fn(SttEvent) + Send + Sync + 'static) -> Self {
        Self(Arc::new(emit))
    }

    pub fn emit(&self, event: SttEvent) {
        let sink: &(dyn Fn(SttEvent) + Send + Sync) = &*self.0;
        sink(event);
    }
}

enum WorkerMsg {
    Audio(Vec<f32>),
    Finish,
}

struct ActiveSession {
    owner: String,
    sender: std::sync::mpsc::Sender<WorkerMsg>,
    thread: Option<std::thread::JoinHandle<()>>,
}

struct ServiceInner {
    engine: Option<Arc<LoadedEngine>>,
    engine_key: Option<String>,
    session: Option<ActiveSession>,
    starting_owner: Option<String>,
    idle_generation: u64,
}

pub struct SttService {
    models_dir: PathBuf,
    loader: Arc<dyn EngineLoader>,
    inner: Mutex<ServiceInner>,
}

impl SttService {
    pub fn new(models_dir: PathBuf) -> Self {
        Self::with_loader(models_dir, Arc::new(SherpaEngineLoader))
    }

    pub fn with_loader(models_dir: PathBuf, loader: Arc<dyn EngineLoader>) -> Self {
        Self {
            models_dir,
            loader,
            inner: Mutex::new(ServiceInner {
                engine: None,
                engine_key: None,
                session: None,
                starting_owner: None,
                idle_generation: 0,
            }),
        }
    }

    /// Model id of the loaded (warm or active) engine, for the deletion guard.
    pub fn loaded_model_id(&self) -> Option<String> {
        self.inner
            .lock()
            .expect("stt lock")
            .engine
            .as_ref()
            .map(|e| e.model_id.clone())
    }

    pub fn idle_generation(&self) -> u64 {
        self.inner.lock().expect("stt lock").idle_generation
    }

    /// Drops the warm engine unless a session started or a newer generation
    /// was issued since. The owner (commands layer) schedules this after
    /// `idle_timeout()`; tests drive it directly.
    pub fn expire_idle(&self, generation: u64) -> bool {
        let mut inner = self.inner.lock().expect("stt lock");
        if inner.session.is_some() || inner.idle_generation != generation {
            return false;
        }
        let had_engine = inner.engine.is_some();
        inner.engine = None;
        inner.engine_key = None;
        had_engine
    }

    pub async fn start_dictation(
        &self,
        model_id: &str,
        owner: String,
        hotwords_file: Option<PathBuf>,
        emit: SttEmitter,
    ) -> Result<(), SttError> {
        get_catalog_model(model_id).ok_or_else(|| SttError::UnknownModel(model_id.into()))?;

        let hotwords_key = hotwords_key(&hotwords_file);
        let engine_key = format!("{model_id}\0{hotwords_key}");

        let needs_load = {
            let mut inner = self.inner.lock().expect("stt lock");
            if let Some(active) = inner.session.as_ref() {
                if active.owner != owner {
                    return Err(SttError::AlreadyActive);
                }
                return Ok(());
            }
            if let Some(starting) = inner.starting_owner.as_ref() {
                if *starting != owner {
                    return Err(SttError::AlreadyActive);
                }
                return Ok(());
            }
            inner.starting_owner = Some(owner.clone());
            inner.idle_generation += 1;
            let reuse = inner.engine_key.as_deref() == Some(&engine_key) && inner.engine.is_some();
            if !reuse {
                inner.engine = None;
                inner.engine_key = None;
            }
            !reuse
        };

        if needs_load {
            let loader = self.loader.clone();
            let models_dir = self.models_dir.clone();
            let model = model_id.to_string();
            let path = hotwords_file.clone();
            let load = tokio::task::spawn_blocking(move || {
                loader.load(&models_dir, &model, path.as_deref())
            });
            let joined = tokio::time::timeout(start_timeout(), load)
                .await
                .map_err(|_| {
                    self.inner.lock().expect("stt lock").starting_owner = None;
                    SttError::StartTimeout
                })?;
            let loaded = joined.map_err(|e| {
                self.inner.lock().expect("stt lock").starting_owner = None;
                SttError::Engine(format!("loader panicked: {e}"))
            })?;

            let mut inner = self.inner.lock().expect("stt lock");
            if inner.starting_owner.as_deref() != Some(&owner) {
                // Stopped while loading: a fresh engine drops here, a reused
                // one was never evicted above. Report quietly.
                return Ok(());
            }
            match loaded {
                Ok(engine) => {
                    inner.engine = Some(Arc::new(engine));
                    inner.engine_key = Some(engine_key);
                }
                Err(reason) => {
                    inner.starting_owner = None;
                    return Err(map_load_error(model_id, &reason));
                }
            }
        }

        let mut inner = self.inner.lock().expect("stt lock");
        if inner.starting_owner.as_deref() != Some(&owner) {
            return Ok(());
        }
        let engine = inner.engine.clone().expect("engine loaded or reused");
        let mut session = engine.new_session(STT_SAMPLE_RATE);
        let (sender, receiver) = std::sync::mpsc::channel::<WorkerMsg>();
        let worker_emit = emit.clone();
        let thread = std::thread::spawn(move || {
            worker_pump(&mut session, receiver, &worker_emit);
        });
        inner.session = Some(ActiveSession {
            owner,
            sender,
            thread: Some(thread),
        });
        inner.starting_owner = None;
        drop(inner);

        emit.emit(SttEvent::Ready);
        Ok(())
    }

    pub fn feed_audio(&self, samples: Vec<f32>, sample_rate: u32, owner: &str) {
        if samples.is_empty() {
            return;
        }
        let sender = {
            let inner = self.inner.lock().expect("stt lock");
            match inner.session.as_ref() {
                Some(session) if session.owner == owner => session.sender.clone(),
                _ => return,
            }
        };
        let resampled = resample_to_16k(&samples, sample_rate);
        if resampled.is_empty() {
            return;
        }
        // Why: the channel is unbounded and decode outruns capture, so a
        // disconnected receiver means teardown is in flight — drop rather
        // than block the Tauri command.
        let _ = sender.send(WorkerMsg::Audio(resampled));
    }

    pub async fn stop_dictation(&self, owner: &str) -> Result<(), SttError> {
        let session = {
            let mut inner = self.inner.lock().expect("stt lock");
            if inner.starting_owner.as_deref() == Some(owner) {
                // Stopped while loading: the post-load check drops the engine.
                inner.starting_owner = None;
                None
            } else {
                inner.session.take_if(|s| s.owner == owner)
            }
        };
        let Some(mut session) = session else {
            return Ok(());
        };
        let _ = session.sender.send(WorkerMsg::Finish);
        if let Some(thread) = session.thread.take() {
            let join = tokio::task::spawn_blocking(move || thread.join());
            match tokio::time::timeout(stop_timeout(), join).await {
                Err(_) => return Err(SttError::StopTimeout),
                Ok(Err(join_error)) => {
                    return Err(SttError::Engine(format!("stop join failed: {join_error}")));
                }
                Ok(Ok(thread_result)) => {
                    if thread_result.is_err() {
                        // Worker panicked after finishing: drop the engine so
                        // the next session cold-loads instead of reusing rot.
                        self.teardown_engine();
                    }
                }
            }
        }
        Ok(())
    }

    fn teardown_engine(&self) {
        let mut inner = self.inner.lock().expect("stt lock");
        inner.engine = None;
        inner.engine_key = None;
    }

    #[cfg(test)]
    pub fn test_session_owner(&self) -> Option<String> {
        self.inner
            .lock()
            .expect("stt lock")
            .session
            .as_ref()
            .map(|s| s.owner.clone())
    }
}

fn worker_pump(
    session: &mut EngineSession,
    receiver: std::sync::mpsc::Receiver<WorkerMsg>,
    emit: &SttEmitter,
) {
    loop {
        match receiver.recv() {
            Ok(WorkerMsg::Audio(samples)) => {
                if let Err(reason) = session.accept(&samples, &|event| emit.emit(event)) {
                    emit.emit(SttEvent::Error(reason));
                    break;
                }
            }
            Ok(WorkerMsg::Finish) | Err(_) => {
                // Finish drains the tail (final); a dropped sender (stop
                // racing teardown) ends the pump either way.
                if let Err(reason) = session.finish(&|event| emit.emit(event)) {
                    emit.emit(SttEvent::Error(reason));
                }
                break;
            }
        }
    }
    emit.emit(SttEvent::Stopped);
}

/// Engine reuse key: model id plus the hotwords file content (path alone is
/// content-addressed by sha12, but content is the ground truth).
fn hotwords_key(hotwords_file: &Option<PathBuf>) -> String {
    match hotwords_file {
        None => "none".into(),
        Some(path) => std::fs::read(path)
            .ok()
            .map(|bytes| {
                use sha2::{Digest, Sha256};
                let mut hasher = Sha256::new();
                hasher.update(&bytes);
                format!("{:x}", hasher.finalize())
            })
            .unwrap_or_else(|| "unreadable".into()),
    }
}

fn map_load_error(model_id: &str, reason: &str) -> SttError {
    if reason.starts_with("unknown_model:") {
        SttError::UnknownModel(model_id.into())
    } else if let Some(detail) = reason.strip_prefix("model_not_ready:") {
        SttError::ModelNotReady(detail.into())
    } else {
        SttError::Engine(reason.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    /// Serializes `OPPA_VOICE_*_MS` mutation: env is process-global and Rust
    /// tests run in parallel.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct FakeLoader {
        loads: AtomicUsize,
        fail_with: Mutex<Option<String>>,
        load_sleep: Duration,
    }

    impl FakeLoader {
        fn succeeding() -> Self {
            Self {
                loads: AtomicUsize::new(0),
                fail_with: Mutex::new(None),
                load_sleep: Duration::from_millis(0),
            }
        }
    }

    impl EngineLoader for FakeLoader {
        fn load(
            &self,
            _models_dir: &Path,
            model_id: &str,
            _hotwords_file: Option<&Path>,
        ) -> Result<LoadedEngine, String> {
            self.loads.fetch_add(1, Ordering::SeqCst);
            if !self.load_sleep.is_zero() {
                std::thread::sleep(self.load_sleep);
            }
            if let Some(reason) = self.fail_with.lock().expect("fail lock").clone() {
                return Err(reason);
            }
            Ok(LoadedEngine::stub_streaming(model_id))
        }
    }

    struct Collected {
        events: Arc<Mutex<Vec<SttEvent>>>,
        emitter: SttEmitter,
    }

    impl Collected {
        fn new() -> Self {
            let events = Arc::new(Mutex::new(Vec::new()));
            let sink = events.clone();
            Self {
                events,
                emitter: SttEmitter::new(move |event| {
                    sink.lock().expect("events lock").push(event);
                }),
            }
        }

        fn kinds(&self) -> Vec<&'static str> {
            self.events
                .lock()
                .expect("events lock")
                .iter()
                .map(|e| match e {
                    SttEvent::Ready => "ready",
                    SttEvent::Partial(_) => "partial",
                    SttEvent::Final(_) => "final",
                    SttEvent::Stopped => "stopped",
                    SttEvent::Error(_) => "error",
                })
                .collect()
        }
    }

    fn test_service(loader: FakeLoader) -> (Arc<SttService>, Arc<FakeLoader>) {
        let loader = Arc::new(loader);
        let service = Arc::new(SttService::with_loader(
            std::env::temp_dir(),
            loader.clone() as Arc<dyn EngineLoader>,
        ));
        (service, loader)
    }

    #[tokio::test]
    async fn rejects_unknown_models_without_loading() {
        let (service, loader) = test_service(FakeLoader::succeeding());
        let collected = Collected::new();
        let err = service
            .start_dictation("nope", "desktop:a".into(), None, collected.emitter.clone())
            .await
            .expect_err("unknown model");
        assert_eq!(err, SttError::UnknownModel("nope".into()));
        assert_eq!(loader.loads.load(Ordering::SeqCst), 0);
        assert!(collected.kinds().is_empty());
    }

    #[tokio::test]
    async fn starts_ready_and_stops_stopped() {
        let (service, _) = test_service(FakeLoader::succeeding());
        let collected = Collected::new();
        service
            .start_dictation(
                "whisper-tiny",
                "desktop:a".into(),
                None,
                collected.emitter.clone(),
            )
            .await
            .expect("start succeeds");
        assert_eq!(service.test_session_owner().as_deref(), Some("desktop:a"));
        assert_eq!(service.loaded_model_id().as_deref(), Some("whisper-tiny"));

        service.feed_audio(vec![0.0; 1600], 16000, "desktop:a");
        service
            .stop_dictation("desktop:a")
            .await
            .expect("stop succeeds");
        assert!(service.test_session_owner().is_none());

        let kinds = collected.kinds();
        assert_eq!(kinds.first(), Some(&"ready"));
        assert_eq!(kinds.last(), Some(&"stopped"));
        assert!(kinds.contains(&"partial"), "stub session emits: {kinds:?}");
        assert!(kinds.contains(&"final"), "stub session emits: {kinds:?}");
    }

    #[tokio::test]
    async fn second_owner_conflicts_while_active() {
        let (service, loader) = test_service(FakeLoader::succeeding());
        let collected = Collected::new();
        service
            .start_dictation(
                "whisper-tiny",
                "desktop:a".into(),
                None,
                collected.emitter.clone(),
            )
            .await
            .expect("first start");
        let err = service
            .start_dictation("whisper-tiny", "desktop:b".into(), None, collected.emitter)
            .await
            .expect_err("second owner conflicts");
        assert_eq!(err, SttError::AlreadyActive);
        assert_eq!(loader.loads.load(Ordering::SeqCst), 1);
        service.stop_dictation("desktop:a").await.expect("stop");
    }

    #[tokio::test]
    async fn wrong_owner_feed_and_post_stop_feed_are_dropped() {
        let (service, _) = test_service(FakeLoader::succeeding());
        let collected = Collected::new();
        service
            .start_dictation(
                "whisper-tiny",
                "desktop:a".into(),
                None,
                collected.emitter.clone(),
            )
            .await
            .expect("start");
        // Wrong owner: no partial may appear (only the session's own feed counts).
        service.feed_audio(vec![0.5; 1600], 16000, "desktop:intruder");
        service.feed_audio(vec![0.5; 1600], 16000, "desktop:a");
        service.stop_dictation("desktop:a").await.expect("stop");
        let partials_before = collected
            .kinds()
            .into_iter()
            .filter(|k| *k == "partial")
            .count();
        // Post-stop feeds are dropped: the count is frozen after stop.
        service.feed_audio(vec![0.5; 1600], 16000, "desktop:a");
        tokio::task::yield_now().await;
        let partials_after = collected
            .kinds()
            .into_iter()
            .filter(|k| *k == "partial")
            .count();
        assert_eq!(partials_before, partials_after);
        assert_eq!(partials_before, 1, "exactly the owner's feed counted");
        // Stopping a stranger is a quiet no-op.
        service
            .stop_dictation("desktop:stranger")
            .await
            .expect("noop");
    }

    #[tokio::test]
    async fn warm_reuse_skips_reload_model_change_reloads() {
        let (service, loader) = test_service(FakeLoader::succeeding());
        let collected = Collected::new();
        service
            .start_dictation(
                "whisper-tiny",
                "desktop:a".into(),
                None,
                collected.emitter.clone(),
            )
            .await
            .expect("start 1");
        service.stop_dictation("desktop:a").await.expect("stop 1");
        service
            .start_dictation(
                "whisper-tiny",
                "desktop:b".into(),
                None,
                collected.emitter.clone(),
            )
            .await
            .expect("start 2 reuses");
        assert_eq!(loader.loads.load(Ordering::SeqCst), 1);
        service.stop_dictation("desktop:b").await.expect("stop 2");
        service
            .start_dictation(
                "zipformer-streaming-en-20m",
                "desktop:c".into(),
                None,
                collected.emitter,
            )
            .await
            .expect("model change reloads");
        assert_eq!(loader.loads.load(Ordering::SeqCst), 2);
        service.stop_dictation("desktop:c").await.expect("stop 3");
    }

    #[tokio::test]
    async fn load_failure_surfaces_and_clears_starting() {
        let loader = FakeLoader::succeeding();
        *loader.fail_with.lock().expect("fail lock") = Some("model_not_ready:gone".into());
        let (service, _) = test_service(loader);
        let collected = Collected::new();
        let err = service
            .start_dictation(
                "whisper-tiny",
                "desktop:a".into(),
                None,
                collected.emitter.clone(),
            )
            .await
            .expect_err("load failure");
        assert_eq!(err, SttError::ModelNotReady("gone".into()));
        // Starting cleared: a retry may proceed (and fail the same way here).
        let retry = service
            .start_dictation("whisper-tiny", "desktop:a".into(), None, collected.emitter)
            .await
            .expect_err("retry");
        assert_eq!(retry, SttError::ModelNotReady("gone".into()));
        assert!(service.test_session_owner().is_none());
    }

    #[tokio::test]
    async fn start_timeout_releases_starting() {
        let _env = ENV_LOCK.lock().expect("env lock");
        std::env::set_var("OPPA_VOICE_START_TIMEOUT_MS", "100");
        let loader = FakeLoader {
            loads: AtomicUsize::new(0),
            fail_with: Mutex::new(None),
            load_sleep: Duration::from_secs(5),
        };
        let (service, _) = test_service(loader);
        let collected = Collected::new();
        let err = service
            .start_dictation("whisper-tiny", "desktop:a".into(), None, collected.emitter)
            .await
            .expect_err("slow load times out");
        assert_eq!(err, SttError::StartTimeout);
        assert!(service.test_session_owner().is_none());
        std::env::remove_var("OPPA_VOICE_START_TIMEOUT_MS");
        // Starting cleared: a fresh attempt proceeds to load.
        let collected = Collected::new();
        service
            .start_dictation("whisper-tiny", "desktop:a".into(), None, collected.emitter)
            .await
            .expect("retry after timeout");
        service.stop_dictation("desktop:a").await.expect("stop");
    }

    #[tokio::test]
    async fn idle_expiry_drops_warm_engine_only_for_its_generation() {
        let (service, _) = test_service(FakeLoader::succeeding());
        let collected = Collected::new();
        service
            .start_dictation("whisper-tiny", "desktop:a".into(), None, collected.emitter)
            .await
            .expect("start");
        let generation = service.idle_generation();
        // Active session pins the engine.
        assert!(!service.expire_idle(generation));
        service.stop_dictation("desktop:a").await.expect("stop");
        // Stale generation never evicts.
        assert!(!service.expire_idle(generation + 99));
        assert!(service.expire_idle(generation));
        assert!(service.loaded_model_id().is_none());
    }
}
