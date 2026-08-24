// Extension manifest parsing + validation. Pure std/serde — no Tauri — so every
// rule is unit-testable. All validation failures are loud (see spec: unknown
// capability, bad id grammar, off-set color keys never pass silently).

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

pub const MANIFEST_FILE_NAME: &str = "oppa-extension.json";

/// Closed set of host capabilities an extension may declare (Phase 2 set).
/// Declarative extensions need none; anything outside this list fails loudly.
pub const KNOWN_CAPABILITIES: &[&str] =
    &["notifications", "storage", "terminal:write", "events"];

/// Hard limits keep a broken manifest from ballooning the registry.
pub const MAX_CONTRIBUTIONS_PER_KIND: usize = 64;

/// xterm ITheme color keys a theme contribution may set. Mirrors the palette
/// used by the built-in themes in `src/lib/theme/terminalThemes.ts`.
const ALLOWED_COLOR_KEYS: &[&str] = &[
    "background",
    "foreground",
    "cursor",
    "cursorAccent",
    "selectionBackground",
    "selectionForeground",
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "brightBlack",
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightMagenta",
    "brightCyan",
    "brightWhite",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestError(pub String);

impl fmt::Display for ManifestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Engines {
    pub oppa: String,
}

impl Default for Engines {
    fn default() -> Self {
        Self {
            oppa: ">=0.1.0".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThemeContribution {
    pub id: String,
    pub name: String,
    /// "dark" | "light"
    #[serde(rename = "type")]
    pub theme_type: String,
    pub colors: BTreeMap<String, String>,
    pub preview_colors: Vec<String>,
}

/// Snippets/commands are schema-parsed for forward compatibility; their
/// consuming surfaces arrive with the command-palette rung.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct Contributions {
    #[serde(default)]
    pub themes: Vec<ThemeContribution>,
    #[serde(default)]
    pub snippets: Vec<serde_json::Value>,
    #[serde(default)]
    pub commands: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct ExtensionManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub engines: Engines,
    pub capabilities: Vec<String>,
    /// Entry script for scriptable extensions. Presence makes the extension
    /// scriptable; must be a bare file name (no directory traversal).
    pub main: Option<String>,
    pub contributes: Contributions,
}

impl Default for ExtensionManifest {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            version: String::new(),
            description: String::new(),
            engines: Engines::default(),
            capabilities: Vec::new(),
            main: None,
            contributes: Contributions::default(),
        }
    }
}

/// True when this manifest ships executable code (Phase 2 scriptable extension).
pub fn is_scriptable(m: &ExtensionManifest) -> bool {
    m.main.is_some()
}

/// Parse JSON into a manifest without semantic validation (discovery uses this
/// split so malformed-but-parseable manifests can be reported individually).
pub fn parse_manifest(json: &str) -> Result<ExtensionManifest, ManifestError> {
    serde_json::from_str(json).map_err(|e| ManifestError(format!("manifest is not valid JSON: {e}")))
}

/// Full semantic validation per spec. Call after `parse_manifest`.
pub fn validate_manifest(m: &ExtensionManifest) -> Result<(), ManifestError> {
    validate_id(&m.id)?;
    validate_version(&m.version)?;
    validate_capabilities(&m.capabilities)?;
    validate_main(&m.main)?;
    validate_contribution_limits(m)?;
    validate_themes(m)
}

fn is_valid_id_part(part: &str) -> bool {
    !part.is_empty()
        && part.len() <= 64
        && part.chars().next().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && part.chars().last().is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && part
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn validate_id(id: &str) -> Result<(), ManifestError> {
    let parts: Vec<&str> = id.split('.').collect();
    let valid = parts.len() == 2 && parts.iter().all(|p| is_valid_id_part(p));
    if valid {
        Ok(())
    } else {
        Err(ManifestError(format!(
            "invalid extension id '{id}': expected 'publisher.name' with lowercase letters, digits, and dashes"
        )))
    }
}

fn validate_version(version: &str) -> Result<(), ManifestError> {
    let parts: Vec<&str> = version.split('.').collect();
    let valid = parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()));
    if valid {
        Ok(())
    } else {
        Err(ManifestError(format!(
            "invalid version '{version}': expected semver X.Y.Z"
        )))
    }
}

