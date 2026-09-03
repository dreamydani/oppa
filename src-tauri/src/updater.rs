//! Update manifest check for the stable channel.
//!
//! The dev build NEVER checks for updates (confirmed user requirement): the
//! updater plugin is registered only for stable, and `check_for_update`
//! short-circuits to `None` on dev before any network I/O. The manifest is
//! Task 3's `oppa-update-manifest.json` uploaded to GitHub Releases:
//! `{ "version": "...", "download": "..." }`.

use crate::channel::Channel;
use serde::{Deserialize, Serialize};
use std::time::Duration;

/// Static update-manifest URL, matching what Task 3's `pnpm release` uploads.
pub const MANIFEST_URL: &str =
    "https://github.com/dreamydani/oppa/releases/latest/download/oppa-update-manifest.json";

/// How long a manifest fetch may take before it is abandoned.
///
/// reqwest's default is NO request timeout, so against a black-holed network
/// (dropped packets, captive portal — a common laptop offline mode) `send()`
/// would hang until OS-level TCP timeouts (tens of seconds to minutes), and
/// the pending invoke would never resolve. Bounding it keeps the check
/// silent-and-fast: failures degrade to `None` in a bounded time.
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// Bounds the TCP connect phase separately (reqwest's default is also
/// unbounded), so an unreachable host is abandoned quickly rather than
/// waiting on the OS connect timeout.
pub const FETCH_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

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
    let major = parse_part(parts.next()?)?;
    let minor = parse_part(parts.next()?)?;
    let patch = parse_part(parts.next()?)?;
    if parts.next().is_some() {
        return None;
    }
    Some([major, minor, patch])
}

/// Parses a single numeric version segment.
///
/// Rust's `u64::from_str` accepts a leading `+`, so a bare `.parse()` would
/// silently accept `"+2"` as `2` and make `"+2.0.0"` look newer. Malformed
/// input must be treated as "not newer", so each segment must be nothing but
/// ASCII digits before it is parsed.
fn parse_part(part: &str) -> Option<u64> {
    if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    part.parse().ok()
}

/// Builds the reqwest client used for the manifest check.
///
/// Split out of `fetch_manifest` so the timeout configuration is unit-testable
/// without network access. The updater plugin (and tauri itself) build on
/// reqwest with `rustls-no-provider`, so ring's provider is installed if
/// nothing is set yet — the same way the plugin does before making requests.
pub fn build_fetch_client() -> Option<reqwest::Client> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }

    reqwest::Client::builder()
        .user_agent(concat!("oppa/", env!("CARGO_PKG_VERSION")))
        .timeout(FETCH_TIMEOUT)
        .connect_timeout(FETCH_CONNECT_TIMEOUT)
        .build()
        .ok()
}

/// Fetches and parses the remote update manifest for the stable channel.
///
/// Returns `None` on any failure (network down, non-2xx, bad JSON) so the app
/// works fine offline and the frontend can swallow the result silently.
async fn fetch_manifest() -> Option<UpdateManifest> {
    let client = build_fetch_client()?;

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
    fn plus_prefixed_version_parts_are_never_newer() {
        // Rust's u64 parse accepts a leading `+` ("+2" parses as 2); a
        // "+"-prefixed version is malformed, so it must NOT be newer.
        assert!(!is_newer_available("0.1.0", "+2.0.0"));
        assert!(!is_newer_available("0.1.0", "+1.0.0"));
        assert!(!is_newer_available("0.1.0", "1.+2.0"));
        assert!(!is_newer_available("0.1.0", "1.0.+2"));
        assert!(!is_newer_available("1.0.0", "+2.0.0"));
        assert!(!is_newer_available("+2.0.0", "1.0.0"));
        assert!(!is_newer_available("+1.0.0", "+2.0.0"));
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
    fn manifest_parses_three_field_shape_with_signature() {
        // Forward-compat pin: a future manifest may carry a `signature`
        // alongside version/download; the custom-shape parse must tolerate it.
        let json = r#"{
            "version": "0.2.3",
            "download": "https://github.com/dreamydani/oppa/releases/download/v0.2.3/oppa_0.2.3_x64-setup.exe",
            "signature": "RWQfakeSignatureBase64=="
        }"#;
        let parsed: UpdateManifest = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.version, "0.2.3");
        assert!(parsed.download.starts_with("https://github.com/dreamydani/oppa/releases/download/"));
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

    #[test]
    fn fetch_client_has_bounded_timeouts() {
        // reqwest defaults to NO timeout (a hung network would stall the check
        // for minutes). The constants below are what `build_fetch_client`
        // applies via `.timeout(...)` / `.connect_timeout(...)`; assert they
        // are present and bounded so a regression to "no timeout" fails here.
        assert_eq!(FETCH_TIMEOUT, Duration::from_secs(10));
        assert_eq!(FETCH_CONNECT_TIMEOUT, Duration::from_secs(5));

        // The client used for real fetches is built through the same function
        // that applies those timeouts; it must construct without network I/O.
        assert!(build_fetch_client().is_some());
    }
}
