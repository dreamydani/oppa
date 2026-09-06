// Per-pane write throttle. All priorities pace output to the frame budget
// so bursty agent output renders as smooth scroll instead of jank: focused
// and hovered panes write the burst head immediately, then drain the rest at
// one frame-budgeted flush per tick; background panes stay at the GPU-tier
// cap. Output is NEVER dropped — dispose() and focus upgrades flush the
// tail. ACKs must be accounted in the write() callback (render time), not at
// push time, so daemon backpressure tracks what xterm actually consumed;
// byte hints travel with their chunks so the totals stay exact even when a
// flush carries a budget-split subset.

import { onNextFrame } from "../layout/frameScheduler";
import type { PanePriority } from "./panePriority";

const DEFAULT_BACKGROUND_FPS = 30;
// Max text length per tick flush: queued follow-ups pace through this per
// rAF tick, so a deep burst never parses as one jumbo join. Whole-chunk
// boundaries keep surrogate pairs intact.
// Test seam: createThrottledWriteQueue's 4th arg overrides this.
const FOCUSED_MAX_BYTES_PER_FRAME = 16 * 1024;

export interface WriteQueue {
  push(data: string, bytes?: number): void;
  setPriority(priority: PanePriority): void;
  dispose(): void;
}

function isFast(priority: PanePriority): boolean {
  return priority === "focused" || priority === "hovered";
}

interface BufferedChunk {
  text: string;
  bytes: number;
}

export function createThrottledWriteQueue(
  initialPriority: PanePriority,
  write: (data: string, bytes: number) => void,
  backgroundFps: number = DEFAULT_BACKGROUND_FPS,
  maxBytesPerFrame: number = FOCUSED_MAX_BYTES_PER_FRAME,
): WriteQueue {
  // Background flush cadence in frames (60fps rAF). Low tier caps at 15fps
  // (every 4th frame), medium/high at 30fps (every 2nd). Fast panes flush
  // every frame (coalesced within the frame).
  const backgroundFramesPerFlush = Math.max(1, Math.round(60 / backgroundFps));
  let priority: PanePriority = initialPriority;
  let buffer: BufferedChunk[] = [];
  let scheduled = false;
  let disposed = false;
  // Frames remaining until the next flush is allowed; enforces the cap.
  let framesUntilAllowed = 0;
  // True once the first flush has been scheduled in the current frame burst;
  // gates the leading-edge fast path so synchronous bursts coalesce.
  let burstArmed = false;

  const framesPerFlush = () => (isFast(priority) ? 1 : backgroundFramesPerFlush);

  // Budget applies per FRAME (not per write call): a tick drains up to
  // maxBytesPerFrame in whole chunks so one frame never parses a jumbo join.
  const takeFrameBatch = (): BufferedChunk | null => {
    if (buffer.length === 0) return null;
    let textLen = 0;
    let count = 0;
    let bytes = 0;
    for (const chunk of buffer) {
      if (count > 0 && textLen + chunk.text.length > maxBytesPerFrame) break;
      textLen += chunk.text.length;
      bytes += chunk.bytes;
      count++;
    }
    if (count === 0) {
      const only = buffer[0]!;
      count = 1;
      bytes = only.bytes;
    }
    const parts = buffer.splice(0, count);
    return { text: parts.map((p) => p.text).join(""), bytes };
  };

  const flush = () => {
    scheduled = false;
    const batch = takeFrameBatch();
    if (batch === null) {
      burstArmed = false;
      return;
    }
    write(batch.text, batch.bytes);
    // Budget remainder stays for the next tick — one flush per frame keeps
    // the parse cost bounded no matter how deep the burst runs.
    burstArmed = buffer.length > 0;
    framesUntilAllowed = Math.max(0, framesPerFlush() - 1);
    if (buffer.length > 0 && !scheduled) {
      scheduled = true;
      onNextFrame(tick);
    }
  };

  const tick = () => {
    scheduled = false;
    if (disposed) return;
    if (framesUntilAllowed > 0) {
      framesUntilAllowed--;
      if (buffer.length > 0) {
        scheduled = true;
        onNextFrame(tick);
        return;
      }
      burstArmed = false;
      return;
    }
    flush();
  };

  const scheduleTick = () => {
    if (!scheduled) {
      scheduled = true;
      onNextFrame(tick);
    }
  };

  return {
    push(data, bytes) {
      if (disposed) return;
      // No hint (older backends): TextEncoder gives exact UTF-8 bytes for
      // the BMP/CJK text agents emit.
      const hint = typeof bytes === "number" ? bytes : new TextEncoder().encode(data).length;
      if (isFast(priority)) {
        // Leading edge: the first chunk of an idle burst writes immediately
        // (typing echo and single-chunk agent messages never wait a frame);
        // anything arriving synchronously after it coalesces to the tick.
        // The 16KB frame budget still bounds every tick, so a jumbo first
        // chunk takes its whole frame but follow-ups pace after it.
        if (!burstArmed && buffer.length === 0 && !scheduled && framesUntilAllowed <= 0) {
          burstArmed = true;
          write(data, hint);
          scheduleTick();
          return;
        }
        burstArmed = true;
        buffer.push({ text: data, bytes: hint });
        scheduleTick();
        return;
      }
      buffer.push({ text: data, bytes: hint });
      scheduleTick();
    },
    setPriority(next) {
      const wasFast = isFast(priority);
      priority = next;
      if (isFast(next) && !wasFast && buffer.length > 0) flush();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      let batch = takeFrameBatch();
      while (batch !== null) {
        write(batch.text, batch.bytes);
        batch = takeFrameBatch();
      }
    },
  };
}
