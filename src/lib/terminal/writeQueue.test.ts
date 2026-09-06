import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { createThrottledWriteQueue } from "./writeQueue";
import {
  setFrameSchedulerForTests,
  resetFrameSchedulerForTests,
} from "../layout/frameScheduler";

let rafQueue: Array<() => void>;
function pumpFrames(count: number) {
  for (let i = 0; i < count; i++) {
    const q = rafQueue;
    rafQueue = [];
    for (const cb of q) cb();
  }
}

describe("createThrottledWriteQueue", () => {
  beforeEach(() => {
    rafQueue = [];
    setFrameSchedulerForTests((cb) => {
      rafQueue.push(cb);
    });
  });
  afterEach(() => {
    resetFrameSchedulerForTests();
  });

  it("writes the burst head immediately when focused (echo never waits)", () => {
    const write = vi.fn();
    const q = createThrottledWriteQueue("focused", write);
    q.push("hello");
    expect(write).toHaveBeenCalledWith("hello", 5);
    q.dispose();
  });

  it("defers writes for background panes and flushes at the cap", () => {
    const write = vi.fn();
    const q = createThrottledWriteQueue("background", write);
    q.push("a");
    q.push("b");
    expect(write).not.toHaveBeenCalled();

    // One frame (16.7ms at 60fps, or ~2 frames at 30fps) flushes the batch.
    pumpFrames(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("ab", 2);
    q.dispose();
  });

  it("upgrading a background pane to focused flushes deferred content immediately", () => {
    const write = vi.fn();
    const q = createThrottledWriteQueue("background", write);
    q.push("a");
    expect(write).not.toHaveBeenCalled();

    q.setPriority("focused");
    q.push("b");
    // Deferred "a" flushes first, then the focused "b" writes immediately —
    // ordering preserved, no cap latency on the upgrade.
    expect(write).toHaveBeenNthCalledWith(1, "a", 1);
    expect(write).toHaveBeenNthCalledWith(2, "b", 1);
    q.dispose();
  });

  it("downgrading a focused pane to background starts deferring", () => {
    const write = vi.fn();
    const q = createThrottledWriteQueue("focused", write);
    q.setPriority("background");
    q.push("a");
    expect(write).not.toHaveBeenCalled();
    pumpFrames(1);
    expect(write).toHaveBeenCalledWith("a", 1);
    q.dispose();
  });

  it("never drops output: dispose flushes the tail", () => {
    const write = vi.fn();
    const q = createThrottledWriteQueue("background", write);
    q.push("tail");
    expect(write).not.toHaveBeenCalled();
    q.dispose();
    expect(write).toHaveBeenCalledWith("tail", 4);
  });

  it("coalesces a focused burst: head immediate, tail on the tick", () => {
    const write = vi.fn();
    const q = createThrottledWriteQueue("focused", write);
    q.push("a");
    q.push("b");
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenNthCalledWith(1, "a", 1);
    pumpFrames(1);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenNthCalledWith(2, "b", 1);
    q.dispose();
  });

  it("splits a queued tail larger than the frame budget across ticks", () => {
    const write = vi.fn();
    const q = createThrottledWriteQueue("focused", write, 30, 4);
    q.push("head");
    q.push("aa");
    q.push("bb");
    q.push("cc");
    // Head writes immediately; the tail paces 4 text-units per tick.
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenNthCalledWith(1, "head", 4);
    pumpFrames(1);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenNthCalledWith(2, "aabb", 4);
    pumpFrames(1);
    expect(write).toHaveBeenCalledTimes(3);
    expect(write).toHaveBeenNthCalledWith(3, "cc", 2);
    q.dispose();
  });

  it("carries exact byte hints through a budget split (multibyte-safe)", () => {
    const write = vi.fn();
    // Budget is TEXT length (UTF-16 units); byte hints ride along untouched.
    // One emoji = 2 units, so budget 2 splits the two queued emojis.
    const q = createThrottledWriteQueue("focused", write, 30, 2);
    q.push("🚀", 4);
    q.push("🚀", 4);
    q.push("🚀", 4);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenNthCalledWith(1, "🚀", 4);
    pumpFrames(1);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenNthCalledWith(2, "🚀", 4);
    pumpFrames(1);
    expect(write).toHaveBeenNthCalledWith(3, "🚀", 4);
    q.dispose();
  });

  it("coalesces multiple pushes within one cap interval", () => {
    const write = vi.fn();
    const q = createThrottledWriteQueue("background", write);
    q.push("1");
    q.push("2");
    pumpFrames(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("12", 2);

    // The cap interval (30fps → every 2nd frame) governs the next flush.
    q.push("3");
    q.push("4");
    pumpFrames(1); // still within the interval — no flush yet
    expect(write).toHaveBeenCalledTimes(1);
    pumpFrames(1); // interval elapsed — flush lands
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenNthCalledWith(2, "34", 2);
    q.dispose();
  });
});
