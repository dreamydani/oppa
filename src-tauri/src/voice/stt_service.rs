// Dictation lifecycle service — behavior port of Orca's `stt-service.ts`.
// Single-owner gating, warm-engine reuse across sessions with the same
// model+hotwords, 60 s start/stop timeouts, 1 h idle teardown. Blocking
// sherpa work runs on a per-session worker thread fed by an mpsc channel;
// the Tauri async runtime only awaits joins with timeouts.

use crate::voice::model_catalog::{get_catalog_model, SpeechModelProvider};
use crate::voice::openai_api_key_store::OpenAiKeyStore;
use crate::voice::openai_transcription_client::{
    OpenAiTranscriptionSession, CLOUD_TRANSCRIPTION_SAMPLE_RATE, MAX_CLOUD_AUDIO_SECONDS,
    TRANSCRIPTION_URL,
};
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

struct CloudSession {
    owner: String,
    model_id: String,
    api_key: String,
    pcm: Vec<f32>,
    audio_samples: u64,
    overflowed: bool,
    emit: SttEmitter,
}

enum SessionKind {
    Local(ActiveSession),
    Cloud(CloudSession),
}

impl SessionKind {
    fn owner(&self) -> &str {
        match self {
            SessionKind::Local(session) => &session.owner,
            SessionKind::Cloud(session) => &session.owner,
        }
    }
}

struct ServiceInner {
    engine: Option<Arc<LoadedEngine>>,
    engine_key: Option<String>,
    session: Option<SessionKind>,
    starting_owner: Option<String>,
    idle_generation: u64,
}

pub struct SttService {
    models_dir: PathBuf,
    key_store: OpenAiKeyStore,
    http_client: Option<reqwest::Client>,
    transcription_url: Mutex<String>,
    loader: Arc<dyn EngineLoader>,
    inner: Mutex<ServiceInner>,
}

impl SttService {
    pub fn new(models_dir: PathBuf) -> Self {
        Self::with_loader(models_dir, Arc::new(SherpaEngineLoader))
    }

