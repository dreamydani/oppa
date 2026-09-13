import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribePtyExit, resetExitMultiplexerForTests } from "./exitMultiplexer";

import type { PtyExitPayload } from "./transport";

const listenState = vi.hoisted(() => ({
  callback: null as null | ((p: PtyExitPayload) => void),
  unlisten: null as null | ReturnType<typeof vi.fn>,
  installCount: 0,
}));

vi.mock("./transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./transport")>();
  return {
    ...actual,
    // Mirrors the real listen() contract: the callback receives the payload.
    onPtyExit: vi.fn(async (cb: (p: PtyExitPayload) => void) => {
      listenState.installCount += 1;
      listenState.callback = cb;
      listenState.unlisten = vi.fn();
      return listenState.unlisten;
    }),
  };
});

function emit(payload: Partial<PtyExitPayload>) {
  listenState.callback?.(payload as PtyExitPayload);
}

describe("exitMultiplexer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listenState.callback = null;
    listenState.unlisten = null;
    listenState.installCount = 0;
    resetExitMultiplexerForTests();
  });

  afterEach(() => {
    resetExitMultiplexerForTests();
  });

  it("installs exactly one underlying listener for many subscriptions", async () => {
    subscribePtyExit("a", () => {});
    subscribePtyExit("b", () => {});
    await vi.waitFor(() => expect(listenState.installCount).toBe(1));
  });

  it("routes payloads only to the matching session id", async () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribePtyExit("a", a);
    subscribePtyExit("b", b);
    await vi.waitFor(() => expect(listenState.callback).not.toBeNull());

    emit({ id: "b", code: 0 });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    expect(b.mock.calls[0][0].code).toBe(0);
  });

  it("unsubscribes cleanly and releases the underlying listener when empty", async () => {
    const a = vi.fn();
    const unsubA = subscribePtyExit("a", a);
    const unsubB = subscribePtyExit("a", vi.fn());
    await vi.waitFor(() => expect(listenState.callback).not.toBeNull());

    unsubA();
    emit({ id: "a", code: 1 });
    expect(a).not.toHaveBeenCalled();

    unsubB();
    expect(listenState.unlisten).toHaveBeenCalled();
    // Re-subscribing after a full release must reinstall the listener.
    subscribePtyExit("a", vi.fn());
    await vi.waitFor(() => expect(listenState.installCount).toBe(2));
  });

  it("ignores payloads for ids with no subscribers", async () => {
    const a = vi.fn();
    subscribePtyExit("a", a);
    await vi.waitFor(() => expect(listenState.callback).not.toBeNull());

    expect(() => emit({ id: "ghost", code: 0 })).not.toThrow();
    expect(a).not.toHaveBeenCalled();
  });

  it("releases the listener when unsubscribe lands while install is still pending", async () => {
    const unlisten = subscribePtyExit("a", vi.fn());
    // No waiting: the install promise has not resolved yet.
    unlisten();

    await vi.waitFor(() => expect(listenState.unlisten).toHaveBeenCalled());
  });
});
