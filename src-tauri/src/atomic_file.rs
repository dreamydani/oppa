// Crash-safe persistence writes: content lands via tmp-file + rename so a
// power loss or crash mid-write can never leave a truncated state file.
// Every JSON persistence path in the app goes through this helper.

use std::io;
use std::path::{Path, PathBuf};

pub fn write_atomic(path: &Path, contents: &str) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut tmp_name = path.as_os_str().to_os_string();
    tmp_name.push(".tmp");
    let tmp_path = PathBuf::from(tmp_name);
    std::fs::write(&tmp_path, contents)?;
    // Same-volume rename is atomic: readers see either the old or new file,
    // never a partial one. Overwrites any stale tmp from a crashed save.
    std::fs::rename(&tmp_path, path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("oppa-atomic-{name}-{}", std::process::id()))
    }

    fn tmp_sibling(path: &Path) -> PathBuf {
        let mut name = path.as_os_str().to_os_string();
        name.push(".tmp");
        PathBuf::from(name)
    }

    #[test]
    fn round_trips_contents() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("state.json");

        write_atomic(&path, r#"{"v":1}"#).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), r#"{"v":1}"#);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn leaves_no_tmp_file_behind_on_success() {
        let dir = temp_dir("no-tmp");
        let path = dir.join("state.json");

        write_atomic(&path, "payload").unwrap();
        assert!(
            !tmp_sibling(&path).exists(),
            "tmp file must be gone after a successful save"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn creates_missing_parent_directories() {
        let dir = temp_dir("parents");
        let path = dir.join("nested").join("deeper").join("state.json");

        write_atomic(&path, "x").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "x");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn overwrite_wins_and_stale_tmp_never_blocks_a_save() {
        let dir = temp_dir("overwrite");
        let path = dir.join("state.json");
        write_atomic(&path, "first").unwrap();

        // Simulate a crashed earlier save that left its tmp behind.
        std::fs::write(tmp_sibling(&path), "half-written garbage").unwrap();

        write_atomic(&path, "second").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");
        assert!(!tmp_sibling(&path).exists());

        std::fs::remove_dir_all(&dir).ok();
    }
}
