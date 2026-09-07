// Model deletion — port of Orca's `speech-model-deletion.ts` orchestration:
// cancel any in-flight download, refuse while the engine holds the model
// (Slice 5 sets the active id), remove files, and clear a dangling
// `sttModel` selection from settings.json (Orca parity).

use crate::settings::{load_settings_at, save_settings_at};
use crate::voice::model_catalog::{get_catalog_model, is_local_speech_model};
use std::path::Path;

/// Delete a local model. Returns whether the persisted `sttModel` selection
/// was cleared because it pointed at the deleted model.
pub fn delete_local_speech_model(
    models_dir: &Path,
    settings_path: &Path,
    model_id: &str,
    is_active_model: bool,
    remove_files: impl FnOnce() -> Result<(), String>,
) -> Result<bool, String> {
    let manifest =
        get_catalog_model(model_id).ok_or_else(|| format!("unknown_model:{model_id}"))?;
    if !is_local_speech_model(&manifest) {
        return Err(format!("not_downloadable:{model_id}"));
    }
    if is_active_model {
        return Err(format!("model_in_use:{model_id}"));
    }
    remove_files()?;
    let _ = models_dir;
    Ok(clear_stt_model_selection(settings_path, model_id))
}

/// Read-modify-write `voice.sttModel` to `""` when it points at `model_id`.
/// Missing/corrupt settings files are left alone (nothing to clear).
fn clear_stt_model_selection(settings_path: &Path, model_id: &str) -> bool {
    let Ok(Some(raw)) = load_settings_at(settings_path) else {
        return false;
    };
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return false;
    };
    let selected = value
        .get("voice")
        .and_then(|v| v.get("sttModel").or_else(|| v.get("stt_model")))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if selected != model_id {
        return false;
    }
    if let Some(voice) = value.get_mut("voice") {
        if let Some(obj) = voice.as_object_mut() {
            obj.remove("stt_model");
            obj.insert("sttModel".into(), serde_json::Value::String(String::new()));
        }
    }
    save_settings_at(settings_path, &value.to_string()).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn settings_file(dir: &Path, voice_json: &str) -> PathBuf {
        let path = dir.join("settings.json");
        std::fs::write(
            &path,
            format!("{{\"general\":{{}},\"voice\":{voice_json}}}"),
        )
        .expect("write settings");
        path
    }

    #[test]
    fn clears_matching_selection_and_keeps_other_keys() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = settings_file(
            dir.path(),
            r#"{"enabled":true,"sttModel":"whisper-tiny","language":"en"}"#,
        );
        let called = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = called.clone();
        let cleared = delete_local_speech_model(dir.path(), &path, "whisper-tiny", false, || {
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        })
        .expect("deletion succeeds");
        assert!(cleared);
        assert!(called.load(std::sync::atomic::Ordering::SeqCst));
        let saved: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).expect("read")).expect("json");
        assert_eq!(saved["voice"]["sttModel"], "");
        assert_eq!(saved["voice"]["enabled"], true);
    }

    #[test]
    fn keeps_unrelated_selection_and_missing_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = settings_file(dir.path(), r#"{"sttModel":"parakeet-tdt-0.6b-v3-int8"}"#);
        let cleared =
            delete_local_speech_model(dir.path(), &path, "whisper-tiny", false, || Ok(()))
                .expect("deletion succeeds");
        assert!(!cleared);

        let missing = dir.path().join("nope.json");
        let cleared =
            delete_local_speech_model(dir.path(), &missing, "whisper-tiny", false, || Ok(()))
                .expect("missing settings tolerated");
        assert!(!cleared);
    }

    #[test]
    fn refuses_unknown_cloud_and_active_models() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("settings.json");
        assert!(delete_local_speech_model(dir.path(), &path, "nope", false, || Ok(())).is_err());
        assert!(delete_local_speech_model(
            dir.path(),
            &path,
            "openai-gpt-4o-transcribe",
            false,
            || Ok(())
        )
        .is_err());
        let err = delete_local_speech_model(dir.path(), &path, "whisper-tiny", true, || Ok(()))
            .expect_err("active model refused");
        assert_eq!(err, "model_in_use:whisper-tiny");
    }
}
