// Voice runtime state: model catalog + per-model states served by the Rust
// backend, plus live dictation state. Settings (enable/model/mic) stay in
// settingsDataSlice; this is the backend-driven + session-driven half.

import {
  cancelVoiceDownload,
  deleteVoiceModel,
  downloadVoiceModel,
  getVoiceCatalog,
  getVoiceModelStates,
} from "../../lib/voice/transport";
import type {
  DictationState,
  SpeechModelManifest,
  SpeechModelState,
} from "../../lib/voice/voiceTypes";
import type { TerminalState } from "../terminalStore";

type Set = (
  partial:
    | Partial<TerminalState>
    | ((state: TerminalState) => Partial<TerminalState>),
) => void;

export interface VoiceSlice {
  catalog: SpeechModelManifest[];
  modelStates: SpeechModelState[];
  dictationState: DictationState;
  partialTranscript: string;
  refreshCatalog: () => Promise<void>;
  refreshModelStates: () => Promise<void>;
  setDictationState: (state: DictationState) => void;
  setPartialTranscript: (text: string) => void;
  // Idempotent per (modelId, progress): repeat events are no-ops so a
  // progress storm never thrashes subscribers (Orca stabilisation parity).
  applyModelProgress: (modelId: string, progress: number) => void;
  downloadModel: (modelId: string) => Promise<void>;
  cancelDownload: (modelId: string) => Promise<void>;
  deleteVoiceModel: (modelId: string) => Promise<void>;
}

export function createVoiceSlice(
  set: Set,
  get: () => TerminalState,
): VoiceSlice {
  return {
    catalog: [],
    modelStates: [],
    dictationState: "idle",
    partialTranscript: "",

    refreshCatalog: async () => {
      try {
        set({ catalog: await getVoiceCatalog() });
      } catch {
        // Backend unreachable (tests, early boot) — pane keeps stub/empty list.
      }
    },

    refreshModelStates: async () => {
      try {
        set({ modelStates: await getVoiceModelStates() });
      } catch {
        // Same tolerance as catalog: states hydrate on the next refresh.
      }
    },

    setDictationState: (state) => {
      set({ dictationState: state });
    },

    setPartialTranscript: (text) => {
      if (get().partialTranscript === text) return;
      set({ partialTranscript: text });
    },

    applyModelProgress: (modelId, progress) => {
      const states = get().modelStates;
      const idx = states.findIndex((s) => s.id === modelId);
      if (idx === -1) {
        set({ modelStates: [...states, { id: modelId, status: "downloading", progress }] });
        return;
      }
      const current = states[idx];
      if (current.status === "downloading" && current.progress === progress) return;
      const next = [...states];
      next[idx] = { ...current, status: "downloading", progress };
      set({ modelStates: next });
    },

    downloadModel: async (modelId) => {
      set((state) => ({
        modelStates: state.modelStates.some((s) => s.id === modelId)
          ? state.modelStates.map((s) =>
              s.id === modelId ? { ...s, status: "downloading" as const, progress: 0 } : s,
            )
          : [...state.modelStates, { id: modelId, status: "downloading" as const, progress: 0 }],
      }));
      try {
        await downloadVoiceModel(modelId);
      } finally {
        // The backend owns the terminal state (ready/error); re-read it rather
        // than guessing from invoke resolution.
        await get().refreshModelStates();
      }
    },

    cancelDownload: async (modelId) => {
      try {
        await cancelVoiceDownload(modelId);
      } finally {
        await get().refreshModelStates();
      }
    },

    deleteVoiceModel: async (modelId) => {
      await deleteVoiceModel(modelId);
      // The backend clears settings.json; mirror it in memory so a dangling
      // selection never points at a deleted model.
      if (get().settings.voice.sttModel === modelId) {
        get().updateSettings({ voice: { sttModel: "" } });
      }
      await get().refreshModelStates();
    },
  };
}
