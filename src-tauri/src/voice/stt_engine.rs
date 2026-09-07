// STT engine: sherpa-onnx recognizer loading, session decode pumps, and the
// `SttEvent` protocol. Thin ownership layer over the safe `sherpa-onnx`
// bindings: all blocking decode runs on the service's worker thread, never
// on the Tauri async runtime.

use crate::voice::model_catalog::{get_catalog_model, SpeechModelManifest};
use crate::voice::model_manager::ModelManager;
use crate::voice::stt_model_config::{
    build_hotwords_config, engine_kind_for, list_model_files, resolve_model_file, resolve_tokens,
    EngineKind, ENDPOINT_RULE1_SILENCE_S, ENDPOINT_RULE2_SILENCE_S, ENDPOINT_RULE3_MIN_UTTERANCE_S,
    OFFLINE_NUM_THREADS, STREAMING_NUM_THREADS,
};
use sherpa_onnx::{
    OfflineNemoEncDecCtcModelConfig, OfflineRecognizer, OfflineRecognizerConfig,
    OfflineSenseVoiceModelConfig, OfflineTransducerModelConfig, OfflineWhisperModelConfig,
    OnlineParaformerModelConfig, OnlineRecognizer, OnlineRecognizerConfig, OnlineStream,
    OnlineTransducerModelConfig,
};
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Debug, Clone)]
pub enum SttEvent {
    Ready,
    Partial(String),
    Final(String),
    Stopped,
    Error(String),
}

pub struct LoadedEngine {
    pub model_id: String,
    pub kind: EngineKind,
    streaming: Option<Arc<OnlineRecognizer>>,
    offline: Option<Arc<OfflineRecognizer>>,
    #[cfg(test)]
    stub: bool,
}

impl LoadedEngine {
    #[cfg(test)]
    pub fn stub_streaming(model_id: &str) -> Self {
        Self {
            model_id: model_id.into(),
            kind: EngineKind::StreamingTransducer,
            streaming: None,
            offline: None,
            stub: true,
        }
    }

    pub fn new_session(&self, sample_rate: u32) -> EngineSession {
        #[cfg(test)]
        if self.stub {
            return EngineSession {
                core: SessionCore::Stub {
                    partial_sent: false,
                },
            };
        }
        let core = match self.kind {
            EngineKind::StreamingTransducer | EngineKind::StreamingParaformer => {
                let recognizer = self.streaming.clone().expect("streaming recognizer loaded");
                let stream = recognizer.create_stream();
                SessionCore::Streaming {
                    recognizer,
                    stream,
                    last_text: String::new(),
                }
            }
            _ => {
                let recognizer = self.offline.clone().expect("offline recognizer loaded");
                SessionCore::Offline {
                    recognizer,
                    chunker: crate::voice::stt_offline_chunker::OfflineAudioChunker::new(
                        sample_rate,
                    ),
                }
            }
        };
        EngineSession { core }
    }
}

enum SessionCore {
    Streaming {
        recognizer: Arc<OnlineRecognizer>,
        stream: OnlineStream,
        last_text: String,
    },
    Offline {
        recognizer: Arc<OfflineRecognizer>,
        chunker: crate::voice::stt_offline_chunker::OfflineAudioChunker,
    },
    #[cfg(test)]
    Stub { partial_sent: bool },
}

pub struct EngineSession {
    core: SessionCore,
}

impl EngineSession {
    /// Accepts samples (always 16 kHz mono by the time they arrive here).
    pub fn accept(&mut self, samples: &[f32], emit: &dyn Fn(SttEvent)) -> Result<(), String> {
        match &mut self.core {
            SessionCore::Streaming {
                recognizer,
                stream,
                last_text,
            } => {
                stream.accept_waveform(
                    crate::voice::stt_audio_resample::STT_SAMPLE_RATE_I32,
                    samples,
                );
                while recognizer.is_ready(stream) {
                    recognizer.decode(stream);
                }
                if let Some(result) = recognizer.get_result(stream) {
                    let text = result.text.trim().to_string();
                    // Orca parity: every non-empty hypothesis rides out as a
                    // partial; the controller owns display dedupe.
                    if !text.is_empty() {
                        *last_text = text.clone();
                        emit(SttEvent::Partial(text));
                    }
                }
                if recognizer.is_endpoint(stream) {
                    let endpoint_text = last_text.clone();
                    if !endpoint_text.is_empty() {
                        emit(SttEvent::Final(endpoint_text));
                    }
                    recognizer.reset(stream);
                    last_text.clear();
                }
                Ok(())
            }
            SessionCore::Offline {
                recognizer,
                chunker,
            } => {
                for chunk in chunker.push(samples) {
                    // Why: an offline stream is single-use — always mint a
                    // fresh stream so a failed decode cannot poison the next.
                    let stream = recognizer.create_stream();
                    stream.accept_waveform(
                        crate::voice::stt_audio_resample::STT_SAMPLE_RATE_I32,
                        &chunk,
                    );
                    recognizer.decode(&stream);
                    match stream.get_result() {
                        Some(result) => {
                            let text = result.text.trim().to_string();
                            if !text.is_empty() {
                                emit(SttEvent::Final(text));
                            }
                        }
                        None => return Err("offline decode produced no result".into()),
                    }
                }
                Ok(())
            }
            #[cfg(test)]
            SessionCore::Stub { partial_sent } => {
                if !*partial_sent {
                    *partial_sent = true;
                    emit(SttEvent::Partial("stub partial".into()));
                }
                Ok(())
            }
        }
    }

