import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRafCoalescer } from "./rafThrottle";
import {
  setFrameSchedulerForTests,
  resetFrameSchedulerForTests,
} from "./frameScheduler";

let queue: Array<() => void>;
function pump() {
  const q = queue;
  queue = [];
  for (const cb of q) cb();
}

describe("createRafCoalescer", () => {
  beforeEach(() => {
    queue = [];
    setFrameSchedulerForTests((cb) => {
      queue.push(cb);
    });
  });

  afterEach(() => {
    resetFrameSchedulerForTests();
  });

  it("applies only the latest pushed value per frame", () => {
    const apply = vi.fn();
    const coalescer = createRafCoalescer<number>(apply);
    coalescer.push(1);
    coalescer.push(2);
    coalescer.push(3);
    expect(apply).not.toHaveBeenCalled();

    pump();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(3);

    pump(); // stray frames are no-ops
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("resumes scheduling after a flushed frame", () => {
    const apply = vi.fn();
    const coalescer = createRafCoalescer<number>(apply);
    coalescer.push(10);
    pump();
    coalescer.push(20);
    pump();
    expect(apply).toHaveBeenNthCalledWith(2, 20);
  });

  it("flushNow applies pending value immediately and defuses the queued frame", () => {
    const apply = vi.fn();
    const coalescer = createRafCoalescer<number>(apply);
    coalescer.push(7);
    coalescer.flushNow();
    expect(apply).toHaveBeenCalledWith(7);
    pump(); // the scheduled frame must be a no-op now
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("flushNow without pending value is a no-op", () => {
    const apply = vi.fn();
    const coalescer = createRafCoalescer<number>(apply);
    coalescer.flushNow();
    expect(apply).not.toHaveBeenCalled();
  });
});
