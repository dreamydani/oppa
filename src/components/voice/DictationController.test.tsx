import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, cleanup, screen, fireEvent } from "@testing-library/react";
import { DictationController } from "./DictationController";
import { VoiceNotice } from "./VoiceNotice";
import { useTerminalStore } from "../../store/terminalStore";
import { DEFAULT_APP_SETTINGS } from "../../lib/settings/types";
import * as voiceTransport from "../../lib/voice/transport";
import * as audioCaptureModule from "../../lib/voice/audioCapture";
import { ptyWrite } from "../../lib/pty/transport";
import { dispatchDictationControl } from "../../lib/voice/dictationControl";
import type { SpeechTranscriptEvent, SpeechLifecycleEvent } from "../../lib/voice/voiceTypes";

vi.mock("../../lib/voice/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof voiceTransport>();
  return {
    ...actual,
    startVoiceDictation: vi.fn(),
    stopVoiceDictation: vi.fn(),
    feedVoiceAudio: vi.fn(),
    onVoicePartial: vi.fn(),
    onVoiceFinal: vi.fn(),
    onVoiceStopped: vi.fn(),
    onVoiceError: vi.fn(),
  };
});

vi.mock("../../lib/voice/audioCapture", async (importOriginal) => {
  const actual = await importOriginal<typeof audioCaptureModule>();
  return {
    ...actual,
    createAudioCapture: vi.fn(),
  };
});

vi.mock("../../lib/pty/transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/pty/transport")>();
  return { ...actual, ptyWrite: vi.fn(async () => {}) };
});

const startVoiceDictationMock = vi.mocked(voiceTransport.startVoiceDictation);
const stopVoiceDictationMock = vi.mocked(voiceTransport.stopVoiceDictation);
const onPartialMock = vi.mocked(voiceTransport.onVoicePartial);
const onFinalMock = vi.mocked(voiceTransport.onVoiceFinal);
const onStoppedMock = vi.mocked(voiceTransport.onVoiceStopped);
const onErrorMock = vi.mocked(voiceTransport.onVoiceError);
const createCaptureMock = vi.mocked(audioCaptureModule.createAudioCapture);
const ptyWriteMock = vi.mocked(ptyWrite);

type CaptureOpts = {
  bufferAudio: boolean;
  sessionId: string;
  microphoneDeviceId: string | null;
  microphoneDeviceLabel: string | null;
  onCaptureLost: () => void;
};

function makeCapture() {
  return {
    start: vi.fn(async (_opts: CaptureOpts) => ({
      fellBackToDefaultMicrophone: false,
      sampleRate: 16000 as const,
    })),
    stop: vi.fn(),
    flushBufferedAudio: vi.fn(async () => {}),
    discardBufferedAudio: vi.fn(),
    getCapturedChunkCount: vi.fn(() => 3),
  };
}

let capture = makeCapture();

function seedVoice(voice: Partial<typeof DEFAULT_APP_SETTINGS.voice> = {}) {
  useTerminalStore.setState({
    settings: {
      ...JSON.parse(JSON.stringify(DEFAULT_APP_SETTINGS)),
      voice: { ...DEFAULT_APP_SETTINGS.voice, enabled: true, sttModel: "whisper-tiny", ...voice },
    },
    dictationState: "idle",
    partialTranscript: "",
    voiceNotice: null,
    isSettingsOpen: false,
  });
}

function focusTerminal(sessionId: string) {
  document.body.innerHTML =
    `<div class="pane-leaf" data-pane-id="${sessionId}">` +
    `<textarea class="xterm-helper-textarea"></textarea></div>`;
  document.querySelector("textarea")!.focus();
}

