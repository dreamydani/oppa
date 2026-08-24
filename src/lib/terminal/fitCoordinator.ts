// Shared fit scheduler for all terminal panes. Two jobs:
//
// 1. Coalesce per-pane fit requests into ONE rAF pass instead of N
//    independent ResizeObserver RAF loops.
// 2. Turn continuous resize streams (divider drags, window resize) into a
//    leading-edge commit + one settle commit, so the grid never reflows
//    mid-drag — that mid-flight churn is what reads as flicker/jitter.
//
// Drawer-driven resizes are ignored while the layout-animation gate is
// active: those commits belong to the gate release (exactly once).

import { isLayoutAnimating } from "../layout/layoutAnimationGate";

const STREAM_QUIET_MS = 140;

type FitFn = () => void;
type FrameScheduler = (cb: () => void) => number;

let pending = new Map<string, FitFn>();
let rafScheduled = false;
let streaming = false;
let quietTimer: ReturnType<typeof setTimeout> | null = null;
// Test hook: swap rAF for a deterministic pump without touching globals.
let schedulerOverride: FrameScheduler | null = null;

function schedulePass(): void {
  if (rafScheduled) return;
  rafScheduled = true;
  const schedule = schedulerOverride ?? ((cb: () => void) => requestAnimationFrame(cb));
  schedule(() => {
    rafScheduled = false;
    flushAll();
  });
}

function flushAll(): void {
  if (pending.size === 0) return;
  const fits = pending;
  pending = new Map();
  for (const fit of fits.values()) fit();
}

export function requestFit(id: string, fit: FitFn): () => void {
  pending.set(id, fit);
  if (!streaming) schedulePass();
  return () => {
    if (pending.get(id) === fit) pending.delete(id);
  };
}

export function notifyResizeActivity(): void {
  // Gate-active resizes are drawer-driven; the gate release commits once.
  if (isLayoutAnimating()) return;

  if (!streaming) {
    streaming = true;
    // Leading edge: discrete transitions (drawer end, first drag frame)
    // commit immediately; everything after coalesces until quiet.
    schedulePass();
  }
  if (quietTimer !== null) clearTimeout(quietTimer);
  quietTimer = setTimeout(endStream, STREAM_QUIET_MS);
}

function endStream(): void {
  quietTimer = null;
  if (!streaming) return;
  streaming = false;
  flushAll();
}

export function isResizeStreaming(): boolean {
  return streaming;
}

export function resetFitCoordinatorForTests(): void {
  if (quietTimer !== null) clearTimeout(quietTimer);
  pending = new Map();
  rafScheduled = false;
  streaming = false;
  quietTimer = null;
  schedulerOverride = null;
}

export function setFitSchedulerForTests(scheduler: FrameScheduler | null): void {
  schedulerOverride = scheduler;
}
