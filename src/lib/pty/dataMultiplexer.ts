// Single pty:data listener routing payloads to per-session handlers.
// Without this, every mounted pane (all tabs stay live) received every
// session's chunks and discarded N−1 of them — dispatch is now O(1).
//
// Installation bookkeeping is a small synchronous state machine: the async
// listener handshake never gates subscribe/unsubscribe decisions, so rapid
// sub/unsub cycles can't strand or leak the underlying listener.

import { onPtyData } from "./transport";
import type { PtyDataPayload } from "./transport";

type DataHandler = (p: PtyDataPayload) => void;

const handlers = new Map<string, Set<DataHandler>>();
let storedUnlisten: (() => void) | null = null;
// "idle" → "pending" (install in flight) → "active"; releases may happen in
// any state and are reconciled against `desired` wherever we land.
let installState: "idle" | "pending" | "active" = "idle";
let desired = false;

function dispatch(p: PtyDataPayload): void {
  const subs = handlers.get(p.id);
  if (!subs) return;
  for (const cb of subs) cb(p);
}

function reconcile(): void {
  if (desired && installState === "idle") {
    installState = "pending";
    void onPtyData(dispatch).then((fn) => {
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

export function subscribePtyData(id: string, cb: DataHandler): () => void {
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

export function resetDataMultiplexerForTests(): void {
  handlers.clear();
  desired = false;
  installState = "idle";
  storedUnlisten?.();
  storedUnlisten = null;
}
