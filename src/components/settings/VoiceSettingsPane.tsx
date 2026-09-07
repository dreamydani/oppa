import React, { useEffect, useState } from "react";
import { useTerminalStore } from "../../store/terminalStore";
import { onVoiceDownloadProgress } from "../../lib/voice/transport";
import {
  buildVoiceMicrophoneSelectOptions,
  listMicrophones,
  microphoneDeviceIdFromSelectValue,
  requestMicrophoneAccess,
  type VoiceMicrophoneDevice,
} from "../../lib/voice/microphoneDevices";
import type {
  DictationMode,
  SpeechModelManifest,
  SpeechModelState,
} from "../../lib/voice/voiceTypes";
import "./GeneralSettingsPane.css";
import "./VoiceSettingsPane.css";

function formatModelSize(sizeBytes?: number): string {
  if (sizeBytes === undefined) return "";
  const mb = sizeBytes / (1024 * 1024);
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

function statusLabel(state: SpeechModelState | undefined, progress?: number): string {
  if (!state || state.status === "not-downloaded") return "Not downloaded";
  if (state.status === "downloading") {
    const pct = Math.round(((progress ?? state.progress) ?? 0) * 100);
    return `${pct}%`;
  }
  if (state.status === "extracting") return "Extracting...";
  if (state.status === "ready") return "Ready";
  return state.error ? `Error: ${state.error}` : "Error";
}

function ModelRow({
  model,
  state,
  selected,
  downloading,
  onSelect,
  onDownload,
  onCancel,
  onDelete,
}: {
  model: SpeechModelManifest;
  state: SpeechModelState | undefined;
  selected: boolean;
  downloading: boolean;
  onSelect: () => void;
  onDownload: () => void;
  onCancel: () => void;
  onDelete: () => void;
}): React.ReactElement {
  const showDownload =
    model.provider === "local" &&
    (!state || state.status === "not-downloaded" || state.status === "error");
  const showDelete = model.provider === "local" && state?.status === "ready";
  return (
    <div
      role="radio"
      tabIndex={0}
      aria-checked={selected}
      aria-label={`${model.label}${model.recommended ? ", recommended" : ""}`}
      className={`voice-model-row ${selected ? "selected" : ""}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
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
        {showDownload ? (
          <button
            type="button"
            aria-label={`Download ${model.label}`}
            className="voice-model-download"
            disabled={downloading}
            onClick={(e) => {
              e.stopPropagation();
              onDownload();
            }}
          >
            Download
          </button>
        ) : (
          <span className="voice-model-status">
            {downloading ? statusLabel(state, state?.progress) : statusLabel(state)}
          </span>
        )}
        {downloading && (
          <button
            type="button"
            aria-label={`Cancel ${model.label} download`}
            className="voice-model-cancel"
            onClick={(e) => {
              e.stopPropagation();
              onCancel();
            }}
          >
            Cancel
          </button>
        )}
        {showDelete && (
          <button
            type="button"
            aria-label={`Delete ${model.label}`}
            title={`Delete ${model.label}`}
            className="voice-model-delete"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            Delete
          </button>
        )}
      </span>
    </div>
  );
}

export function VoiceSettingsPane(): React.ReactElement {
  const voice = useTerminalStore((s) => s.settings.voice);
  const updateSettings = useTerminalStore((s) => s.updateSettings);
  const catalog = useTerminalStore((s) => s.catalog);
  const modelStates = useTerminalStore((s) => s.modelStates);
  const refreshCatalog = useTerminalStore((s) => s.refreshCatalog);
  const refreshModelStates = useTerminalStore((s) => s.refreshModelStates);
  const downloadModel = useTerminalStore((s) => s.downloadModel);
  const cancelDownload = useTerminalStore((s) => s.cancelDownload);
  const deleteVoiceModel = useTerminalStore((s) => s.deleteVoiceModel);
  const applyModelProgress = useTerminalStore((s) => s.applyModelProgress);
  const [micDevices, setMicDevices] = useState<VoiceMicrophoneDevice[]>([]);
  // False until enumeration has produced a usable list — an un-enumerated
  // list must not flag the preferred mic as unplugged (Orca parity).
  const [devicesKnown, setDevicesKnown] = useState(false);
  const [requestingAccess, setRequestingAccess] = useState(false);

  // Catalog + states come from the backend; progress events patch the store
  // directly so a download storm never triggers a re-fetch loop.
  useEffect(() => {
    void refreshCatalog();
    void refreshModelStates();
    let unlisten: (() => void) | null = null;
    void onVoiceDownloadProgress(({ modelId, progress }) => {
      applyModelProgress(modelId, progress);
    }).then((fn) => {
      unlisten = fn;
    }).catch(() => {});
    return () => {
      unlisten?.();
    };
  }, [refreshCatalog, refreshModelStates, applyModelProgress]);

  // Picker listing driven by the device module; rescans on devicechange.
  // No hot-swap of an active capture here — that is Slice 6's concern.
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const list = await listMicrophones();
      if (cancelled) return;
      setMicDevices(list);
      if (list.length > 0) setDevicesKnown(true);
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

  const requestAccess = async () => {
    setRequestingAccess(true);
    try {
      await requestMicrophoneAccess();
      const list = await listMicrophones();
      setMicDevices(list);
      setDevicesKnown(true);
    } catch {
      // Denial keeps the picker on System default; capture surfaces the
      // named error when dictation actually starts (Slice 6).
    } finally {
      setRequestingAccess(false);
    }
  };

  const toggleEnabled = () => {
    updateSettings({ voice: { enabled: !voice.enabled } });
  };

  const setDictationMode = (mode: DictationMode) => {
    updateSettings({ voice: { dictationMode: mode } });
  };

  const setMicrophone = (selectValue: string) => {
    const deviceId = microphoneDeviceIdFromSelectValue(selectValue);
    if (deviceId === null) {
      updateSettings({ voice: { microphoneDeviceId: null, microphoneDeviceLabel: null } });
      return;
    }
    // Keep the cached label when re-selecting the currently unplugged device.
    const match = micDevices.find((d) => d.deviceId === deviceId);
    const label =
      match?.label ??
      (deviceId === voice.microphoneDeviceId ? voice.microphoneDeviceLabel : deviceId);
    updateSettings({
      voice: { microphoneDeviceId: deviceId, microphoneDeviceLabel: label },
    });
  };

  const setModel = (modelId: string) => {
    updateSettings({ voice: { sttModel: modelId } });
  };

  const handleDownload = (modelId: string) => {
    // Backend owns the terminal state; failures surface as the row's error
    // status via refresh (no toast infra in settings).
    void downloadModel(modelId).catch(() => {});
  };

  const handleCancel = (modelId: string) => {
    void cancelDownload(modelId).catch(() => {});
  };

  const handleDelete = (modelId: string) => {
    void deleteVoiceModel(modelId).catch(() => {});
  };

  const stateById = new Map(modelStates.map((s) => [s.id, s]));

  const micSelect = buildVoiceMicrophoneSelectOptions({
    devices: micDevices,
    devicesKnown,
    preferredDeviceId: voice.microphoneDeviceId,
    preferredDeviceLabel: voice.microphoneDeviceLabel,
    systemDefaultLabel: "System default",
    unavailableSuffix: "unplugged",
  });

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
                  value={micSelect.selectedValue}
                  onChange={(e) => setMicrophone(e.target.value)}
                  disabled={!voice.enabled}
                >
                  {micSelect.options.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                {micDevices.length === 0 && (
                  <button
                    type="button"
                    className="settings-segmented-btn voice-allow-access"
                    onClick={() => void requestAccess()}
                    disabled={!voice.enabled || requestingAccess}
                  >
                    {requestingAccess ? "Requesting…" : "Allow access"}
                  </button>
                )}
              </div>
            </div>
          </section>

          <section className="settings-card" aria-labelledby="heading-voice-model">
            <h3 id="heading-voice-model" className="settings-card-title">
              Speech Model
            </h3>

            {catalog.length === 0 ? (
              <p className="voice-stub-note" role="note">
                Loading speech models from the backend…
              </p>
            ) : (
              <div className="voice-model-list" role="radiogroup" aria-label="Speech model">
                {catalog.map((model) => (
                  <ModelRow
                    key={model.id}
                    model={model}
                    state={stateById.get(model.id)}
                    selected={voice.sttModel === model.id}
                    downloading={stateById.get(model.id)?.status === "downloading"}
                    onSelect={() => setModel(model.id)}
                    onDownload={() => handleDownload(model.id)}
                    onCancel={() => handleCancel(model.id)}
                    onDelete={() => handleDelete(model.id)}
                  />
                ))}
              </div>
            )}
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
