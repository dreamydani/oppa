import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, cleanup } from "@testing-library/react";
import { VoiceSettingsPane } from "./VoiceSettingsPane";
import { useTerminalStore } from "../../store/terminalStore";
import * as voiceTransport from "../../lib/voice/transport";
import * as micDevicesModule from "../../lib/voice/microphoneDevices";
import type {
  SpeechModelManifest,
  SpeechModelState,
} from "../../lib/voice/voiceTypes";
import { DEFAULT_APP_SETTINGS } from "../../lib/settings/types";

vi.mock("../../lib/voice/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof voiceTransport>();
  return {
    ...actual,
    getVoiceCatalog: vi.fn(),
    getVoiceModelStates: vi.fn(),
    downloadVoiceModel: vi.fn(),
    cancelVoiceDownload: vi.fn(),
    deleteVoiceModel: vi.fn(),
    getVoiceKeyStatus: vi.fn(),
    saveVoiceApiKey: vi.fn(),
    clearVoiceApiKey: vi.fn(),
    onVoiceDownloadProgress: vi.fn(),
  };
});

vi.mock("../../lib/voice/microphoneDevices", async (importOriginal) => {
  const actual = await importOriginal<typeof micDevicesModule>();
  return {
    ...actual,
    listMicrophones: vi.fn().mockResolvedValue([]),
    requestMicrophoneAccess: vi.fn().mockResolvedValue(undefined),
  };
});

const getCatalogMock = vi.mocked(voiceTransport.getVoiceCatalog);
const getStatesMock = vi.mocked(voiceTransport.getVoiceModelStates);
const downloadMock = vi.mocked(voiceTransport.downloadVoiceModel);
const cancelMock = vi.mocked(voiceTransport.cancelVoiceDownload);
const deleteMock = vi.mocked(voiceTransport.deleteVoiceModel);
const onProgressMock = vi.mocked(voiceTransport.onVoiceDownloadProgress);
const getKeyStatusMock = vi.mocked(voiceTransport.getVoiceKeyStatus);
const saveKeyMock = vi.mocked(voiceTransport.saveVoiceApiKey);
const clearKeyMock = vi.mocked(voiceTransport.clearVoiceApiKey);
const listMicsMock = vi.mocked(micDevicesModule.listMicrophones);
const requestAccessMock = vi.mocked(micDevicesModule.requestMicrophoneAccess);

const CATALOG: SpeechModelManifest[] = [
  {
    id: "parakeet-tdt-0.6b-v3-int8",
    label: "Parakeet TDT v3",
    description: "Highest accuracy for 25 European languages.",
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
    id: "zipformer-streaming-en-20m",
    label: "Zipformer Streaming EN",
    description: "English only. Lightweight streaming.",
    type: "transducer",
    provider: "local",
    language: "en",
    sizeBytes: 91928372,
    sampleRate: 16000,
    streaming: true,
    modelingUnit: "bpe",
  },
  {
    id: "openai-gpt-4o-mini-transcribe",
    label: "GPT-4o mini Transcribe",
    description: "Cloud transcription. Requires an OpenAI API key.",
    type: "openai",
    provider: "openai",
    language: "multilingual",
    sampleRate: 16000,
    streaming: false,
  },
];

function seedStore() {
  useTerminalStore.setState({
    settings: JSON.parse(JSON.stringify(DEFAULT_APP_SETTINGS)),
    isSettingsOpen: true,
    activeSettingsTab: "voice",
    catalog: [],
    modelStates: [],
    dictationState: "idle",
    partialTranscript: "",
  });
}

