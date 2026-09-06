import React, { useEffect, useState } from "react";
import { useTerminalStore } from "../../store/terminalStore";
import type { DictationMode, SpeechModelManifest } from "../../lib/voice/voiceTypes";
import "./GeneralSettingsPane.css";
import "./VoiceSettingsPane.css";

// Slice 1 stub: static catalog mirroring Orca's model-catalog entries
// (ids, labels, descriptions, sizes). Replaced by the live backend catalog
// in Slice 2/4; download/delete actions stay disabled until then.
export const STUB_VOICE_CATALOG: SpeechModelManifest[] = [
  {
    id: "parakeet-tdt-0.6b-v3-int8",
    label: "Parakeet TDT v3",
    description: "Highest accuracy for 25 European languages. Punctuation, capitalization, and word-level timestamps.",
    type: "transducer",
    provider: "local",
    language: "multilingual",
    sizeBytes: 670478772,
    sampleRate: 16000,
    streaming: false,
    modelingUnit: "bpe",
    recommended: true,
  },
  {
    id: "parakeet-tdt-0.6b-v2-int8",
    label: "Parakeet TDT v2",
    description: "English only. Faster than v3 with similar accuracy. Punctuation and capitalization.",
    type: "transducer",
    provider: "local",
    language: "en",
    sizeBytes: 661190513,
    sampleRate: 16000,
    streaming: false,
    modelingUnit: "bpe",
  },
  {
    id: "zipformer-bilingual-zh-en",
    label: "Zipformer Bilingual",
    description: "Chinese + English with code-switching. Low-latency real-time streaming.",
    type: "transducer",
    provider: "local",
    language: "zh-en",
    sizeBytes: 356862456,
    sampleRate: 16000,
    streaming: true,
    modelingUnit: "cjkchar+bpe",
  },
  {
    id: "paraformer-bilingual-zh-en",
    label: "Paraformer Bilingual",
    description: "Chinese (Mandarin + dialects) + English. Strong on accented and regional Chinese.",
    type: "paraformer",
    provider: "local",
    language: "zh-en",
    sizeBytes: 237202501,
    sampleRate: 16000,
    streaming: true,
  },
  {
    id: "zipformer-streaming-en-20m",
    label: "Zipformer Streaming EN",
    description: "English only. Lightweight 20M-param model, good balance of speed and size.",
    type: "transducer",
    provider: "local",
    language: "en",
    sizeBytes: 91928372,
    sampleRate: 16000,
    streaming: true,
    modelingUnit: "bpe",
  },
  {
    id: "zipformer-streaming-zh-14m",
    label: "Zipformer Streaming ZH",
    description: "Chinese only. Ultra-lightweight 14M-param model, ideal for low-resource devices.",
    type: "transducer",
    provider: "local",
    language: "zh",
    sizeBytes: 55716588,
    sampleRate: 16000,
    streaming: true,
    modelingUnit: "cjkchar",
  },
  {
    id: "zipformer-streaming-korean",
    label: "Zipformer Streaming KO",
    description: "Korean only. Low-latency real-time streaming.",
    type: "transducer",
    provider: "local",
    language: "ko",
    sizeBytes: 132455201,
    sampleRate: 16000,
    streaming: true,
    modelingUnit: "bpe",
  },
  {
    id: "parakeet-tdt-ctc-0.6b-ja-int8",
    label: "Parakeet TDT-CTC JA",
    description: "Japanese only. Trained on 35k+ hours of natural speech. Punctuation included.",
    type: "nemo-ctc",
    provider: "local",
    language: "ja",
    sizeBytes: 655571161,
    sampleRate: 16000,
    streaming: false,
  },
  {
    id: "whisper-tiny",
    label: "Whisper Tiny",
    description: "90+ languages. Lower accuracy than Parakeet but broadest language coverage.",
    type: "whisper",
    provider: "local",
    language: "multilingual",
    sizeBytes: 152969611,
    sampleRate: 16000,
    streaming: false,
  },
  {
    id: "sense-voice-zh-en-ja-ko-yue",
    label: "SenseVoice",
    description: "Chinese, English, Japanese, Korean, and Cantonese with automatic language detection.",
    type: "senseVoice",
    provider: "local",
    language: "multilingual",
    sizeBytes: 239549735,
    sampleRate: 16000,
    streaming: false,
  },
  {
    id: "openai-gpt-4o-mini-transcribe",
    label: "GPT-4o mini Transcribe",
    description: "Cloud transcription with strong accuracy and low cost. Requires an OpenAI API key.",
    type: "openai",
    provider: "openai",
    language: "multilingual",
    sampleRate: 16000,
    streaming: false,
  },
  {
    id: "openai-gpt-4o-transcribe",
    label: "GPT-4o Transcribe",
    description: "Cloud transcription with higher accuracy. Requires an OpenAI API key.",
    type: "openai",
    provider: "openai",
    language: "multilingual",
    sampleRate: 16000,
    streaming: false,
  },
];

