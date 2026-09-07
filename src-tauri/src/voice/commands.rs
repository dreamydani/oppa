// Voice dictation commands (Tauri boundary). Downloads (Slice 4) and local
// STT (Slice 5) are real; cloud transcription (Slice 7) replaces the last
// stubs. Names, args, and event channels are final.

use crate::voice::model_catalog::{get_catalog_model, speech_model_catalog, SpeechModelManifest};
pub use crate::voice::model_manager::{ModelManager, SpeechModelState, SpeechModelStatus};
use crate::voice::stt_engine::SttEvent;
use crate::voice::stt_model_config::hotwords_file_content;
use crate::voice::stt_service::{SttEmitter, SttService};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

/// Process-wide voice state: the download manager plus the dictation service
/// (warm engine + active session). Both share the models dir.
pub struct VoiceState {
    manager: ModelManager,
    service: Arc<SttService>,
}

impl VoiceState {
    pub fn with_models_dir(models_dir: PathBuf) -> Self {
        Self {
            manager: ModelManager::new(models_dir.clone()),
            service: Arc::new(SttService::new(models_dir)),
        }
    }

    /// Test/dev constructor (temp dir, no shared state).
    pub fn new() -> Self {
        Self::with_models_dir(std::env::temp_dir().join("oppa-voice-models"))
    }

    pub fn manager(&self) -> &ModelManager {
        &self.manager
    }

    pub fn service(&self) -> &Arc<SttService> {
        &self.service
    }
}

impl Default for VoiceState {
    fn default() -> Self {
        Self::new()
    }
}

fn require_known_model(model_id: &str) -> Result<SpeechModelManifest, String> {
    get_catalog_model(model_id).ok_or_else(|| format!("unknown_model:{model_id}"))
}

#[derive(Debug, Clone, Serialize)]
struct SessionPayload {
    session_id: String,
}

#[derive(Debug, Clone, Serialize)]
struct TranscriptPayload {
    text: String,
    session_id: String,
}

#[derive(Debug, Clone, Serialize)]
struct ErrorPayload {
    error: String,
    session_id: String,
}

#[derive(Debug, Clone, Serialize)]
struct DownloadProgressPayload {
    model_id: String,
    progress: f32,
}

fn desktop_session(session_id: Option<String>) -> String {
    session_id.unwrap_or_else(|| "desktop".into())
}

#[tauri::command(async)]
pub fn voice_get_catalog() -> Result<Vec<SpeechModelManifest>, String> {
    Ok(speech_model_catalog())
}

#[tauri::command(async)]
pub fn voice_get_model_states(
    state: State<'_, VoiceState>,
) -> Result<Vec<SpeechModelState>, String> {
    Ok(state.manager().get_model_states())
}

#[tauri::command(async)]
pub async fn voice_download_model(
    app: AppHandle,
    state: State<'_, VoiceState>,
    model_id: String,
) -> Result<(), String> {
    // Progress fan-out: the manager reports whole-percent steps; each one
    // rides to the renderer so the pane never polls.
    // Why AppHandle clone (not the window): a closed settings window must not
    // retain a callback — Tauri drops emits to dead windows harmlessly.
    let emitter = app.clone();
    let report_id = model_id.clone();
    state
        .manager()
        .download_model(&model_id, &|progress| {
            let _ = emitter.emit(
                "voice://download-progress",
                DownloadProgressPayload {
                    model_id: report_id.clone(),
                    progress,
                },
            );
        })
        .await
}

#[tauri::command(async)]
pub fn voice_cancel_download(state: State<'_, VoiceState>, model_id: String) -> Result<(), String> {
    require_known_model(&model_id)?;
    state.manager().cancel_download(&model_id);
    Ok(())
}

#[tauri::command(async)]
pub fn voice_delete_model(
    app: AppHandle,
    state: State<'_, VoiceState>,
    model_id: String,
) -> Result<(), String> {
    let manager = state.manager();
    let active = state.service().loaded_model_id().as_deref() == Some(model_id.as_str());
    let settings_path = crate::pty::snapshot::resolve_gui_data_dir(&app)
        .map(|dir| dir.join("settings.json"))
        .unwrap_or_else(|| PathBuf::from("settings.json"));
    crate::voice::model_deletion::delete_local_speech_model(
        manager.models_dir(),
        &settings_path,
        &model_id,
        active,
        || manager.delete_model_files(&model_id),
    )?;
    Ok(())
}

