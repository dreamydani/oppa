// Settings persistence. The Tauri-free core (`save_settings_at`, `load_settings_at`)
// is kept separate from `#[tauri::command(async)]` wrappers so logic is testable without Tauri runtime.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct GeneralSettings {
    pub default_cwd_mode: String,
    pub custom_default_cwd: String,
    pub startup_behavior: String,
    pub tab_switch_mode: String,
    pub confirm_close_tab_with_multiple_panes: bool,
    pub confirm_quit_with_running_processes: bool,
    pub editor_word_wrap: bool,
    pub editor_auto_save_delay: u64,
    pub browser_search_engine: String,
    pub browser_home_page: String,
    pub auto_resume_agents: bool,
    /// Version the user dismissed in the "Update now / Not now" banner;
    /// `None` (or absent in old saves) means never dismissed.
    #[serde(default)]
    pub dismissed_update_version: Option<String>,
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            default_cwd_mode: "home".into(),
            custom_default_cwd: String::new(),
            startup_behavior: "restore_previous".into(),
            tab_switch_mode: "sequential".into(),
            confirm_close_tab_with_multiple_panes: true,
            confirm_quit_with_running_processes: true,
            editor_word_wrap: true,
            editor_auto_save_delay: 1000,
            browser_search_engine: "duckduckgo".into(),
            browser_home_page: "https://duckduckgo.com".into(),
            auto_resume_agents: true,
            dismissed_update_version: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct AppearanceSettings {
    pub app_theme: String,
    pub app_font_family: String,
    pub ui_zoom: f32,
    pub sidebar_on_launch: String,
    pub show_status_bar: bool,
    pub show_titlebar_logo: bool,
    pub theme_name: String,
    pub font_family: String,
    pub font_size: u16,
    pub line_height: f32,
    pub cursor_style: String,
    pub cursor_blink: bool,
    pub dim_inactive_panes: bool,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            app_theme: "dark".into(),
            app_font_family: "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif".into(),
            ui_zoom: 1.0,
            sidebar_on_launch: "remember_last".into(),
            show_status_bar: true,
            show_titlebar_logo: true,
            theme_name: "oppa_dark".into(),
            font_family: "'Geist Mono', 'SF Mono', 'JetBrains Mono', Consolas, monospace".into(),
            font_size: 14,
            line_height: 1.2,
            cursor_style: "block".into(),
            cursor_blink: true,
            dim_inactive_panes: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct AppSettings {
    pub general: GeneralSettings,
    pub appearance: AppearanceSettings,
}

/// Persist settings.json to `path`, creating parent directories as needed.
pub fn save_settings_at(path: &Path, json: &str) -> std::io::Result<()> {
    crate::atomic_file::write_atomic(path, json)
}

/// Read settings.json from `path`; `Ok(None)` when the file does not exist.
pub fn load_settings_at(path: &Path) -> std::io::Result<Option<String>> {
    if path.exists() {
        std::fs::read_to_string(path).map(Some)
    } else {
        Ok(None)
    }
}

fn settings_path(app: &AppHandle) -> PathBuf {
    crate::pty::snapshot::resolve_gui_data_dir(app)
        .expect("app data dir resolves")
        .join("settings.json")
}

#[tauri::command(async)]
pub fn save_settings(app: AppHandle, settings_json: String) -> Result<(), String> {
    save_settings_at(&settings_path(&app), &settings_json).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn load_settings(app: AppHandle) -> Result<Option<String>, String> {
    load_settings_at(&settings_path(&app)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    // Unique temp dir per test process so parallel runs never collide.
    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("oppa-settings-{name}-{}", std::process::id()))
    }

    #[test]
    fn settings_json_round_trips_through_file() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("settings.json");
        let json = r#"{"general":{"default_cwd_mode":"home","custom_default_cwd":"","startup_behavior":"restore_previous","tab_switch_mode":"sequential","confirm_close_tab_with_multiple_panes":true,"confirm_quit_with_running_processes":true,"editor_word_wrap":true,"editor_auto_save_delay":1000,"browser_search_engine":"duckduckgo","browser_home_page":"https://duckduckgo.com"}}"#;

        save_settings_at(&path, json).unwrap();
        assert_eq!(load_settings_at(&path).unwrap().as_deref(), Some(json));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_settings_returns_none_when_file_does_not_exist() {
        let dir = temp_dir("nonexistent");
        let path = dir.join("settings.json");
        assert_eq!(load_settings_at(&path).unwrap(), None);
    }

    #[test]
    fn app_settings_default_serialization() {
        let settings = AppSettings::default();
        assert_eq!(settings.general.default_cwd_mode, "home");
        assert_eq!(settings.general.editor_auto_save_delay, 1000);
        let serialized = serde_json::to_string(&settings).unwrap();
        let deserialized: AppSettings = serde_json::from_str(&serialized).unwrap();
        assert_eq!(deserialized, settings);
    }

    #[test]
    fn appearance_settings_default_and_roundtrip() {
        let settings = AppSettings::default();
        assert_eq!(settings.appearance.app_theme, "dark");
        assert_eq!(settings.appearance.app_font_family, "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif");
        assert_eq!(settings.appearance.ui_zoom, 1.0);
        assert_eq!(settings.appearance.sidebar_on_launch, "remember_last");
        assert!(settings.appearance.show_status_bar);
        assert!(settings.appearance.show_titlebar_logo);
        assert_eq!(settings.appearance.theme_name, "oppa_dark");
        assert_eq!(settings.appearance.font_family, "'Geist Mono', 'SF Mono', 'JetBrains Mono', Consolas, monospace");
        assert_eq!(settings.appearance.font_size, 14);
        assert_eq!(settings.appearance.line_height, 1.2);
        assert_eq!(settings.appearance.cursor_style, "block");
        assert!(settings.appearance.cursor_blink);
        assert!(settings.appearance.dim_inactive_panes);

        let serialized = serde_json::to_string(&settings).unwrap();
        let deserialized: AppSettings = serde_json::from_str(&serialized).unwrap();
        assert_eq!(deserialized, settings);
    }

    #[test]
    fn appearance_settings_backward_compatibility_without_appearance_key() {
        let json_without_appearance = r#"{"general":{"default_cwd_mode":"home","custom_default_cwd":"","startup_behavior":"restore_previous","tab_switch_mode":"sequential","confirm_close_tab_with_multiple_panes":true,"confirm_quit_with_running_processes":true,"editor_word_wrap":true,"editor_auto_save_delay":1000,"browser_search_engine":"duckduckgo","browser_home_page":"https://duckduckgo.com"}}"#;
        let deserialized: AppSettings = serde_json::from_str(json_without_appearance).unwrap();
        assert_eq!(deserialized.appearance, AppearanceSettings::default());
    }

    #[test]
    fn dismissed_update_version_defaults_to_none_and_is_backward_compatible() {
        // New field: defaults to null when absent (old saves keep loading).
        let settings = AppSettings::default();
        assert_eq!(settings.general.dismissed_update_version, None);

        // A legacy save without the field must deserialize to the default.
        let legacy_json = r#"{"general":{"default_cwd_mode":"home","custom_default_cwd":"","startup_behavior":"restore_previous","tab_switch_mode":"sequential","confirm_close_tab_with_multiple_panes":true,"confirm_quit_with_running_processes":true,"editor_word_wrap":true,"editor_auto_save_delay":1000,"browser_search_engine":"duckduckgo","browser_home_page":"https://duckduckgo.com","auto_resume_agents":true}}"#;
        let deserialized: AppSettings = serde_json::from_str(legacy_json).unwrap();
        assert_eq!(deserialized.general.dismissed_update_version, None);

        // A persisted dismissal round-trips.
        let json_with_dismissal = r#"{"general":{"default_cwd_mode":"home","dismissed_update_version":"0.2.0"}}"#;
        let deserialized: AppSettings = serde_json::from_str(json_with_dismissal).unwrap();
        assert_eq!(
            deserialized.general.dismissed_update_version.as_deref(),
            Some("0.2.0")
        );
    }

    #[test]
    fn app_ui_appearance_settings_defaults_and_backward_compatibility() {
        let settings = AppSettings::default();
        assert_eq!(settings.appearance.app_theme, "dark");
        assert_eq!(settings.appearance.app_font_family, "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif");
        assert_eq!(settings.appearance.ui_zoom, 1.0);
        assert_eq!(settings.appearance.sidebar_on_launch, "remember_last");
        assert!(settings.appearance.show_status_bar);
        assert!(settings.appearance.show_titlebar_logo);

        let legacy_json = r#"{"general":{"default_cwd_mode":"home"},"appearance":{"theme_name":"dracula","font_size":16}}"#;
        let deserialized: AppSettings = serde_json::from_str(legacy_json).unwrap();
        assert_eq!(deserialized.appearance.theme_name, "dracula");
        assert_eq!(deserialized.appearance.app_theme, "dark");
        assert_eq!(deserialized.appearance.app_font_family, "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif");
        assert_eq!(deserialized.appearance.ui_zoom, 1.0);
        assert_eq!(deserialized.appearance.sidebar_on_launch, "remember_last");
        assert!(deserialized.appearance.show_status_bar);
        assert!(deserialized.appearance.show_titlebar_logo);
    }
}