function formatModelSize(sizeBytes?: number): string {
  if (sizeBytes === undefined) return "";
  const mb = sizeBytes / (1024 * 1024);
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

interface MicDevice {
  deviceId: string;
  label: string;
}

export function VoiceSettingsPane(): React.ReactElement {
  const voice = useTerminalStore((s) => s.settings.voice);
  const updateSettings = useTerminalStore((s) => s.updateSettings);
  const [micDevices, setMicDevices] = useState<MicDevice[]>([]);

  // List already-permitted devices for the picker; no new permission prompt
  // in this slice (live capture + permission flow arrive in Slice 3).
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        if (!navigator.mediaDevices?.enumerateDevices) return;
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (cancelled) return;
        setMicDevices(
          devices
            .filter((d) => d.kind === "audioinput")
            .map((d, i) => ({
              deviceId: d.deviceId,
              label: d.label || `Microphone ${i + 1}`,
            }))
            .filter((d) => d.deviceId !== ""),
        );
      } catch {
        // Unavailable (no media stack in tests/SSR) — picker keeps System default.
      }
    };
    void refresh();
    try {
      navigator.mediaDevices?.addEventListener("devicechange", refresh);
    } catch {
      // Older stacks without EventTarget on mediaDevices.
    }
    return () => {
      cancelled = true;
      try {
        navigator.mediaDevices?.removeEventListener("devicechange", refresh);
      } catch {
        // Ignore teardown on stacks without removeEventListener.
      }
    };
  }, []);

  const toggleEnabled = () => {
    updateSettings({ voice: { enabled: !voice.enabled } });
  };

  const setDictationMode = (mode: DictationMode) => {
    updateSettings({ voice: { dictationMode: mode } });
  };

  const setMicrophone = (deviceId: string) => {
    if (deviceId === "") {
      updateSettings({ voice: { microphoneDeviceId: null, microphoneDeviceLabel: null } });
      return;
    }
    const match = micDevices.find((d) => d.deviceId === deviceId);
    updateSettings({
      voice: { microphoneDeviceId: deviceId, microphoneDeviceLabel: match?.label ?? null },
    });
  };

  const setModel = (modelId: string) => {
    updateSettings({ voice: { sttModel: modelId } });
  };

  // Preferred device currently unplugged — keep its cached label visible.
  const preferredMissing =
    voice.microphoneDeviceId !== null &&
    micDevices.length > 0 &&
    !micDevices.some((d) => d.deviceId === voice.microphoneDeviceId);

  return (
    <div className="settings-pane" role="region" aria-label="Voice Settings">
      <div className="settings-pane-container">
        <div className="settings-pane-header">
          <h2 className="settings-pane-title">Voice</h2>
          <p className="settings-pane-desc">
            Local speech-to-text dictation. Speak into your microphone and have it transcribed into the focused terminal.
          </p>
        </div>

        <div className="settings-pane-content">
          <section className="settings-card" aria-labelledby="heading-voice-dictation">
            <h3 id="heading-voice-dictation" className="settings-card-title">
              Voice Dictation
            </h3>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Enable voice dictation</span>
                <span className="settings-row-desc">
                  Turn on microphone dictation. Press Ctrl+E (Cmd+E on Mac) to start and stop transcribing.
                </span>
              </div>
              <div className="settings-row-control">
                <button
                  type="button"
                  role="switch"
                  aria-checked={voice.enabled}
                  aria-label="Enable voice dictation"
                  className={`settings-switch ${voice.enabled ? "checked" : ""}`}
                  onClick={toggleEnabled}
                >
                  <span className="settings-switch-thumb" />
                </button>
              </div>
            </div>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Dictation mode</span>
                <span className="settings-row-desc">
                  Toggle starts and stops on each press; hold only records while the shortcut is held.
                </span>
              </div>
              <div className="settings-row-control">
                <div className="settings-segmented-group" role="group" aria-label="Dictation mode">
                  <button
                    type="button"
                    className={`settings-segmented-btn ${voice.dictationMode === "toggle" ? "active" : ""}`}
                    onClick={() => setDictationMode("toggle")}
                    disabled={!voice.enabled}
                  >
                    Toggle
                  </button>
                  <button
                    type="button"
                    className={`settings-segmented-btn ${voice.dictationMode === "hold" ? "active" : ""}`}
                    onClick={() => setDictationMode("hold")}
                    disabled={!voice.enabled}
                  >
                    Hold
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section className="settings-card" aria-labelledby="heading-voice-microphone">
            <h3 id="heading-voice-microphone" className="settings-card-title">
              Microphone
            </h3>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Input device</span>
                <span className="settings-row-desc">
                  Microphone used for dictation. Falls back to the system default when the selected device is unavailable.
                </span>
              </div>
              <div className="settings-row-control">
                <select
                  aria-label="Input device"
                  className="settings-select"
                  value={voice.microphoneDeviceId ?? ""}
                  onChange={(e) => setMicrophone(e.target.value)}
                  disabled={!voice.enabled}
                >
                  <option value="">System default</option>
                  {preferredMissing && (
                    <option value={voice.microphoneDeviceId ?? ""}>
                      {voice.microphoneDeviceLabel ?? "Selected microphone"} (unplugged)
                    </option>
                  )}
                  {micDevices.map((d) => (
                    <option key={d.deviceId} value={d.deviceId}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </section>

          <section className="settings-card" aria-labelledby="heading-voice-model">
            <h3 id="heading-voice-model" className="settings-card-title">
              Speech Model
            </h3>

            <p className="voice-stub-note" role="note">
              Model downloads arrive in the next slice — selecting a model below saves your choice but does not download anything yet.
            </p>

            <div className="voice-model-list" role="radiogroup" aria-label="Speech model">
              {STUB_VOICE_CATALOG.map((model) => {
                const selected = voice.sttModel === model.id;
                return (
                  <button
                    key={model.id}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={`${model.label}${model.recommended ? ", recommended" : ""}`}
                    className={`voice-model-row ${selected ? "selected" : ""}`}
                    onClick={() => setModel(model.id)}
                  >
                    <span className="voice-model-main">
                      <span className="voice-model-label">
                        {model.provider === "openai" && (
                          <span className="voice-model-cloud" aria-hidden="true">☁</span>
                        )}
                        {model.label}
                        {model.recommended && <span className="voice-model-badge recommended">Recommended</span>}
                      </span>
                      <span className="voice-model-desc">{model.description}</span>
                    </span>
                    <span className="voice-model-meta">
                      <span className="voice-model-badge">{model.streaming ? "Streaming" : "Offline"}</span>
                      <span className="voice-model-badge">{model.language}</span>
                      {model.sizeBytes !== undefined && (
                        <span className="voice-model-size">{formatModelSize(model.sizeBytes)}</span>
                      )}
                      <span className="voice-model-status">Not downloaded</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="settings-card" aria-labelledby="heading-voice-openai">
            <h3 id="heading-voice-openai" className="settings-card-title">
              OpenAI Transcription
            </h3>

            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">API key</span>
                <span className="settings-row-desc">
                  {voice.openAiApiKeyConfigured
                    ? "An OpenAI API key is configured for cloud transcription."
                    : "No OpenAI API key configured. Cloud models need one — key setup arrives in a later slice."}
                </span>
              </div>
              <div className="settings-row-control">
                <button
                  type="button"
                  className="settings-segmented-btn"
                  disabled
                  title="Available in a later slice"
                >
                  Configure
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
