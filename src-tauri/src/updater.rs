//! Update manifest check for the stable channel.
//!
//! The dev build NEVER checks for updates (confirmed user requirement): the
//! updater plugin is registered only for stable, and `check_for_update`
//! short-circuits to `None` on dev before any network I/O. The manifest is
//! Task 3's `oppa-update-manifest.json` uploaded to GitHub Releases:
//! `{ "version": "...", "download": "..." }`.

use crate::channel::Channel;
use serde::{Deserialize, Serialize};

/// Static update-manifest URL, matching what Task 3's `pnpm release` uploads.
pub const MANIFEST_URL: &str =
    "https://github.com/dreamydani/oppa/releases/latest/download/oppa-update-manifest.json";

/// The update manifest published by the release pipeline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdateManifest {
    pub version: String,
    pub download: String,
}

/// Payload returned to the renderer by `check_for_update`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct UpdateInfo {
    pub version: String,
    pub download: String,
    pub available: bool,
}

/// Stable builds check for updates; dev builds never do.
pub fn should_check_for_updates(channel: Channel) -> bool {
    !channel.is_dev()
}

/// True when `current` is strictly older than `manifest`.
///
/// Version strings are split on `.` and compared numerically (major, then
/// minor, then patch). Malformed input (non-numeric segment, wrong segment
/// count, leading junk) is treated as "not newer" — a malformed manifest must
/// never be reported as an available update.
pub fn is_newer_available(current: &str, manifest: &str) -> bool {
    match (parse_version(current), parse_version(manifest)) {
        (Some(current), Some(manifest)) => current < manifest,
        _ => false,
    }
}

/// Parses a version into comparable numeric segments, or `None` if malformed.
fn parse_version(version: &str) -> Option<[u64; 3]> {
    let version = version.trim();
    if version.is_empty() || version.contains(char::is_whitespace) {
        return None;
    }
    let mut parts = version.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some([major, minor, patch])
}

/// Fetches and parses the remote update manifest for the stable channel.
///
/// Returns `None` on any failure (network down, non-2xx, bad JSON) so the app
/// works fine offline and the frontend can swallow the result silently.
async fn fetch_manifest() -> Option<UpdateManifest> {
    // The updater plugin (and tauri itself) build on reqwest with
    // rustls-no-provider; install ring's provider if nothing is set yet, the
    // same way the plugin does before making requests.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }

    let client = reqwest::Client::builder()
        .user_agent(concat!("oppa/", env!("CARGO_PKG_VERSION")))
        .build()
        .ok()?;

    let response = client.get(MANIFEST_URL).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json::<UpdateManifest>().await.ok()
}

/// Checks whether a newer version is published for this app.
///
/// Dev builds return `None` immediately — a dev build NEVER checks for
/// updates. Stable builds fetch Task 3's update manifest and compare it with
/// the compiled-in `CARGO_PKG_VERSION`. Any failure degrades to `None`.
#[tauri::command]
pub async fn check_for_update() -> Option<UpdateInfo> {
    let channel = Channel::current();
    if !should_check_for_updates(channel) {
        return None;
    }

    let manifest = fetch_manifest().await?;
    let current = env!("CARGO_PKG_VERSION");

    Some(UpdateInfo {
        available: is_newer_available(current, &manifest.version),
        version: manifest.version,
        download: manifest.download,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_check_for_updates_is_false_for_dev_and_true_for_stable() {
        assert!(!should_check_for_updates(Channel::Dev));
        assert!(should_check_for_updates(Channel::Stable));
    }

    #[test]
    fn newer_major_is_available() {
        assert!(is_newer_available("0.1.0", "0.2.0"));
        assert!(is_newer_available("0.1.0", "1.0.0"));
        assert!(is_newer_available("1.2.3", "2.0.0"));
    }

    #[test]
    fn older_or_equal_manifest_is_not_available() {
        assert!(!is_newer_available("0.2.0", "0.1.0"));
        assert!(!is_newer_available("2.0.0", "1.9.9"));
        assert!(!is_newer_available("0.1.0", "0.1.0"));
    }

    #[test]
    fn compares_numerically_not_lexically() {
        assert!(is_newer_available("0.9.0", "0.10.0"));
        assert!(!is_newer_available("0.10.0", "0.9.0"));
        assert!(is_newer_available("0.1.0", "0.1.10"));
    }

    #[test]
    fn malformed_versions_are_never_newer() {
        assert!(!is_newer_available("0.1.0", "banana"));
        assert!(!is_newer_available("0.1.0", "1.2"));
        assert!(!is_newer_available("0.1.0", "1.2.3.4"));
        assert!(!is_newer_available("0.1.0", ""));
        assert!(!is_newer_available("0.1.0", "v0.2.0"));
        assert!(!is_newer_available("banana", "0.2.0"));
        assert!(!is_newer_available("", "0.2.0"));
    }

    #[test]
    fn leading_and_trailing_whitespace_is_tolerated() {
        assert!(is_newer_available("0.1.0", " 0.2.0 "));
    }

    #[test]
    fn manifest_serde_round_trips() {
        let manifest = UpdateManifest {
            version: "0.2.0".into(),
            download: "https://github.com/dreamydani/oppa/releases/download/v0.2.0/oppa.exe"
                .into(),
        };
        let json = serde_json::to_string(&manifest).unwrap();
        let parsed: UpdateManifest = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed, manifest);
    }

    #[test]
    fn manifest_parses_the_task_three_shape() {
        let json = r#"{
            "version": "0.2.0",
            "download": "https://github.com/dreamydani/oppa/releases/download/v0.2.0/oppa_0.2.0_x64-setup.exe"
        }"#;
        let parsed: UpdateManifest = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.version, "0.2.0");
        assert!(parsed.download.starts_with("https://github.com/dreamydani/oppa/releases/download/"));
    }

    #[test]
    fn update_info_serializes_with_available_flag() {
        let info = UpdateInfo {
            version: "0.2.0".into(),
            download: "https://example.com/oppa.exe".into(),
            available: true,
        };
        let json = serde_json::to_value(&info).unwrap();
        assert_eq!(json["version"], "0.2.0");
        assert_eq!(json["download"], "https://example.com/oppa.exe");
        assert_eq!(json["available"], true);
    }
}