    pub fn with_loader(models_dir: PathBuf, loader: Arc<dyn EngineLoader>) -> Self {
        let key_store = OpenAiKeyStore::new(OpenAiKeyStore::default_path(&models_dir));
        Self {
            models_dir,
            key_store,
            http_client: crate::voice::http_client::build_voice_http_client(),
            transcription_url: Mutex::new(TRANSCRIPTION_URL.to_string()),
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

    #[cfg(test)]
    pub fn set_transcription_url(&self, url: &str) {
        *self.transcription_url.lock().expect("url lock") = url.to_string();
    }

    #[cfg(test)]
    pub fn test_key_store(&self) -> &OpenAiKeyStore {
        &self.key_store
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

    pub fn key_configured(&self) -> bool {
        self.key_store.has_key()
    }

    pub fn save_api_key(&self, api_key: &str) -> Result<(), String> {
        self.key_store.save_key(api_key)
    }

    pub fn clear_api_key(&self) {
        self.key_store.clear_key();
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
        let manifest =
            get_catalog_model(model_id).ok_or_else(|| SttError::UnknownModel(model_id.into()))?;

        if manifest.provider == SpeechModelProvider::Openai {
            return self.start_cloud_dictation(model_id, owner, emit);
        }

        let hotwords_key = hotwords_key(&hotwords_file);
        let engine_key = format!("{model_id}\0{hotwords_key}");

        let needs_load = {
            let mut inner = self.inner.lock().expect("stt lock");
            if let Some(active) = inner.session.as_ref() {
                if active.owner() != owner {
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
        inner.session = Some(SessionKind::Local(ActiveSession {
            owner,
            sender,
            thread: Some(thread),
        }));
        inner.starting_owner = None;
        drop(inner);

        emit.emit(SttEvent::Ready);
        Ok(())
    }

    /// Cloud transcription session (Slice 7): no model files, no worker
    /// thread — audio accumulates in memory and transcribes on stop. The
    /// warm local engine is evicted first (single session resource, Orca
    /// parity: one worker *or* cloud session at a time).
    fn start_cloud_dictation(
        &self,
        model_id: &str,
        owner: String,
        emit: SttEmitter,
    ) -> Result<(), SttError> {
        let mut inner = self.inner.lock().expect("stt lock");
        if let Some(active) = inner.session.as_ref() {
            if active.owner() != owner {
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
        // The key is read once here: clearing mid-session must not strand an
        // active dictation (Orca parity — the session keeps its key).
        let api_key = self.key_store.read_key().map_err(SttError::ModelNotReady)?;
        inner.engine = None;
        inner.engine_key = None;
        inner.idle_generation += 1;
        inner.session = Some(SessionKind::Cloud(CloudSession {
            owner,
            model_id: model_id.into(),
            api_key,
            pcm: Vec::new(),
            audio_samples: 0,
            overflowed: false,
            emit: emit.clone(),
        }));
        drop(inner);

        emit.emit(SttEvent::Ready);
        Ok(())
    }

    pub fn feed_audio(&self, samples: Vec<f32>, sample_rate: u32, owner: &str) {
        if samples.is_empty() {
            return;
        }
        let resampled = resample_to_16k(&samples, sample_rate);
        if resampled.is_empty() {
            return;
        }
        let mut inner = self.inner.lock().expect("stt lock");
        let Some(session) = inner.session.as_mut() else {
            return;
        };
        if session.owner() != owner {
            return;
        }
        match session {
            SessionKind::Local(active) => {
                let sender = active.sender.clone();
                drop(inner);
                // Why: the channel is unbounded and decode outruns capture, so
                // a disconnected receiver means teardown is in flight — drop
                // rather than block the Tauri command.
                let _ = sender.send(WorkerMsg::Audio(resampled));
            }
            SessionKind::Cloud(cloud) => {
                cloud.audio_samples += resampled.len() as u64;
                if cloud.audio_samples
                    > MAX_CLOUD_AUDIO_SECONDS * CLOUD_TRANSCRIPTION_SAMPLE_RATE as u64
                {
                    // Past the 10-minute cap: flag overflow and drop audio
                    // (the stop path reports it instead of transcribing).
                    cloud.overflowed = true;
                    return;
                }
                cloud.pcm.extend_from_slice(&resampled);
            }
        }
    }

    pub async fn stop_dictation(&self, owner: &str) -> Result<(), SttError> {
        let session = {
            let mut inner = self.inner.lock().expect("stt lock");
            if inner.starting_owner.as_deref() == Some(owner) {
                // Stopped while loading: the post-load check drops the engine.
                inner.starting_owner = None;
                None
            } else {
                inner.session.take_if(|s| s.owner() == owner)
            }
        };
        let Some(session) = session else {
            return Ok(());
        };
        match session {
            SessionKind::Local(mut active) => self.stop_local_session(&mut active).await,
            SessionKind::Cloud(cloud) => self.stop_cloud_session(cloud).await,
        }
    }

    async fn stop_local_session(&self, session: &mut ActiveSession) -> Result<(), SttError> {
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

    async fn stop_cloud_session(&self, cloud: CloudSession) -> Result<(), SttError> {
        let CloudSession {
            model_id,
            api_key,
            pcm,
            overflowed,
            emit,
            ..
        } = cloud;
        if overflowed {
            emit.emit(SttEvent::Error(
                "Cloud transcription is limited to 10 minutes per dictation".into(),
            ));
            emit.emit(SttEvent::Stopped);
            return Ok(());
        }
        let client = self
            .http_client
            .clone()
            .ok_or_else(|| SttError::Engine("http_unavailable".into()))?;
        let url = self.transcription_url.lock().expect("url lock").clone();
        let mut session = OpenAiTranscriptionSession::new(&model_id);
        // Fits by construction: overflow is flagged (not stored) in feed.
        session.feed_audio(&pcm).map_err(SttError::Engine)?;
        match session.finish_to(&client, &api_key, &url).await {
            Ok(text) => {
                if !text.trim().is_empty() {
                    emit.emit(SttEvent::Final(text));
                }
            }
            Err(reason) => {
                emit.emit(SttEvent::Error(reason));
            }
        }
        emit.emit(SttEvent::Stopped);
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
            .map(|s| s.owner().to_string())
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

    /// Isolated service whose key file lives under a temp dir.
    fn cloud_test_service() -> (Arc<SttService>, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let loader = Arc::new(FakeLoader::succeeding());
        let service = Arc::new(SttService::with_loader(
            dir.path().join("voice-models"),
            loader as Arc<dyn EngineLoader>,
        ));
        (service, dir)
    }

    /// Single-shot transcription mock: reads one request, answers JSON text.
    async fn start_text_mock(json: &'static str) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let mut raw = Vec::new();
            let mut buf = [0u8; 8192];
            loop {
                match socket.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        raw.extend_from_slice(&buf[..n]);
                        if raw.windows(4).any(|w| w == b"\r\n\r\n") && raw.len() > 1024 {
                            // Headers done; drain a little body then answer.
                            break;
                        }
                        if raw.len() > 256 * 1024 {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{json}",
                json.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
        });
        format!("http://{addr}/v1/audio/transcriptions")
    }

    #[tokio::test]
    async fn cloud_requires_a_key() {
        let (service, _dir) = cloud_test_service();
        let collected = Collected::new();
        let err = service
            .start_dictation(
                "openai-gpt-4o-mini-transcribe",
                "desktop:a".into(),
                None,
                collected.emitter,
            )
            .await
            .expect_err("no key");
        assert_eq!(err, SttError::ModelNotReady("missing_api_key".into()));
        assert!(service.test_session_owner().is_none());
    }

    #[tokio::test]
    async fn cloud_transcribes_on_stop_with_stored_key() {
        let (service, _dir) = cloud_test_service();
        service
            .test_key_store()
            .save_key("sk-test")
            .expect("save key");
        service.set_transcription_url(&start_text_mock(r#"{"text":"hi cloud"}"#).await);
        let collected = Collected::new();

        service
            .start_dictation(
                "openai-gpt-4o-mini-transcribe",
                "desktop:a".into(),
                None,
                collected.emitter.clone(),
            )
            .await
            .expect("cloud start");
        assert_eq!(service.test_session_owner().as_deref(), Some("desktop:a"));
        service.feed_audio(vec![0.1; 1600], 16000, "desktop:a");
        service.feed_audio(vec![0.2; 1600], 16000, "desktop:intruder");
        service.stop_dictation("desktop:a").await.expect("stop");

        let kinds = collected.kinds();
        assert_eq!(kinds.first(), Some(&"ready"));
        assert_eq!(kinds.last(), Some(&"stopped"));
        let finals: Vec<String> = collected
            .events
            .lock()
            .expect("lock")
            .iter()
            .filter_map(|e| match e {
                SttEvent::Final(text) => Some(text.clone()),
                _ => None,
            })
            .collect();
        assert_eq!(finals, vec!["hi cloud".to_string()]);
    }

    #[tokio::test]
    async fn cloud_session_survives_key_clear_and_conflicts_like_local() {
        let dir = tempfile::tempdir().expect("tempdir");
        let service = Arc::new(SttService::with_loader(
            dir.path().join("voice-models"),
            Arc::new(FakeLoader::succeeding()) as Arc<dyn EngineLoader>,
        ));
        service.test_key_store().save_key("sk-test").expect("save");
        service.set_transcription_url(&start_text_mock(r#"{"text":"ok"}"#).await);
        let collected = Collected::new();

        // Local first: cloud start from another owner conflicts.
        service
            .start_dictation(
                "whisper-tiny",
                "desktop:local".into(),
                None,
                collected.emitter.clone(),
            )
            .await
            .expect("local start");
        // Cloud start evicts nothing while a session is active — it conflicts.
        let err = service
            .start_dictation(
                "openai-gpt-4o-mini-transcribe",
                "desktop:cloud".into(),
                None,
                collected.emitter.clone(),
            )
            .await
            .expect_err("conflict");
        assert_eq!(err, SttError::AlreadyActive);
        service
            .stop_dictation("desktop:local")
            .await
            .expect("stop local");

        // Cloud start evicts the warm local engine (single session resource).
        service
            .start_dictation(
                "openai-gpt-4o-mini-transcribe",
                "desktop:cloud".into(),
                None,
                collected.emitter.clone(),
            )
            .await
            .expect("cloud start");
        assert!(service.loaded_model_id().is_none());
        // Clearing mid-session keeps the in-memory key: stop still transcribes.
        service.test_key_store().clear_key();
        service.feed_audio(vec![0.1; 160], 16000, "desktop:cloud");
        service
            .stop_dictation("desktop:cloud")
            .await
            .expect("stop cloud");
        let finals = collected
            .events
            .lock()
            .expect("lock")
            .iter()
            .filter_map(|e| match e {
                SttEvent::Final(text) => Some(text.clone()),
                _ => None,
            })
            .collect::<Vec<_>>();
        // The collector is shared with the earlier local session ("stub
        // final"); the cloud session appends its own transcript.
        assert_eq!(finals.last().map(String::as_str), Some("ok"));
        // Next cloud start requires the key again.
        let err = service
            .start_dictation(
                "openai-gpt-4o-mini-transcribe",
                "desktop:cloud".into(),
                None,
                collected.emitter,
            )
            .await
            .expect_err("key gone");
        assert_eq!(err, SttError::ModelNotReady("missing_api_key".into()));
    }
}