#[tauri::command(async)]
pub async fn voice_start_dictation(
    app: AppHandle,
    state: State<'_, VoiceState>,
    model_id: String,
    hotwords: Option<Vec<String>>,
    session_id: Option<String>,
) -> Result<(), String> {
    require_known_model(&model_id)?;
    let session_id = desktop_session(session_id);
    let owner = format!("desktop:{session_id}");

    // Hotwords biasing file (`<word> :2.0` per line, Orca parity). Written
    // before engine load, unlinked right after start resolves.
    let hotwords_file = match hotwords.as_deref().unwrap_or(&[]) {
        [] => None,
        words => {
            let models_dir = state.manager().models_dir().to_path_buf();
            Some(write_hotwords_file(&models_dir, words).map_err(|e| format!("io:{e}"))?)
        }
    };

    let emitter = session_emitter(&app, &session_id);
    let started = state
        .service()
        .start_dictation(&model_id, owner, hotwords_file.clone(), emitter)
        .await
        .map_err(|e| e.to_string());

    if let Some(path) = hotwords_file {
        let _ = std::fs::remove_file(path);
    }
    started
}

/// Content-addressed hotwords file co-located with the models dir (sherpa
/// cannot read non-ASCII Windows paths either, so the ASCII-safe cache dir
/// doubles for these temp files — Orca parity).
fn write_hotwords_file(models_dir: &Path, hotwords: &[String]) -> std::io::Result<PathBuf> {
    use sha2::{Digest, Sha256};
    let content =
        hotwords_file_content(&hotwords.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    let path = models_dir.join(format!("speech-hotwords-{}.txt", &digest[..12]));
    std::fs::write(&path, content)?;
    Ok(path)
}

fn session_emitter(app: &AppHandle, session_id: &str) -> SttEmitter {
    let emitter = app.clone();
    let session_id = session_id.to_string();
    SttEmitter::new(move |event| {
        let session_id = session_id.clone();
        match event {
            SttEvent::Ready => {
                let _ = emitter.emit("voice://ready", SessionPayload { session_id });
            }
            SttEvent::Partial(text) => {
                let _ = emitter.emit("voice://partial", TranscriptPayload { text, session_id });
            }
            SttEvent::Final(text) => {
                let _ = emitter.emit("voice://final", TranscriptPayload { text, session_id });
            }
            SttEvent::Stopped => {
                let _ = emitter.emit("voice://stopped", SessionPayload { session_id });
            }
            SttEvent::Error(error) => {
                let _ = emitter.emit("voice://error", ErrorPayload { error, session_id });
            }
        }
    })
}

#[tauri::command(async)]
pub fn voice_feed_audio(
    state: State<'_, VoiceState>,
    samples_b64: String,
    sample_rate: u32,
    session_id: Option<String>,
) -> Result<(), String> {
    let samples = decode_audio_wire(&samples_b64, sample_rate)?;
    let owner = format!("desktop:{}", desktop_session(session_id));
    state.service().feed_audio(samples, sample_rate, &owner);
    Ok(())
}

// Sync validation behind `voice_feed_audio` (the `#[tauri::command]` wrapper
// takes `State<'_>`, which unit tests cannot build, so the pure check lives
// here and the wrapper delegates to it).
/// Decodes the base64 f32-LE wire shape (Slice 2 contract) to samples.
fn decode_audio_wire(samples_b64: &str, sample_rate: u32) -> Result<Vec<f32>, String> {
    if sample_rate != 16000 {
        return Err(format!("unsupported_sample_rate:{sample_rate}"));
    }
    let bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        samples_b64.trim(),
    )
    .map_err(|e| format!("invalid_audio:{e}"))?;
    if bytes.len() % 4 != 0 {
        return Err(format!("invalid_audio:not_f32_le_len:{}", bytes.len()));
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect())
}

