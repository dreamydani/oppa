// STT model configuration — port of Orca's `stt-worker-model-config.ts`.
// Resolves ONNX/tokens paths from the downloaded model dir, decides the
// recognizer kind per model, and builds the hotwords config. Endpoint and
// threading constants mirror `stt-worker.ts`.

use crate::voice::model_catalog::{SpeechModelManifest, SpeechModelType};
use std::path::{Path, PathBuf};

/// Endpoint tuning from Orca (`rule1MinTrailingSilence: 2.4`,
/// `rule2MinTrailingSilence: 1.2`, `rule3MinUtteranceLength: 20`).
pub const ENDPOINT_RULE1_SILENCE_S: f32 = 2.4;
pub const ENDPOINT_RULE2_SILENCE_S: f32 = 1.2;
pub const ENDPOINT_RULE3_MIN_UTTERANCE_S: f32 = 20.0;

/// Hotwords boost for modified beam search (Orca parity).
pub const HOTWORDS_SCORE: f32 = 1.5;

pub const STREAMING_NUM_THREADS: i32 = 1;
pub const OFFLINE_NUM_THREADS: i32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineKind {
    StreamingTransducer,
    StreamingParaformer,
    OfflineTransducer,
    OfflineNemoCtc,
    OfflineWhisper,
    OfflineSenseVoice,
}

impl EngineKind {
    pub fn is_streaming(self) -> bool {
        matches!(
            self,
            EngineKind::StreamingTransducer | EngineKind::StreamingParaformer
        )
    }
}

/// Which recognizer a catalog model needs (Orca `stt-worker.ts` mapping).
pub fn engine_kind_for(manifest: &SpeechModelManifest) -> EngineKind {
    match (&manifest.model_type, manifest.streaming) {
        (SpeechModelType::Transducer, true) => EngineKind::StreamingTransducer,
        (SpeechModelType::Paraformer, true) => EngineKind::StreamingParaformer,
        (SpeechModelType::Transducer, false) => EngineKind::OfflineTransducer,
        (SpeechModelType::NemoCtc, _) => EngineKind::OfflineNemoCtc,
        (SpeechModelType::Whisper, _) => EngineKind::OfflineWhisper,
        (SpeechModelType::SenseVoice, _) => EngineKind::OfflineSenseVoice,
        // Paraformer offline / unknown combos fall back to the offline
        // transducer path only when encoder+decoder+joiner resolve; callers
        // surface `model_unsupported` otherwise (decided at load).
        (SpeechModelType::Paraformer, false) => EngineKind::OfflineTransducer,
        (SpeechModelType::Openai, _) => EngineKind::OfflineWhisper,
    }
}

// Why: different models name their ONNX files differently (e.g.
// encoder.int8.onnx vs tiny-encoder.onnx vs encoder-epoch-99-avg-1.onnx).
// The on-disk listing is the source of truth (Orca uses the manifest's
// files list; ours is equivalent post-download).
pub fn list_model_files(model_dir: &Path) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    let entries = std::fs::read_dir(model_dir).map_err(|e| format!("model_dir_unreadable:{e}"))?;
    for entry in entries.flatten() {
        if let Some(name) = entry.file_name().to_str() {
            files.push(name.to_string());
        }
    }
    files.sort();
    Ok(files)
}

/// Role-substring search over the on-disk listing (see `list_model_files`).
pub fn resolve_model_file(
    files: &[String],
    role: &str,
    model_dir: &Path,
) -> Result<PathBuf, String> {
    files
        .iter()
        .find(|f| f.contains(role) && f.ends_with(".onnx"))
        .map(|f| model_dir.join(f))
        .ok_or_else(|| {
            format!(
                "model file *{role}*.onnx missing in {}",
                model_dir.display()
            )
        })
}

pub fn resolve_tokens(files: &[String], model_dir: &Path) -> Result<PathBuf, String> {
    files
        .iter()
        .find(|f| f.ends_with("tokens.txt"))
        .map(|f| model_dir.join(f))
        .ok_or_else(|| format!("*tokens.txt missing in {}", model_dir.display()))
}

// Why: BPE models need a vocab file for hotwords token matching, but older
// caches may omit it.
pub fn discover_bpe_vocab(model_dir: &Path) -> Option<PathBuf> {
    std::fs::read_dir(model_dir)
        .ok()?
        .flatten()
        .find_map(|entry| {
            let path = entry.path();
            if path.extension().is_some_and(|ext| ext == "vocab") {
                Some(path)
            } else {
                None
            }
        })
}

#[derive(Debug, Clone, PartialEq)]
pub struct HotwordsConfig {
    pub decoding_method: &'static str,
    pub hotwords_file: Option<PathBuf>,
    pub hotwords_score: f32,
    pub modeling_unit: Option<String>,
    pub bpe_vocab: Option<PathBuf>,
}

