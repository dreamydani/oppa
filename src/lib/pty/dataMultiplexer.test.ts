import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { subscribePtyData, resetDataMultiplexerForTests } from "./dataMultiplexer";

import type { PtyDataPayload } from "./transport";

const listenState = vi.hoisted(() => ({
  callback: null as null | ((p: PtyDataPayload) => void),
  unlisten: null as null | ReturnType<typeof vi.fn>,
  installCount: 0,
}));

vi.mock("./transport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./transport")>();
  return {
    ...actual,
    // Mirrors the real listen() contract: the callback receives the payload.
    onPtyData: vi.fn(async (cb: (p: PtyDataPayload) => void) => {
      listenState.installCount += 1;
      listenState.callback = cb;
      listenState.unlisten = vi.fn();
      return listenState.unlisten;
    }),
  };
});

function emit(payload: Partial<PtyDataPayload>) {
  listenState.callback?.(payload as PtyDataPayload);
}

describe("dataMultiplexer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listenState.callback = null;
    listenState.unlisten = null;
    listenState.installCount = 0;
    resetDataMultiplexerForTests();
  });

  afterEach(() => {
    resetDataMultiplexerForTests();
  });

  it("installs exactly one underlying listener for many subscriptions", async () => {
    subscribePtyData("a", () => {});
    subscribePtyData("b", () => {});
    await vi.waitFor(() => expect(listenState.installCount).toBe(1));
  });

  it("routes payloads only to the matching session id", async () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribePtyData("a", a);
    subscribePtyData("b", b);
    await vi.waitFor(() => expect(listenState.callback).not.toBeNull());

    emit({ id: "b", data: "x" });
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    expect(b.mock.calls[0][0].data).toBe("x");
  });

  it("unsubscribes cleanly and releases the underlying listener when empty", async () => {
    const a = vi.fn();
    const unsubA = subscribePtyData("a", a);
    const unsubB = subscribePtyData("a", vi.fn());
    await vi.waitFor(() => expect(listenState.callback).not.toBeNull());

    unsubA();
    emit({ id: "a", data: "y" });
    expect(a).not.toHaveBeenCalled();

    unsubB();
    expect(listenState.unlisten).toHaveBeenCalled();
    // Re-subscribing after a full release must reinstall the listener.
    subscribePtyData("a", vi.fn());
    await vi.waitFor(() => expect(listenState.installCount).toBe(2));
  });

  it("ignores payloads for ids with no subscribers", async () => {
    const a = vi.fn();
    subscribePtyData("a", a);
    await vi.waitFor(() => expect(listenState.callback).not.toBeNull());

    expect(() => emit({ id: "ghost", data: "?" })).not.toThrow();
    expect(a).not.toHaveBeenCalled();
  });

  it("releases the listener when unsubscribe lands while install is still pending", async () => {
    const unlisten = subscribePtyData("a", vi.fn());
    // No waiting: the install promise has not resolved yet.
    unlisten();

    await vi.waitFor(() => expect(listenState.unlisten).toHaveBeenCalled());
  });
});
