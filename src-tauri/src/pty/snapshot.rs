use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

const SNAPSHOT_DIR: &str = "terminal-scrollback";
const MAX_SNAPSHOT_BYTES: usize = 500 * 1024; // 500KB cap
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

pub struct SnapshotStorage {
    dir: PathBuf,
}

impl SnapshotStorage {
    pub fn new(app_data_dir: PathBuf) -> Self {
        Self {
            dir: app_data_dir.join(SNAPSHOT_DIR),
        }
    }

    fn safe_id(id: &str) -> String {
        id.replace(|c: char| !c.is_alphanumeric() && c != '-' && c != '_', "_")
    }

    fn snapshot_path(&self, id: &str) -> PathBuf {
        let safe_id = Self::safe_id(id);
        self.dir.join(format!("{safe_id}.bin"))
    }

    pub fn save(&self, id: &str, data: &str) -> std::io::Result<()> {
        if data.is_empty() {
            return Ok(());
        }
        fs::create_dir_all(&self.dir)?;

        let target_path = self.snapshot_path(id);
        let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let tmp_path = self.dir.join(format!("{}.tmp.{}.{}", Self::safe_id(id), std::process::id(), seq));

        // Truncate to trailing MAX_SNAPSHOT_BYTES on valid UTF-8 boundary
        let bytes = data.as_bytes();
        let slice = if bytes.len() > MAX_SNAPSHOT_BYTES {
            let start = bytes.len() - MAX_SNAPSHOT_BYTES;
            let mut valid_start = start;
            while valid_start < bytes.len() && (bytes[valid_start] & 0xc0) == 0x80 {
                valid_start += 1;
            }
            &bytes[valid_start..]
        } else {
            bytes
        };

        {
            let mut file = File::create(&tmp_path)?;
            file.write_all(slice)?;
            file.sync_all()?;
        }

        fs::rename(&tmp_path, &target_path)?;
        Ok(())
    }

    pub fn load(&self, id: &str) -> std::io::Result<Option<String>> {
        let path = self.snapshot_path(id);
        if !path.exists() {
            return Ok(None);
        }
        let mut file = File::open(&path)?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
    }

    pub fn delete(&self, id: &str) -> std::io::Result<()> {
        let path = self.snapshot_path(id);
        if path.exists() {
            let _ = fs::remove_file(path);
        }
        Ok(())
    }

    pub fn cleanup_stale(&self, active_ids: &[String]) -> std::io::Result<()> {
        if !self.dir.exists() {
            return Ok(());
        }
        let active_set: std::collections::HashSet<_> =
            active_ids.iter().map(|id| self.snapshot_path(id)).collect();
        for entry in fs::read_dir(&self.dir)? {
            if let Ok(entry) = entry {
                let path = entry.path();
                if path.is_file() && path.extension().map_or(false, |ext| ext == "bin") {
                    if !active_set.contains(&path) {
                        let _ = fs::remove_file(&path);
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_save_and_load_scrollback_roundtrip() {
        let temp_dir = std::env::temp_dir().join(format!("oppa_snap_test_{}", std::process::id()));
        let storage = SnapshotStorage::new(temp_dir.clone());

        let sample_ansi = "\x1b[32mSuccess\x1b[0m\r\nLine 2";
        storage.save("session-1", sample_ansi).expect("save succeeds");

        let loaded = storage.load("session-1").expect("load succeeds");
        assert_eq!(loaded, Some(sample_ansi.to_string()));

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_delete_scrollback() {
        let temp_dir = std::env::temp_dir().join(format!("oppa_snap_del_{}", std::process::id()));
        let storage = SnapshotStorage::new(temp_dir.clone());

        storage.save("session-2", "content").expect("save succeeds");
        storage.delete("session-2").expect("delete succeeds");

        let loaded = storage.load("session-2").expect("load succeeds");
        assert_eq!(loaded, None);

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_truncate_to_max_bytes_on_utf8_boundary() {
        let temp_dir = std::env::temp_dir().join(format!("oppa_snap_trunc_{}", std::process::id()));
        let storage = SnapshotStorage::new(temp_dir.clone());

        // Create a large multi-byte string > 500KB
        // "🦀" is 4 bytes: [0xF0, 0x9F, 0xA6, 0x80]
        let base = "🦀 Hello World! \n".repeat(40_000); // > 600KB
        storage.save("session-large", &base).expect("save succeeds");

        let loaded = storage.load("session-large").expect("load succeeds").expect("loaded some");
        assert!(loaded.len() <= 500 * 1024);
        assert!(!loaded.is_empty());
        assert!(base.ends_with(&loaded));

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_cleanup_stale() {
        let temp_dir = std::env::temp_dir().join(format!("oppa_snap_clean_{}", std::process::id()));
        let storage = SnapshotStorage::new(temp_dir.clone());

        storage.save("sess-active", "active").expect("save succeeds");
        storage.save("sess-stale", "stale").expect("save succeeds");

        let active_ids = vec!["sess-active".to_string()];
        storage.cleanup_stale(&active_ids).expect("cleanup succeeds");

        assert_eq!(storage.load("sess-active").unwrap(), Some("active".to_string()));
        assert_eq!(storage.load("sess-stale").unwrap(), None);

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