fn validate_capabilities(capabilities: &[String]) -> Result<(), ManifestError> {
    for cap in capabilities {
        if !KNOWN_CAPABILITIES.contains(&cap.as_str()) {
            return Err(ManifestError(format!(
                "unknown capability '{cap}': allowed capabilities are {KNOWN_CAPABILITIES:?}"
            )));
        }
    }
    Ok(())
}

/// `main` must be a bare file name — no separators, no traversal, sane charset.
fn validate_main(main: &Option<String>) -> Result<(), ManifestError> {
    let Some(name) = main else {
        return Ok(());
    };
    let valid = !name.is_empty()
        && name.len() <= 128
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if valid {
        Ok(())
    } else {
        Err(ManifestError(format!(
            "invalid main '{name}': expected a bare file name (e.g. \"main.js\")"
        )))
    }
}

fn validate_contribution_limits(m: &ExtensionManifest) -> Result<(), ManifestError> {
    let counts = [
        ("themes", m.contributes.themes.len()),
        ("snippets", m.contributes.snippets.len()),
        ("commands", m.contributes.commands.len()),
    ];
    for (kind, count) in counts {
        if count > MAX_CONTRIBUTIONS_PER_KIND {
            return Err(ManifestError(format!(
                "{kind} contributions exceed the limit of {MAX_CONTRIBUTIONS_PER_KIND}"
            )));
        }
    }
    Ok(())
}

fn is_valid_color(value: &str) -> bool {
    let hex = value.strip_prefix('#').unwrap_or("");
    (hex.len() == 6 || hex.len() == 8) && hex.chars().all(|c| c.is_ascii_hexdigit())
}

fn validate_theme(theme: &ThemeContribution, seen_ids: &mut BTreeSet<String>) -> Result<(), ManifestError> {
    if theme.id.is_empty() || theme.id.len() > 64 {
        return Err(ManifestError("theme id must be 1-64 characters".into()));
    }
    if !seen_ids.insert(theme.id.clone()) {
        return Err(ManifestError(format!("duplicate theme id '{}'", theme.id)));
    }
    if theme.name.trim().is_empty() {
        return Err(ManifestError(format!("theme '{}' has an empty name", theme.id)));
    }
    if theme.theme_type != "dark" && theme.theme_type != "light" {
        return Err(ManifestError(format!(
            "theme '{}' type must be \"dark\" or \"light\"",
            theme.id
        )));
    }
    for key in ["background", "foreground"] {
        if !theme.colors.contains_key(key) {
            return Err(ManifestError(format!(
                "theme '{}' is missing required color '{key}'",
                theme.id
            )));
        }
    }
    for (key, value) in &theme.colors {
        if !ALLOWED_COLOR_KEYS.contains(&key.as_str()) {
            return Err(ManifestError(format!(
                "theme '{}' sets unknown color key '{key}'",
                theme.id
            )));
        }
        if !is_valid_color(value) {
            return Err(ManifestError(format!(
                "theme '{}' color '{key}' is not a #rrggbb or #rrggbbaa value",
                theme.id
            )));
        }
    }
    if theme.preview_colors.len() != 4 || theme.preview_colors.iter().any(|c| !is_valid_color(c)) {
        return Err(ManifestError(format!(
            "theme '{}' previewColors must be exactly 4 #rrggbb values",
            theme.id
        )));
    }
    Ok(())
}

