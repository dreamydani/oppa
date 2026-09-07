import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTerminalStore } from "../terminalStore";
import * as voiceTransport from "../../lib/voice/transport";
import type {
  SpeechModelManifest,
  SpeechModelState,
} from "../../lib/voice/voiceTypes";

vi.mock("../../lib/voice/transport", () => ({
  VOICE_DESKTOP_SESSION_ID: "desktop",
  getVoiceCatalog: vi.fn(),
  getVoiceModelStates: vi.fn(),
  downloadVoiceModel: vi.fn(),
  cancelVoiceDownload: vi.fn(),
  deleteVoiceModel: vi.fn(),
}));

const getCatalogMock = vi.mocked(voiceTransport.getVoiceCatalog);
const getStatesMock = vi.mocked(voiceTransport.getVoiceModelStates);
const downloadMock = vi.mocked(voiceTransport.downloadVoiceModel);
const cancelMock = vi.mocked(voiceTransport.cancelVoiceDownload);
const deleteMock = vi.mocked(voiceTransport.deleteVoiceModel);

const CATALOG: SpeechModelManifest[] = [
  {
    id: "whisper-tiny",
    label: "Whisper Tiny",
    description: "90+ languages.",
    type: "whisper",
    provider: "local",
    language: "multilingual",
    sizeBytes: 152969611,
    sampleRate: 16000,
    streaming: false,
  },
];

const STATES: SpeechModelState[] = [{ id: "whisper-tiny", status: "ready" }];

describe("voiceSlice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTerminalStore.setState({
      catalog: [],
      modelStates: [],
      dictationState: "idle",
      partialTranscript: "",
    });
    getCatalogMock.mockResolvedValue(CATALOG);
    getStatesMock.mockResolvedValue(STATES);
    downloadMock.mockResolvedValue(undefined);
  });

  it("starts idle with empty catalog and states", () => {
    const s = useTerminalStore.getState();
    expect(s.dictationState).toBe("idle");
    expect(s.partialTranscript).toBe("");
    expect(s.catalog).toEqual([]);
    expect(s.modelStates).toEqual([]);
  });

  it("refreshCatalog and refreshModelStates hydrate from transport", async () => {
    const s = useTerminalStore.getState();
    await s.refreshCatalog();
    await s.refreshModelStates();
    expect(useTerminalStore.getState().catalog).toEqual(CATALOG);
    expect(useTerminalStore.getState().modelStates).toEqual(STATES);
  });

  it("tolerates transport failures without clobbering state", async () => {
    getCatalogMock.mockRejectedValueOnce(new Error("no backend"));
    getStatesMock.mockRejectedValueOnce(new Error("no backend"));
    const s = useTerminalStore.getState();
    await s.refreshCatalog();
    await s.refreshModelStates();
    expect(useTerminalStore.getState().catalog).toEqual([]);
    expect(useTerminalStore.getState().modelStates).toEqual([]);
  });

  it("transitions dictation state and partial transcript", () => {
    const s = useTerminalStore.getState();
    s.setDictationState("listening");
    expect(useTerminalStore.getState().dictationState).toBe("listening");
    s.setPartialTranscript("hello");
    expect(useTerminalStore.getState().partialTranscript).toBe("hello");
    s.setDictationState("idle");
    s.setPartialTranscript("");
    expect(useTerminalStore.getState().dictationState).toBe("idle");
    expect(useTerminalStore.getState().partialTranscript).toBe("");
  });

  it("applyModelProgress dedupes repeat events for the same progress", () => {
    const s = useTerminalStore.getState();
    const setSpy: string[] = [];
    const unsub = useTerminalStore.subscribe((state, prev) => {
      if (state.modelStates !== prev.modelStates) setSpy.push("changed");
    });
    try {
      s.applyModelProgress("whisper-tiny", 0.5);
      s.applyModelProgress("whisper-tiny", 0.5);
      s.applyModelProgress("whisper-tiny", 0.5);
      s.applyModelProgress("whisper-tiny", 0.75);
      expect(setSpy).toHaveLength(2);
      expect(useTerminalStore.getState().modelStates).toEqual([
        { id: "whisper-tiny", status: "downloading", progress: 0.75 },
      ]);
    } finally {
      unsub();
    }
  });

  it("downloadModel marks downloading then refreshes terminal state", async () => {
    const s = useTerminalStore.getState();
    await s.downloadModel("whisper-tiny");
    expect(downloadMock).toHaveBeenCalledWith("whisper-tiny");
    // Backend owns the terminal state: stub resolves to ready via refresh.
    expect(useTerminalStore.getState().modelStates).toEqual(STATES);
  });

  it("downloadModel refreshes states even when the invoke rejects", async () => {
    downloadMock.mockRejectedValueOnce(new Error("offline"));
    // The failure still surfaces to the caller (pane shows a retry); the
    // finally-refresh guarantees states reflect the backend either way.
    await expect(useTerminalStore.getState().downloadModel("whisper-tiny")).rejects.toThrow(
      "offline",
    );
    expect(useTerminalStore.getState().modelStates).toEqual(STATES);
  });

  it("cancelDownload invokes the backend then refreshes states", async () => {
    cancelMock.mockResolvedValueOnce(undefined);
    await useTerminalStore.getState().cancelDownload("whisper-tiny");
    expect(cancelMock).toHaveBeenCalledWith("whisper-tiny");
    expect(useTerminalStore.getState().modelStates).toEqual(STATES);
  });

  it("deleteVoiceModel clears a dangling sttModel selection", async () => {
    deleteMock.mockResolvedValueOnce(undefined);
    useTerminalStore.setState({
      settings: {
        ...useTerminalStore.getState().settings,
        voice: { ...useTerminalStore.getState().settings.voice, sttModel: "whisper-tiny" },
      },
    });
    await useTerminalStore.getState().deleteVoiceModel("whisper-tiny");
    expect(deleteMock).toHaveBeenCalledWith("whisper-tiny");
    expect(useTerminalStore.getState().settings.voice.sttModel).toBe("");
  });

  it("deleteVoiceModel keeps an unrelated sttModel selection", async () => {
    deleteMock.mockResolvedValueOnce(undefined);
    useTerminalStore.setState({
      settings: {
        ...useTerminalStore.getState().settings,
        voice: { ...useTerminalStore.getState().settings.voice, sttModel: "parakeet-tdt-0.6b-v3-int8" },
      },
    });
    await useTerminalStore.getState().deleteVoiceModel("whisper-tiny");
    expect(useTerminalStore.getState().settings.voice.sttModel).toBe("parakeet-tdt-0.6b-v3-int8");
  });
});
