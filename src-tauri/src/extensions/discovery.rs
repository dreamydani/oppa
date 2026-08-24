// Finds extensions: embedded built-ins (compile-time JSON) + user-installed
// directories under <app_data>/extensions/. Malformed entries never abort
// startup — they surface as errored entries the UI can display.

use super::manifest::{parse_manifest, validate_manifest, ExtensionManifest, MANIFEST_FILE_NAME};
use std::path::Path;

#[derive(Debug, Clone, PartialEq)]
pub struct DiscoveredExtension {
    pub is_builtin: bool,
    /// Directory name / built-in label so errored entries can still be shown.
    pub source_label: String,
    /// Present iff parse + validation succeeded.
    pub manifest: Option<ExtensionManifest>,
    /// Human-readable reason when the extension failed to load.
    pub error: Option<String>,
}

fn errored(is_builtin: bool, source_label: String, message: String) -> DiscoveredExtension {
    DiscoveredExtension {
        is_builtin,
        source_label,
        manifest: None,
        error: Some(message),
    }
}

/// Built-in manifests compiled into the binary. Populated as built-ins ship.
const BUILTIN_MANIFEST_JSONS: &[&str] = &[];

/// Parse embedded built-in manifests in order. Public for testing with inline JSON.
pub fn discover_builtins_from(manifest_jsons: &[&str]) -> Vec<DiscoveredExtension> {
    manifest_jsons
        .iter()
        .map(|json| match parse_manifest(json) {
            Ok(m) => match validate_manifest(&m) {
                Ok(()) => DiscoveredExtension {
                    is_builtin: true,
                    source_label: m.name.clone(),
                    manifest: Some(m),
                    error: None,
                },
                Err(e) => errored(true, "built-in".into(), e.to_string()),
            },
            Err(e) => errored(true, "built-in".into(), e.to_string()),
        })
        .collect()
}

/// Scan `<dir>/<extension-id>/oppa-extension.json` one level deep. Directories
/// without a manifest are skipped silently; unreadable or invalid ones become
/// errored entries. A missing root directory yields an empty list.
pub fn discover_user_extensions_at(dir: &Path) -> Vec<DiscoveredExtension> {
    let mut discovered = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return discovered,
    };
    let mut paths: Vec<_> = entries.flatten().map(|e| e.path()).collect();
    paths.sort();
    for path in paths {
        if !path.is_dir() {
            continue;
        }
        let manifest_path = path.join(MANIFEST_FILE_NAME);
        if !manifest_path.is_file() {
            continue;
        }
        let source_label = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "unknown".into());
        let display_path = manifest_path.display().to_string();
        match std::fs::read_to_string(&manifest_path) {
            Ok(json) => match parse_manifest(&json).and_then(|m| validate_manifest(&m).map(|_| m)) {
                Ok(manifest) => discovered.push(DiscoveredExtension {
                    is_builtin: false,
                    source_label,
                    manifest: Some(manifest),
                    error: None,
                }),
                Err(e) => discovered.push(errored(
                    false,
                    source_label,
                    format!("{display_path}: {e}"),
                )),
            },
            Err(e) => discovered.push(errored(
                false,
                source_label,
                format!("{display_path}: cannot be read ({e})"),
            )),
        }
    }
    discovered
}

/// Full discovery pass: built-ins first (so user installs of the same id lose),
/// then user-directory extensions sorted by directory name.
pub fn discover_all_at(user_dir: &Path) -> Vec<DiscoveredExtension> {
    let mut all = discover_builtins_from(BUILTIN_MANIFEST_JSONS);
    all.extend(discover_user_extensions_at(user_dir));
    all
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "oppa-ext-discovery-{name}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    const VALID_JSON: &str = r#"{
        "id": "acme.cool-pack",
        "name": "Cool Pack",
        "version": "1.2.3",
        "description": "Does cool things."
    }"#;

    #[test]
    fn missing_user_dir_yields_empty_list() {
        assert!(discover_user_extensions_at(Path::new("Z:/definitely/not/here")).is_empty());
    }

    #[test]
    fn valid_extension_is_discovered() {
        let dir = temp_dir("valid");
        let ext_dir = dir.join("acme.cool-pack");
        fs::create_dir_all(&ext_dir).unwrap();
        fs::write(ext_dir.join(MANIFEST_FILE_NAME), VALID_JSON).unwrap();

        let found = discover_user_extensions_at(&dir);
        assert_eq!(found.len(), 1);
        let m = found[0].manifest.as_ref().unwrap();
        assert!(!found[0].is_builtin);
        assert_eq!(m.id, "acme.cool-pack");
        assert_eq!(m.version, "1.2.3");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn malformed_manifest_becomes_errored_entry_with_path() {
        let dir = temp_dir("malformed");
        let ext_dir = dir.join("broken.ext");
        fs::create_dir_all(&ext_dir).unwrap();
        fs::write(ext_dir.join(MANIFEST_FILE_NAME), "{ nope").unwrap();

        let found = discover_user_extensions_at(&dir);
        assert_eq!(found.len(), 1);
        assert!(found[0].manifest.is_none());
        let error = found[0].error.as_ref().unwrap();
        assert!(error.contains("oppa-extension.json"), "mentions path: {error}");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn semantically_invalid_manifest_becomes_errored_entry() {
        let dir = temp_dir("semantic");
        let ext_dir = dir.join("Bad.ID");
        fs::create_dir_all(&ext_dir).unwrap();
        fs::write(
            ext_dir.join(MANIFEST_FILE_NAME),
            r#"{ "id": "good.id", "name": "x", "version": "1.0" }"#,
        )
        .unwrap();

        let found = discover_user_extensions_at(&dir);
        assert_eq!(found.len(), 1);
        assert!(found[0].manifest.is_none());
        assert!(found[0].error.as_ref().unwrap().contains("invalid version"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn directories_without_manifest_and_loose_files_are_skipped() {
        let dir = temp_dir("skip");
        fs::create_dir_all(dir.join("not-an-extension")).unwrap();
        fs::write(dir.join("loose-file.txt"), "hi").unwrap();

        assert!(discover_user_extensions_at(&dir).is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn results_are_sorted_by_directory_name() {
        let dir = temp_dir("sorted");
        for id in ["zzz.pack", "aaa.pack"] {
            let ext_dir = dir.join(id);
            fs::create_dir_all(&ext_dir).unwrap();
            fs::write(
                ext_dir.join(MANIFEST_FILE_NAME),
                format!(r#"{{ "id": "{id}", "name": "{id}", "version": "1.0.0" }}"#),
            )
            .unwrap();
        }

        let ids: Vec<String> = discover_user_extensions_at(&dir)
            .into_iter()
            .map(|d| d.manifest.unwrap().id)
            .collect();
        assert_eq!(ids, vec!["aaa.pack".to_string(), "zzz.pack".to_string()]);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn builtin_jsons_parse_in_order() {
        let found = discover_builtins_from(&[VALID_JSON]);
        assert_eq!(found.len(), 1);
        assert!(found[0].is_builtin);
        assert_eq!(found[0].manifest.as_ref().unwrap().id, "acme.cool-pack");

        let broken = discover_builtins_from(&["{ bad"]);
        assert_eq!(broken.len(), 1);
        assert!(broken[0].error.is_some());
    }
}