describe("VoiceSettingsPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    seedStore();
    getCatalogMock.mockResolvedValue(CATALOG);
    getStatesMock.mockResolvedValue([]);
    downloadMock.mockResolvedValue(undefined);
    getKeyStatusMock.mockResolvedValue({ configured: false });
    saveKeyMock.mockResolvedValue({ configured: true });
    clearKeyMock.mockResolvedValue({ configured: false });
    onProgressMock.mockResolvedValue(vi.fn());
  });

  it("renders dictation, microphone, model, and OpenAI sections", async () => {
    render(<VoiceSettingsPane />);
    await act(async () => {});

    expect(screen.getByRole("heading", { name: /^voice$/i, level: 2 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /voice dictation/i, level: 3 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^microphone$/i, level: 3 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /speech model/i, level: 3 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /openai transcription/i, level: 3 })).toBeInTheDocument();
  });

  it("loads the catalog via invoke — no hardcoded list in the component", async () => {
    render(<VoiceSettingsPane />);
    await act(async () => {});

    expect(getCatalogMock).toHaveBeenCalledTimes(1);
    expect(getStatesMock).toHaveBeenCalledTimes(1);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(CATALOG.length);
    expect(screen.getByRole("radio", { name: /parakeet tdt v3/i })).toBeInTheDocument();
    expect(screen.getByText("Recommended")).toBeInTheDocument();
    expect(useTerminalStore.getState().catalog).toEqual(CATALOG);
  });

  it("reflects backend model states and download progress without refetch loops", async () => {
    const states: SpeechModelState[] = [
      { id: "parakeet-tdt-0.6b-v3-int8", status: "ready" },
      { id: "zipformer-streaming-en-20m", status: "downloading", progress: 0.5 },
    ];
    getStatesMock.mockResolvedValue(states);
    render(<VoiceSettingsPane />);
    await act(async () => {});

    expect(screen.getByText("Ready")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();

    // Progress events patch the store directly — no extra state fetches.
    const progressCb = onProgressMock.mock.calls[0][0];
    const fetchesBefore = getStatesMock.mock.calls.length;
    act(() => {
      progressCb({ modelId: "zipformer-streaming-en-20m", progress: 0.75 });
    });
    expect(screen.getByText("75%")).toBeInTheDocument();
    expect(getStatesMock.mock.calls.length).toBe(fetchesBefore);
  });

  it("downloads a model and shows the terminal ready state", async () => {
    getStatesMock
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ id: "zipformer-streaming-en-20m", status: "ready" }]);
    render(<VoiceSettingsPane />);
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: /download zipformer streaming en/i }));
    expect(downloadMock).toHaveBeenCalledWith("zipformer-streaming-en-20m");
    await act(async () => {});
    expect(screen.getByText("Ready")).toBeInTheDocument();
  });

  it("cancels an in-flight download from the row", async () => {
    getStatesMock.mockResolvedValue([
      { id: "zipformer-streaming-en-20m", status: "downloading", progress: 0.4 },
    ]);
    render(<VoiceSettingsPane />);
    await act(async () => {});

    expect(screen.getByText("40%")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /cancel zipformer streaming en download/i }));
    expect(cancelMock).toHaveBeenCalledWith("zipformer-streaming-en-20m");
    await act(async () => {});
  });

  it("deletes a ready model and clears a dangling selection", async () => {
    getStatesMock.mockResolvedValue([
      { id: "parakeet-tdt-0.6b-v3-int8", status: "ready" },
    ]);
    useTerminalStore.setState({
      settings: {
        ...JSON.parse(JSON.stringify(DEFAULT_APP_SETTINGS)),
        voice: { ...DEFAULT_APP_SETTINGS.voice, sttModel: "parakeet-tdt-0.6b-v3-int8" },
      },
    });
    render(<VoiceSettingsPane />);
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: /delete parakeet tdt v3/i }));
    expect(deleteMock).toHaveBeenCalledWith("parakeet-tdt-0.6b-v3-int8");
    await act(async () => {});
    expect(useTerminalStore.getState().settings.voice.sttModel).toBe("");
  });

  it("shows Download as retry on error rows", async () => {
    getStatesMock.mockResolvedValue([
      { id: "zipformer-streaming-en-20m", status: "error", error: "checksum_mismatch" },
    ]);
    render(<VoiceSettingsPane />);
    await act(async () => {});

    // Error rows offer Download as the retry affordance (status text hidden).
    const retry = screen.getByRole("button", { name: /download zipformer streaming en/i });
    expect(retry).toBeInTheDocument();
    fireEvent.click(retry);
    expect(downloadMock).toHaveBeenCalledWith("zipformer-streaming-en-20m");
    await act(async () => {});
  });

  it("subscribes once per mount and unsubscribes on unmount", async () => {
    const unlisten = vi.fn();
    onProgressMock.mockResolvedValue(unlisten);

    const first = render(<VoiceSettingsPane />);
    await act(async () => {});
    expect(onProgressMock).toHaveBeenCalledTimes(1);

    first.unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);

    render(<VoiceSettingsPane />);
    await act(async () => {});
    expect(onProgressMock).toHaveBeenCalledTimes(2);
  });

  it("toggles dictation enabled and gates mic/mode controls", async () => {
    render(<VoiceSettingsPane />);
    await act(async () => {});

    const toggle = screen.getByRole("switch", { name: /enable voice dictation/i });
    const micSelect = screen.getByLabelText("Input device");
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(micSelect).toBeDisabled();

    fireEvent.click(toggle);
    expect(useTerminalStore.getState().settings.voice.enabled).toBe(true);
    expect(screen.getByRole("switch", { name: /enable voice dictation/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByLabelText("Input device")).not.toBeDisabled();

    // Sibling settings untouched by the toggle.
    expect(useTerminalStore.getState().settings.general.defaultCwdMode).toBe("home");
  });

  it("switches dictation mode and persists the choice", async () => {
    useTerminalStore.setState({
      settings: {
        ...JSON.parse(JSON.stringify(DEFAULT_APP_SETTINGS)),
        voice: { ...DEFAULT_APP_SETTINGS.voice, enabled: true },
      },
    });
    render(<VoiceSettingsPane />);
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: /^hold$/i }));
    expect(useTerminalStore.getState().settings.voice.dictationMode).toBe("hold");

    fireEvent.click(screen.getByRole("button", { name: /^toggle$/i }));
    expect(useTerminalStore.getState().settings.voice.dictationMode).toBe("toggle");
  });

  it("selects a model and persists sttModel", async () => {
    render(<VoiceSettingsPane />);
    await act(async () => {});

    fireEvent.click(screen.getByRole("radio", { name: /parakeet tdt v3/i }));
    expect(useTerminalStore.getState().settings.voice.sttModel).toBe("parakeet-tdt-0.6b-v3-int8");
    expect(screen.getByRole("radio", { name: /parakeet tdt v3/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("keeps System default mic and resets device id/label", async () => {
    useTerminalStore.setState({
      settings: {
        ...JSON.parse(JSON.stringify(DEFAULT_APP_SETTINGS)),
        voice: {
          ...DEFAULT_APP_SETTINGS.voice,
          enabled: true,
          microphoneDeviceId: "mic-1",
          microphoneDeviceLabel: "USB Mic",
        },
      },
    });
    render(<VoiceSettingsPane />);
    await act(async () => {});

    const micSelect = screen.getByLabelText("Input device") as HTMLSelectElement;
    fireEvent.change(micSelect, { target: { value: "system-default" } });
    const voice = useTerminalStore.getState().settings.voice;
    expect(voice.microphoneDeviceId).toBeNull();
    expect(voice.microphoneDeviceLabel).toBeNull();
  });

  it("shows Allow access when no devices are listed and rescans on grant", async () => {
    useTerminalStore.setState({
      settings: {
        ...JSON.parse(JSON.stringify(DEFAULT_APP_SETTINGS)),
        voice: { ...DEFAULT_APP_SETTINGS.voice, enabled: true },
      },
    });
    render(<VoiceSettingsPane />);
    await act(async () => {});

    expect(screen.getByRole("button", { name: /allow access/i })).toBeInTheDocument();
    listMicsMock.mockResolvedValue([{ deviceId: "mic-1", label: "USB Mic" }]);
    fireEvent.click(screen.getByRole("button", { name: /allow access/i }));
    await act(async () => {});

    expect(requestAccessMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("option", { name: "USB Mic" })).toBeInTheDocument();
  });

  it("retains the cached label with unplugged suffix once the list is known", async () => {
    listMicsMock.mockResolvedValue([{ deviceId: "mic-2", label: "Headset" }]);
    useTerminalStore.setState({
      settings: {
        ...JSON.parse(JSON.stringify(DEFAULT_APP_SETTINGS)),
        voice: {
          ...DEFAULT_APP_SETTINGS.voice,
          enabled: true,
          microphoneDeviceId: "mic-1",
          microphoneDeviceLabel: "USB Mic",
        },
      },
    });
    render(<VoiceSettingsPane />);
    await act(async () => {});

    expect(screen.getByRole("option", { name: "USB Mic (unplugged)" })).toBeInTheDocument();
  });

  it("manages the OpenAI key: dialog gating, save selects, clear resets", async () => {
    render(<VoiceSettingsPane />);
    await act(async () => {});

    // Picking a cloud model without a key opens the dialog, defers selection.
    fireEvent.click(screen.getByRole("radio", { name: /gpt-4o mini transcribe/i }));
    expect(useTerminalStore.getState().settings.voice.sttModel).toBe("");
    expect(screen.getByRole("dialog", { name: /openai api key/i })).toBeInTheDocument();

    // Save selects the pending model and marks the key configured.
    fireEvent.change(screen.getByPlaceholderText("sk-…"), { target: { value: "sk-test" } });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await act(async () => {});
    expect(saveKeyMock).toHaveBeenCalledWith("sk-test");
    const voice = useTerminalStore.getState().settings.voice;
    expect(voice.openAiApiKeyConfigured).toBe(true);
    expect(voice.sttModel).toBe("openai-gpt-4o-mini-transcribe");
    expect(screen.queryByRole("dialog", { name: /openai api key/i })).not.toBeInTheDocument();

    // Clear resets a cloud selection and the flag.
    fireEvent.click(screen.getByRole("button", { name: /^clear$/i }));
    await act(async () => {});
    expect(clearKeyMock).toHaveBeenCalled();
    expect(useTerminalStore.getState().settings.voice.openAiApiKeyConfigured).toBe(false);
    expect(useTerminalStore.getState().settings.voice.sttModel).toBe("");
  });

  it("selects a cloud model directly when the key is configured", async () => {
    getKeyStatusMock.mockResolvedValue({ configured: true });
    useTerminalStore.setState({
      settings: {
        ...JSON.parse(JSON.stringify(DEFAULT_APP_SETTINGS)),
        voice: { ...DEFAULT_APP_SETTINGS.voice, openAiApiKeyConfigured: true },
      },
    });
    render(<VoiceSettingsPane />);
    await act(async () => {});

    fireEvent.click(screen.getByRole("radio", { name: /gpt-4o mini transcribe/i }));
    expect(useTerminalStore.getState().settings.voice.sttModel).toBe(
      "openai-gpt-4o-mini-transcribe",
    );
    expect(screen.queryByRole("dialog", { name: /openai api key/i })).not.toBeInTheDocument();
  });

  it("keeps a local selection when the key is cleared", async () => {
    getKeyStatusMock.mockResolvedValue({ configured: true });
    useTerminalStore.setState({
      settings: {
        ...JSON.parse(JSON.stringify(DEFAULT_APP_SETTINGS)),
        voice: {
          ...DEFAULT_APP_SETTINGS.voice,
          openAiApiKeyConfigured: true,
          sttModel: "parakeet-tdt-0.6b-v3-int8",
        },
      },
    });
    render(<VoiceSettingsPane />);
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: /^clear$/i }));
    await act(async () => {});
    expect(useTerminalStore.getState().settings.voice.sttModel).toBe("parakeet-tdt-0.6b-v3-int8");
  });
});
