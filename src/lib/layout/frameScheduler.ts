// Shared next-frame scheduler with a test seam so components can be driven
// deterministically without stubbing global rAF (which fights fake timers).

type FrameCallback = () => void;

let override: ((cb: FrameCallback) => void) | null = null;

export function onNextFrame(cb: FrameCallback): void {
  if (override) {
    override(cb);
    return;
  }
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(cb as FrameRequestCallback);
  } else {
    setTimeout(cb, 16);
  }
}

export function setFrameSchedulerForTests(scheduler: (cb: FrameCallback) => void): void {
  override = scheduler;
}

export function resetFrameSchedulerForTests(): void {
  override = null;
}
