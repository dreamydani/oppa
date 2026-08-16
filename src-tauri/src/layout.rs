// Layout + session-state persistence. The Tauri-free core (`save_layout_at`,
// `load_layout_at`) is kept separate from the `#[tauri::command]` wrappers so
// the round-trip logic is testable without dragging Tauri's runtime into the
// test binary (0xc0000139 constraint, see Task 3).

use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// Persist layout.json to `path`, creating parent directories as needed.
pub fn save_layout_at(path: &Path, json: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, json)
}

/// Read layout.json from `path`; `Ok(None)` when the file has never been saved.
pub fn load_layout_at(path: &Path) -> std::io::Result<Option<String>> {
    if path.exists() {
        std::fs::read_to_string(path).map(Some)
    } else {
        Ok(None)
    }
}

fn layout_path(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap().join("layout.json")
}

#[tauri::command]
pub fn save_layout(app: AppHandle, layout_json: String) -> Result<(), String> {
    save_layout_at(&layout_path(&app), &layout_json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_layout(app: AppHandle) -> Result<Option<String>, String> {
    load_layout_at(&layout_path(&app)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    // Unique temp dir per test process so parallel runs never collide.
    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("oppa-layout-{name}-{}", std::process::id()))
    }

    #[test]
    fn layout_json_round_trips_through_the_same_file() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("layout.json");
        let json = r#"{"layout":{"type":"leaf","id":"abc"},"sessions":[]}"#;

        save_layout_at(&path, json).unwrap();
        assert_eq!(load_layout_at(&path).unwrap().as_deref(), Some(json));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_layout_at_returns_none_when_the_file_is_missing() {
        let path = temp_dir("missing").join("layout.json");
        assert!(load_layout_at(&path).unwrap().is_none());
    }
}
