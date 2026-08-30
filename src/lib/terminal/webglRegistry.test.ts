import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireGlSlot,
  releaseGlSlot,
  touchGlSlot,
  setMaxActiveContextsForTests,
  resetWebglRegistryForTests,
} from "./webglRegistry";
import {
  setFocusedPane,
  resetPanePriorityForTests,
} from "./panePriority";

describe("webglRegistry", () => {
  beforeEach(() => {
    resetWebglRegistryForTests();
    resetPanePriorityForTests();
    setMaxActiveContextsForTests(3);
  });

  afterEach(() => {
    resetWebglRegistryForTests();
    resetPanePriorityForTests();
  });

  it("admits panes up to the cap", () => {
    expect(acquireGlSlot("a", vi.fn())).toBe(true);
    expect(acquireGlSlot("b", vi.fn())).toBe(true);
    expect(acquireGlSlot("c", vi.fn())).toBe(true);
    // Cap reached: acquiring d must succeed by evicting someone.
    expect(acquireGlSlot("d", vi.fn())).toBe(true);
  });

  it("evicts the least-recently-focused pane and calls its downgrade", () => {
    const downA = vi.fn();
    const downB = vi.fn();
    const downC = vi.fn();
    acquireGlSlot("a", downA);
    acquireGlSlot("b", downB);
    acquireGlSlot("c", downC);

    // Focus b, then c: a becomes the LRU victim.
    touchGlSlot("b");
    touchGlSlot("c");

    acquireGlSlot("d", vi.fn());
    expect(downA).toHaveBeenCalledTimes(1);
    expect(downB).not.toHaveBeenCalled();
    expect(downC).not.toHaveBeenCalled();

    // Next victim: b (older than c).
    acquireGlSlot("e", vi.fn());
    expect(downB).toHaveBeenCalledTimes(1);
    expect(downC).not.toHaveBeenCalled();
  });

  it("re-acquiring an active id touches it without evicting", () => {
    const downA = vi.fn();
    const downB = vi.fn();
    acquireGlSlot("a", downA);
    acquireGlSlot("b", downB);
    touchGlSlot("b");
    // Re-acquire must refresh recency, not duplicate or evict.
    expect(acquireGlSlot("b", vi.fn())).toBe(true);
    acquireGlSlot("c", vi.fn()); // cap reached exactly, no victim yet
    expect(downA).not.toHaveBeenCalled();
    acquireGlSlot("d", vi.fn()); // a is LRU (b was touched twice)
    expect(downA).toHaveBeenCalledTimes(1);
    expect(downB).not.toHaveBeenCalled();
  });

  it("release frees a slot so the next acquire does not evict", () => {
    const downA = vi.fn();
    const downB = vi.fn();
    acquireGlSlot("a", downA);
    acquireGlSlot("b", downB);
    acquireGlSlot("c", vi.fn());
    releaseGlSlot("a");
    expect(downA).not.toHaveBeenCalled(); // release ≠ downgrade
    acquireGlSlot("d", vi.fn());
    expect(downB).not.toHaveBeenCalled();
  });

  it("release of an unknown id is a no-op", () => {
    expect(() => releaseGlSlot("ghost")).not.toThrow();
  });

  it("never evicts the focused pane even when it is the LRU", () => {
    const downA = vi.fn();
    const downB = vi.fn();
    const downC = vi.fn();
    acquireGlSlot("a", downA);
    acquireGlSlot("b", downB);
    acquireGlSlot("c", downC);
    // a is oldest and unfocused; b and c are touched (fresher).
    touchGlSlot("b");
    touchGlSlot("c");
    // Make the OLDEST pane the focused one.
    setFocusedPane("a");

    acquireGlSlot("d", vi.fn());
    // Focused "a" survives; the oldest *background* pane (b) is evicted.
    expect(downA).not.toHaveBeenCalled();
    expect(downB).toHaveBeenCalledTimes(1);
    expect(downC).not.toHaveBeenCalled();
  });

  it("downgrading via the callback then releasing keeps state consistent", () => {
    let downgradeA: () => void = () => {};
    downgradeA = vi.fn();
    acquireGlSlot("a", downgradeA as () => void);
    acquireGlSlot("b", vi.fn());
    acquireGlSlot("c", vi.fn());
    touchGlSlot("b");
    touchGlSlot("c");
    acquireGlSlot("d", vi.fn()); // evicts a
    expect(downgradeA).toHaveBeenCalled();
    releaseGlSlot("a"); // evicted pane unmounts later
    acquireGlSlot("e", vi.fn()); // evicts c (oldest now)
    expect((downgradeA as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});