fn validate_themes(m: &ExtensionManifest) -> Result<(), ManifestError> {
    let mut seen = BTreeSet::new();
    for theme in &m.contributes.themes {
        validate_theme(theme, &mut seen)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_manifest() -> ExtensionManifest {
        ExtensionManifest {
            id: "oppa.theme-pack".into(),
            name: "Oppa Theme Pack".into(),
            version: "1.0.0".into(),
            description: "Extra terminal themes.".into(),
            engines: Engines::default(),
            capabilities: vec![],
            main: None,
            contributes: Contributions::default(),
        }
    }

    fn dark_theme(id: &str) -> ThemeContribution {
        let mut colors = BTreeMap::new();
        colors.insert("background".to_string(), "#0a0e14".to_string());
        colors.insert("foreground".to_string(), "#d5d8df".to_string());
        ThemeContribution {
            id: id.into(),
            name: "Midnight".into(),
            theme_type: "dark".into(),
            colors,
            preview_colors: vec![
                "#0a0e14".into(),
                "#d5d8df".into(),
                "#58a6ff".into(),
                "#4ade80".into(),
            ],
        }
    }

    #[test]
    fn valid_minimal_manifest_validates() {
        assert_eq!(validate_manifest(&base_manifest()), Ok(()));
    }

    #[test]
    fn manifest_round_trips_through_json() {
        let mut m = base_manifest();
        m.contributes.themes.push(dark_theme("midnight"));
        let json = serde_json::to_string(&m).unwrap();
        let parsed = parse_manifest(&json).unwrap();
        assert_eq!(parsed, m);
    }

    #[test]
    fn parse_failure_reports_json_error() {
        assert!(parse_manifest("{ not json").is_err());
    }

    #[test]
    fn rejects_bad_ids() {
        for bad in ["Oppa.Pack", "oppa", "oppa.a.b", "-oppa.pack", "oppa-.pack", "", "oppa.pack!"] {
            let mut m = base_manifest();
            m.id = bad.into();
            assert!(validate_manifest(&m).is_err(), "expected '{bad}' to be rejected");
        }
    }

    #[test]
    fn accepts_single_part_publishers_with_dashes_and_digits() {
        let mut m = base_manifest();
        m.id = "my-pub2.my-theme-9".into();
        assert_eq!(validate_manifest(&m), Ok(()));
    }

    #[test]
    fn rejects_bad_versions() {
        for bad in ["1", "1.0", "v1.0.0", "1.0.0-beta", "a.b.c", ""] {
            let mut m = base_manifest();
            m.version = bad.into();
            assert!(validate_manifest(&m).is_err(), "expected '{bad}' to be rejected");
        }
    }

    #[test]
    fn known_capabilities_pass_unknown_fail() {
        let mut m = base_manifest();
        m.capabilities = vec!["notifications".into(), "terminal:write".into()];
        assert_eq!(validate_manifest(&m), Ok(()));

        m.capabilities = vec!["network:fetch".into()];
        let err = validate_manifest(&m).unwrap_err();
        assert!(err.0.contains("unknown capability"));
    }

    #[test]
    fn capability_check_consults_closed_set_not_prefixes() {
        // Guards against a startswith/prefix implementation sneaking in.
        let mut m = base_manifest();
        m.capabilities = vec!["notifications:extra".into()];
        assert!(validate_manifest(&m).is_err());
    }

    #[test]
    fn rejects_theme_with_unknown_color_key() {
        let mut m = base_manifest();
        let mut theme = dark_theme("midnight");
        theme.colors.insert("notAColorKey".into(), "#ffffff".into());
        m.contributes.themes.push(theme);
        let err = validate_manifest(&m).unwrap_err();
        assert!(err.0.contains("unknown color key"));
    }

    #[test]
    fn rejects_invalid_color_values() {
        let mut m = base_manifest();
        let mut theme = dark_theme("midnight");
        theme.colors.insert("background".into(), "white".into());
        m.contributes.themes.push(theme);
        let err = validate_manifest(&m).unwrap_err();
        assert!(err.0.contains("#rrggbb"));
    }

    #[test]
    fn requires_background_and_foreground() {
        for missing in ["background", "foreground"] {
            let mut m = base_manifest();
            let mut theme = dark_theme("midnight");
            theme.colors.remove(missing);
            m.contributes.themes.push(theme);
            let err = validate_manifest(&m).unwrap_err();
            assert!(err.0.contains("missing required color"), "missing {missing}");
        }
    }

    #[test]
    fn rejects_preview_colors_not_exactly_four() {
        let mut m = base_manifest();
        let mut theme = dark_theme("midnight");
        theme.preview_colors = vec!["#000000".into()];
        m.contributes.themes.push(theme);
        let err = validate_manifest(&m).unwrap_err();
        assert!(err.0.contains("exactly 4"));
    }

    #[test]
    fn rejects_duplicate_theme_ids_within_extension() {
        let mut m = base_manifest();
        m.contributes.themes.push(dark_theme("midnight"));
        m.contributes.themes.push(dark_theme("midnight"));
        let err = validate_manifest(&m).unwrap_err();
        assert!(err.0.contains("duplicate theme id"));
    }

    #[test]
    fn rejects_invalid_theme_type() {
        let mut m = base_manifest();
        let mut theme = dark_theme("midnight");
        theme.theme_type = "sepia".into();
        m.contributes.themes.push(theme);
        assert!(validate_manifest(&m).is_err());
    }

    #[test]
    fn enforces_contribution_limit() {
        let mut m = base_manifest();
        for i in 0..=MAX_CONTRIBUTIONS_PER_KIND {
            m.contributes.themes.push(dark_theme(&format!("theme-{i}")));
        }
        let err = validate_manifest(&m).unwrap_err();
        assert!(err.0.contains("exceed the limit"));
    }

    #[test]
    fn forward_compatible_snippets_and_commands_parse() {
        let json = r#"{
            "id": "oppa.snippets",
            "name": "Snippets",
            "version": "1.0.0",
            "engines": { "oppa": ">=0.1.0" },
            "contributes": {
                "snippets": [{ "label": "git status" }],
                "commands": [{ "title": "Build" }]
            }
        }"#;
        let m = parse_manifest(json).unwrap();
        assert_eq!(m.contributes.snippets.len(), 1);
        assert_eq!(m.contributes.commands.len(), 1);
        assert_eq!(validate_manifest(&m), Ok(()));
    }

    #[test]
    fn missing_optional_fields_default() {
        let json = r#"{
            "id": "oppa.minimal",
            "name": "Minimal",
            "version": "0.1.0"
        }"#;
        let m = parse_manifest(json).unwrap();
        assert_eq!(m.engines, Engines::default());
        assert!(m.capabilities.is_empty());
        assert_eq!(validate_manifest(&m), Ok(()));
    }

    #[test]
    fn scriptable_manifest_with_main_parses_and_flags() {
        let json = r##"{
            "id": "acme.notifier",
            "name": "Notifier",
            "version": "1.0.0",
            "main": "main.js",
            "capabilities": ["notifications", "events"]
        }"##;
        let m = parse_manifest(json).unwrap();
        assert!(is_scriptable(&m));
        assert_eq!(validate_manifest(&m), Ok(()));

        // Declarative manifests stay non-scriptable.
        assert!(!is_scriptable(&base_manifest()));
    }

    #[test]
    fn rejects_path_traversal_in_main() {
        for bad in ["../evil.js", "sub/dir/main.js", "back\\slash.js", "", ".."] {
            let mut m = base_manifest();
            m.main = Some(bad.into());
            assert!(
                validate_manifest(&m).is_err(),
                "expected main '{bad}' to be rejected"
            );
        }
        // Plain names pass.
        for good in ["main.js", "entry-2.js", "index.mjs"] {
            let mut m = base_manifest();
            m.main = Some(good.into());
            assert_eq!(validate_manifest(&m), Ok(()), "'{good}' should be valid");
        }
    }
}
