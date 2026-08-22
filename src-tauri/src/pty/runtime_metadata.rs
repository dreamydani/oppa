// Discovery file binding a live daemon to its pid/endpoint/token so clients can find and authenticate it.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const RUNTIME_METADATA_FILE: &str = "oppa-runtime.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeMetadata {
    pub pid: u32,
    pub pipe_path: String,
    pub auth_token: Option<String>,
    pub protocol_version: u32,
    pub started_at_ms: u64,
}

pub fn metadata_path(dir: &Path) -> PathBuf {
    dir.join(RUNTIME_METADATA_FILE)
}

// Two v4 uuids = 32 random bytes; uuid+getrandom are already in the dep tree.
pub fn generate_auth_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

fn unix_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Atomic tmp+rename write so a client never reads a half-written discovery file.
pub fn write_runtime_metadata(
    dir: &Path,
    pipe_path: &str,
    auth_token: &str,
) -> Result<RuntimeMetadata, String> {
    let metadata = RuntimeMetadata {
        pid: std::process::id(),
        pipe_path: pipe_path.to_string(),
        auth_token: Some(auth_token.to_string()),
        protocol_version: crate::pty::ipc_protocol::DAEMON_PROTOCOL_VERSION,
        started_at_ms: unix_now_ms(),
    };
    let path = metadata_path(dir);
    let json = serde_json::to_string(&metadata).map_err(|e| e.to_string())?;
    let mut tmp_name = path.as_os_str().to_os_string();
    tmp_name.push(".tmp");
    let tmp_path = PathBuf::from(tmp_name);
    std::fs::write(&tmp_path, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp_path, &path).map_err(|e| e.to_string())?;
    Ok(metadata)
}

// None on missing/unreadable/corrupt file: callers fall back to the default endpoint.
pub fn read_runtime_metadata(dir: &Path) -> Option<RuntimeMetadata> {
    let text = std::fs::read_to_string(metadata_path(dir)).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn remove_runtime_metadata(dir: &Path) {
    let _ = std::fs::remove_file(metadata_path(dir));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_token_is_64_hex_chars_and_unique_per_call() {
        let a = generate_auth_token();
        let b = generate_auth_token();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn metadata_roundtrips_through_disk_atomically() {
        let dir = std::env::temp_dir().join(format!(
            "oppa-rt-meta-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let written = write_runtime_metadata(&dir, r"\\.\pipe\oppa-daemon-x", "tok123").unwrap();
        assert_eq!(written.pipe_path, r"\\.\pipe\oppa-daemon-x");
        assert_eq!(written.auth_token.as_deref(), Some("tok123"));
        assert_eq!(written.protocol_version, super::super::ipc_protocol::DAEMON_PROTOCOL_VERSION);
        assert!(!metadata_path(&dir).join(".tmp").exists());

        let read_back = read_runtime_metadata(&dir).expect("metadata readable");
        assert_eq!(written, read_back);

        remove_runtime_metadata(&dir);
        assert!(read_runtime_metadata(&dir).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn stale_metadata_file_is_removed() {
        let dir = std::env::temp_dir().join(format!("oppa-rt-stale-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let _ = write_runtime_metadata(&dir, "/tmp/x", "t");
        assert!(metadata_path(&dir).exists());
        remove_runtime_metadata(&dir);
        assert!(!metadata_path(&dir).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn corrupt_or_missing_file_degrades_to_none() {
        let dir = std::env::temp_dir().join(format!("oppa-rt-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(metadata_path(&dir), "{not json").unwrap();
        assert!(read_runtime_metadata(&dir).is_none());
        assert!(read_runtime_metadata(&dir.join("missing-subdir")).is_none());
        std::fs::remove_dir_all(&dir).ok();
    }
}
