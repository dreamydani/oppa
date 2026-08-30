import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDropTargetCoalescer } from "./dragState";
import {
  setFrameSchedulerForTests,
  resetFrameSchedulerForTests,
} from "../layout/frameScheduler";

let queue: Array<() => void>;
function pump() {
  const q = queue;
  queue = [];
  for (const cb of q) cb();
}

describe("createDropTargetCoalescer", () => {
  beforeEach(() => {
    queue = [];
    setFrameSchedulerForTests((cb) => {
      queue.push(cb);
    });
  });

  afterEach(() => {
    resetFrameSchedulerForTests();
  });

  it("detects the drop target at most once per frame during a pointermove burst", () => {
    const detect = vi.fn((x: number, y: number) =>
      x >= 100 && y >= 100 ? { targetId: "b", zone: "right" as const } : null,
    );
    const onTarget = vi.fn();
    const coalescer = createDropTargetCoalescer(detect, onTarget);

    // 10 pointermoves in one frame collapse to a single detection with the
    // latest coordinates.
    for (let i = 0; i < 10; i++) coalescer.push(100 + i, 100 + i);
    expect(detect).not.toHaveBeenCalled();

    pump();
    expect(detect).toHaveBeenCalledTimes(1);
    expect(detect).toHaveBeenCalledWith(109, 109);
    expect(onTarget).toHaveBeenCalledTimes(1);
    expect(onTarget).toHaveBeenCalledWith({ targetId: "b", zone: "right" });
  });

  it("does not re-notify when the target is unchanged across frames", () => {
    const detect = vi.fn((x: number) =>
      x < 50 ? { targetId: "b", zone: "left" as const } : { targetId: "c", zone: "top" as const },
    );
    const onTarget = vi.fn();
    const coalescer = createDropTargetCoalescer(detect, onTarget);

    coalescer.push(10, 10);
    pump();
    expect(onTarget).toHaveBeenCalledTimes(1);

    // Same target next frame: must not spam the store.
    coalescer.push(20, 20);
    pump();
    expect(onTarget).toHaveBeenCalledTimes(1);

    // Different target: notifies.
    coalescer.push(60, 60);
    pump();
    expect(onTarget).toHaveBeenCalledTimes(2);
    expect(onTarget).toHaveBeenLastCalledWith({ targetId: "c", zone: "top" });
  });

  it("flushNow runs detection immediately with the latest coordinates", () => {
    const detect = vi.fn((x: number) =>
      x > 0 ? { targetId: "b", zone: "top" as const } : null,
    );
    const onTarget = vi.fn();
    const coalescer = createDropTargetCoalescer(detect, onTarget);

    coalescer.push(10, 10);
    coalescer.push(30, 30);
    coalescer.flushNow();
    expect(detect).toHaveBeenCalledTimes(1);
    expect(detect).toHaveBeenCalledWith(30, 30);
    expect(onTarget).toHaveBeenCalledTimes(1);

    // The queued frame must be a no-op now.
    pump();
    expect(detect).toHaveBeenCalledTimes(1);
  });

  it("flushNow without a pending move is a no-op", () => {
    const detect = vi.fn();
    const onTarget = vi.fn();
    const coalescer = createDropTargetCoalescer(detect, onTarget);
    coalescer.flushNow();
    expect(detect).not.toHaveBeenCalled();
    expect(onTarget).not.toHaveBeenCalled();
  });
});
