// Static speech-model catalog — 1:1 port of Orca's `model-catalog.ts`
// (ids, labels, descriptions, sizes). Download URLs + hashes land in
// `model_download_catalog.rs` and the downloader in `model_manager.rs`
// (Slice 4); this file is only the list the pane renders.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SpeechModelType {
    Transducer,
    Paraformer,
    Whisper,
    #[serde(rename = "senseVoice")]
    SenseVoice,
    #[serde(rename = "nemo-ctc")]
    NemoCtc,
    Openai,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SpeechModelProvider {
    Local,
    Openai,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpeechModelManifest {
    pub id: String,
    #[serde(rename = "type")]
    pub model_type: SpeechModelType,
    pub label: String,
    pub description: String,
    pub provider: SpeechModelProvider,
    pub language: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    pub sample_rate: u32,
    pub streaming: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modeling_unit: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recommended: Option<bool>,
}

fn local(
    id: &str,
    label: &str,
    description: &str,
    model_type: SpeechModelType,
    language: &str,
    size_bytes: u64,
    streaming: bool,
    modeling_unit: Option<&str>,
    recommended: bool,
) -> SpeechModelManifest {
    SpeechModelManifest {
        id: id.into(),
        model_type,
        label: label.into(),
        description: description.into(),
        provider: SpeechModelProvider::Local,
        language: language.into(),
        size_bytes: Some(size_bytes),
        sample_rate: 16000,
        streaming,
        modeling_unit: modeling_unit.map(str::to_string),
        recommended: recommended.then_some(true),
    }
}

fn cloud(
    id: &str,
    label: &str,
    description: &str,
) -> SpeechModelManifest {
    SpeechModelManifest {
        id: id.into(),
        model_type: SpeechModelType::Openai,
        label: label.into(),
        description: description.into(),
        provider: SpeechModelProvider::Openai,
        language: "multilingual".into(),
        size_bytes: None,
        sample_rate: 16000,
        streaming: false,
        modeling_unit: None,
        recommended: None,
    }
}

pub fn speech_model_catalog() -> Vec<SpeechModelManifest> {
    vec![
        local(
            "parakeet-tdt-0.6b-v3-int8",
            "Parakeet TDT v3",
            "Highest accuracy for 25 European languages. Punctuation, capitalization, and word-level timestamps.",
            SpeechModelType::Transducer,
            "multilingual",
            670_478_772,
            false,
            Some("bpe"),
            true,
        ),
        local(
            "parakeet-tdt-0.6b-v2-int8",
            "Parakeet TDT v2",
            "English only. Faster than v3 with similar accuracy. Punctuation and capitalization.",
            SpeechModelType::Transducer,
            "en",
            661_190_513,
            false,
            Some("bpe"),
            false,
        ),
        local(
            "zipformer-bilingual-zh-en",
            "Zipformer Bilingual",
            "Chinese + English with code-switching. Low-latency real-time streaming.",
            SpeechModelType::Transducer,
            "zh-en",
            356_862_456,
            true,
            Some("cjkchar+bpe"),
            false,
        ),
        local(
            "paraformer-bilingual-zh-en",
            "Paraformer Bilingual",
            "Chinese (Mandarin + dialects) + English. Strong on accented and regional Chinese.",
            SpeechModelType::Paraformer,
            "zh-en",
            237_202_501,
            true,
            None,
            false,
        ),
        local(
            "zipformer-streaming-en-20m",
            "Zipformer Streaming EN",
            "English only. Lightweight 20M-param model, good balance of speed and size.",
            SpeechModelType::Transducer,
            "en",
            91_928_372,
            true,
            Some("bpe"),
            false,
        ),
        local(
            "zipformer-streaming-zh-14m",
            "Zipformer Streaming ZH",
            "Chinese only. Ultra-lightweight 14M-param model, ideal for low-resource devices.",
            SpeechModelType::Transducer,
            "zh",
            55_716_588,
            true,
            Some("cjkchar"),
            false,
        ),
        local(
            "zipformer-streaming-korean",
            "Zipformer Streaming KO",
            "Korean only. Low-latency real-time streaming.",
            SpeechModelType::Transducer,
            "ko",
            132_455_201,
            true,
            Some("bpe"),
            false,
        ),
        local(
            "parakeet-tdt-ctc-0.6b-ja-int8",
            "Parakeet TDT-CTC JA",
            "Japanese only. Trained on 35k+ hours of natural speech. Punctuation included.",
            SpeechModelType::NemoCtc,
            "ja",
            655_571_161,
            false,
            None,
            false,
        ),
        local(
            "whisper-tiny",
            "Whisper Tiny",
            "90+ languages. Lower accuracy than Parakeet but broadest language coverage.",
            SpeechModelType::Whisper,
            "multilingual",
            152_969_611,
            false,
            None,
            false,
        ),
        local(
            "sense-voice-zh-en-ja-ko-yue",
            "SenseVoice",
            "Chinese, English, Japanese, Korean, and Cantonese with automatic language detection.",
            SpeechModelType::SenseVoice,
            "multilingual",
            239_549_735,
            false,
            None,
            false,
        ),
        cloud(
            "openai-gpt-4o-mini-transcribe",
            "GPT-4o mini Transcribe",
            "Cloud transcription with strong accuracy and low cost. Requires an OpenAI API key.",
        ),
        cloud(
            "openai-gpt-4o-transcribe",
            "GPT-4o Transcribe",
            "Cloud transcription with higher accuracy. Requires an OpenAI API key.",
        ),
    ]
}

pub fn get_catalog_model(id: &str) -> Option<SpeechModelManifest> {
    speech_model_catalog().into_iter().find(|m| m.id == id)
}

pub fn is_local_speech_model(manifest: &SpeechModelManifest) -> bool {
    manifest.provider == SpeechModelProvider::Local
}