#[tauri::command(async)]
pub async fn voice_stop_dictation(
    state: State<'_, VoiceState>,
    session_id: Option<String>,
) -> Result<(), String> {
    let owner = format!("desktop:{}", desktop_session(session_id));
    let service = state.service().clone();
    service
        .stop_dictation(&owner)
        .await
        .map_err(|e| e.to_string())?;
    // Idle teardown: a stale generation never evicts a fresh engine.
    let generation = service.idle_generation();
    tokio::spawn(async move {
        tokio::time::sleep(crate::voice::stt_service::idle_timeout()).await;
        service.expire_idle(generation);
    });
    Ok(())
}

#[tauri::command(async)]
pub fn voice_get_key_status() -> Result<bool, String> {
    // Real key store lands in Slice 7.
    Ok(false)
}

#[tauri::command(async)]
pub fn voice_save_key(key: String) -> Result<bool, String> {
    if key.trim().is_empty() {
        return Err("invalid_api_key".into());
    }
    // Real key store lands in Slice 7; acknowledge the shape only.
    Ok(true)
}

#[tauri::command(async)]
pub fn voice_clear_key() -> Result<bool, String> {
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_has_twelve_models_all_at_16k() {
        let catalog = speech_model_catalog();
        assert_eq!(catalog.len(), 12);
        assert!(catalog.iter().all(|m| m.sample_rate == 16000));
        let v3 = catalog
            .iter()
            .find(|m| m.id == "parakeet-tdt-0.6b-v3-int8")
            .expect("recommended model present");
        assert_eq!(v3.recommended, Some(true));
        assert!(catalog.iter().any(|m| m.id == "openai-gpt-4o-transcribe"));
    }

    #[test]
    fn unknown_model_ids_error() {
        assert!(require_known_model("nope").is_err());
        assert_eq!(
            require_known_model("nope").unwrap_err(),
            "unknown_model:nope"
        );
    }

    #[test]
    fn model_states_default_to_not_downloaded() {
        let dir = tempfile::tempdir().expect("tempdir");
        let state = VoiceState::with_models_dir(dir.path().to_path_buf());
        let states = state.manager().get_model_states();
        assert_eq!(states.len(), 12);
        let tiny = states
            .iter()
            .find(|s| s.id == "whisper-tiny")
            .expect("tiny present");
        assert_eq!(tiny.status, SpeechModelStatus::NotDownloaded);
        assert_eq!(tiny.progress, None);
    }

    #[test]
    fn feed_audio_accepts_valid_f32_le_wire() {
        // 2 samples of f32 LE zeros.
        let ok = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, [0u8; 8]);
        assert!(decode_audio_wire(&ok, 16000).is_ok());
    }

    #[test]
    fn feed_audio_rejects_bad_rate_and_bad_base64() {
        let ok = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, [0u8; 8]);
        assert!(decode_audio_wire(&ok, 48000).is_err());
        assert!(decode_audio_wire("!!!", 16000).is_err());
        // Valid base64 but not a multiple of 4 bytes (not f32 LE).
        assert!(decode_audio_wire("aGk=", 16000).is_err());
    }

    #[test]
    fn decode_audio_wire_round_trips_f32_le() {
        let samples = [1.0f32, -0.5, 0.0, 3.25];
        let mut bytes = Vec::new();
        for sample in samples {
            bytes.extend_from_slice(&sample.to_le_bytes());
        }
        let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
        assert_eq!(
            decode_audio_wire(&encoded, 16000).expect("decodes"),
            samples
        );
    }

    #[test]
    fn hotwords_file_is_content_addressed_and_parseable() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write_hotwords_file(
            dir.path(),
            &["oppa".to_string(), "voice dictation".to_string()],
        )
        .expect("writes");
        let name = path.file_name().expect("name").to_string_lossy();
        assert!(name.starts_with("speech-hotwords-") && name.ends_with(".txt"));
        assert_eq!(
            std::fs::read_to_string(&path).expect("reads"),
            "oppa :2.0\nvoice dictation :2.0\n"
        );
        // Same content → same path (no duplicates across sessions).
        let again = write_hotwords_file(
            dir.path(),
            &["oppa".to_string(), "voice dictation".to_string()],
        )
        .expect("rewrites");
        assert_eq!(path, again);
    }
}
