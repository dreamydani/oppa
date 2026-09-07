import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createAudioCapture,
  downsampleTo16k,
  VOICE_TARGET_SAMPLE_RATE,
} from "./audioCapture";

// ---- Fakes (no real mic or AudioContext in tests) ----

class FakeTrack {
  stopped = false;
  private listeners = new Map<string, Set<() => void>>();
  stop() {
    this.stopped = true;
  }
  addEventListener(type: string, cb: () => void) {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(cb);
  }
  removeEventListener(type: string, cb: () => void) {
    this.listeners.get(type)?.delete(cb);
  }
  fireEnded() {
    this.listeners.get("ended")?.forEach((cb) => cb());
  }
}

class FakeStream {
  track = new FakeTrack();
  getTracks() {
    return [this.track];
  }
  getAudioTracks() {
    return [this.track];
  }
}

class FakeProcessor {
  onaudioprocess: ((e: { inputBuffer: { getChannelData: (ch: number) => Float32Array } }) => void) | null = null;
  connected = false;
  connect() {
    this.connected = true;
  }
  disconnect() {
    this.connected = false;
  }
  fire(samples: Float32Array) {
    this.onaudioprocess?.({ inputBuffer: { getChannelData: () => samples } });
  }
}

class FakeSource {
  connected = false;
  connect() {
    this.connected = true;
  }
  disconnect() {
    this.connected = false;
  }
}

class FakeContext {
  sampleRate: number;
  state: "running" | "suspended" | "closed" = "running";
  resumed = 0;
  closed = 0;
  processor = new FakeProcessor();
  source = new FakeSource();
  destination = {};
  constructor(sampleRate = 48000, state: "running" | "suspended" = "running") {
    this.sampleRate = sampleRate;
    this.state = state;
  }
  async resume() {
    this.resumed += 1;
    this.state = "running";
  }
  async close() {
    this.closed += 1;
    this.state = "closed";
  }
  createMediaStreamSource(_stream: MediaStream) {
    return this.source as unknown as MediaStreamAudioSourceNode;
  }
  createScriptProcessor(_size: number, _in: number, _out: number) {
    return this.processor as unknown as ScriptProcessorNode;
  }
}

const BASE_OPTS = {
  bufferAudio: false,
  sessionId: "desktop",
  microphoneDeviceId: null as string | null,
  microphoneDeviceLabel: null as string | null,
  onCaptureLost: () => {},
};

function constantChunk(value: number, length = 4096): Float32Array {
  return new Float32Array(length).fill(value);
}

describe("downsampleTo16k", () => {
  it("passes 16 kHz audio through untouched", () => {
    const samples = constantChunk(0.5, 100);
    expect(downsampleTo16k(samples, VOICE_TARGET_SAMPLE_RATE)).toBe(samples);
  });

  it("downsamples 48 kHz to a third with level preserved", () => {
    const out = downsampleTo16k(constantChunk(0.5), 48000);
    expect(out.length).toBe(Math.floor((4096 * 16000) / 48000));
    expect(out[0]).toBeCloseTo(0.5, 5);
    expect(out[out.length - 1]).toBeCloseTo(0.5, 5);
  });

  it("interpolates ramps instead of point-sampling", () => {
    const ramp = new Float32Array([0, 1, 2, 3]);
    const out = downsampleTo16k(ramp, 32000);
    expect(out.length).toBe(2);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[1]).toBeCloseTo(2, 5);
  });
});

