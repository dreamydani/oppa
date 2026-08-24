// Finds extensions: embedded built-ins (compile-time JSON + entry script) and
// user-installed directories under <app_data>/extensions/. Malformed entries
// never abort startup — they surface as errored entries the UI can display.

use super::consent::content_fingerprint;
use super::manifest::{is_scriptable, parse_manifest, validate_manifest, ExtensionManifest, MANIFEST_FILE_NAME};
use std::path::Path;

#[derive(Debug, Clone, PartialEq)]
pub struct DiscoveredExtension {
    pub is_builtin: bool,
    /// Directory name / built-in label so errored entries can still be shown.
    pub source_label: String,
    /// Present iff parse + validation succeeded.
    pub manifest: Option<ExtensionManifest>,
    /// Entry script source for scriptable extensions (manifest.main present).
    pub entry_source: Option<String>,
    /// sha256 over canonical manifest + entry source; consent is bound to it.
    pub fingerprint: String,
    /// Human-readable reason when the extension failed to load.
    pub error: Option<String>,
}

impl DiscoveredExtension {
    fn from_validated(
        is_builtin: bool,
        source_label: String,
        manifest: ExtensionManifest,
        entry_source: Option<String>,
    ) -> Self {
        // Canonical serialization so whitespace-only edits don't re-prompt.
        let canonical = serde_json::to_string(&manifest).unwrap_or_default();
        let fingerprint = content_fingerprint(&canonical, entry_source.as_deref());
        Self {
            is_builtin,
            source_label,
            manifest: Some(manifest),
            entry_source,
            fingerprint,
            error: None,
        }
    }
}

fn errored(is_builtin: bool, source_label: String, message: String) -> DiscoveredExtension {
    DiscoveredExtension {
        is_builtin,
        source_label,
        manifest: None,
        entry_source: None,
        fingerprint: String::new(),
        error: Some(message),
    }
}

/// A built-in extension compiled into the binary.
struct BuiltinSource {
    manifest_json: &'static str,
    entry_js: Option<&'static str>,
}

/// Built-in extensions shipped with oppa. Populated as they land.
const BUILTIN_SOURCES: &[BuiltinSource] = &[
    BuiltinSource {
        manifest_json: include_str!(
            "../../resources/extensions/oppa.theme-pack/oppa-extension.json"
        ),
        entry_js: None,
    },
    BuiltinSource {
        manifest_json: include_str!(
            "../../resources/extensions/oppa.completion-notifier/oppa-extension.json"
        ),
        entry_js: Some(include_str!(
            "../../resources/extensions/oppa.completion-notifier/main.js"
        )),
    },
];

/// Load an entry script for a scriptable manifest. `Ok(None)` for declarative;
/// `Err` when a declared main file cannot be read.
fn load_entry(dir: &Path, manifest: &ExtensionManifest) -> Result<Option<String>, String> {
    let Some(main) = &manifest.main else {
        return Ok(None);
    };
    let path = dir.join(main);
    std::fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| format!("declares main '{}' but it cannot be read ({e})", main))
}

