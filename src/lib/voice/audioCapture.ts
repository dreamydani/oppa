// Microphone audio capture — 1:1 port of Orca's `use-audio-capture.ts` as a
// framework-free factory (algorithms ported, no verbatim copy). Opens the
// preferred mic (silent fallback to system default), streams 16 kHz mono
// float chunks through `transport.feedVoiceAudio`, and optionally buffers
// during engine startup so early speech is not lost.
//
// Two deliberate deltas from Orca: (a) chunks are downsampled to 16 kHz in
// the renderer (linear interp) because our backend contract is always 16 kHz
// — Orca lets sherpa resample internally; (b) the AudioContext constructor
// and feed function inject so tests run without a mic.

import { feedVoiceAudio } from "./transport";
import { openMicrophoneCaptureStream } from "./microphoneDevices";

export const VOICE_TARGET_SAMPLE_RATE = 16000;
const CAPTURE_BUFFER_SIZE = 4096;
const MAX_BUFFERED_AUDIO_SECONDS = 30;
const MAX_BUFFERED_AUDIO_BYTES = 8 * 1024 * 1024;

export interface CaptureStartOpts {
  bufferAudio: boolean;
  sessionId: string;
  microphoneDeviceId: string | null;
  microphoneDeviceLabel: string | null;
  onCaptureLost: () => void;
}

export interface CaptureResult {
  fellBackToDefaultMicrophone: boolean;
  sampleRate: typeof VOICE_TARGET_SAMPLE_RATE;
}

interface BufferedAudioChunk {
  samples: Float32Array;
  sessionId: string;
}

export interface AudioCaptureDeps {
  createAudioContext?: () => AudioContext;
  feedAudio?: (samples: Float32Array, sampleRate: number, sessionId: string) => Promise<void>;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  enumerateDevices?: () => Promise<MediaDeviceInfo[]>;
}

/** Linear-interp downsampler to 16 kHz mono; passthrough when already 16 kHz. */
export function downsampleTo16k(samples: Float32Array, fromRate: number): Float32Array {
  if (fromRate === VOICE_TARGET_SAMPLE_RATE) return samples;
  if (fromRate <= 0) return samples;
  const outLength = Math.floor((samples.length * VOICE_TARGET_SAMPLE_RATE) / fromRate);
  if (outLength <= 0) return new Float32Array(0);
  const out = new Float32Array(outLength);
  const step = fromRate / VOICE_TARGET_SAMPLE_RATE;
  for (let i = 0; i < outLength; i++) {
    const pos = i * step;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, samples.length - 1);
    const frac = pos - lo;
    out[i] = samples[lo]! * (1 - frac) + samples[hi]! * frac;
  }
  return out;
}

