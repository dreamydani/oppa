// Tauri-facing extension commands. All logic sits in path-taking helpers so it
// stays testable without a Tauri runtime (same split as settings.rs/layout.rs).

use super::consent::ExtensionConsents;
use super::discovery::{discover_all_at, DiscoveredExtension};
use super::manifest::{is_scriptable, ExtensionManifest, ThemeContribution};
use super::registry::{
    load_state_at, save_state_at, ExtensionRegistry, ExtensionsStateFile, STATE_FILE_NAME,
};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
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
    /// Scriptable = ships executable code; enabling requires consent.
    pub is_scriptable: bool,
    pub capabilities: Vec<String>,
    /// Enabling now would require the consent dialog (no valid grant stored).
    pub consent_required: bool,
    /// Last crash/failure message recorded by the host supervisor.
    pub crash_error: Option<String>,
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

/// Discovery + persisted disabled-set/consents -> ready registry.
///
/// Boot policy: a scriptable extension whose current fingerprint has no valid
/// consent grant starts DISABLED, even if the persisted flag says enabled.
/// Content changed since the last grant => it must be re-approved first.
pub fn init_registry_at(user_dir: &Path, state_path: &Path) -> ExtensionRegistry {
    let entries = discover_all_at(user_dir);
    let state = load_state_at(state_path);
    let mut registry =
        ExtensionRegistry::from_discovery(entries, state.disabled_ids).with_consents(state.consents);
    let unconsented: Vec<String> = registry
        .entries()
        .iter()
        .filter(|e| {
            e.manifest
                .as_ref()
                .is_some_and(|m| is_scriptable(m) && !registry.is_consented(&m.id, &e.fingerprint))
        })
        .filter_map(|e| e.manifest.as_ref().map(|m| m.id.clone()))
        .collect();
    for id in unconsented {
        let _ = registry.set_enabled(&id, false);
    }
    registry
}

