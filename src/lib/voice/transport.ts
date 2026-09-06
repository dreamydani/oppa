import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  DictationMode,
  SpeechErrorEvent,
  SpeechLifecycleEvent,
  SpeechModelManifest,
  SpeechModelState,
  SpeechTranscriptEvent,
  VoiceSettings,
} from "./voiceTypes";

export type { VoiceSettings, DictationMode };

// Orca parity: every dictation session carries an id; the desktop surface
// uses 'desktop' so later pane-level sessions cannot collide with it.
export const VOICE_DESKTOP_SESSION_ID = "desktop";

export type Unlisten = () => void;

// Wire payloads (snake_case, mirrors src-tauri/src/voice/commands.rs).
interface DownloadProgressWire {
  model_id?: string;
  modelId?: string;
  progress: number;
}

export interface DownloadProgress {
  modelId: string;
  progress: number;
}

function normalizeProgress(raw: DownloadProgressWire): DownloadProgress {
  return { modelId: raw.modelId ?? raw.model_id ?? "", progress: raw.progress };
}

function normalizeTranscript<T extends { sessionId?: string; session_id?: string }>(
  raw: T,
): Omit<T, "session_id"> & { sessionId: string } {
  const { session_id, ...rest } = raw;
  return { ...rest, sessionId: raw.sessionId ?? session_id ?? "" };
}

// Audio wire format: base64 of f32 little-endian bytes. Tauri invoke is JSON,
// so a raw Float32Array would serialize as a 4x-larger number array; base64
// keeps 4096-sample chunks small and the backend validates shape on receipt.
export function encodeAudioSamples(samples: Float32Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function getVoiceCatalog(): Promise<SpeechModelManifest[]> {
  return invoke<SpeechModelManifest[]>("voice_get_catalog");
}

export function getVoiceModelStates(): Promise<SpeechModelState[]> {
  return invoke<SpeechModelState[]>("voice_get_model_states");
}

export function getVoiceKeyStatus(): Promise<{ configured: boolean }> {
  return invoke<{ configured: boolean }>("voice_get_key_status");
}

export function saveVoiceApiKey(key: string): Promise<{ configured: boolean }> {
  return invoke<{ configured: boolean }>("voice_save_key", { key });
}

export function clearVoiceApiKey(): Promise<{ configured: boolean }> {
  return invoke<{ configured: boolean }>("voice_clear_key");
}

export function downloadVoiceModel(modelId: string): Promise<void> {
  return invoke("voice_download_model", { model_id: modelId });
}

export function cancelVoiceDownload(modelId: string): Promise<void> {
  return invoke("voice_cancel_download", { model_id: modelId });
}

export function deleteVoiceModel(modelId: string): Promise<void> {
  return invoke("voice_delete_model", { model_id: modelId });
}

export function startVoiceDictation(
  modelId: string,
  hotwords?: string[],
  sessionId: string = VOICE_DESKTOP_SESSION_ID,
): Promise<void> {
  return invoke("voice_start_dictation", {
    model_id: modelId,
    hotwords: hotwords ?? null,
    session_id: sessionId,
  });
}

export function feedVoiceAudio(
  samples: Float32Array,
  sampleRate: number,
  sessionId: string = VOICE_DESKTOP_SESSION_ID,
): Promise<void> {
  return invoke("voice_feed_audio", {
    samples_b64: encodeAudioSamples(samples),
    sample_rate: sampleRate,
    session_id: sessionId,
  });
}

export function stopVoiceDictation(
  sessionId: string = VOICE_DESKTOP_SESSION_ID,
): Promise<void> {
  return invoke("voice_stop_dictation", { session_id: sessionId });
}

export async function onVoicePartial(
  cb: (e: SpeechTranscriptEvent) => void,
): Promise<Unlisten> {
  return listen<SpeechTranscriptEvent>("voice://partial", (e) =>
    cb(normalizeTranscript(e.payload)),
  );
}

export async function onVoiceFinal(cb: (e: SpeechTranscriptEvent) => void): Promise<Unlisten> {
  return listen<SpeechTranscriptEvent>("voice://final", (e) => cb(normalizeTranscript(e.payload)));
}

export async function onVoiceDownloadProgress(
  cb: (e: DownloadProgress) => void,
): Promise<Unlisten> {
  return listen<DownloadProgressWire>("voice://download-progress", (e) =>
    cb(normalizeProgress(e.payload)),
  );
}

export async function onVoiceReady(cb: (e: SpeechLifecycleEvent) => void): Promise<Unlisten> {
  return listen<SpeechLifecycleEvent>("voice://ready", (e) => cb(normalizeTranscript(e.payload)));
}

export async function onVoiceStopped(
  cb: (e: SpeechLifecycleEvent) => void,
): Promise<Unlisten> {
  return listen<SpeechLifecycleEvent>("voice://stopped", (e) =>
    cb(normalizeTranscript(e.payload)),
  );
}

export async function onVoiceError(cb: (e: SpeechErrorEvent) => void): Promise<Unlisten> {
  return listen<SpeechErrorEvent>("voice://error", (e) => cb(normalizeTranscript(e.payload)));
}
