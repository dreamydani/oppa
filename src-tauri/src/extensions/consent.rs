// Consent fingerprints + persisted consent state. A fingerprint hashes the
// canonical manifest plus the raw entry script, so ANY code or capability
// change invalidates a previous grant and forces re-consent (spec: Phase 2).

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

/// Hex fingerprint over canonical manifest JSON + NUL + raw entry source.
/// Canonical (re-serialized) manifest bytes mean whitespace-only edits do not
/// re-prompt; entry bytes are hashed verbatim so any code change does.
pub fn content_fingerprint(canonical_manifest_json: &str, entry_source: Option<&str>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(canonical_manifest_json.as_bytes());
    hasher.update([0u8]);
    if let Some(source) = entry_source {
        hasher.update(source.as_bytes());
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// extensions-state.json v2 shape. Serde defaults keep v1 files loadable.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct ExtensionConsents {
    #[serde(default)]
    pub consents: BTreeMap<String, String>,
    /// Last crash/failure message per extension id, shown in the panel.
    #[serde(default)]
    pub errors: BTreeMap<String, String>,
}

impl ExtensionConsents {
    /// True when the stored grant matches the current fingerprint exactly.
    pub fn is_consented(&self, id: &str, fingerprint: &str) -> bool {
        self.consents.get(id).is_some_and(|granted| granted == fingerprint)
    }

    pub fn grant(&mut self, id: &str, fingerprint: String) {
        self.consents.insert(id.to_string(), fingerprint);
        self.errors.remove(id);
    }

    pub fn revoke(&mut self, id: &str) {
        self.consents.remove(id);
    }

    pub fn record_error(&mut self, id: &str, message: String) {
        self.errors.insert(id.to_string(), message);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_stable_hex_sha256() {
        let fp = content_fingerprint(r#"{"id":"a.b"}"#, Some("oppa.notify('x')"));
        assert_eq!(fp.len(), 64);
        assert!(fp.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(fp, content_fingerprint(r#"{"id":"a.b"}"#, Some("oppa.notify('x')")));
    }

    #[test]
    fn any_entry_change_changes_fingerprint() {
        let base = content_fingerprint(r#"{"id":"a.b"}"#, Some("let x = 1;"));
        let changed = content_fingerprint(r#"{"id":"a.b"}"#, Some("let x = 2;"));
        assert_ne!(base, changed);
    }

    #[test]
    fn capability_change_changes_fingerprint_even_with_same_code() {
        let before = content_fingerprint(
            r#"{"capabilities":["notifications"]}"#,
            Some("oppa.notify('x')"),
        );
        let after = content_fingerprint(
            r#"{"capabilities":["notifications","events"]}"#,
            Some("oppa.notify('x')"),
        );
        assert_ne!(before, after);
    }

    #[test]
    fn whitespace_only_manifest_edits_do_not_re_prompt() {
        // Canonicalization happens upstream (serde round-trip); identical
        // canonical input yields identical fingerprints regardless of layout.
        let compact = r#"{"id":"a.b","version":"1.0.0"}"#;
        let pretty = "{\n  \"id\": \"a.b\",\n  \"version\": \"1.0.0\"\n}";
        let canonical_of_pretty = r#"{"id":"a.b","version":"1.0.0"}"#;
        assert_eq!(
            content_fingerprint(compact, None),
            content_fingerprint(canonical_of_pretty, None)
        );
        assert_ne!(content_fingerprint(pretty, None), content_fingerprint(compact, None));
    }

    #[test]
    fn declarative_extensions_have_stable_fingerprint_without_entry() {
        let fp = content_fingerprint(r#"{"id":"a.b"}"#, None);
        assert_eq!(fp, content_fingerprint(r#"{"id":"a.b"}"#, None));
    }

    #[test]
    fn consents_grant_revoke_error_round_trip() {
        let mut consents = ExtensionConsents::default();
        assert!(!consents.is_consented("a.b", "fp1"));

        consents.grant("a.b", "fp1".into());
        assert!(consents.is_consented("a.b", "fp1"));
        assert!(!consents.is_consented("a.b", "fp2"), "changed content needs new consent");

        consents.record_error("a.b", "boom".into());
        assert_eq!(consents.errors.get("a.b").map(String::as_str), Some("boom"));

        consents.revoke("a.b");
        assert!(!consents.is_consented("a.b", "fp1"));
    }

    #[test]
    fn consents_survive_serde_round_trip_with_v1_compatible_files() {
        let json = r#"{"consents":{"a.b":"fp"},"errors":{"c.d":"bad"}}"#;
        let parsed: ExtensionConsents = serde_json::from_str(json).unwrap();
        assert!(parsed.is_consented("a.b", "fp"));
        assert_eq!(parsed.errors.get("c.d").map(String::as_str), Some("bad"));

        // Empty object (v1-era state file) loads as defaults.
        let empty: ExtensionConsents = serde_json::from_str("{}").unwrap();
        assert!(empty.consents.is_empty());
    }
}
