// Voice dictation commands (Tauri boundary). Downloads are real (Slice 4);
// local STT (Slice 5) and cloud transcription (Slice 7) replace the remaining
// stubs command by command; the names, args, and event channels are final.

use crate::voice::model_catalog::{get_catalog_model, speech_model_catalog, SpeechModelManifest};
pub use crate::voice::model_manager::{ModelManager, SpeechModelState, SpeechModelStatus};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

/// Process-wide voice state: the download manager plus the engine's active
/// model id (set by Slice 5; gates deletion of a model in use).
pub struct VoiceState {
    manager: ModelManager,
    active_model: Mutex<Option<String>>,
}

impl VoiceState {
    pub fn with_models_dir(models_dir: PathBuf) -> Self {
        Self {
            manager: ModelManager::new(models_dir),
            active_model: Mutex::new(None),
        }
    }

    /// Test/dev constructor (temp dir, no shared state).
    pub fn new() -> Self {
        Self::with_models_dir(std::env::temp_dir().join("oppa-voice-models"))
    }

    pub fn manager(&self) -> &ModelManager {
        &self.manager
    }

    fn is_active_model(&self, model_id: &str) -> bool {
        self.active_model
            .lock()
            .expect("voice active lock")
            .as_deref()
            == Some(model_id)
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
#[allow(dead_code)] // Emitted by the STT engine from Slice 5.
struct TranscriptPayload {
    text: String,
    session_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[allow(dead_code)] // Emitted by the STT engine from Slice 5.
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
    let active = state.is_active_model(&model_id);
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
    let _ = state;
    let _ = hotwords;
    require_known_model(&model_id)?;
    let session_id = desktop_session(session_id);
    // Stub: report ready now; the stopped event follows shortly so the Slice 6
    // state machine can already be smoke-tested against the real backend.
    let _ = app.emit(
        "voice://ready",
        SessionPayload {
            session_id: session_id.clone(),
        },
    );
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        let _ = app.emit("voice://stopped", SessionPayload { session_id });
    });
    Ok(())
}

#[tauri::command(async)]
pub fn voice_feed_audio(
    state: State<'_, VoiceState>,
    samples_b64: String,
    sample_rate: u32,
    session_id: Option<String>,
) -> Result<(), String> {
    let _ = state;
    let _ = session_id;
    validate_audio_wire(&samples_b64, sample_rate)
}

// Sync validation behind `voice_feed_audio` (the `#[tauri::command]` wrapper
// takes `State<'_>`, which unit tests cannot build, so the pure check lives
// here and the wrapper delegates to it).
fn validate_audio_wire(samples_b64: &str, sample_rate: u32) -> Result<(), String> {
    if sample_rate != 16000 {
        return Err(format!("unsupported_sample_rate:{sample_rate}"));
    }
    // Validate the base64 f32-LE wire shape now so Slice 3/5 inherit a checked contract.
    let bytes = base64::Engine::decode(
        &base64::engine::general_purpose::STANDARD,
        samples_b64.trim(),
    )
    .map_err(|e| format!("invalid_audio:{e}"))?;
    if bytes.len() % 4 != 0 {
        return Err(format!("invalid_audio:not_f32_le_len:{}", bytes.len()));
    }
    Ok(())
}

#[tauri::command(async)]
pub fn voice_stop_dictation(app: AppHandle, session_id: Option<String>) -> Result<(), String> {
    let _ = app.emit(
        "voice://stopped",
        SessionPayload {
            session_id: desktop_session(session_id),
        },
    );
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
        assert!(validate_audio_wire(&ok, 16000).is_ok());
    }

    #[test]
    fn feed_audio_rejects_bad_rate_and_bad_base64() {
        let ok = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, [0u8; 8]);
        assert!(validate_audio_wire(&ok, 48000).is_err());
        assert!(validate_audio_wire("!!!", 16000).is_err());
        // Valid base64 but not a multiple of 4 bytes (not f32 LE).
        assert!(validate_audio_wire("aGk=", 16000).is_err());
    }
}
