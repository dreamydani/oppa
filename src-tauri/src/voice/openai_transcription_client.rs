// OpenAI cloud transcription session — port of Orca's
// `openai-transcription-client.ts`. Buffers 16 kHz mono f32, WAV-encodes on
// finish, and POSTs multipart to `/v1/audio/transcriptions`. Same cap,
// field names, filename, and error strings as Orca.

use std::time::Duration;

pub const TRANSCRIPTION_URL: &str = "https://api.openai.com/v1/audio/transcriptions";
pub const CLOUD_TRANSCRIPTION_SAMPLE_RATE: u32 = 16000;
pub const MAX_CLOUD_AUDIO_SECONDS: u64 = 10 * 60;
const MAX_CLOUD_AUDIO_SAMPLES: u64 =
    MAX_CLOUD_AUDIO_SECONDS * CLOUD_TRANSCRIPTION_SAMPLE_RATE as u64;

/// Catalog model id → OpenAI API model string (Orca parity).
pub fn api_model_for(catalog_id: &str) -> Option<&'static str> {
    match catalog_id {
        "openai-gpt-4o-mini-transcribe" => Some("gpt-4o-mini-transcribe"),
        "openai-gpt-4o-transcribe" => Some("gpt-4o-transcribe"),
        _ => None,
    }
}

/// Strips key material from provider errors (Orca parity: incorrect-key
/// special case, `sk-*` and `Bearer *` redaction).
pub fn sanitize_transcription_error(message: &str) -> String {
    let lower = message.to_lowercase();
    if lower.contains("incorrect api key provided:") {
        // Keep only the head sentence (Orca parity).
        return "Incorrect OpenAI API key provided.".into();
    }
    let redacted = redact_pattern(message, "sk-");
    let redacted = redact_bearer(&redacted);
    let trimmed = redacted.trim().to_string();
    if trimmed.is_empty() {
        "OpenAI transcription request failed".into()
    } else {
        trimmed
    }
}

fn redact_pattern(message: &str, prefix: &str) -> String {
    let mut out = String::with_capacity(message.len());
    let mut rest = message;
    while let Some(index) = rest.find(prefix) {
        out.push_str(&rest[..index]);
        out.push_str("[redacted]");
        rest = &rest[index + prefix.len()..];
        let token_len = rest
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))
            .unwrap_or(rest.len());
        rest = &rest[token_len..];
    }
    out.push_str(rest);
    out
}

fn redact_bearer(message: &str) -> String {
    let mut out = String::with_capacity(message.len());
    let mut rest = message;
    loop {
        let lower = rest.to_lowercase();
        let Some(index) = lower.find("bearer ") else {
            break;
        };
        // Preserve the original "Bearer" casing head.
        out.push_str(&rest[..index + 7]);
        out.push_str("[redacted]");
        rest = &rest[index + 7..];
        let token_len = rest
            .find(|c: char| {
                !(c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '~' | '+' | '/' | '=' | '-'))
            })
            .unwrap_or(rest.len());
        rest = &rest[token_len..];
    }
    out.push_str(rest);
    out
}

/// Mono 16-bit PCM WAV at 16 kHz (Orca's `encodePcm16Wav` layout, byte-exact).
pub fn encode_pcm16_wav(samples: &[f32], sample_rate: u32) -> Vec<u8> {
    let data_bytes = samples.len() * 2;
    let mut wav = Vec::with_capacity(44 + data_bytes);
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&(36 + data_bytes as u32).to_le_bytes());
    wav.extend_from_slice(b"WAVE");
    wav.extend_from_slice(b"fmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&sample_rate.to_le_bytes());
    wav.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&(data_bytes as u32).to_le_bytes());
    for sample in samples {
        let clamped = sample.clamp(-1.0, 1.0);
        let value = if clamped < 0.0 {
            clamped * 32768.0
        } else {
            clamped * 32767.0
        };
        wav.extend_from_slice(&(value.round() as i16).to_le_bytes());
    }
    wav
}