describe("DictationController", () => {
  let partialCbs: Array<(e: SpeechTranscriptEvent) => void> = [];
  let finalCbs: Array<(e: SpeechTranscriptEvent) => void> = [];
  let stoppedCbs: Array<(e: SpeechLifecycleEvent) => void> = [];
  let errorCbs: Array<(e: { error: string; sessionId: string }) => void> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    document.body.innerHTML = "";
    capture = makeCapture();
    createCaptureMock.mockReturnValue(capture as unknown as ReturnType<typeof audioCaptureModule.createAudioCapture>);
    startVoiceDictationMock.mockResolvedValue(undefined);
    stopVoiceDictationMock.mockResolvedValue(undefined);
    onPartialMock.mockImplementation(async (cb) => {
      partialCbs.push(cb);
      return () => {};
    });
    onFinalMock.mockImplementation(async (cb) => {
      finalCbs.push(cb);
      return () => {};
    });
    onStoppedMock.mockImplementation(async (cb) => {
      stoppedCbs.push(cb);
      return () => {};
    });
    onErrorMock.mockImplementation(async (cb) => {
      errorCbs.push(cb);
      return () => {};
    });
    partialCbs = [];
    finalCbs = [];
    stoppedCbs = [];
    errorCbs = [];
    seedVoice();
  });

  afterEach(() => {
    cleanup();
    document.body.innerHTML = "";
  });

  function emitStopped(sessionId: string) {
    act(() => {
      stoppedCbs.forEach((cb) => cb({ sessionId }));
    });
  }

  async function settle() {
    await act(async () => {});
  }

  async function startViaControl() {
    render(<DictationController />);
    await settle();
    act(() => {
      dispatchDictationControl("toggle");
    });
    await settle();
  }

  async function stopViaDrain(sessionId: string) {
    emitStopped(sessionId);
    await settle();
  }

  it("stays silent when no model is selected (parity: keyboard path guards quietly)", async () => {
    seedVoice({ sttModel: "" });
    render(<DictationController />);
    await settle();
    act(() => {
      dispatchDictationControl("toggle");
    });
    await settle();

    expect(useTerminalStore.getState().dictationState).toBe("idle");
    expect(useTerminalStore.getState().voiceNotice).toBeNull();
    expect(capture.start).not.toHaveBeenCalled();
    expect(startVoiceDictationMock).not.toHaveBeenCalled();
  });

  it("stays silent when dictation is disabled without touching the mic", async () => {
    seedVoice({ enabled: false });
    render(<DictationController />);
    await settle();
    act(() => {
      dispatchDictationControl("toggle");
    });
    await settle();

    expect(useTerminalStore.getState().dictationState).toBe("idle");
    expect(useTerminalStore.getState().voiceNotice).toBeNull();
    expect(capture.start).not.toHaveBeenCalled();
  });

  it("runs start → partial → final → stop into the focused terminal", async () => {
    focusTerminal("s-1");
    await startViaControl();

    expect(useTerminalStore.getState().dictationState).toBe("listening");
    expect(capture.start).toHaveBeenCalledWith(
      expect.objectContaining({ bufferAudio: true, sessionId: "1" }),
    );
    expect(startVoiceDictationMock).toHaveBeenCalledWith("whisper-tiny", undefined, "1");
    expect(capture.flushBufferedAudio).toHaveBeenCalled();

    act(() => {
      partialCbs.forEach((cb) => cb({ text: "hello", sessionId: "1" }));
    });
    expect(useTerminalStore.getState().partialTranscript).toBe("hello");

    act(() => {
      finalCbs.forEach((cb) => cb({ text: "hello world", sessionId: "1" }));
    });
    expect(ptyWriteMock).toHaveBeenCalledWith("s-1", "hello world");

    // Second chunk joins with a space.
    act(() => {
      finalCbs.forEach((cb) => cb({ text: "again", sessionId: "1" }));
    });
    expect(ptyWriteMock).toHaveBeenCalledWith("s-1", " again");

    act(() => {
      dispatchDictationControl("toggle");
    });
    await settle();
    expect(stopVoiceDictationMock).toHaveBeenCalledWith("1");
    // Backend stopped event drains the session back to idle.
    await stopViaDrain("1");
    expect(useTerminalStore.getState().dictationState).toBe("idle");
  });

  it("inserts into the start-captured terminal even after focus moves", async () => {
    focusTerminal("s-1");
    await startViaControl();

    focusTerminal("s-2");
    act(() => {
      finalCbs.forEach((cb) => cb({ text: "pinned", sessionId: "1" }));
    });
    expect(ptyWriteMock).toHaveBeenCalledWith("s-1", "pinned");
    expect(ptyWriteMock).not.toHaveBeenCalledWith("s-2", expect.anything());
  });

  it("ignores transcripts from stale sessions", async () => {
    focusTerminal("s-1");
    await startViaControl();

    act(() => {
      finalCbs.forEach((cb) => cb({ text: "old news", sessionId: "999" }));
      partialCbs.forEach((cb) => cb({ text: "old news", sessionId: "999" }));
    });
    expect(ptyWriteMock).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().partialTranscript).toBe("");
  });

  it("notices when no text field was focused at start", async () => {
    document.body.innerHTML = `<div tabindex="0"></div>`;
    document.querySelector("div")!.focus();
    await startViaControl();

    act(() => {
      finalCbs.forEach((cb) => cb({ text: "lost words", sessionId: "1" }));
    });
    expect(ptyWriteMock).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().voiceNotice?.text).toMatch(/no text field/i);
  });

  it("toggles with the Mod+E chord and exempts xterm", async () => {
    focusTerminal("s-1");
    render(<DictationController />);
    await settle();

    // A bubble-phase listener stands in for xterm/App handlers: capture-phase
    // interception must keep the chord from ever reaching them.
    let bubbleReached = false;
    window.addEventListener("keydown", () => {
      bubbleReached = true;
    });
    const down = new KeyboardEvent("keydown", {
      key: "e",
      code: "KeyE",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      window.dispatchEvent(down);
    });
    expect(useTerminalStore.getState().dictationState).toBe("listening");
    expect(down.defaultPrevented).toBe(true);
    expect(bubbleReached).toBe(false);

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "e", code: "KeyE", ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(stopVoiceDictationMock).toHaveBeenCalled();
    await stopViaDrain("1");
    expect(useTerminalStore.getState().dictationState).toBe("idle");
  });

  it("does not steal Ctrl+Shift+E (split vertical)", async () => {
    focusTerminal("s-1");
    render(<DictationController />);
    await act(async () => {});

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "E",
          code: "KeyE",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(useTerminalStore.getState().dictationState).toBe("idle");
    expect(capture.start).not.toHaveBeenCalled();
  });

  it("hold mode starts on press and stops on release", async () => {
    seedVoice({ dictationMode: "hold" });
    focusTerminal("s-1");
    render(<DictationController />);
    await act(async () => {});

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "e", code: "KeyE", ctrlKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(useTerminalStore.getState().dictationState).toBe("listening");

    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keyup", { key: "e", code: "KeyE", ctrlKey: false, bubbles: true, cancelable: true }),
      );
    });
    expect(stopVoiceDictationMock).toHaveBeenCalled();
    await stopViaDrain("1");
    expect(useTerminalStore.getState().dictationState).toBe("idle");
  });

  it("returns to idle silently on dictation_canceled", async () => {
    focusTerminal("s-1");
    startVoiceDictationMock.mockRejectedValueOnce(new Error("dictation_canceled by teardown"));
    render(<DictationController />);
    await act(async () => {});
    act(() => {
      dispatchDictationControl("toggle");
    });
    await act(async () => {});

    expect(useTerminalStore.getState().dictationState).toBe("idle");
    expect(useTerminalStore.getState().voiceNotice).toBeNull();
  });

  it("surfaces engine errors and recovers to idle", async () => {
    focusTerminal("s-1");
    await startViaControl();

    act(() => {
      errorCbs.forEach((cb) => cb({ error: "engine: boom", sessionId: "1" }));
    });
    expect(useTerminalStore.getState().voiceNotice?.text).toMatch(/speech error/i);
    await stopViaDrain("1");
    expect(useTerminalStore.getState().dictationState).toBe("idle");
  });

  it("stop button dispatches stop without stealing focus", async () => {    focusTerminal("s-1");
    render(<DictationController />);
    await settle();
    act(() => {
      dispatchDictationControl("toggle");
    });
    await settle();
    expect(useTerminalStore.getState().dictationState).toBe("listening");

    const stopBtn = document.querySelector(".dictation-indicator-stop") as HTMLElement;
    expect(stopBtn).toBeInTheDocument();
    // mousedown default-prevented keeps the terminal focused for insertion.
    const mousedown = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    const prevented = !stopBtn.dispatchEvent(mousedown);
    expect(prevented).toBe(true);
  });
});

describe("VoiceNotice", () => {
  beforeEach(() => {
    cleanup();
    seedVoice();
    useTerminalStore.setState({ voiceNotice: null });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders notice text with an Open Settings action", () => {
    useTerminalStore.setState({
      voiceNotice: {
        id: 1,
        text: "No speech model selected. Download one in Settings > Voice.",
        action: "open-voice-settings",
      },
    });
    render(<VoiceNotice />);

    expect(screen.getByText(/no speech model/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    expect(useTerminalStore.getState().activeSettingsTab).toBe("voice");
    expect(useTerminalStore.getState().isSettingsOpen).toBe(true);
    expect(useTerminalStore.getState().voiceNotice).toBeNull();
  });

  it("renders nothing without a notice and dismisses plain ones", () => {
    const { container, rerender } = render(<VoiceNotice />);
    expect(container).toBeEmptyDOMElement();

    useTerminalStore.setState({ voiceNotice: { id: 2, text: "No speech detected." } });
    rerender(<VoiceNotice />);
    expect(screen.getByText(/no speech detected/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /dismiss notification/i }));
    expect(useTerminalStore.getState().voiceNotice).toBeNull();
  });
});
