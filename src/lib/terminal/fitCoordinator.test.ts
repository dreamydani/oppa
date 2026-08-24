import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  notifyResizeActivity,
  requestFit,
  isResizeStreaming,
  resetFitCoordinatorForTests,
  setFitSchedulerForTests,
} from "./fitCoordinator";
import {
  beginLayoutAnimation,
  endLayoutAnimation,
  resetLayoutAnimationGateForTests,
} from "../layout/layoutAnimationGate";

// Manual frame pump: the coordinator schedules through an injectable
// scheduler so tests decide when a "frame" runs.
let rafQueue: Array<() => void>;

function pumpFrame() {
  const queue = rafQueue;
  rafQueue = [];
  for (const cb of queue) cb();
}

describe("fitCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetLayoutAnimationGateForTests();
    resetFitCoordinatorForTests();
    rafQueue = [];
    setFitSchedulerForTests((cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
  });

  afterEach(() => {
    resetLayoutAnimationGateForTests();
    resetFitCoordinatorForTests();
    vi.useRealTimers();
  });

  it("coalesces requests from different panes into one scheduled frame", () => {
    const a = vi.fn();
    const b = vi.fn();
    requestFit("a", a);
    requestFit("b", b);
    expect(rafQueue.length).toBe(1);
    pumpFrame();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("replaces a prior unscheduled request for the same pane id", () => {
    const a1 = vi.fn();
    const a2 = vi.fn();
    requestFit("a", a1);
    requestFit("a", a2);
    pumpFrame();
    expect(a1).not.toHaveBeenCalled();
    expect(a2).toHaveBeenCalledTimes(1);
  });

  it("runs a leading-edge commit when a resize stream starts", () => {
    const a = vi.fn();
    requestFit("a", a);

    notifyResizeActivity();
    expect(isResizeStreaming()).toBe(true);
    pumpFrame();
    // Leading-edge commit lands immediately (discrete-transition semantics).
    expect(a).toHaveBeenCalledTimes(1);

    // Continuous resizes keep the stream open and block new commits...
    requestFit("a", a);
    notifyResizeActivity();
    notifyResizeActivity();
    pumpFrame();
    expect(a).toHaveBeenCalledTimes(1);

    // ...until the stream goes quiet and the settle flush runs.
    vi.advanceTimersByTime(200);
    expect(isResizeStreaming()).toBe(false);
    expect(a).toHaveBeenCalledTimes(2);
  });

  it("re-arming the stream with fresh resizes postpones the settle flush", () => {
    const a = vi.fn();
    notifyResizeActivity();
    pumpFrame();

    requestFit("a", a);
    notifyResizeActivity();
    vi.advanceTimersByTime(100);
    notifyResizeActivity(); // still dragging
    vi.advanceTimersByTime(100);
    expect(a).not.toHaveBeenCalled();

    vi.advanceTimersByTime(100); // past the re-armed quiet window
    expect(a).toHaveBeenCalledTimes(1);
  });

  it("ignores resize activity while the layout-animation gate is active", () => {
    const a = vi.fn();
    beginLayoutAnimation("sidebar-left", 380);

    notifyResizeActivity();
    expect(isResizeStreaming()).toBe(false);

    requestFit("a", a);
    pumpFrame();
    // Drawer-driven resizes commit normally once the gate releases them.
    expect(a).toHaveBeenCalledTimes(1);
    endLayoutAnimation("sidebar-left");
  });

  it("cancelling a pending request prevents its execution", () => {
    const a = vi.fn();
    const cancel = requestFit("a", a);
    cancel();
    pumpFrame();
    expect(a).not.toHaveBeenCalled();
  });
});