/// Mirror of Orca's `buildHotwordsConfig`: beam search with hotwords only
/// for transducer models with a hotwords file; BPE units additionally need
/// the vocab file, otherwise greedy.
pub fn build_hotwords_config(
    model_type: &SpeechModelType,
    hotwords_file: Option<PathBuf>,
    modeling_unit: Option<&str>,
    model_dir: &Path,
) -> HotwordsConfig {
    const GREEDY: HotwordsConfig = HotwordsConfig {
        decoding_method: "greedy_search",
        hotwords_file: None,
        hotwords_score: 0.0,
        modeling_unit: None,
        bpe_vocab: None,
    };
    if *model_type != SpeechModelType::Transducer || hotwords_file.is_none() {
        return GREEDY;
    }
    if modeling_unit.is_some_and(|unit| unit.contains("bpe")) {
        let Some(bpe_vocab) = discover_bpe_vocab(model_dir) else {
            return GREEDY;
        };
        return HotwordsConfig {
            decoding_method: "modified_beam_search",
            hotwords_file,
            hotwords_score: HOTWORDS_SCORE,
            modeling_unit: modeling_unit.map(str::to_string),
            bpe_vocab: Some(bpe_vocab),
        };
    }
    HotwordsConfig {
        decoding_method: "modified_beam_search",
        hotwords_file,
        hotwords_score: HOTWORDS_SCORE,
        modeling_unit: modeling_unit.map(str::to_string),
        bpe_vocab: None,
    }
}

/// Hotwords file content: `<word> :2.0` per line (Orca parity).
pub fn hotwords_file_content(hotwords: &[String]) -> String {
    let mut content = String::new();
    for word in hotwords {
        let trimmed = word.trim();
        if !trimmed.is_empty() {
            content.push_str(trimmed);
            content.push_str(" :2.0\n");
        }
    }
    content
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::voice::model_catalog::{SpeechModelProvider, SpeechModelType};

    fn manifest(model_type: SpeechModelType, streaming: bool) -> SpeechModelManifest {
        SpeechModelManifest {
            id: "test".into(),
            model_type,
            label: "Test".into(),
            description: "".into(),
            provider: SpeechModelProvider::Local,
            language: "en".into(),
            size_bytes: None,
            sample_rate: 16000,
            streaming,
            modeling_unit: None,
            recommended: None,
        }
    }

    #[test]
    fn engine_kind_mapping_matches_orca_worker() {
        assert_eq!(
            engine_kind_for(&manifest(SpeechModelType::Transducer, true)),
            EngineKind::StreamingTransducer
        );
        assert_eq!(
            engine_kind_for(&manifest(SpeechModelType::Paraformer, true)),
            EngineKind::StreamingParaformer
        );
        assert_eq!(
            engine_kind_for(&manifest(SpeechModelType::Transducer, false)),
            EngineKind::OfflineTransducer
        );
        assert_eq!(
            engine_kind_for(&manifest(SpeechModelType::NemoCtc, false)),
            EngineKind::OfflineNemoCtc
        );
        assert_eq!(
            engine_kind_for(&manifest(SpeechModelType::Whisper, false)),
            EngineKind::OfflineWhisper
        );
        assert_eq!(
            engine_kind_for(&manifest(SpeechModelType::SenseVoice, false)),
            EngineKind::OfflineSenseVoice
        );
    }

    #[test]
    fn resolves_files_by_role_substring() {
        let dir = Path::new("/m");
        let files = vec![
            "encoder-epoch-99-avg-1.onnx".to_string(),
            "decoder-epoch-99-avg-1.onnx".to_string(),
            "joiner-epoch-99-avg-1.onnx".to_string(),
            "tokens.txt".to_string(),
        ];
        assert_eq!(
            resolve_model_file(&files, "encoder", dir).expect("encoder"),
            Path::new("/m/encoder-epoch-99-avg-1.onnx")
        );
        assert_eq!(
            resolve_tokens(&files, dir).expect("tokens"),
            Path::new("/m/tokens.txt")
        );
        assert!(resolve_model_file(&files, "model", dir).is_err());
    }

    #[test]
    fn hotwords_config_needs_transducer_file_and_vocab() {
        let dir = tempfile::tempdir().expect("tempdir");
        // No hotwords file → greedy.
        let config =
            build_hotwords_config(&SpeechModelType::Transducer, None, Some("bpe"), dir.path());
        assert_eq!(config.decoding_method, "greedy_search");

        // Non-transducer → greedy even with a file.
        let config = build_hotwords_config(
            &SpeechModelType::Whisper,
            Some(dir.path().join("hw.txt")),
            None,
            dir.path(),
        );
        assert_eq!(config.decoding_method, "greedy_search");

        // BPE without vocab → greedy.
        let config = build_hotwords_config(
            &SpeechModelType::Transducer,
            Some(dir.path().join("hw.txt")),
            Some("bpe"),
            dir.path(),
        );
        assert_eq!(config.decoding_method, "greedy_search");

        // BPE with vocab → beam + score 1.5.
        std::fs::write(dir.path().join("bpe.vocab"), "x").expect("vocab");
        let config = build_hotwords_config(
            &SpeechModelType::Transducer,
            Some(dir.path().join("hw.txt")),
            Some("bpe"),
            dir.path(),
        );
        assert_eq!(config.decoding_method, "modified_beam_search");
        assert_eq!(config.hotwords_score, 1.5);

        // Non-BPE transducer → beam without vocab.
        let config = build_hotwords_config(
            &SpeechModelType::Transducer,
            Some(dir.path().join("hw.txt")),
            Some("cjkchar"),
            dir.path(),
        );
        assert_eq!(config.decoding_method, "modified_beam_search");
        assert!(config.bpe_vocab.is_none());
    }

    #[test]
    fn hotwords_file_content_format() {
        let content =
            hotwords_file_content(&["oppa".to_string(), "  voice  ".to_string(), String::new()]);
        assert_eq!(content, "oppa :2.0\nvoice :2.0\n");
        assert_eq!(hotwords_file_content(&[]), "");
    }
}
