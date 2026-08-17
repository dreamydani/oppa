use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecentWorkspace {
    pub name: String,
    pub path: String,
    pub terminal_count: usize,
    pub last_opened: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspacePreset {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub terminal_count: usize,
    #[serde(default)]
    pub shell: Option<String>,
    #[serde(default)]
    pub commands: Vec<String>,
    #[serde(default)]
    pub agent_persona: Option<String>,
}

pub fn default_presets() -> Vec<WorkspacePreset> {
    vec![
        WorkspacePreset {
            id: "dev-stack".to_string(),
            name: "Dev Stack".to_string(),
            description: Some("Frontend, backend, and git status panes".to_string()),
            terminal_count: 3,
            shell: None,
            commands: vec![
                "pnpm dev".to_string(),
                "cargo check".to_string(),
                "git status".to_string(),
            ],
            agent_persona: Some("Fullstack Developer".to_string()),
        },
        WorkspacePreset {
            id: "full-grid".to_string(),
            name: "Full Grid".to_string(),
            description: Some("4-pane balanced quadrant grid".to_string()),
            terminal_count: 4,
            shell: None,
            commands: vec![],
            agent_persona: None,
        },
        WorkspacePreset {
            id: "obs".to_string(),
            name: "OBS".to_string(),
            description: Some("Dual pane streaming & monitor setup".to_string()),
            terminal_count: 2,
            shell: None,
            commands: vec![],
            agent_persona: None,
        },
        WorkspacePreset {
            id: "grok".to_string(),
            name: "Grok".to_string(),
            description: Some("Agent-focused research terminal pair".to_string()),
            terminal_count: 2,
            shell: None,
            commands: vec![],
            agent_persona: Some("Grok".to_string()),
        },
    ]
}

pub fn save_recents_at(path: &Path, recents: &[RecentWorkspace]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(recents)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(path, json)
}

pub fn load_recents_at(path: &Path) -> std::io::Result<Vec<RecentWorkspace>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(path)?;
    serde_json::from_str(&content)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

pub fn save_presets_at(path: &Path, presets: &[WorkspacePreset]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(presets)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(path, json)
}

pub fn load_presets_at(path: &Path) -> std::io::Result<Vec<WorkspacePreset>> {
    if !path.exists() {
        return Ok(default_presets());
    }
    let content = std::fs::read_to_string(path)?;
    serde_json::from_str(&content)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

fn recents_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("recents.json"))
        .map_err(|e| e.to_string())
}

fn presets_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|d| d.join("presets.json"))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_recents(app: AppHandle, recents: Vec<RecentWorkspace>) -> Result<(), String> {
    let path = recents_path(&app)?;
    save_recents_at(&path, &recents).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_recents(app: AppHandle) -> Result<Vec<RecentWorkspace>, String> {
    let path = recents_path(&app)?;
    load_recents_at(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_presets(app: AppHandle, presets: Vec<WorkspacePreset>) -> Result<(), String> {
    let path = presets_path(&app)?;
    save_presets_at(&path, &presets).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_presets(app: AppHandle) -> Result<Vec<WorkspacePreset>, String> {
    let path = presets_path(&app)?;
    load_presets_at(&path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("oppa-presets-{name}-{}", std::process::id()))
    }

    #[test]
    fn test_recents_round_trip() {
        let dir = temp_dir("recents-roundtrip");
        let path = dir.join("recents.json");
        let recents = vec![
            RecentWorkspace {
                name: "project-a".to_string(),
                path: "D:/projects/project-a".to_string(),
                terminal_count: 2,
                last_opened: 1720000000,
            },
            RecentWorkspace {
                name: "project-b".to_string(),
                path: "D:/projects/project-b".to_string(),
                terminal_count: 4,
                last_opened: 1720000500,
            },
        ];

        save_recents_at(&path, &recents).unwrap();
        let loaded = load_recents_at(&path).unwrap();
        assert_eq!(loaded, recents);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_load_recents_empty_when_missing() {
        let path = temp_dir("recents-missing").join("recents.json");
        let loaded = load_recents_at(&path).unwrap();
        assert!(loaded.is_empty());
    }

    #[test]
    fn test_presets_round_trip() {
        let dir = temp_dir("presets-roundtrip");
        let path = dir.join("presets.json");
        let presets = vec![WorkspacePreset {
            id: "custom-test".to_string(),
            name: "Custom Test".to_string(),
            description: Some("Custom description".to_string()),
            terminal_count: 3,
            shell: Some("pwsh.exe".to_string()),
            commands: vec!["echo 1".to_string(), "echo 2".to_string()],
            agent_persona: Some("Code Reviewer".to_string()),
        }];

        save_presets_at(&path, &presets).unwrap();
        let loaded = load_presets_at(&path).unwrap();
        assert_eq!(loaded, presets);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_load_presets_returns_default_when_missing() {
        let path = temp_dir("presets-missing").join("presets.json");
        let loaded = load_presets_at(&path).unwrap();
        assert_eq!(loaded, default_presets());
        assert!(!loaded.is_empty());
    }

    #[test]
    fn test_save_creates_parent_directories() {
        let dir = temp_dir("nested-dirs").join("deep").join("nested");
        let path = dir.join("recents.json");
        let recents = vec![RecentWorkspace {
            name: "nested".to_string(),
            path: "/path/nested".to_string(),
            terminal_count: 1,
            last_opened: 100,
        }];

        save_recents_at(&path, &recents).unwrap();
        assert!(path.exists());
        let loaded = load_recents_at(&path).unwrap();
        assert_eq!(loaded, recents);

        std::fs::remove_dir_all(temp_dir("nested-dirs")).ok();
    }
}
