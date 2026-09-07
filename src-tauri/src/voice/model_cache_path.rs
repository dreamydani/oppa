// Model cache location. Two constraints drive this file:
// 1. sherpa-onnx cannot read non-ASCII paths on Windows, so the dir must be
//    ASCII (validated, with fallback) — same WHY as Orca's model-cache-path.
// 2. Models are ~100 MB–1 GB, so the dir must NOT be the roaming profile
//    (`dirs::data_dir()` == %APPDATA% on Windows, which syncs). Use the
//    local (non-roaming) data dir instead.

use std::path::{Path, PathBuf};

/// Channel-aware models root: `<local-data>/<identifier>/voice-models`.
pub fn resolve_models_dir() -> Option<PathBuf> {
    let mut identifier = crate::pty::snapshot::app_identifier().to_string();
    if let Some(suffix) = crate::channel::Channel::current().data_dir_suffix() {
        identifier.push_str(suffix);
    }
    let base = dirs::data_local_dir().or_else(dirs::data_dir)?;
    Some(base.join(identifier).join("voice-models"))
}

/// Pure ASCII selection: primary wins when ASCII, else the fallback.
pub fn select_ascii_dir(primary: &Path, fallback: &Path) -> PathBuf {
    if primary.to_str().is_some_and(|s| s.is_ascii()) {
        return primary.to_path_buf();
    }
    fallback.to_path_buf()
}

/// Ensure the models dir exists and is ASCII-safe for the STT engine.
/// Falls back to the OS temp dir when the primary is non-ASCII.
pub fn ensure_models_dir() -> std::io::Result<PathBuf> {
    let primary = resolve_models_dir()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotFound, "no local data dir"))?;
    let fallback = std::env::temp_dir().join("oppa-voice-models");
    let dir = select_ascii_dir(&primary, &fallback);
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_primary_wins_non_ascii_falls_back() {
        let primary = Path::new("/data/models");
        let fallback = Path::new("/tmp/oppa-voice-models");
        assert_eq!(select_ascii_dir(primary, fallback), primary);

        let non_ascii = Path::new("/data/mödels");
        assert_eq!(select_ascii_dir(non_ascii, fallback), fallback);
    }

    #[test]
    fn models_dir_is_channel_aware_and_non_roaming() {
        let dir = resolve_models_dir().expect("data dir resolves in tests");
        let name = dir
            .parent()
            .and_then(|p| p.file_name())
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        assert!(name.starts_with("com.pc.oppa"), "unexpected dir {dir:?}");
        assert_eq!(dir.file_name().unwrap(), "voice-models");
    }
}
