// Latest-value rAF coalescer for drag inputs (divider ratios, sidebar
// widths): per-event pushes collapse into one apply per frame carrying the
// final value, so store writes track the cursor without flooding React.

import { onNextFrame } from "./frameScheduler";

export interface RafCoalescer<T> {
  push(value: T): void;
  /** Apply any pending value immediately; the queued frame becomes a no-op. */
  flushNow(): void;
}

export function createRafCoalescer<T>(apply: (value: T) => void): RafCoalescer<T> {
  let pending: T | undefined;
  let hasPending = false;
  let scheduled = false;

  const run = () => {
    scheduled = false;
    if (!hasPending) return;
    const value = pending as T;
    hasPending = false;
    pending = undefined;
    apply(value);
  };

  return {
    push(value: T) {
      pending = value;
      hasPending = true;
      if (!scheduled) {
        scheduled = true;
        onNextFrame(run);
      }
    },
    flushNow() {
      scheduled = false;
      if (!hasPending) return;
      const value = pending as T;
      hasPending = false;
      pending = undefined;
      apply(value);
    },
  };
}
