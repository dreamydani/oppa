import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AckCoalescer } from "./ackCoalescer";

describe("AckCoalescer", () => {
  let queued: Array<() => void>;

  beforeEach(() => {
    queued = [];
  });

  function makeCoalescer(flush: (bytes: number) => void) {
    return new AckCoalescer(flush, (cb) => {
      queued.push(cb);
    });
  }

  it("flushes accumulated bytes once per frame, not per write batch", () => {
    const flush = vi.fn();
    const c = makeCoalescer(flush);

    c.add(10);
    c.add(20);
    c.add(5);
    expect(flush).not.toHaveBeenCalled();

    queued.splice(0).forEach((cb) => cb());
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(35);
  });

  it("keeps counting across frames until the flush lands", () => {
    const flush = vi.fn();
    const c = makeCoalescer(flush);

    c.add(8);
    queued.splice(0).forEach((cb) => cb());
    expect(flush).toHaveBeenCalledWith(8);

    c.add(3);
    c.add(4);
    queued.splice(0).forEach((cb) => cb());
    expect(flush).toHaveBeenCalledWith(7);
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("does nothing when flushed with zero pending bytes", () => {
    const flush = vi.fn();
    const c = makeCoalescer(flush);
    queued.splice(0).forEach((cb) => cb());
    expect(flush).not.toHaveBeenCalled();
  });

  it("dispose flushes the remainder synchronously and cancels the frame", () => {
    const flush = vi.fn();
    const c = makeCoalescer(flush);

    c.add(42);
    c.dispose();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(42);

    // The scheduled frame must be a no-op afterwards.
    queued.splice(0).forEach((cb) => cb());
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
