// In-memory extension registry + enable/disable persistence. Deduplicates by
// id (first wins), tracks which ids the user disabled, and persists that set
// to extensions-state.json. Pure logic here; Tauri wrappers live in commands.rs.

use super::discovery::DiscoveredExtension;
use super::manifest::ExtensionManifest;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::Path;

pub const STATE_FILE_NAME: &str = "extensions-state.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct ExtensionsStateFile {
    #[serde(default)]
    pub disabled_ids: Vec<String>,
}

/// Persist the disabled-id set, creating parent directories as needed.
pub fn save_state_at(path: &Path, state: &ExtensionsStateFile) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let json = serde_json::to_string_pretty(state)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(path, json)
}

/// Load the disabled-id set; missing or corrupt files fall back to defaults so
/// a broken state file can never brick extension loading.
pub fn load_state_at(path: &Path) -> ExtensionsStateFile {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

#[derive(Debug, Clone)]
pub struct ExtensionRegistry {
    entries: Vec<DiscoveredExtension>,
    disabled_ids: BTreeSet<String>,
}

impl ExtensionRegistry {
    /// Build from discovery output. First manifest wins per id; later
    /// duplicates are demoted to errored entries so users can see the conflict.
    pub fn from_discovery(entries: Vec<DiscoveredExtension>, disabled_ids: Vec<String>) -> Self {
        let mut resolved: Vec<DiscoveredExtension> = Vec::with_capacity(entries.len());
        let mut seen_ids = BTreeSet::new();
        for mut entry in entries {
            let id = entry.manifest.as_ref().map(|m| m.id.clone());
            if let Some(id) = id {
                // Spec: duplicate installed id = later one rejected with reason.
                if !seen_ids.insert(id.clone()) {
                    entry.manifest = None;
                    entry.error = Some(format!(
                        "duplicate extension id '{id}' — an extension with this id is already loaded"
                    ));
                }
            }
            resolved.push(entry);
        }
        Self {
            entries: resolved,
            disabled_ids: disabled_ids.into_iter().collect(),
        }
    }

    pub fn entries(&self) -> &[DiscoveredExtension] {
        &self.entries
    }

    pub fn is_enabled(&self, id: &str) -> bool {
        !self.disabled_ids.contains(id)
    }

    /// Unknown id (no loaded manifest) is an error; re-disabling a disabled id is a no-op Ok.
    pub fn set_enabled(&mut self, id: &str, enabled: bool) -> Result<(), String> {
        let known = self
            .entries
            .iter()
            .any(|e| e.manifest.as_ref().is_some_and(|m| m.id == id));
        if !known {
            return Err(format!("extension '{id}' is not installed"));
        }
        if enabled {
            self.disabled_ids.remove(id);
        } else {
            self.disabled_ids.insert(id.to_string());
        }
        Ok(())
    }

    /// Manifests of valid, non-disabled extensions in discovery order.
    pub fn enabled_manifests(&self) -> Vec<&ExtensionManifest> {
        self.entries
            .iter()
            .filter_map(|e| e.manifest.as_ref())
            .filter(|m| !self.disabled_ids.contains(&m.id))
            .collect()
    }

    pub fn disabled_ids(&self) -> Vec<String> {
        self.disabled_ids.iter().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::extensions::manifest::{parse_manifest, validate_manifest};
    use std::fs;
    use std::path::PathBuf;

    fn ok_entry(json: &str) -> DiscoveredExtension {
        let m = parse_manifest(json).unwrap();
        validate_manifest(&m).unwrap();
        DiscoveredExtension {
            is_builtin: true,
            source_label: m.name.clone(),
            manifest: Some(m),
            error: None,
        }
    }

    const PACK_A: &str =
        r#"{ "id": "acme.pack-a", "name": "Pack A", "version": "1.0.0" }"#;
    const PACK_B: &str =
        r#"{ "id": "acme.pack-b", "name": "Pack B", "version": "1.0.0" }"#;
    const PACK_A_CLONE: &str =
        r#"{ "id": "acme.pack-a", "name": "Pack A Imposter", "version": "9.9.9" }"#;

    fn temp_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "oppa-ext-registry-{name}-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ))
    }

    #[test]
    fn state_file_round_trips() {
        let path = temp_path("roundtrip");
        let state = ExtensionsStateFile {
            disabled_ids: vec!["a.b".into(), "c.d".into()],
        };
        save_state_at(&path, &state).unwrap();
        assert_eq!(load_state_at(&path), state);
        fs::remove_file(&path).ok();
    }

    #[test]
    fn missing_or_corrupt_state_file_falls_back_to_default() {
        assert_eq!(load_state_at(Path::new("Z:/no/such/file.json")), ExtensionsStateFile::default());

        let path = temp_path("corrupt");
        fs::write(&path, "{ broken").unwrap();
        assert_eq!(load_state_at(&path), ExtensionsStateFile::default());
        fs::remove_file(&path).ok();
    }

    #[test]
    fn first_duplicate_id_wins_and_later_one_is_errored() {
        let registry = ExtensionRegistry::from_discovery(
            vec![ok_entry(PACK_A), ok_entry(PACK_B), ok_entry(PACK_A_CLONE)],
            vec![],
        );
        assert_eq!(registry.entries().len(), 3);
        let last = &registry.entries()[2];
        assert!(last.manifest.is_none());
        assert!(last.error.as_ref().unwrap().contains("duplicate"));
        // The kept one is the ORIGINAL Pack A.
        assert_eq!(
            registry.entries()[0].manifest.as_ref().unwrap().version,
            "1.0.0"
        );
    }

    #[test]
    fn set_enabled_unknown_id_errors() {
        let mut registry = ExtensionRegistry::from_discovery(vec![ok_entry(PACK_A)], vec![]);
        assert!(registry.set_enabled("ghost.ext", false).is_err());
    }

    #[test]
    fn disable_then_enable_toggles() {
        let mut registry = ExtensionRegistry::from_discovery(vec![ok_entry(PACK_A)], vec![]);
        assert!(registry.is_enabled("acme.pack-a"));

        registry.set_enabled("acme.pack-a", false).unwrap();
        assert!(!registry.is_enabled("acme.pack-a"));
        assert!(registry.enabled_manifests().is_empty());

        // Re-disable is a no-op Ok.
        registry.set_enabled("acme.pack-a", false).unwrap();

        registry.set_enabled("acme.pack-a", true).unwrap();
        assert!(registry.is_enabled("acme.pack-a"));
        assert_eq!(registry.enabled_manifests().len(), 1);
    }

    #[test]
    fn persisted_disabled_ids_are_applied_on_construction() {
        let registry = ExtensionRegistry::from_discovery(
            vec![ok_entry(PACK_A), ok_entry(PACK_B)],
            vec!["acme.pack-b".to_string()],
        );
        assert!(registry.is_enabled("acme.pack-a"));
        assert!(!registry.is_enabled("acme.pack-b"));
        let enabled: Vec<&str> = registry
            .enabled_manifests()
            .iter()
            .map(|m| m.id.as_str())
            .collect();
        assert_eq!(enabled, vec!["acme.pack-a"]);
    }

    #[test]
    fn errored_entries_cannot_be_enabled() {
        let broken = DiscoveredExtension {
            is_builtin: false,
            source_label: "broken".into(),
            manifest: None,
            error: Some("bad".into()),
        };
        let mut registry = ExtensionRegistry::from_discovery(vec![broken], vec![]);
        assert!(registry.set_enabled("broken", false).is_err());
        assert!(registry.set_enabled("broken", true).is_err());
    }

    #[test]
    fn state_survives_save_load_set_round_trip() {
        let path = temp_path("apply");
        let mut registry = ExtensionRegistry::from_discovery(vec![ok_entry(PACK_A)], vec![]);
        registry.set_enabled("acme.pack-a", false).unwrap();
        save_state_at(
            &path,
            &ExtensionsStateFile {
                disabled_ids: registry.disabled_ids(),
            },
        )
        .unwrap();

        let restored =
            ExtensionRegistry::from_discovery(vec![ok_entry(PACK_A)], load_state_at(&path).disabled_ids);
        assert!(!restored.is_enabled("acme.pack-a"));
        fs::remove_file(&path).ok();
    }
}
