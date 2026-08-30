// Per-pane write throttle. The focused pane's pty output reaches xterm
// immediately (typing echo must never wait); background panes buffer chunks
// and flush them at a capped rate so N live panes don't each redraw at 60fps.
// Output is NEVER dropped — dispose() and priority upgrades flush the tail.
// ACKs are accounted at parse time (onWriteParsed), independent of this queue,
// so backpressure semantics are unchanged.

import { onNextFrame } from "../layout/frameScheduler";
import type { PanePriority } from "./panePriority";

const DEFAULT_BACKGROUND_FPS = 30;

export interface WriteQueue {
  push(data: string): void;
  setPriority(priority: PanePriority): void;
  dispose(): void;
}

export function createThrottledWriteQueue(
  initialPriority: PanePriority,
  write: (data: string) => void,
  backgroundFps: number = DEFAULT_BACKGROUND_FPS,
): WriteQueue {
  // Background flush cadence in frames (60fps rAF). Low tier caps at 15fps
  // (every 4th frame), medium/high at 30fps (every 2nd).
  const framesPerFlush = Math.max(1, Math.round(60 / backgroundFps));
  let priority: PanePriority = initialPriority;
  let buffer: string[] = [];
  let scheduled = false;
  let disposed = false;
  // Frames remaining until the next flush is allowed; enforces the cap.
  let framesUntilAllowed = 0;

  const flush = () => {
    scheduled = false;
    if (buffer.length === 0) return;
    const batch = buffer.join("");
    buffer = [];
    write(batch);
    // After a flush, wait out the cap interval before the next one.
    framesUntilAllowed = framesPerFlush - 1;
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
    }
    flush();
  };

  return {
    push(data) {
      if (disposed) return;
      if (priority === "focused") {
        // Flush any deferred background tail first so ordering is preserved.
        if (buffer.length > 0) flush();
        write(data);
        return;
      }
      buffer.push(data);
      if (!scheduled) {
        scheduled = true;
        onNextFrame(tick);
      }
    },
    setPriority(next) {
      priority = next;
      if (next === "focused" && buffer.length > 0) flush();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      flush();
    },
  };
}
