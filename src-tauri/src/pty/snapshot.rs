use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

const SNAPSHOT_DIR: &str = "terminal-scrollback";
const MAX_SNAPSHOT_BYTES: usize = 500 * 1024; // 500KB cap
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionSnapshot {
    pub session_id: String,
    pub cwd: String,
    pub title: Option<String>,
    pub cols: u16,
    pub rows: u16,
    pub persona_id: Option<String>,
    pub scrollback: String,
    pub timestamp: u64,
    #[serde(default)]
    pub foreground_command: Option<String>,
    #[serde(default)]
    pub agent_session: Option<AgentSessionRef>,
    // Worktree identity survives restarts so cold restore rebinds the pane
    #[serde(default)]
    pub worktree_id: Option<String>,
    // Last hook-classified agent state; lets a rebooted machine show truthful pills instantly
    #[serde(default)]
    pub agent_status: Option<crate::agents::status::AgentStatusEntry>,
}

/// Identity of an agent CLI session (e.g. Claude Code transcript id) captured
/// while it ran, so a cold-booted machine can relaunch it with its native resume.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentSessionRef {
    pub agent: String,
    pub id: String,
    pub transcript_path: Option<String>,
}

const APP_IDENTIFIER: &str = "com.pc.oppa";

/// Resolve app data dir without a Tauri context (the headless daemon process).
/// Mirrors tauri's `app_data_dir`: platform data dir + identifier.
pub fn resolve_app_data_dir() -> Option<PathBuf> {
    resolve_app_data_dir_for(crate::channel::Channel::current())
}

