// Shared HTTP client for voice backends (model downloads, cloud
// transcription). Same TLS-stack setup as the updater client
// (rustls-no-provider needs an installed ring provider), but deliberately
// WITHOUT a total-request timeout: model files are hundreds of MB and
// transcription POSTs carry minutes of audio. Stalls are bounded by callers
// (chunk watchdog, command timeouts), not by the client.

use std::time::Duration;

pub fn build_voice_http_client() -> Option<reqwest::Client> {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    reqwest::Client::builder()
        .user_agent(concat!("oppa/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(30))
        .build()
        .ok()
}
