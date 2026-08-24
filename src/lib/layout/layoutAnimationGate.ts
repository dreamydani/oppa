// Layout-animation gate: while a sidebar/panel motion is in flight, terminal
// fits must defer so the grid commits exactly once at animation end — mid-flight
// refits are what read as flicker. Pure module state; no React.

export type LayoutAnimationKind = "sidebar-left" | "sidebar-right";

const SAFETY_MARGIN_MS = 250;

let active = new Set<LayoutAnimationKind>();
let expiryTimers = new Map<LayoutAnimationKind, ReturnType<typeof setTimeout>>();
let idleCallbacks: Array<() => void> = [];

function flushIdleCallbacks(): void {
  if (active.size > 0) return;
  const pending = idleCallbacks;
  idleCallbacks = [];
  for (const cb of pending) cb();
}

export function beginLayoutAnimation(kind: LayoutAnimationKind, durationMs: number): void {
  const prevTimer = expiryTimers.get(kind);
  if (prevTimer !== undefined) clearTimeout(prevTimer);
  active.add(kind);
  expiryTimers.set(
    kind,
    setTimeout(() => {
      // Safety net: transitionend can never fire (hidden tab, happy-dom).
      active.delete(kind);
      expiryTimers.delete(kind);
      flushIdleCallbacks();
    }, durationMs + SAFETY_MARGIN_MS),
  );
}

export function endLayoutAnimation(kind: LayoutAnimationKind): void {
  if (!active.has(kind)) return;
  const timer = expiryTimers.get(kind);
  if (timer !== undefined) {
    clearTimeout(timer);
    expiryTimers.delete(kind);
  }
  active.delete(kind);
  flushIdleCallbacks();
}

export function isLayoutAnimating(): boolean {
  return active.size > 0;
}

// Runs `cb` synchronously when idle, otherwise queues it until the last
// animation ends or expires.
export function runWhenLayoutIdle(cb: () => void): void {
  if (!isLayoutAnimating()) {
    cb();
    return;
  }
  idleCallbacks.push(cb);
}

export function resetLayoutAnimationGateForTests(): void {
  for (const timer of expiryTimers.values()) clearTimeout(timer);
  active = new Set();
  expiryTimers = new Map();
  idleCallbacks = [];
}
