import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginLayoutAnimation,
  endLayoutAnimation,
  isLayoutAnimating,
  runWhenLayoutIdle,
  resetLayoutAnimationGateForTests,
} from "./layoutAnimationGate";

describe("layoutAnimationGate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetLayoutAnimationGateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetLayoutAnimationGateForTests();
  });

  it("reports idle before any animation begins", () => {
    expect(isLayoutAnimating()).toBe(false);
  });

  it("is active between begin and end", () => {
    beginLayoutAnimation("sidebar-left", 380);
    expect(isLayoutAnimating()).toBe(true);
    endLayoutAnimation("sidebar-left");
    expect(isLayoutAnimating()).toBe(false);
  });

  it("auto-expires after duration + safety margin even without end", () => {
    beginLayoutAnimation("sidebar-left", 380);
    vi.advanceTimersByTime(380 + 250 - 1);
    expect(isLayoutAnimating()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(isLayoutAnimating()).toBe(false);
  });

  it("tracks independent kinds concurrently", () => {
    beginLayoutAnimation("sidebar-left", 380);
    beginLayoutAnimation("sidebar-right", 380);
    expect(isLayoutAnimating()).toBe(true);
    endLayoutAnimation("sidebar-right");
    expect(isLayoutAnimating()).toBe(true);
    endLayoutAnimation("sidebar-left");
    expect(isLayoutAnimating()).toBe(false);
  });

  it("ignores end for unknown kind", () => {
    endLayoutAnimation("sidebar-left");
    expect(isLayoutAnimating()).toBe(false);
  });

  it("runs callbacks immediately when already idle", () => {
    const cb = vi.fn();
    runWhenLayoutIdle(cb);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("defers callbacks until all animations end", () => {
    const a = vi.fn();
    const b = vi.fn();
    beginLayoutAnimation("sidebar-left", 380);

    runWhenLayoutIdle(a);
    runWhenLayoutIdle(b);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();

    endLayoutAnimation("sidebar-left");
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("flushes deferred callbacks on auto-expiry", () => {
    const a = vi.fn();
    beginLayoutAnimation("sidebar-left", 380);
    runWhenLayoutIdle(a);
    vi.advanceTimersByTime(380 + 250);
    expect(a).toHaveBeenCalledTimes(1);
  });

  it("does not re-run flushed callbacks on later ends", () => {
    const a = vi.fn();
    beginLayoutAnimation("sidebar-left", 100);
    runWhenLayoutIdle(a);
    endLayoutAnimation("sidebar-left");
    endLayoutAnimation("sidebar-left");
    expect(a).toHaveBeenCalledTimes(1);
  });
});
