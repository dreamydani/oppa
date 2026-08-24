// Tauri-facing extension commands. All logic sits in path-taking helpers so it
// stays testable without a Tauri runtime (same split as settings.rs/layout.rs).

use super::discovery::{discover_all_at, DiscoveredExtension};
use super::manifest::{ExtensionManifest, ThemeContribution};
use super::registry::{
    load_state_at, save_state_at, ExtensionRegistry, ExtensionsStateFile, STATE_FILE_NAME,
};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

/// Tauri-managed singleton holding the loaded registry.
pub struct ExtensionsState(pub Mutex<ExtensionRegistry>);

#[derive(Debug, Clone, Serialize)]
pub struct ExtensionListItem {
    /// Empty for errored entries.
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub is_builtin: bool,
    pub enabled: bool,
    pub error: Option<String>,
    pub theme_count: usize,
    pub snippet_count: usize,
    pub command_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ContributedTheme {
    pub extension_id: String,
    /// Globally unique id used in settings: "<extension.id>:<theme.id>".
    pub theme_id: String,
    pub name: String,
    /// "dark" | "light"
    pub theme_type: String,
    /// xterm ITheme color map as authored in the manifest.
    pub colors: std::collections::BTreeMap<String, String>,
    pub preview_colors: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct ContributionPayload {
    pub themes: Vec<ContributedTheme>,
}

fn user_extensions_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("extensions"))
}

fn state_file_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join(STATE_FILE_NAME))
}

/// Discovery + persisted disabled-set -> ready registry.
pub fn init_registry_at(user_dir: &Path, state_path: &Path) -> ExtensionRegistry {
    let entries = discover_all_at(user_dir);
    let disabled_ids = load_state_at(state_path).disabled_ids;
    ExtensionRegistry::from_discovery(entries, disabled_ids)
}

fn list_item(entry: &DiscoveredExtension, registry: &ExtensionRegistry) -> ExtensionListItem {
    match &entry.manifest {
        Some(m) => ExtensionListItem {
            id: m.id.clone(),
            name: m.name.clone(),
            version: m.version.clone(),
            description: m.description.clone(),
            is_builtin: entry.is_builtin,
            enabled: registry.is_enabled(&m.id),
            error: None,
            theme_count: m.contributes.themes.len(),
            snippet_count: m.contributes.snippets.len(),
            command_count: m.contributes.commands.len(),
        },
        None => ExtensionListItem {
            id: String::new(),
            name: entry.source_label.clone(),
            version: String::new(),
            description: String::new(),
            is_builtin: entry.is_builtin,
            enabled: false,
            error: entry.error.clone(),
            theme_count: 0,
            snippet_count: 0,
            command_count: 0,
        },
    }
}

pub fn contribution_payload_from(manifests: &[&ExtensionManifest]) -> ContributionPayload {
    let mut themes = Vec::new();
    for manifest in manifests {
        for theme in &manifest.contributes.themes {
            themes.push(contributed_theme(manifest, theme));
        }
    }
    ContributionPayload { themes }
}

fn contributed_theme(manifest: &ExtensionManifest, theme: &ThemeContribution) -> ContributedTheme {
    ContributedTheme {
        extension_id: manifest.id.clone(),
        theme_id: format!("{}:{}", manifest.id, theme.id),
        name: theme.name.clone(),
        theme_type: theme.theme_type.clone(),
        colors: theme.colors.clone(),
        preview_colors: theme.preview_colors.clone(),
    }
}

#[tauri::command]
pub fn list_extensions(state: State<'_, ExtensionsState>) -> Result<Vec<ExtensionListItem>, String> {
    let registry = state.0.lock().map_err(|e| e.to_string())?;
    Ok(registry.entries().iter().map(|e| list_item(e, &registry)).collect())
}

