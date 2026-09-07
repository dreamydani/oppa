// OpenAI speech API key store — port of Orca's `openai-api-key-store.ts`
// (minus Electron safeStorage: no Tauri equivalent exists without a new
// native keyring dependency, so this matches Orca's own plaintext fallback
// shape — 0600 file + memory cache. An OS-keyring backend remains the
// documented upgrade path; see slice-07 Decisions.)
//
// `has()` is a pure file-exists check: status probes on launch/settings-open
// must never do expensive or interactive work (Orca parity: no keychain
// prompts from mere probes).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct OpenAiKeyStore {
    file: PathBuf,
    cache: Mutex<Option<String>>,
}

impl OpenAiKeyStore {
    pub fn new(file: PathBuf) -> Self {
        Self {
            file,
            cache: Mutex::new(None),
        }
    }

    /// Models-dir adjacent default: `<app-data>/openai-speech-token`.
    pub fn default_path(models_dir: &Path) -> PathBuf {
        models_dir
            .parent()
            .map(|parent| parent.join("openai-speech-token"))
            .unwrap_or_else(|| models_dir.join("openai-speech-token"))
    }

    pub fn has_key(&self) -> bool {
        self.file.exists()
    }

    pub fn save_key(&self, api_key: &str) -> Result<(), String> {
        let trimmed = api_key.trim();
        if trimmed.is_empty() {
            return Err("invalid_api_key".into());
        }
        if let Some(parent) = self.file.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("io:{e}"))?;
        }
        std::fs::write(&self.file, trimmed).map_err(|e| format!("io:{e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.file, std::fs::Permissions::from_mode(0o600));
        }
        *self.cache.lock().expect("key cache lock") = Some(trimmed.to_string());
        Ok(())
    }

    pub fn read_key(&self) -> Result<String, String> {
        if let Some(cached) = self.cache.lock().expect("key cache lock").clone() {
            return Ok(cached);
        }
        let raw = std::fs::read_to_string(&self.file).map_err(|_| "missing_api_key".to_string())?;
        let trimmed = raw.trim().to_string();
        if trimmed.is_empty() {
            return Err("missing_api_key".into());
        }
        *self.cache.lock().expect("key cache lock") = Some(trimmed.clone());
        Ok(trimmed)
    }

    pub fn clear_key(&self) {
        *self.cache.lock().expect("key cache lock") = None;
        let _ = std::fs::remove_file(&self.file);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (OpenAiKeyStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = OpenAiKeyStore::new(dir.path().join("openai-speech-token"));
        (store, dir)
    }

    #[test]
    fn save_has_read_clear_round_trip() {
        let (store, _dir) = store();
        assert!(!store.has_key());
        store.save_key("  sk-test-123  ").expect("save");
        assert!(store.has_key());
        assert_eq!(store.read_key().expect("read"), "sk-test-123");
        store.clear_key();
        assert!(!store.has_key());
        assert_eq!(store.read_key().expect_err("cleared"), "missing_api_key");
    }

    #[test]
    fn rejects_blank_keys_without_touching_disk() {
        let (store, _dir) = store();
        assert_eq!(store.save_key("   ").expect_err("blank"), "invalid_api_key");
        assert!(!store.has_key());
    }

    #[test]
    fn read_falls_back_to_disk_after_cache_drop() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("openai-speech-token");
        OpenAiKeyStore::new(path.clone())
            .save_key("sk-persist")
            .expect("save");
        // Fresh store instance: cold cache reads the file.
        assert_eq!(
            OpenAiKeyStore::new(path).read_key().expect("read"),
            "sk-persist"
        );
    }

    #[test]
    fn has_never_reads_content() {
        let (store, dir) = store();
        std::fs::write(dir.path().join("openai-speech-token"), "sk-x").expect("write");
        // Presence alone is the signal (Orca parity: probes stay cheap).
        assert!(store.has_key());
    }

    #[cfg(unix)]
    #[test]
    fn key_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let (store, dir) = store();
        store.save_key("sk-secret").expect("save");
        let mode = std::fs::metadata(dir.path().join("openai-speech-token"))
            .expect("stat")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }
}
