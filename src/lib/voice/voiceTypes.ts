// Voice dictation settings types — 1:1 port of Orca's `speech-types.ts`
// (algorithms and UX ported, no verbatim copy). Full STT engine, model
// catalog service, and live transcription land in later slices; this module
// is only the settings document shape plus shared UI types.

export type SpeechModelType =
  | "transducer"
  | "paraformer"
  | "whisper"
  | "senseVoice"
  | "nemo-ctc"
  | "openai";

export type SpeechModelProvider = "local" | "openai";

export type ModelingUnit = "bpe" | "cjkchar" | "cjkchar+bpe";

export interface SpeechModelDownloadFile {
  name: string;
  url: string;
  sizeBytes: number;
  sha256: string;
}

export interface SpeechModelManifest {
  id: string;
  label: string;
  description: string;
  type: SpeechModelType;
  provider: SpeechModelProvider;
  language: string;
  sizeBytes?: number;
  downloadFiles?: SpeechModelDownloadFile[];
  files?: string[];
  sampleRate: number;
  streaming: boolean;
  modelingUnit?: ModelingUnit;
  recommended?: boolean;
}

export type SpeechModelStatus =
  | "not-downloaded"
  | "downloading"
  | "extracting"
  | "ready"
  | "error";

export interface SpeechModelState {
  id: string;
  status: SpeechModelStatus;
  progress?: number;
  error?: string;
}

export interface SpeechTranscriptEvent {
  text: string;
  sessionId: string;
}

export interface SpeechLifecycleEvent {
  sessionId: string;
}

export interface SpeechErrorEvent {
  error: string;
  sessionId: string;
}

export type DictationState = "idle" | "starting" | "listening" | "stopping" | "error";

export interface UserModelConfig {
  id: string;
  type: SpeechModelType;
  dir: string;
  sampleRate?: number;
}

export type DictationMode = "toggle" | "hold";

export interface VoiceSettings {
  enabled: boolean;
  sttModel: string;
  modelsDir: string;
  language: string;
  dictationMode: DictationMode;
  terminalConfirmBeforeInsert: boolean;
  userModels: UserModelConfig[];
  openAiApiKeyConfigured: boolean;
  /** null = system default input device */
  microphoneDeviceId: string | null;
  /** Cached label for display when the preferred device is unplugged */
  microphoneDeviceLabel: string | null;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  enabled: false,
  sttModel: "",
  modelsDir: "",
  language: "en",
  dictationMode: "toggle",
  terminalConfirmBeforeInsert: false,
  userModels: [],
  openAiApiKeyConfigured: false,
  microphoneDeviceId: null,
  microphoneDeviceLabel: null,
};