    /// End-of-session drain: streaming flushes the tail, offline decodes the
    /// remainder (bounded below the chunk limit by construction).
    pub fn finish(&mut self, emit: &dyn Fn(SttEvent)) -> Result<(), String> {
        match &mut self.core {
            SessionCore::Streaming {
                recognizer,
                stream,
                last_text: _,
            } => {
                stream.input_finished();
                while recognizer.is_ready(stream) {
                    recognizer.decode(stream);
                }
                if let Some(result) = recognizer.get_result(stream) {
                    let text = result.text.trim().to_string();
                    if !text.is_empty() {
                        emit(SttEvent::Final(text));
                    }
                }
                Ok(())
            }
            SessionCore::Offline {
                recognizer,
                chunker,
            } => {
                if let Some(remaining) = chunker.flush() {
                    if !remaining.is_empty() {
                        let stream = recognizer.create_stream();
                        stream.accept_waveform(
                            crate::voice::stt_audio_resample::STT_SAMPLE_RATE_I32,
                            &remaining,
                        );
                        recognizer.decode(&stream);
                        match stream.get_result() {
                            Some(result) => {
                                let text = result.text.trim().to_string();
                                if !text.is_empty() {
                                    emit(SttEvent::Final(text));
                                }
                            }
                            None => return Err("offline decode produced no result".into()),
                        }
                    }
                }
                Ok(())
            }
            #[cfg(test)]
            SessionCore::Stub { .. } => {
                emit(SttEvent::Final("stub final".into()));
                Ok(())
            }
        }
    }
}

/// Loads recognizers from the downloaded model dir. Construction is blocking
/// (native model load) — callers run it under a timeout off the async runtime.
pub trait EngineLoader: Send + Sync {
    fn load(
        &self,
        models_dir: &Path,
        model_id: &str,
        hotwords_file: Option<&Path>,
    ) -> Result<LoadedEngine, String>;
}

pub struct SherpaEngineLoader;

