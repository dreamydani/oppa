// Voice dictation backend: speech-model catalog, downloader, and the local
// STT engine (Slice 5) behind the Tauri commands.

pub mod commands;
pub mod http_client;
pub mod model_cache_path;
pub mod model_catalog;
pub mod model_deletion;
pub mod model_download_catalog;
pub mod model_manager;
pub mod openai_api_key_store;
pub mod openai_transcription_client;
pub mod stt_audio_resample;
pub mod stt_engine;
pub mod stt_model_config;
pub mod stt_offline_chunker;
pub mod stt_service;