pub struct OpenAiTranscriptionSession {
    model_id: String,
    pcm_chunks: Vec<Vec<i16>>,
    audio_samples: u64,
}

impl OpenAiTranscriptionSession {
    pub fn new(model_id: &str) -> Self {
        Self {
            model_id: model_id.into(),
            pcm_chunks: Vec::new(),
            audio_samples: 0,
        }
    }

    /// Accumulates 16 kHz mono f32 (the service resamples upstream).
    pub fn feed_audio(&mut self, samples: &[f32]) -> Result<(), String> {
        self.audio_samples += samples.len() as u64;
        if self.audio_samples > MAX_CLOUD_AUDIO_SAMPLES {
            return Err("Cloud transcription is limited to 10 minutes per dictation".into());
        }
        self.pcm_chunks.push(
            samples
                .iter()
                .map(|sample| {
                    let clamped = sample.clamp(-1.0, 1.0);
                    let value = if clamped < 0.0 {
                        clamped * 32768.0
                    } else {
                        clamped * 32767.0
                    };
                    value.round() as i16
                })
                .collect(),
        );
        Ok(())
    }

    pub fn audio_seconds(&self) -> u64 {
        self.audio_samples / CLOUD_TRANSCRIPTION_SAMPLE_RATE as u64
    }

    pub async fn finish(self, client: &reqwest::Client, api_key: &str) -> Result<String, String> {
        self.finish_to(client, api_key, TRANSCRIPTION_URL).await
    }