impl EngineLoader for SherpaEngineLoader {
    fn load(
        &self,
        models_dir: &Path,
        model_id: &str,
        hotwords_file: Option<&Path>,
    ) -> Result<LoadedEngine, String> {
        let manifest =
            get_catalog_model(model_id).ok_or_else(|| format!("unknown_model:{model_id}"))?;
        if manifest.provider != crate::voice::model_catalog::SpeechModelProvider::Local {
            return Err(format!("not_downloadable:{model_id}"));
        }
        // The native runtime reads these bytes directly: verify integrity on
        // every cold load (warm reuse skips this in the service).
        ModelManager::new(models_dir.to_path_buf())
            .verify_model_files(model_id)
            .map_err(|e| format!("model_not_ready:{e}"))?;

        let dir = models_dir.join(model_id);
        let files = list_model_files(&dir)?;
        let tokens = string_path(resolve_tokens(&files, &dir)?);
        let kind = engine_kind_for(&manifest);
        let hotwords: Option<PathBuf> = hotwords_file.map(|p| p.to_path_buf());

        let (streaming, offline) = match kind {
            EngineKind::StreamingTransducer => {
                let hotwords_config = build_hotwords_config(
                    &manifest.model_type,
                    hotwords.clone().map(PathBuf::from),
                    manifest.modeling_unit.as_deref(),
                    &dir,
                );
                let mut config = OnlineRecognizerConfig::default();
                config.feat_config.sample_rate = 16000;
                config.feat_config.feature_dim = 80;
                config.model_config.transducer = OnlineTransducerModelConfig {
                    encoder: some_path(resolve_model_file(&files, "encoder", &dir)?),
                    decoder: some_path(resolve_model_file(&files, "decoder", &dir)?),
                    joiner: some_path(resolve_model_file(&files, "joiner", &dir)?),
                };
                apply_online_common(&mut config, &manifest, &hotwords_config, &tokens);
                let recognizer = OnlineRecognizer::create(&config)
                    .ok_or_else(|| "engine: create failed".to_string())?;
                (Some(Arc::new(recognizer)), None)
            }
            EngineKind::StreamingParaformer => {
                let mut config = OnlineRecognizerConfig::default();
                config.feat_config.sample_rate = 16000;
                config.feat_config.feature_dim = 80;
                config.model_config.paraformer = OnlineParaformerModelConfig {
                    encoder: some_path(resolve_model_file(&files, "encoder", &dir)?),
                    decoder: some_path(resolve_model_file(&files, "decoder", &dir)?),
                };
                config.model_config.tokens = Some(tokens.clone());
                config.model_config.num_threads = STREAMING_NUM_THREADS;
                config.model_config.provider = Some("cpu".into());
                config.decoding_method = Some("greedy_search".into());
                apply_online_endpoint(&mut config);
                let recognizer = OnlineRecognizer::create(&config)
                    .ok_or_else(|| "engine: create failed".to_string())?;
                (Some(Arc::new(recognizer)), None)
            }
            EngineKind::OfflineTransducer => {
                let mut config = OfflineRecognizerConfig::default();
                config.model_config.transducer = OfflineTransducerModelConfig {
                    encoder: some_path(resolve_model_file(&files, "encoder", &dir)?),
                    decoder: some_path(resolve_model_file(&files, "decoder", &dir)?),
                    joiner: some_path(resolve_model_file(&files, "joiner", &dir)?),
                };
                apply_offline_common(&mut config, &tokens);
                let recognizer = OfflineRecognizer::create(&config)
                    .ok_or_else(|| "engine: create failed".to_string())?;
                (None, Some(Arc::new(recognizer)))
            }
            EngineKind::OfflineNemoCtc => {
                let mut config = OfflineRecognizerConfig::default();
                config.model_config.nemo_ctc = OfflineNemoEncDecCtcModelConfig {
                    model: some_path(resolve_model_file(&files, "model", &dir)?),
                };
                apply_offline_common(&mut config, &tokens);
                let recognizer = OfflineRecognizer::create(&config)
                    .ok_or_else(|| "engine: create failed".to_string())?;
                (None, Some(Arc::new(recognizer)))
            }
            EngineKind::OfflineWhisper => {
                let mut config = OfflineRecognizerConfig::default();
                config.model_config.whisper = OfflineWhisperModelConfig {
                    encoder: some_path(resolve_model_file(&files, "encoder", &dir)?),
                    decoder: some_path(resolve_model_file(&files, "decoder", &dir)?),
                    // Empty language = auto-detect (Orca parity).
                    language: Some(String::new()),
                    task: Some("transcribe".into()),
                    tail_paddings: 0,
                    enable_token_timestamps: false,
                    enable_segment_timestamps: false,
                };
                apply_offline_common(&mut config, &tokens);
                let recognizer = OfflineRecognizer::create(&config)
                    .ok_or_else(|| "engine: create failed".to_string())?;
                (None, Some(Arc::new(recognizer)))
            }
            EngineKind::OfflineSenseVoice => {
                let mut config = OfflineRecognizerConfig::default();
                config.model_config.sense_voice = OfflineSenseVoiceModelConfig {
                    model: some_path(resolve_model_file(&files, "model", &dir)?),
                    // Empty string = auto-detect zh/en/ja/ko/yue (Orca parity).
                    language: Some(String::new()),
                    use_itn: true,
                };
                apply_offline_common(&mut config, &tokens);
                let recognizer = OfflineRecognizer::create(&config)
                    .ok_or_else(|| "engine: create failed".to_string())?;
                (None, Some(Arc::new(recognizer)))
            }
        };

        Ok(LoadedEngine {
            model_id: model_id.into(),
            kind,
            streaming,
            offline,
            #[cfg(test)]
            stub: false,
        })
    }
}

fn apply_online_common(
    config: &mut OnlineRecognizerConfig,
    manifest: &SpeechModelManifest,
    hotwords: &crate::voice::stt_model_config::HotwordsConfig,
    tokens: &str,
) {
    config.model_config.tokens = Some(tokens.to_string());
    config.model_config.num_threads = STREAMING_NUM_THREADS;
    config.model_config.provider = Some("cpu".into());
    // Why: the crate default leaves `bpe_vocab` as `Some("")`, which the
    // native validator rejects once `modeling_unit` mentions bpe. Orca only
    // sends modeling-unit/vocab alongside an actual hotwords file, so gate
    // all four on hotwords being active; otherwise leave them unset.
    config.model_config.bpe_vocab = None;
    config.decoding_method = Some(hotwords.decoding_method.to_string());
    if hotwords.hotwords_file.is_some() {
        config.model_config.modeling_unit = manifest.modeling_unit.clone();
        config.model_config.bpe_vocab = hotwords.bpe_vocab.as_ref().map(|p| string_path(p.clone()));
        config.hotwords_file = hotwords
            .hotwords_file
            .as_ref()
            .map(|p| string_path(p.clone()));
        config.hotwords_score = hotwords.hotwords_score;
    }
    apply_online_endpoint(config);
}

fn apply_online_endpoint(config: &mut OnlineRecognizerConfig) {
    config.enable_endpoint = true;
    config.rule1_min_trailing_silence = ENDPOINT_RULE1_SILENCE_S;
    config.rule2_min_trailing_silence = ENDPOINT_RULE2_SILENCE_S;
    config.rule3_min_utterance_length = ENDPOINT_RULE3_MIN_UTTERANCE_S;
}

fn apply_offline_common(config: &mut OfflineRecognizerConfig, tokens: &str) {
    config.model_config.tokens = Some(tokens.to_string());
    config.model_config.num_threads = OFFLINE_NUM_THREADS;
    config.model_config.provider = Some("cpu".into());
}

fn some_path(path: PathBuf) -> Option<String> {
    Some(string_path(path))
}

fn string_path(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}