/// Parse embedded built-ins in order. Public for testing with inline JSON pairs.
pub fn discover_builtins_from(sources: &[(String, Option<String>)]) -> Vec<DiscoveredExtension> {
    sources
        .iter()
        .map(|(json, entry)| match parse_manifest(json) {
            Ok(m) => match validate_manifest(&m) {
                Ok(()) => DiscoveredExtension::from_validated(
                    true,
                    m.name.clone(),
                    m,
                    entry.clone(),
                ),
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
            Ok(json) => {
                match parse_manifest(&json).and_then(|m| validate_manifest(&m).map(|_| m)) {
                    Ok(manifest) => match load_entry(&path, &manifest) {
                        Ok(entry_source) => discovered.push(DiscoveredExtension::from_validated(
                            false,
                            source_label,
                            manifest,
                            entry_source,
                        )),
                        Err(e) => discovered.push(errored(
                            false,
                            source_label,
                            format!("{display_path}: {e}"),
                        )),
                    },
                    Err(e) => discovered.push(errored(
                        false,
                        source_label,
                        format!("{display_path}: {e}"),
                    )),
                }
            }
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
    let builtin_pairs: Vec<(String, Option<String>)> = BUILTIN_SOURCES
        .iter()
        .map(|s| (s.manifest_json.to_string(), s.entry_js.map(str::to_string)))
        .collect();
    let mut all = discover_builtins_from(&builtin_pairs);
    all.extend(discover_user_extensions_at(user_dir));
    all
}

/// Convenience predicate mirroring `manifest::is_scriptable`.
pub fn has_entry(discovered: &DiscoveredExtension) -> bool {
    discovered
        .manifest
        .as_ref()
        .map(is_scriptable)
        .unwrap_or(false)
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
        let found = discover_builtins_from(&[(VALID_JSON.to_string(), None)]);
        assert_eq!(found.len(), 1);
        assert!(found[0].is_builtin);
        assert_eq!(found[0].manifest.as_ref().unwrap().id, "acme.cool-pack");
        assert!(!found[0].fingerprint.is_empty());

        let broken = discover_builtins_from(&[("{ bad".to_string(), None)]);
        assert_eq!(broken.len(), 1);
        assert!(broken[0].error.is_some());
    }

    #[test]
    fn scriptable_user_extension_loads_entry_and_fingerprints_it() {
        let dir = temp_dir("scriptable");
        let ext_dir = dir.join("acme.notifier");
        fs::create_dir_all(&ext_dir).unwrap();
        fs::write(
            ext_dir.join(MANIFEST_FILE_NAME),
            r##"{ "id": "acme.notifier", "name": "Notifier", "version": "1.0.0", "main": "main.js", "capabilities": ["events"] }"##,
        )
        .unwrap();
        fs::write(ext_dir.join("main.js"), "oppa.on('session-exit', () => {});").unwrap();

        let found = discover_user_extensions_at(&dir);
        assert_eq!(found.len(), 1);
        let entry = &found[0];
        assert!(entry.error.is_none(), "{:?}", entry.error);
        assert!(has_entry(entry));
        assert!(entry.entry_source.as_deref().unwrap().contains("session-exit"));
        assert!(!entry.fingerprint.is_empty());

        // Changing the code changes the fingerprint (consent must re-prompt).
        let before = entry.fingerprint.clone();
        fs::write(ext_dir.join("main.js"), "/* edited */").unwrap();
        let rediscovered = discover_user_extensions_at(&dir);
        assert_ne!(rediscovered[0].fingerprint, before);
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_entry_file_becomes_errored_entry() {
        let dir = temp_dir("missing-entry");
        let ext_dir = dir.join("acme.broken-code");
        fs::create_dir_all(&ext_dir).unwrap();
        fs::write(
            ext_dir.join(MANIFEST_FILE_NAME),
            r##"{ "id": "acme.broken-code", "name": "B", "version": "1.0.0", "main": "main.js" }"##,
        )
        .unwrap();

        let found = discover_user_extensions_at(&dir);
        assert_eq!(found.len(), 1);
        assert!(found[0].manifest.is_none());
        assert!(found[0].error.as_ref().unwrap().contains("main 'main.js'"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn shipped_builtin_theme_pack_is_valid() {
        // Guards against shipping a broken built-in: the compiled manifest
        // must parse and validate, or the app would boot with a failed entry.
        let builtins = discover_all_at(Path::new("Z:/definitely/not/here"));
        assert!(builtins.iter().all(|b| b.error.is_none()));
        let pack = builtins
            .iter()
            .find(|b| b.manifest.as_ref().is_some_and(|m| m.id == "oppa.theme-pack"))
            .expect("theme pack must ship");
        assert!(pack.is_builtin);
        assert_eq!(pack.manifest.as_ref().unwrap().contributes.themes.len(), 3);
    }

    #[test]
    fn shipped_completion_notifier_is_scriptable_with_entry() {
        let builtins = discover_all_at(Path::new("Z:/definitely/not/here"));
        let notifier = builtins
            .iter()
            .find(|b| b.manifest.as_ref().is_some_and(|m| m.id == "oppa.completion-notifier"))
            .expect("notifier must ship");
        assert!(notifier.error.is_none(), "{:?}", notifier.error);
        assert!(has_entry(notifier));
        let source = notifier.entry_source.as_deref().unwrap();
        assert!(source.contains("session-exit"), "registers the exit handler");
        assert!(source.contains("notify("), "fires notifications");
        assert!(!notifier.fingerprint.is_empty());
    }
}
