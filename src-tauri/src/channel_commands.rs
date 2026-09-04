// Tauri command surface for the build channel. `app_channel` lets the
// frontend learn whether this binary is the dev ("Developer OPPA"), rc, or
// stable build, so later tasks (updater gating, banner) can branch on it
// without another IPC surface. The payload is just
// `Channel::current().as_str()`.

use crate::channel::Channel;

/// Return the compile-time build channel: `"dev"`, `"rc"`, or `"stable"`.
#[tauri::command]
pub fn app_channel() -> &'static str {
    Channel::current().as_str()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_channel_payload_matches_build_time_channel() {
        // The wire payload must equal Channel::current().as_str() — the same
        // value the frontend gates on — so a dev build can never be mistaken
        // for stable (or vice versa) by the renderer.
        let payload = app_channel();
        assert_eq!(payload, Channel::current().as_str());
        assert!(payload == "dev" || payload == "stable" || payload == "rc");
    }

    #[test]
    fn app_channel_payload_serializes_to_plain_string() {
        // Tauri serializes the returned &str as a JSON string on the wire; a
        // payload like `"dev"` / `"stable"` / `"rc"` is exactly what the
        // frontend's `invoke<string>("app_channel")` expects.
        for channel in [Channel::Dev, Channel::Stable, Channel::Rc] {
            let serialized = serde_json::to_string(channel.as_str()).unwrap();
            assert_eq!(serialized, format!("\"{}\"", channel.as_str()));
        }
    }
}