describe("audioCapture", () => {
  let mediaDevices: { getUserMedia: ReturnType<typeof vi.fn>; enumerateDevices: ReturnType<typeof vi.fn> };
  let savedDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    savedDescriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
    mediaDevices = { getUserMedia: vi.fn(), enumerateDevices: vi.fn() };
    Object.defineProperty(navigator, "mediaDevices", {
      value: mediaDevices,
      configurable: true,
    });
  });

  afterEach(() => {
    if (savedDescriptor) {
      Object.defineProperty(navigator, "mediaDevices", savedDescriptor);
    } else {
      // @ts-expect-error test cleanup restores the pristine navigator
      delete navigator.mediaDevices;
    }
    vi.clearAllMocks();
  });

  function setup(context = new FakeContext(), stream = new FakeStream()) {
    const feedAudio = vi.fn().mockResolvedValue(undefined);
    mediaDevices.getUserMedia.mockResolvedValue(stream as unknown as MediaStream);
    mediaDevices.enumerateDevices.mockResolvedValue([]);
    const capture = createAudioCapture({
      createAudioContext: () => context as unknown as AudioContext,
      feedAudio,
    });
    return { capture, feedAudio, context, stream };
  }

  it("opens the preferred device and streams resampled 16 kHz chunks live", async () => {
    const { capture } = setup();
    mediaDevices.enumerateDevices.mockResolvedValue([
      { deviceId: "mic-1", kind: "audioinput", label: "USB Mic" },
    ]);
    const result = await capture.start({ ...BASE_OPTS, microphoneDeviceId: "mic-1" });

    expect(result).toEqual({ fellBackToDefaultMicrophone: false, sampleRate: 16000 });
    const constraints = mediaDevices.getUserMedia.mock.calls[0][0];
    expect(constraints.audio).toMatchObject({ deviceId: { exact: "mic-1" } });

    capture.stop();
    const live = setup();
    await live.capture.start(BASE_OPTS);
    live.context.processor.fire(constantChunk(0.25));
    live.context.processor.fire(constantChunk(0.5));
    expect(live.feedAudio).toHaveBeenCalledTimes(2);
    expect(live.feedAudio.mock.calls[0][1]).toBe(16000);
    expect(live.feedAudio.mock.calls[0][2]).toBe("desktop");
    expect((live.feedAudio.mock.calls[0][0] as Float32Array).length).toBe(
      Math.floor((4096 * 16000) / 48000),
    );
    expect(live.capture.getCapturedChunkCount()).toBe(2);
    live.capture.stop();
  });

  it("falls back to system default for a known-missing device", async () => {
    const { capture } = setup();
    mediaDevices.enumerateDevices.mockResolvedValue([
      { deviceId: "mic-1", kind: "audioinput", label: "USB Mic" },
    ]);
    const onCaptureLost = vi.fn();
    const result = await capture.start({
      ...BASE_OPTS,
      microphoneDeviceId: "mic-gone",
      onCaptureLost,
    });

    expect(result?.fellBackToDefaultMicrophone).toBe(true);
    // Missing is known from enumeration: exactly one default-constraint call.
    expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    expect(mediaDevices.getUserMedia.mock.calls[0][0].audio).not.toHaveProperty("deviceId");
    capture.stop();
  });

  it("buffers during startup and flushes in order, then goes live", async () => {
    const { capture, feedAudio, context } = setup();
    await capture.start({ ...BASE_OPTS, bufferAudio: true });

    context.processor.fire(constantChunk(1));
    context.processor.fire(constantChunk(2));
    context.processor.fire(constantChunk(3));
    expect(feedAudio).not.toHaveBeenCalled();
    expect(capture.getCapturedChunkCount()).toBe(3);

    await capture.flushBufferedAudio();
    expect(feedAudio).toHaveBeenCalledTimes(3);
    expect((feedAudio.mock.calls[0][0] as Float32Array)[0]).toBeCloseTo(1, 5);
    expect((feedAudio.mock.calls[1][0] as Float32Array)[0]).toBeCloseTo(2, 5);
    expect((feedAudio.mock.calls[2][0] as Float32Array)[0]).toBeCloseTo(3, 5);

    // Post-flush audio goes straight through.
    context.processor.fire(constantChunk(4));
    expect(feedAudio).toHaveBeenCalledTimes(4);
    capture.stop();
  });

  it("discards buffered audio and honors preserveBufferedAudio on stop", async () => {
    const { capture, feedAudio, context } = setup();
    await capture.start({ ...BASE_OPTS, bufferAudio: true });
    context.processor.fire(constantChunk(1));
    capture.discardBufferedAudio();
    await capture.flushBufferedAudio();
    expect(feedAudio).not.toHaveBeenCalled();

    context.processor.fire(constantChunk(2));
    capture.stop({ preserveBufferedAudio: true });
    await capture.flushBufferedAudio();
    expect(feedAudio).toHaveBeenCalledTimes(1);
    capture.stop();
  });

  it("evicts the oldest buffered audio past the 30s window, newest survive", async () => {
    const { capture, feedAudio, context } = setup();
    await capture.start({ ...BASE_OPTS, bufferAudio: true });

    // 400 chunks × ~0.085s ≈ 34s at 16 kHz — past the 30s cap.
    for (let i = 1; i <= 400; i++) {
      context.processor.fire(constantChunk(i / 1000));
    }
    await capture.flushBufferedAudio();
    const flushed = feedAudio.mock.calls.map((c) => (c[0] as Float32Array)[0]);
    expect(flushed.length).toBeGreaterThan(0);
    expect(flushed.length).toBeLessThan(400);
    // Survivors are the newest suffix, still in order.
    for (let i = 1; i < flushed.length; i++) {
      expect(flushed[i]).toBeGreaterThan(flushed[i - 1]!);
    }
    expect(flushed[flushed.length - 1]).toBeCloseTo(400 / 1000, 5);
    capture.stop();
  });

  it("fires onCaptureLost when the track ends mid-session, not after stop", async () => {
    const { capture, stream } = setup();
    const onCaptureLost = vi.fn();
    await capture.start({ ...BASE_OPTS, onCaptureLost });

    stream.track.fireEnded();
    expect(onCaptureLost).toHaveBeenCalledTimes(1);

    capture.stop();
    stream.track.fireEnded();
    expect(onCaptureLost).toHaveBeenCalledTimes(1);
  });

  it("second start while capturing is a no-op", async () => {
    const { capture } = setup();
    await capture.start(BASE_OPTS);
    expect(await capture.start(BASE_OPTS)).toBeUndefined();
    expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    capture.stop();
  });

  it("resumes a suspended AudioContext on start", async () => {
    const suspended = new FakeContext(48000, "suspended");
    const { capture } = setup(suspended);
    await capture.start(BASE_OPTS);
    expect(suspended.resumed).toBe(1);
    capture.stop();
  });

  it("throws mic_unavailable without a media stack", async () => {
    Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
    const { capture } = setup();
    await expect(capture.start(BASE_OPTS)).rejects.toThrow("mic_unavailable");
  });

  it("maps permission denial to mic_permission_denied", async () => {
    const { capture } = setup();
    mediaDevices.getUserMedia.mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    await expect(capture.start(BASE_OPTS)).rejects.toThrow("mic_permission_denied");
  });

  it("stop tears down tracks and context", async () => {
    const { capture, context, stream } = setup();
    await capture.start(BASE_OPTS);
    context.processor.fire(constantChunk(0.5));
    capture.stop();
    expect(stream.track.stopped).toBe(true);
    expect(context.closed).toBe(1);
    // Count survives stop (Orca parity); the next start resets it.
    expect(capture.getCapturedChunkCount()).toBe(1);
    await capture.start(BASE_OPTS);
    expect(capture.getCapturedChunkCount()).toBe(0);
    capture.stop();
  });
});