#[tauri::command]
pub fn set_extension_enabled(
    app: AppHandle,
    state: State<'_, ExtensionsState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    let mut registry = state.0.lock().map_err(|e| e.to_string())?;
    registry.set_enabled(&id, enabled)?;
    if let Some(path) = state_file_path(&app) {
        save_state_at(
            &path,
            &ExtensionsStateFile {
                disabled_ids: registry.disabled_ids(),
            },
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_contributions(state: State<'_, ExtensionsState>) -> Result<ContributionPayload, String> {
    let registry = state.0.lock().map_err(|e| e.to_string())?;
    Ok(contribution_payload_from(&registry.enabled_manifests()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::registry::ExtensionsStateFile as _;
    use crate::extensions::registry::{load_state_at, save_state_at};
    use std::fs;
    use std::path::PathBuf;

    const PACK_JSON: &str = r##"{
        "id": "acme.themes",
        "name": "Acme Themes",
        "version": "1.0.0",
        "description": "Test themes.",
        "contributes": {
            "themes": [{
                "id": "midnight",
                "name": "Midnight",
                "type": "dark",
                "colors": { "background": "#0a0e14", "foreground": "#d5d8df" },
                "preview_colors": ["#0a0e14", "#d5d8df", "#58a6ff", "#4ade80"]
            }]
        }
    }"##;

    fn ok_entry(json: &str) -> DiscoveredExtension {
        use crate::extensions::manifest::{parse_manifest, validate_manifest};
        let m = parse_manifest(json).unwrap();
        validate_manifest(&m).unwrap();
        DiscoveredExtension {
            is_builtin: true,
            source_label: m.name.clone(),
            manifest: Some(m),
            error: None,
        }
    }

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "oppa-ext-commands-{name}-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ))
    }

    #[test]
    fn contributions_only_come_from_enabled_extensions() {
        let mut registry =
            ExtensionRegistry::from_discovery(vec![ok_entry(PACK_JSON)], vec![]);
        let all = contribution_payload_from(&registry.enabled_manifests());
        assert_eq!(all.themes.len(), 1);
        assert_eq!(all.themes[0].theme_id, "acme.themes:midnight");
        assert_eq!(all.themes[0].colors["background"], "#0a0e14");

        registry.set_enabled("acme.themes", false).unwrap();
        assert!(contribution_payload_from(&registry.enabled_manifests())
            .themes
            .is_empty());
    }

    #[test]
    fn list_items_reflect_registry_state() {
        let mut broken = ok_entry(PACK_JSON);
        broken.manifest = None;
        broken.error = Some("bad manifest".into());
        broken.source_label = "broken-dir".into();

        let registry = ExtensionRegistry::from_discovery(
            vec![ok_entry(PACK_JSON), broken],
            vec![],
        );
        let items: Vec<ExtensionListItem> = registry
            .entries()
            .iter()
            .map(|e| list_item(e, &registry))
            .collect();

        assert_eq!(items[0].id, "acme.themes");
        assert!(items[0].enabled);
        assert_eq!(items[0].theme_count, 1);
        assert_eq!(items[1].name, "broken-dir");
        assert!(!items[1].enabled);
        assert_eq!(items[1].error.as_deref(), Some("bad manifest"));
    }

    #[test]
    fn toggle_persists_disabled_set_for_next_launch() {
        let state_path = temp_path("persist");
        let mut registry =
            ExtensionRegistry::from_discovery(vec![ok_entry(PACK_JSON)], vec![]);
        registry.set_enabled("acme.themes", false).unwrap();
        save_state_at(
            &state_path,
            &ExtensionsStateFile {
                disabled_ids: registry.disabled_ids(),
            },
        )
        .unwrap();

        // Next launch: discovery again + persisted state.
        let relaunched = ExtensionRegistry::from_discovery(
            vec![ok_entry(PACK_JSON)],
            load_state_at(&state_path).disabled_ids,
        );
        assert!(!relaunched.is_enabled("acme.themes"));
        fs::remove_file(&state_path).ok();
    }
}
