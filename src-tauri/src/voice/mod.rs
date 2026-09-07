// Voice dictation backend: speech-model catalog, download states, and
// (from Slice 5) the STT engine. Slice 2 skeleton: catalog + stub commands.

pub mod commands;
pub mod model_cache_path;
pub mod model_catalog;
pub mod model_deletion;
pub mod model_download_catalog;
pub mod model_manager;
