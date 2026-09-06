import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  VOICE_DESKTOP_SESSION_ID,
  cancelVoiceDownload,
  clearVoiceApiKey,
  deleteVoiceModel,
  downloadVoiceModel,
  encodeAudioSamples,
  feedVoiceAudio,
  getVoiceCatalog,
  getVoiceKeyStatus,
  getVoiceModelStates,
  onVoiceDownloadProgress,
  onVoiceError,
  onVoiceFinal,
  onVoicePartial,
  onVoiceReady,
  onVoiceStopped,
  saveVoiceApiKey,
  startVoiceDictation,
  stopVoiceDictation,
} from "./transport";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

describe("voice transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("getVoiceCatalog invokes voice_get_catalog", async () => {
    invokeMock.mockResolvedValueOnce([]);
    await getVoiceCatalog();
    expect(invokeMock).toHaveBeenCalledWith("voice_get_catalog");
  });

  it("getVoiceModelStates invokes voice_get_model_states", async () => {
    invokeMock.mockResolvedValueOnce([]);
    await getVoiceModelStates();
    expect(invokeMock).toHaveBeenCalledWith("voice_get_model_states");
  });

  it("key helpers invoke snake_case voice key commands", async () => {
    invokeMock.mockResolvedValue({ configured: false });
    await getVoiceKeyStatus();
    expect(invokeMock).toHaveBeenCalledWith("voice_get_key_status");

    await saveVoiceApiKey("sk-test");
    expect(invokeMock).toHaveBeenCalledWith("voice_save_key", { key: "sk-test" });

    await clearVoiceApiKey();
    expect(invokeMock).toHaveBeenCalledWith("voice_clear_key");
  });

  it("model lifecycle invokes snake_case commands with model_id", async () => {
    invokeMock.mockResolvedValue(undefined);
    await downloadVoiceModel("whisper-tiny");
    expect(invokeMock).toHaveBeenCalledWith("voice_download_model", { model_id: "whisper-tiny" });

    await cancelVoiceDownload("whisper-tiny");
    expect(invokeMock).toHaveBeenCalledWith("voice_cancel_download", { model_id: "whisper-tiny" });

    await deleteVoiceModel("whisper-tiny");
    expect(invokeMock).toHaveBeenCalledWith("voice_delete_model", { model_id: "whisper-tiny" });
  });

  it("startVoiceDictation defaults session to desktop and passes snake_case args", async () => {
    invokeMock.mockResolvedValue(undefined);
    await startVoiceDictation("whisper-tiny");
    expect(invokeMock).toHaveBeenCalledWith("voice_start_dictation", {
      model_id: "whisper-tiny",
      hotwords: null,
      session_id: VOICE_DESKTOP_SESSION_ID,
    });

    await startVoiceDictation("whisper-tiny", ["oppa"], "pane-3");
    expect(invokeMock).toHaveBeenCalledWith("voice_start_dictation", {
      model_id: "whisper-tiny",
      hotwords: ["oppa"],
      session_id: "pane-3",
    });
  });

  it("feedVoiceAudio base64-encodes f32-LE samples", async () => {
    invokeMock.mockResolvedValue(undefined);
    const samples = new Float32Array([1.0, -1.0]);
    await feedVoiceAudio(samples, 16000);
    // 1.0f32 LE = 00 00 80 3F, -1.0f32 LE = 00 00 80 BF.
    const expected = btoa(
      String.fromCharCode(0x00, 0x00, 0x80, 0x3f, 0x00, 0x00, 0x80, 0xbf),
    );
    expect(invokeMock).toHaveBeenCalledWith("voice_feed_audio", {
      samples_b64: expected,
      sample_rate: 16000,
      session_id: VOICE_DESKTOP_SESSION_ID,
    });
    expect(encodeAudioSamples(samples)).toBe(expected);
  });

  it("stopVoiceDictation defaults session to desktop", async () => {
    invokeMock.mockResolvedValue(undefined);
    await stopVoiceDictation();
    expect(invokeMock).toHaveBeenCalledWith("voice_stop_dictation", {
      session_id: VOICE_DESKTOP_SESSION_ID,
    });
  });

  it("event helpers subscribe to voice:// channels and normalize snake_case", async () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValue(unlisten);

    const partialCb = vi.fn();
    expect(await onVoicePartial(partialCb)).toBe(unlisten);
    expect(listenMock).toHaveBeenCalledWith("voice://partial", expect.any(Function));
    const partialHandler = listenMock.mock.calls[0][1] as (e: {
      payload: { text: string; session_id: string };
    }) => void;
    partialHandler({ payload: { text: "hello", session_id: "desktop" } });
    expect(partialCb).toHaveBeenCalledWith({ text: "hello", sessionId: "desktop" });

    const finalCb = vi.fn();
    await onVoiceFinal(finalCb);
    expect(listenMock).toHaveBeenCalledWith("voice://final", expect.any(Function));

    const progressCb = vi.fn();
    await onVoiceDownloadProgress(progressCb);
    expect(listenMock).toHaveBeenCalledWith("voice://download-progress", expect.any(Function));
    const progressHandler = listenMock.mock.calls[2][1] as (e: {
      payload: { model_id: string; progress: number };
    }) => void;
    progressHandler({ payload: { model_id: "whisper-tiny", progress: 0.5 } });
    expect(progressCb).toHaveBeenCalledWith({ modelId: "whisper-tiny", progress: 0.5 });

    const readyCb = vi.fn();
    await onVoiceReady(readyCb);
    expect(listenMock).toHaveBeenCalledWith("voice://ready", expect.any(Function));

    const stoppedCb = vi.fn();
    await onVoiceStopped(stoppedCb);
    expect(listenMock).toHaveBeenCalledWith("voice://stopped", expect.any(Function));

    const errorCb = vi.fn();
    await onVoiceError(errorCb);
    expect(listenMock).toHaveBeenCalledWith("voice://error", expect.any(Function));
    const errorHandler = listenMock.mock.calls[5][1] as (e: {
      payload: { error: string; session_id: string };
    }) => void;
    errorHandler({ payload: { error: "boom", session_id: "desktop" } });
    expect(errorCb).toHaveBeenCalledWith({ error: "boom", sessionId: "desktop" });
  });
});