/// Channel-aware variant used by tests and by callers that already know the
/// channel. Stable keeps the historic `com.pc.oppa`; dev isolates under
/// `com.pc.oppa-dev` so the two builds can never share layout/settings/snapshots.
pub fn resolve_app_data_dir_for(channel: crate::channel::Channel) -> Option<PathBuf> {
    let mut identifier = APP_IDENTIFIER.to_string();
    if let Some(suffix) = channel.data_dir_suffix() {
        identifier.push_str(suffix);
    }
    dirs::data_dir().map(|dir| dir.join(identifier))
}

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

    fn snapshot_json_path(&self, id: &str) -> PathBuf {
        let safe_id = Self::safe_id(id);
        self.dir.join(format!("{safe_id}.json"))
    }

    fn truncate_utf8_trailing(s: &str, max_bytes: usize) -> &str {
        let bytes = s.as_bytes();
        if bytes.len() <= max_bytes {
            return s;
        }
        let start = bytes.len() - max_bytes;
        let mut valid_start = start;
        while valid_start < bytes.len() && (bytes[valid_start] & 0xc0) == 0x80 {
            valid_start += 1;
        }
        std::str::from_utf8(&bytes[valid_start..]).unwrap_or("")
    }

    pub fn save_snapshot(&self, snapshot: &SessionSnapshot) -> std::io::Result<()> {
        fs::create_dir_all(&self.dir)?;

        let target_path = self.snapshot_json_path(&snapshot.session_id);
        let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let tmp_path = self.dir.join(format!(
            "{}.tmp.{}.{}",
            Self::safe_id(&snapshot.session_id),
            std::process::id(),
            seq
        ));

        // UTF-8 boundary slice for trailing cap
        let truncated_scrollback =
            Self::truncate_utf8_trailing(&snapshot.scrollback, MAX_SNAPSHOT_BYTES);
        let snap_to_save;
        let snap_ref = if truncated_scrollback.len() < snapshot.scrollback.len() {
            snap_to_save = SessionSnapshot {
                scrollback: truncated_scrollback.to_string(),
                ..snapshot.clone()
            };
            &snap_to_save
        } else {
            snapshot
        };

        let json_data = serde_json::to_string(snap_ref)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

        {
            let mut file = File::create(&tmp_path)?;
            file.write_all(json_data.as_bytes())?;
        }

        fs::rename(&tmp_path, &target_path)?;
        Ok(())
    }

    pub fn load_snapshot(&self, id: &str) -> std::io::Result<Option<SessionSnapshot>> {
        let json_path = self.snapshot_json_path(id);
        if json_path.exists() {
            let mut file = File::open(&json_path)?;
            let mut content = String::new();
            file.read_to_string(&mut content)?;
            let snapshot: SessionSnapshot = serde_json::from_str(&content)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
            return Ok(Some(snapshot));
        }

        // Backward compatibility fallback to .bin file
        let bin_path = self.snapshot_path(id);
        if bin_path.exists() {
            let mut file = File::open(&bin_path)?;
            let mut content = String::new();
            file.read_to_string(&mut content)?;
            if let Ok(snap) = serde_json::from_str::<SessionSnapshot>(&content) {
                return Ok(Some(snap));
            }
            return Ok(Some(SessionSnapshot {
                session_id: id.to_string(),
                cwd: String::new(),
                title: None,
                cols: 80,
                rows: 24,
                persona_id: None,
                scrollback: content,
                timestamp: 0,
                foreground_command: None,
                agent_session: None,
                worktree_id: None,
                agent_status: None,
            }));
        }

        Ok(None)
    }

    pub fn save(&self, id: &str, data: &str) -> std::io::Result<()> {
        if data.is_empty() {
            return Ok(());
        }
        fs::create_dir_all(&self.dir)?;

        let target_path = self.snapshot_path(id);
        let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let tmp_path = self.dir.join(format!("{}.tmp.{}.{}", Self::safe_id(id), std::process::id(), seq));

        let slice = Self::truncate_utf8_trailing(data, MAX_SNAPSHOT_BYTES);

        {
            let mut file = File::create(&tmp_path)?;
            file.write_all(slice.as_bytes())?;
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
        let json_path = self.snapshot_json_path(id);
        if json_path.exists() {
            let _ = fs::remove_file(json_path);
        }
        Ok(())
    }

    pub fn cleanup_stale(&self, active_ids: &[String]) -> std::io::Result<()> {
        if !self.dir.exists() {
            return Ok(());
        }
        let active_bin: std::collections::HashSet<_> =
            active_ids.iter().map(|id| self.snapshot_path(id)).collect();
        let active_json: std::collections::HashSet<_> =
            active_ids.iter().map(|id| self.snapshot_json_path(id)).collect();
        for entry in fs::read_dir(&self.dir)? {
            if let Ok(entry) = entry {
                let path = entry.path();
                if path.is_file() {
                    let ext = path.extension().and_then(|s| s.to_str());
                    if (ext == Some("bin") && !active_bin.contains(&path))
                        || (ext == Some("json") && !active_json.contains(&path))
                    {
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
    fn resolve_app_data_dir_stable_keeps_base_identifier() {
        let dir = resolve_app_data_dir_for(crate::channel::Channel::Stable)
            .expect("data dir resolves on dev machines");
        let name = dir
            .file_name()
            .and_then(|s| s.to_str())
            .expect("data dir has a file name");
        assert_eq!(name, APP_IDENTIFIER);
        assert!(!name.ends_with("-dev"));
    }

    #[test]
    fn resolve_app_data_dir_dev_appends_dev_suffix() {
        let dev = resolve_app_data_dir_for(crate::channel::Channel::Dev)
            .expect("data dir resolves on dev machines");
        let name = dev
            .file_name()
            .and_then(|s| s.to_str())
            .expect("data dir has a file name");
        assert_eq!(name, format!("{APP_IDENTIFIER}-dev"));
    }

    #[test]
    fn resolve_app_data_dir_dev_and_stable_are_distinct() {
        let dev = resolve_app_data_dir_for(crate::channel::Channel::Dev).expect("dev data dir");
        let stable =
            resolve_app_data_dir_for(crate::channel::Channel::Stable).expect("stable data dir");
        assert_ne!(dev, stable);
    }

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

    #[test]
    fn test_save_and_load_session_snapshot_structured() {
        let temp_dir = std::env::temp_dir().join(format!("oppa_snap_struct_{}", std::process::id()));
        let storage = SnapshotStorage::new(temp_dir.clone());

        let snapshot = SessionSnapshot {
            session_id: "term-cold-1".to_string(),
            cwd: "D:\\oppa\\oppa".to_string(),
            title: Some("oppa-main".to_string()),
            cols: 120,
            rows: 30,
            persona_id: Some("architect".to_string()),
            scrollback: "\x1b[32mSuccess\x1b[0m\r\nDone.".to_string(),
            timestamp: 1724050000000,
            foreground_command: None,
            agent_session: None,
            worktree_id: None,
            agent_status: None,
        };

        storage.save_snapshot(&snapshot).expect("save succeeds");
        let loaded = storage
            .load_snapshot("term-cold-1")
            .expect("load succeeds")
            .expect("found");

        assert_eq!(loaded.session_id, "term-cold-1");
        assert_eq!(loaded.cwd, "D:\\oppa\\oppa");
        assert_eq!(loaded.title, Some("oppa-main".to_string()));
        assert_eq!(loaded.cols, 120);
        assert_eq!(loaded.rows, 30);
        assert_eq!(loaded.persona_id, Some("architect".to_string()));
        assert_eq!(loaded.scrollback, "\x1b[32mSuccess\x1b[0m\r\nDone.");
        assert_eq!(loaded.timestamp, 1724050000000);

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_snapshot_roundtrip_with_foreground_and_agent_fields() {
        let temp_dir = std::env::temp_dir().join(format!("oppa_snap_agent_{}", std::process::id()));
        let storage = SnapshotStorage::new(temp_dir.clone());

        let snapshot = SessionSnapshot {
            session_id: "agent-sess-1".to_string(),
            cwd: "C:\\oppa\\oppa".to_string(),
            title: None,
            cols: 100,
            rows: 30,
            persona_id: None,
            scrollback: "claude> ready".to_string(),
            timestamp: 1724050000000,
            foreground_command: Some("claude --resume abc123".to_string()),
            agent_session: Some(AgentSessionRef {
                agent: "claude".to_string(),
                id: "abc123".to_string(),
                transcript_path: Some(
                    "C:\\Users\\danial\\.claude\\projects\\x\\abc123.jsonl".to_string(),
                ),
            }),
            worktree_id: Some("repo::C:/ws/feat-a".to_string()),
            agent_status: None,
        };

        storage.save_snapshot(&snapshot).expect("save succeeds");
        let loaded = storage
            .load_snapshot("agent-sess-1")
            .expect("load succeeds")
            .expect("found");

        assert_eq!(loaded.foreground_command, Some("claude --resume abc123".to_string()));
        assert_eq!(
            loaded.agent_session,
            Some(AgentSessionRef {
                agent: "claude".to_string(),
                id: "abc123".to_string(),
                transcript_path: Some(
                    "C:\\Users\\danial\\.claude\\projects\\x\\abc123.jsonl".to_string()
                ),
            })
        );
        assert_eq!(loaded, snapshot);

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_old_json_without_new_fields_loads_with_defaults() {
        let temp_dir =
            std::env::temp_dir().join(format!("oppa_snap_legacy_{}", std::process::id()));
        let storage = SnapshotStorage::new(temp_dir.clone());
        fs::create_dir_all(temp_dir.join(SNAPSHOT_DIR)).expect("create snapshot dir");

        let legacy_json = r#"{"session_id":"legacy-1","cwd":"/home/user","title":null,"cols":80,"rows":24,"persona_id":null,"scrollback":"old","timestamp":1724050000000}"#;
        fs::write(
            temp_dir.join(SNAPSHOT_DIR).join("legacy-1.json"),
            legacy_json,
        )
        .expect("write legacy json");

        let loaded = storage
            .load_snapshot("legacy-1")
            .expect("load succeeds")
            .expect("found");
        assert_eq!(loaded.scrollback, "old");
        assert_eq!(loaded.foreground_command, None);
        assert_eq!(loaded.agent_session, None);
        assert_eq!(loaded.worktree_id, None);

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_bin_fallback_still_loads_with_defaults() {
        let temp_dir =
            std::env::temp_dir().join(format!("oppa_snap_binfallback_{}", std::process::id()));
        let storage = SnapshotStorage::new(temp_dir.clone());

        storage.save("bin-fallback-sess", "raw legacy scrollback").expect("save succeeds");
        let loaded = storage
            .load_snapshot("bin-fallback-sess")
            .expect("load succeeds")
            .expect("found");
        assert_eq!(loaded.session_id, "bin-fallback-sess");
        assert_eq!(loaded.scrollback, "raw legacy scrollback");
        assert_eq!(loaded.foreground_command, None);
        assert_eq!(loaded.agent_session, None);

        let _ = fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_save_snapshot_truncates_large_scrollback() {
        let temp_dir = std::env::temp_dir().join(format!("oppa_snap_trunc_struct_{}", std::process::id()));
        let storage = SnapshotStorage::new(temp_dir.clone());

        let base = "🦀 Hello World! \n".repeat(40_000); // > 600KB
        let snapshot = SessionSnapshot {
            session_id: "term-large-snap".to_string(),
            cwd: "/home/user".to_string(),
            title: None,
            cols: 80,
            rows: 24,
            persona_id: None,
            scrollback: base.clone(),
            timestamp: 1724050000000,
            foreground_command: None,
            agent_session: None,
            worktree_id: None,
            agent_status: None,
        };

        storage.save_snapshot(&snapshot).expect("save succeeds");
        let loaded = storage
            .load_snapshot("term-large-snap")
            .expect("load succeeds")
            .expect("found");

        assert!(loaded.scrollback.len() <= 500 * 1024);
        assert!(!loaded.scrollback.is_empty());
        assert!(base.ends_with(&loaded.scrollback));

        let _ = fs::remove_dir_all(&temp_dir);
    }
}