    pub(crate) async fn finish_to(
        self,
        client: &reqwest::Client,
        api_key: &str,
        url: &str,
    ) -> Result<String, String> {
        if self.pcm_chunks.is_empty() {
            return Ok(String::new());
        }
        let api_model = api_model_for(&self.model_id)
            .ok_or_else(|| format!("unknown_model:{}", self.model_id))?;
        let samples: Vec<f32> = self
            .pcm_chunks
            .iter()
            .flatten()
            .map(|sample| *sample as f32 / 32768.0)
            .collect();
        let wav = encode_pcm16_wav(&samples, CLOUD_TRANSCRIPTION_SAMPLE_RATE);
        let form = reqwest::multipart::Form::new()
            .text("model", api_model.to_string())
            .text("response_format", "json".to_string())
            // Why: a named WAV part avoids filesystem temp files in packaged apps.
            .part(
                "file",
                reqwest::multipart::Part::bytes(wav)
                    .file_name("dictation.wav")
                    .mime_str("audio/wav")
                    .map_err(|e| format!("transcription_failed:bad mime: {e}"))?,
            );
        let response = tokio::time::timeout(
            Duration::from_secs(120),
            client
                .post(url)
                .header("Authorization", format!("Bearer {api_key}"))
                .multipart(form)
                .send(),
        )
        .await
        .map_err(|_| "transcription_failed:request timed out".to_string())?
        .map_err(|e| {
            format!(
                "transcription_failed:{}",
                sanitize_transcription_error(&e.to_string())
            )
        })?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            let message = serde_json::from_str::<serde_json::Value>(&body)
                .ok()
                .and_then(|json| {
                    json.get("error")
                        .and_then(|error| error.get("message"))
                        .and_then(|message| message.as_str())
                        .map(str::to_string)
                })
                .map(|message| sanitize_transcription_error(&message))
                .unwrap_or_else(|| format!("HTTP {status}"));
            return Err(format!("transcription_failed:{message}"));
        }
        let text = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|json| {
                json.get("text")
                    .and_then(|text| text.as_str())
                    .map(str::to_string)
            })
            .map(|text| text.trim().to_string())
            .ok_or_else(|| "transcription_failed:no text in response".to_string())?;
        Ok(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn wav_header_is_byte_exact() {
        let wav = encode_pcm16_wav(&[0.0, 1.0, -1.0, 0.5], 16000);
        assert_eq!(wav.len(), 44 + 8);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(
            u32::from_le_bytes(wav[4..8].try_into().expect("len")),
            36 + 8
        );
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(u32::from_le_bytes(wav[16..20].try_into().expect("len")), 16);
        assert_eq!(u16::from_le_bytes(wav[20..22].try_into().expect("len")), 1);
        assert_eq!(u16::from_le_bytes(wav[22..24].try_into().expect("len")), 1);
        assert_eq!(
            u32::from_le_bytes(wav[24..28].try_into().expect("len")),
            16000
        );
        assert_eq!(
            u32::from_le_bytes(wav[28..32].try_into().expect("len")),
            32000
        );
        assert_eq!(u16::from_le_bytes(wav[32..34].try_into().expect("len")), 2);
        assert_eq!(u16::from_le_bytes(wav[34..36].try_into().expect("len")), 16);
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(u32::from_le_bytes(wav[40..44].try_into().expect("len")), 8);
        // 0.0 → 0; 1.0 → 32767; -1.0 → -32768; 0.5 → 16384 (rounded).
        assert_eq!(i16::from_le_bytes(wav[44..46].try_into().expect("len")), 0);
        assert_eq!(
            i16::from_le_bytes(wav[46..48].try_into().expect("len")),
            32767
        );
        assert_eq!(
            i16::from_le_bytes(wav[48..50].try_into().expect("len")),
            -32768
        );
        assert_eq!(
            i16::from_le_bytes(wav[50..52].try_into().expect("len")),
            16384
        );
    }

    #[test]
    fn sanitize_redacts_key_material() {
        assert_eq!(
            sanitize_transcription_error("Incorrect API key provided: sk-abc123. Foo."),
            "Incorrect OpenAI API key provided."
        );
        assert_eq!(
            sanitize_transcription_error("call with sk-abc_123 failed"),
            "call with [redacted] failed"
        );
        assert_eq!(
            sanitize_transcription_error("auth Bearer abc.DEF+123== broken"),
            "auth Bearer [redacted] broken"
        );
        assert_eq!(
            sanitize_transcription_error("   "),
            "OpenAI transcription request failed"
        );
    }

    #[test]
    fn session_cap_boundary() {
        let mut session = OpenAiTranscriptionSession::new("openai-gpt-4o-mini-transcribe");
        // Exactly 10 minutes is accepted; one sample more is not.
        session
            .feed_audio(&vec![0.0; MAX_CLOUD_AUDIO_SAMPLES as usize])
            .expect("cap is exclusive");
        assert_eq!(session.audio_seconds(), 600);
        assert!(session.feed_audio(&[0.0]).is_err());
    }

    #[test]
    fn api_model_map() {
        assert_eq!(
            api_model_for("openai-gpt-4o-mini-transcribe"),
            Some("gpt-4o-mini-transcribe")
        );
        assert_eq!(
            api_model_for("openai-gpt-4o-transcribe"),
            Some("gpt-4o-transcribe")
        );
        assert_eq!(api_model_for("whisper-tiny"), None);
    }

    struct MockTranscription {
        url: String,
        seen_auth: Arc<std::sync::Mutex<Option<String>>>,
        seen_body_markers: Arc<std::sync::Mutex<Vec<String>>>,
    }

    async fn start_mock(status: u16, json: &'static str) -> MockTranscription {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("addr");
        let seen_auth = Arc::new(Mutex::new(None));
        let seen_body_markers = Arc::new(Mutex::new(Vec::new()));
        let auth_sink = seen_auth.clone();
        let markers_sink = seen_body_markers.clone();
        tokio::spawn(async move {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let mut raw = Vec::new();
            let mut buf = [0u8; 8192];
            let content_length = loop {
                match socket.read(&mut buf).await {
                    Ok(0) => return,
                    Ok(n) => {
                        raw.extend_from_slice(&buf[..n]);
                        if let Some(end) = find_header_end(&raw) {
                            let head = String::from_utf8_lossy(&raw[..end]).to_lowercase();
                            if let Some(length) = head.lines().find_map(|line| {
                                line.split_once(':').and_then(|(name, value)| {
                                    (name.trim() == "content-length")
                                        .then(|| value.trim().parse::<usize>().ok())
                                        .flatten()
                                })
                            }) {
                                break length;
                            }
                            break 0;
                        }
                        if raw.len() > 4 * 1024 * 1024 {
                            return;
                        }
                    }
                    Err(_) => return,
                }
            };
            while raw.len() < content_length + header_len(&raw) {
                match socket.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => raw.extend_from_slice(&buf[..n]),
                    Err(_) => break,
                }
            }
            let text = String::from_utf8_lossy(&raw);
            *auth_sink.lock().expect("lock") = text.lines().find_map(|line| {
                line.split_once(':').and_then(|(name, value)| {
                    name.trim()
                        .eq_ignore_ascii_case("authorization")
                        .then(|| value.trim().to_string())
                })
            });
            let found: Vec<String> = [
                "name=\"model\"",
                "gpt-4o-mini-transcribe",
                "name=\"response_format\"",
                "filename=\"dictation.wav\"",
                "audio/wav",
                "RIFF",
            ]
            .into_iter()
            .filter(|marker| text.contains(marker))
            .map(str::to_string)
            .collect();
            markers_sink.lock().expect("lock").extend(found);
            let reason = if status == 200 { "OK" } else { "Error" };
            let response = format!(
                "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{json}",
                json.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
        });
        MockTranscription {
            url: format!("http://{addr}/v1/audio/transcriptions"),
            seen_auth,
            seen_body_markers,
        }
    }

    fn find_header_end(raw: &[u8]) -> Option<usize> {
        raw.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4)
    }

    fn header_len(raw: &[u8]) -> usize {
        find_header_end(raw).unwrap_or(0)
    }

    #[tokio::test]
    async fn posts_multipart_with_auth_and_parses_text() {
        let mock = start_mock(200, r#"{"text":"  hello world  "}"#).await;
        let client = crate::voice::http_client::build_voice_http_client().expect("client");
        let mut session = OpenAiTranscriptionSession::new("openai-gpt-4o-mini-transcribe");
        session.feed_audio(&[0.1; 1600]).expect("feed");
        let text = session
            .finish_to(&client, "sk-test-key", &mock.url)
            .await
            .expect("transcribes");
        assert_eq!(text, "hello world");
        assert_eq!(
            mock.seen_auth.lock().expect("lock").as_deref(),
            Some("Bearer sk-test-key")
        );
        let markers = mock.seen_body_markers.lock().expect("lock").clone();
        for marker in [
            "name=\"model\"",
            "gpt-4o-mini-transcribe",
            "filename=\"dictation.wav\"",
            "audio/wav",
        ] {
            assert!(
                markers.contains(&marker.to_string()),
                "missing {marker}: {markers:?}"
            );
        }
    }

    #[tokio::test]
    async fn maps_provider_errors_without_leaking_keys() {
        let mock = start_mock(
            401,
            r#"{"error":{"message":"Incorrect API key provided: sk-abc123. Check it."}}"#,
        )
        .await;
        let client = crate::voice::http_client::build_voice_http_client().expect("client");
        let mut session = OpenAiTranscriptionSession::new("openai-gpt-4o-mini-transcribe");
        session.feed_audio(&[0.1; 160]).expect("feed");
        let err = session
            .finish_to(&client, "sk-abc123", &mock.url)
            .await
            .expect_err("provider error");
        assert_eq!(
            err,
            "transcription_failed:Incorrect OpenAI API key provided."
        );
        assert!(!err.contains("sk-abc123"));
    }

    #[tokio::test]
    async fn empty_session_finishes_silently() {
        let client = crate::voice::http_client::build_voice_http_client().expect("client");
        let session = OpenAiTranscriptionSession::new("openai-gpt-4o-mini-transcribe");
        assert_eq!(
            session
                .finish_to(&client, "sk-x", "http://127.0.0.1:1/")
                .await
                .expect("empty"),
            ""
        );
    }
}
