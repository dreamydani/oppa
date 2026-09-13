// Single pty:exit listener routing payloads to per-session handlers.
// Without this, every mounted pane installed its own global listener and
// filtered N-1 sessions' exits — dispatch is now O(1). Same state machine as
// dataMultiplexer: async install never gates subscribe/unsubscribe.

import { onPtyExit } from "./transport";
import type { PtyExitPayload } from "./transport";

type ExitHandler = (p: PtyExitPayload) => void;

const handlers = new Map<string, Set<ExitHandler>>();
let storedUnlisten: (() => void) | null = null;
// "idle" → "pending" (install in flight) → "active"; releases may happen in
// any state and are reconciled against `desired` wherever we land.
let installState: "idle" | "pending" | "active" = "idle";
let desired = false;

function dispatch(p: PtyExitPayload): void {
  const subs = handlers.get(p.id);
  if (!subs) return;
  for (const cb of subs) cb(p);
}

function reconcile(): void {
  if (desired && installState === "idle") {
    installState = "pending";
    void onPtyExit(dispatch).then((fn) => {
      // Desired may have flipped while installing — trust it, not the phase.
      if (!desired) {
        fn();
        if (installState === "pending") installState = "idle";
        return;
      }
      installState = "active";
      storedUnlisten = fn;
    });
  } else if (!desired && installState === "active") {
    storedUnlisten?.();
    storedUnlisten = null;
    installState = "idle";
  }
}

export function subscribePtyExit(id: string, cb: ExitHandler): () => void {
  let subs = handlers.get(id);
  if (!subs) {
    subs = new Set();
    handlers.set(id, subs);
  }
  subs.add(cb);
  desired = true;
  reconcile();
  return () => {
    const current = handlers.get(id);
    if (!current || !current.delete(cb)) return;
    if (current.size === 0) handlers.delete(id);
    if (handlers.size === 0) {
      desired = false;
      reconcile();
    }
  };
}

export function resetExitMultiplexerForTests(): void {
  handlers.clear();
  desired = false;
  installState = "idle";
  storedUnlisten?.();
  storedUnlisten = null;
}