export function createAudioCapture(deps: AudioCaptureDeps = {}) {
  const createAudioContext =
    deps.createAudioContext ?? (() => new AudioContext());
  const feedAudio = deps.feedAudio ?? feedVoiceAudio;

  let stream: MediaStream | null = null;
  let context: AudioContext | null = null;
  let processor: ScriptProcessorNode | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let capturing = false;
  let startRequest = 0;
  let bufferAudio = false;
  let bufferGeneration = 0;
  let buffered: BufferedAudioChunk[] = [];
  let bufferedBytes = 0;
  let bufferedSeconds = 0;
  let capturedChunkCount = 0;
  let sessionId = "desktop";
  let trackLostCleanup: (() => void) | null = null;

  function cleanupCaptureResources() {
    trackLostCleanup?.();
    trackLostCleanup = null;
    processor?.disconnect();
    source?.disconnect();
    processor = null;
    source = null;
    if (context?.state !== "closed") {
      void context?.close();
    }
    context = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
  }

  function resetBufferedAudio() {
    bufferGeneration += 1;
    buffered = [];
    bufferedBytes = 0;
    bufferedSeconds = 0;
  }

  function appendBufferedAudioChunk(chunk: BufferedAudioChunk) {
    buffered.push(chunk);
    bufferedBytes += chunk.samples.byteLength;
    bufferedSeconds += chunk.samples.length / VOICE_TARGET_SAMPLE_RATE;

    // Why: worker/model startup can hang; keep only a bounded recent window
    // so renderer memory cannot grow forever while buffering is enabled.
    while (
      buffered.length > 0 &&
      (bufferedBytes > MAX_BUFFERED_AUDIO_BYTES || bufferedSeconds > MAX_BUFFERED_AUDIO_SECONDS)
    ) {
      const oldest = buffered.shift();
      if (!oldest) break;
      bufferedBytes -= oldest.samples.byteLength;
      bufferedSeconds -= oldest.samples.length / VOICE_TARGET_SAMPLE_RATE;
    }
  }

  async function start(opts: CaptureStartOpts): Promise<CaptureResult | undefined> {
    if (capturing) return undefined;
    const request = startRequest + 1;
    startRequest = request;
    cleanupCaptureResources();
    sessionId = opts.sessionId;
    bufferAudio = opts.bufferAudio;
    resetBufferedAudio();
    capturedChunkCount = 0;

    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.getUserMedia) {
      throw new Error("mic_unavailable");
    }
    let opened;
    try {
      opened = await openMicrophoneCaptureStream({
        preferredDeviceId: opts.microphoneDeviceId,
        preferredDeviceLabel: opts.microphoneDeviceLabel,
        getUserMedia: deps.getUserMedia ?? ((c) => mediaDevices.getUserMedia(c)),
        enumerateDevices:
          deps.enumerateDevices ??
          (mediaDevices.enumerateDevices
            ? () => mediaDevices.enumerateDevices()
            : undefined),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        throw new Error("mic_permission_denied");
      }
      throw error;
    }
    if (startRequest !== request) {
      opened.stream.getTracks().forEach((track) => track.stop());
      return undefined;
    }
    stream = opened.stream;

    let nextContext: AudioContext | null = null;
    let nextSource: MediaStreamAudioSourceNode | null = null;
    let nextProcessor: ScriptProcessorNode | null = null;
    try {
      // Why: requesting 16 kHz in the AudioContext can produce silence on
      // macOS (hardware mics run at 44.1/48 kHz). Use the system rate and
      // downsample to 16 kHz per chunk before sending.
      nextContext = createAudioContext();
      context = nextContext;

      // Why: some Chromium builds suspend the AudioContext until a user
      // gesture. Resume explicitly so processing actually starts.
      if (nextContext.state === "suspended") {
        await nextContext.resume();
      }
      if (startRequest !== request || stream !== opened.stream) {
        throw new Error("dictation_canceled");
      }

      nextSource = nextContext.createMediaStreamSource(opened.stream);

      // Why: ScriptProcessorNode is deprecated but AudioWorklet needs a
      // separate module file, complicating the Vite pipeline. Negligible
      // difference for 4096-sample speech chunks.
      nextProcessor = nextContext.createScriptProcessor(CAPTURE_BUFFER_SIZE, 1, 1);

      nextProcessor.onaudioprocess = (e: AudioProcessingEvent) => {
        if (!capturing || startRequest !== request || processor !== nextProcessor) {
          return;
        }
        const resampled = downsampleTo16k(
          new Float32Array(e.inputBuffer.getChannelData(0)),
          nextContext!.sampleRate,
        );
        capturedChunkCount += 1;
        if (bufferAudio) {
          appendBufferedAudioChunk({ samples: resampled, sessionId });
          return;
        }
        void feedAudio(resampled, VOICE_TARGET_SAMPLE_RATE, sessionId).catch(() => undefined);
      };

      nextSource.connect(nextProcessor);
      nextProcessor.connect(nextContext.destination);

      processor = nextProcessor;
      source = nextSource;
      capturing = true;

      // Why: unplugging the input ends the track without ending the graph —
      // the processor keeps feeding zeros, so dictation looks live while
      // capturing nothing.
      const audioTrack = opened.stream.getAudioTracks()[0];
      if (audioTrack) {
        const handleTrackEnded = () => {
          if (startRequest !== request || !capturing) return;
          opts.onCaptureLost();
        };
        audioTrack.addEventListener("ended", handleTrackEnded);
        trackLostCleanup = () => {
          audioTrack.removeEventListener("ended", handleTrackEnded);
        };
      }
      return { fellBackToDefaultMicrophone: opened.fellBackToDefaultMicrophone, sampleRate: 16000 };
    } catch (error) {
      nextProcessor?.disconnect();
      nextSource?.disconnect();
      if (processor === nextProcessor) processor = null;
      if (source === nextSource) source = null;
      if (context === nextContext) context = null;
      if (nextContext && nextContext.state !== "closed") {
        void nextContext.close();
      }
      opened.stream.getTracks().forEach((track) => track.stop());
      if (stream === opened.stream) stream = null;
      if (startRequest === request) {
        bufferAudio = false;
        resetBufferedAudio();
      }
      if (startRequest !== request || (error instanceof Error && error.message === "dictation_canceled")) {
        return undefined;
      }
      throw error;
    }
  }

  async function flushBufferedAudio(): Promise<void> {
    const generation = bufferGeneration;
    try {
      // Why: keep buffering enabled while draining so live audio appends
      // behind startup audio instead of overtaking it through direct sends.
      while (bufferGeneration === generation && buffered.length > 0) {
        const chunk = buffered[0];
        if (!chunk) break;
        buffered.shift();
        bufferedBytes -= chunk.samples.byteLength;
        bufferedSeconds -= chunk.samples.length / VOICE_TARGET_SAMPLE_RATE;
        await feedAudio(chunk.samples, VOICE_TARGET_SAMPLE_RATE, chunk.sessionId);
      }
    } finally {
      if (bufferGeneration === generation) {
        bufferAudio = false;
        resetBufferedAudio();
      }
    }
  }

  function discardBufferedAudio() {
    bufferAudio = false;
    resetBufferedAudio();
  }

  function getCapturedChunkCount(): number {
    return capturedChunkCount;
  }

  function stop(opts: { preserveBufferedAudio?: boolean } = {}) {
    startRequest += 1;
    capturing = false;
    bufferAudio = false;
    if (!opts.preserveBufferedAudio) {
      resetBufferedAudio();
    }
    cleanupCaptureResources();
  }

  return { start, stop, flushBufferedAudio, discardBufferedAudio, getCapturedChunkCount };
}

export type AudioCapture = ReturnType<typeof createAudioCapture>;