/// Persist the full v2 state (disabled ids + consents + crash notes).
fn persist_state(app: &AppHandle, registry: &ExtensionRegistry) -> Result<(), String> {
    if let Some(path) = state_file_path(app) {
        save_state_at(
            &path,
            &ExtensionsStateFile {
                disabled_ids: registry.disabled_ids(),
                consents: registry.consents().clone(),
            },
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Sentinel prefix the renderer matches on to open the consent dialog.
pub const CONSENT_REQUIRED_PREFIX: &str = "consent required:";

fn list_item(entry: &DiscoveredExtension, registry: &ExtensionRegistry) -> ExtensionListItem {
    match &entry.manifest {
        Some(m) => {
            let scriptable = is_scriptable(m);
            ExtensionListItem {
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
                is_scriptable: scriptable,
                capabilities: m.capabilities.clone(),
                consent_required: scriptable && !registry.is_consented(&m.id, &entry.fingerprint),
                crash_error: if scriptable {
                    registry.error_for(&m.id).cloned()
                } else {
                    None
                },
            }
        }
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
            is_scriptable: false,
            capabilities: vec![],
            consent_required: false,
            crash_error: None,
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
    host: State<'_, Arc<super::service::ExtensionHostService>>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    let mut registry = state.0.lock().map_err(|e| e.to_string())?;
    // Scriptable extensions need a valid consent grant for their CURRENT
    // content before the engine may start.
    if enabled {
        if let Some(entry) = find_entry(&registry, &id) {
            if is_scriptable(entry.manifest.as_ref().unwrap())
                && !registry.is_consented(&id, &entry.fingerprint)
            {
                return Err(format!(
                    "{CONSENT_REQUIRED_PREFIX} extension '{id}' needs your approval to run code"
                ));
            }
        }
    }
    registry.set_enabled(&id, enabled)?;
    sync_engine_state(&host, &registry, &id, enabled);
    persist_state(&app, &registry)?;
    Ok(())
}

fn find_entry<'a>(
    registry: &'a ExtensionRegistry,
    id: &str,
) -> Option<&'a DiscoveredExtension> {
    registry
        .entries()
        .iter()
        .find(|e| e.manifest.as_ref().is_some_and(|m| m.id == id))
}

/// Start or stop an extension's engine to match its registry state. Declarative
/// extensions never have engines; stopping a non-running id is a no-op.
fn sync_engine_state(
    host: &Arc<super::service::ExtensionHostService>,
    registry: &ExtensionRegistry,
    id: &str,
    enabled: bool,
) {
    match (enabled, find_entry(registry, id)) {
        (true, Some(entry)) if entry.entry_source.is_some() => {
            let caps = entry
                .manifest
                .as_ref()
                .map(|m| m.capabilities.clone())
                .unwrap_or_default();
            host.start(id, caps, entry.entry_source.clone().unwrap());
        }
        _ => host.stop(id),
    }
}

/// Validate + apply a consent grant against the registry. Shared by the
/// `grant_extension_consent` command and unit tests.
pub fn apply_consent_grant(
    registry: &mut ExtensionRegistry,
    id: &str,
    fingerprint: &str,
) -> Result<(), String> {
    let entry = registry
        .entries()
        .iter()
        .find(|e| e.manifest.as_ref().is_some_and(|m| m.id == id))
        .ok_or_else(|| format!("extension '{id}' is not installed"))?;
    if entry.fingerprint != fingerprint {
        return Err("stale consent request: extension content changed, review it again".into());
    }
    registry.grant_consent(id, entry.fingerprint.clone());
    registry.set_enabled(id, true)
}

/// Grant consent for a scriptable extension's current fingerprint and enable it
/// atomically. The renderer calls this after the user approves the dialog.
#[tauri::command]
pub fn grant_extension_consent(
    app: AppHandle,
    state: State<'_, ExtensionsState>,
    host: State<'_, Arc<super::service::ExtensionHostService>>,
    id: String,
    fingerprint: String,
) -> Result<(), String> {
    let mut registry = state.0.lock().map_err(|e| e.to_string())?;
    apply_consent_grant(&mut registry, &id, &fingerprint)?;
    sync_engine_state(&host, &registry, &id, true);
    persist_state(&app, &registry)
}

/// The current fingerprint of an installed extension (for consent dialogs).
#[tauri::command]
pub fn get_extension_fingerprint(
    state: State<'_, ExtensionsState>,
    id: String,
) -> Result<String, String> {
    let registry = state.0.lock().map_err(|e| e.to_string())?;
    registry
        .entries()
        .iter()
        .find(|e| e.manifest.as_ref().is_some_and(|m| m.id == id))
        .map(|e| e.fingerprint.clone())
        .ok_or_else(|| format!("extension '{id}' is not installed"))
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
            entry_source: None,
            fingerprint: "test-fp".into(),
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
                consents: registry.consents().clone(),
            },
        )
        .unwrap();

        // Next launch: discovery again + persisted state.
        let relaunched = init_registry_from_parts(vec![ok_entry(PACK_JSON)], &state_path);
        assert!(!relaunched.is_enabled("acme.themes"));
        fs::remove_file(&state_path).ok();
    }

    /// Test-only mirror of `init_registry_at` with injected entries.
    fn init_registry_from_parts(entries: Vec<DiscoveredExtension>, state_path: &Path) -> ExtensionRegistry {
        let state = load_state_at(state_path);
        ExtensionRegistry::from_discovery(entries, state.disabled_ids).with_consents(state.consents)
    }

    const NOTIFIER_JSON: &str = r##"{
        "id": "acme.notifier",
        "name": "Notifier",
        "version": "1.0.0",
        "main": "main.js",
        "capabilities": ["notifications", "events"]
    }"##;

    #[test]
    fn scriptable_items_report_consent_requirements() {
        let registry =
            ExtensionRegistry::from_discovery(vec![ok_entry(NOTIFIER_JSON)], vec![]);
        let item = list_item(&registry.entries()[0].clone(), &registry);
        assert!(item.is_scriptable);
        assert_eq!(item.capabilities, vec!["notifications", "events"]);
        assert!(item.consent_required, "no grant stored yet");

        let mut granted = ExtensionRegistry::from_discovery(vec![ok_entry(NOTIFIER_JSON)], vec![]);
        granted.grant_consent("acme.notifier", "test-fp".into());
        let item2 = list_item(&granted.entries()[0].clone(), &granted);
        assert!(!item2.consent_required);

        // A crash note surfaces only on scriptable items.
        granted.record_error("acme.notifier", "infinite loop".into());
        let item3 = list_item(&granted.entries()[0].clone(), &granted);
        assert_eq!(item3.crash_error.as_deref(), Some("infinite loop"));

        // Declarative extensions never require consent nor show crash notes.
        let declarative = ExtensionRegistry::from_discovery(vec![ok_entry(PACK_JSON)], vec![]);
        let item4 = list_item(&declarative.entries()[0].clone(), &declarative);
        assert!(!item4.is_scriptable);
        assert!(!item4.consent_required);
        assert!(item4.crash_error.is_none());
    }

    #[test]
    fn consent_grant_validates_fingerprint_and_enables() {
        let mut registry =
            ExtensionRegistry::from_discovery(vec![ok_entry(NOTIFIER_JSON)], vec![]);

        // Stale fingerprint (content changed since the dialog rendered): rejected.
        let err = apply_consent_grant(&mut registry, "acme.notifier", "stale-fp").unwrap_err();
        assert!(err.contains("stale consent request"));
        assert!(!registry.is_consented("acme.notifier", "stale-fp"));

        // Unknown extension: rejected.
        assert!(apply_consent_grant(&mut registry, "ghost.ext", "any").is_err());

        // Matching fingerprint: grants consent and enables atomically.
        let fp = registry.entries()[0].fingerprint.clone();
        apply_consent_grant(&mut registry, "acme.notifier", &fp).unwrap();
        assert!(registry.is_enabled("acme.notifier"));
        assert!(registry.is_consented("acme.notifier", &fp));

        // A later enable (no consent needed) clears crash notes.
        registry.record_error("acme.notifier", "crashed".into());
        registry.set_enabled("acme.notifier", false).unwrap();
        registry.set_enabled("acme.notifier", true).unwrap();
        assert!(registry.error_for("acme.notifier").is_none());
    }

    #[test]
    fn unconsented_scriptable_extensions_boot_disabled() {
        use super::super::manifest::MANIFEST_FILE_NAME;

        let root = std::env::temp_dir().join(format!(
            "oppa-ext-bootpolicy-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        let user_dir = root.join("extensions");
        let ext_dir = user_dir.join("acme.notifier");
        fs::create_dir_all(&ext_dir).unwrap();
        fs::write(
            ext_dir.join(MANIFEST_FILE_NAME),
            r##"{ "id": "acme.notifier", "name": "Notifier", "version": "1.0.0", "main": "main.js", "capabilities": ["events"] }"##,
        )
        .unwrap();
        fs::write(ext_dir.join("main.js"), "oppa.on('session-exit', () => {});").unwrap();
        let state_path = root.join("extensions-state.json");

        // First boot: scriptable + no consent => boots disabled.
        let registry = init_registry_at(&user_dir, &state_path);
        assert!(!registry.is_enabled("acme.notifier"));
        let entry = registry
            .entries()
            .iter()
            .find(|e| e.manifest.as_ref().is_some_and(|m| m.id == "acme.notifier"))
            .unwrap();
        let item = list_item(entry, &registry);
        assert!(item.consent_required, "item: {item:?}");

        // Grant consent for the CURRENT fingerprint -> enable succeeds and
        // persists across a re-init (simulating restart).
        let fp = entry.fingerprint.clone();
        let mut granted = init_registry_at(&user_dir, &state_path);
        apply_consent_grant(&mut granted, "acme.notifier", &fp).unwrap();
        save_state_at(
            &state_path,
            &ExtensionsStateFile {
                disabled_ids: granted.disabled_ids(),
                consents: granted.consents().clone(),
            },
        )
        .unwrap();

        let rebooted = init_registry_at(&user_dir, &state_path);
        assert!(rebooted.is_enabled("acme.notifier"));
        let entry2 = rebooted
            .entries()
            .iter()
            .find(|e| e.manifest.as_ref().is_some_and(|m| m.id == "acme.notifier"))
            .unwrap();
        assert!(!list_item(entry2, &rebooted).consent_required);

        fs::remove_dir_all(&root).ok();
    }
}
