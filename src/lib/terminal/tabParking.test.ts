import { describe, expect, it, beforeEach } from "vitest";
import {
  planTabParking,
  noteTabActivated,
  noteTabHidden,
  dropTabTracking,
  pruneTabTracking,
  tabTrackingSnapshot,
  resetTabParkingForTests,
  TAB_COLD_PARK_DELAY_MS,
  type ParkableTab,
} from "./tabParking";

function tab(id: string, overrides: Partial<ParkableTab> = {}): ParkableTab {
  return {
    id,
    isVisible: false,
    hiddenSinceMs: 0,
    lastActivatedSeq: 0,
    worktreeIds: [],
    ...overrides,
  };
}

describe("planTabParking", () => {
  beforeEach(() => {
    resetTabParkingForTests();
  });

  it("never parks visible tabs", () => {
    const tabs = [tab("a", { isVisible: true, hiddenSinceMs: 0 })];
    expect(planTabParking(tabs, TAB_COLD_PARK_DELAY_MS + 1)).toEqual([]);
  });

  it("never parks freshly hidden tabs inside the delay", () => {
    const now = 1_000_000;
    const tabs = [tab("a", { hiddenSinceMs: now - TAB_COLD_PARK_DELAY_MS + 1000, lastActivatedSeq: 1 })];
    expect(planTabParking(tabs, now)).toEqual([]);
  });

  it("keeps a lone overdue tab warm inside every hot cap", () => {
    const now = 1_000_000;
    const tabs = [
      tab("old", { hiddenSinceMs: now - TAB_COLD_PARK_DELAY_MS - 1, lastActivatedSeq: 1 }),
      tab("fresh", { hiddenSinceMs: now, lastActivatedSeq: 2 }),
    ];
    // "fresh" is inside the delay; "old" is overdue but within the hot
    // window and every cap, so nothing parks yet.
    expect(planTabParking(tabs, now)).toEqual([]);
  });

  it("evicts beyond the hot tab cap, oldest first", () => {
    const now = 1_000_000;
    const tabs = Array.from({ length: 8 }, (_, i) =>
      tab(`t${i}`, {
        hiddenSinceMs: now - TAB_COLD_PARK_DELAY_MS - 1,
        lastActivatedSeq: i + 1,
      }),
    );
    // 8 overdue warm tabs, cap 6: the two least recently activated park.
    expect(planTabParking(tabs, now).sort()).toEqual(["t0", "t1"]);
  });

  it("parks everything past the hot window regardless of caps", () => {
    const now = 10_000_000;
    const tabs = [
      tab("a", { hiddenSinceMs: 0, lastActivatedSeq: 2 }),
      tab("b", { hiddenSinceMs: 0, lastActivatedSeq: 1 }),
    ];
    expect(planTabParking(tabs, now).sort()).toEqual(["a", "b"]);
  });

  it("evicts whole worktree buckets beyond the worktree cap", () => {
    const now = 1_000_000;
    const tabs = Array.from({ length: 5 }, (_, i) =>
      tab(`t${i}`, {
        hiddenSinceMs: now - TAB_COLD_PARK_DELAY_MS - 1,
        lastActivatedSeq: i + 1,
        worktreeIds: [`w${i}`],
      }),
    );
    // 5 buckets, cap 4: the stalest bucket's tab parks even under the tab cap.
    expect(planTabParking(tabs, now)).toEqual(["t0"]);
  });

  it("honors override seams for fast tests", () => {
    const tabs = Array.from({ length: 8 }, (_, i) =>
      tab(`t${i}`, { hiddenSinceMs: 0, lastActivatedSeq: i + 1 }),
    );
    expect(planTabParking(tabs, 50, { coldParkDelayMs: 100 })).toEqual([]);
    // Overdue under a 100ms delay: hot caps evict the two stalest.
    expect(
      planTabParking(tabs, 150, { coldParkDelayMs: 100 }).sort(),
    ).toEqual(["t0", "t1"]);
  });
});

describe("tab visibility tracking", () => {
  beforeEach(() => {
    resetTabParkingForTests();
  });

  it("first hide wins; activation clears the clock and bumps recency", () => {
    noteTabActivated("a");
    noteTabHidden("a", 100);
    noteTabHidden("a", 200);
    expect(tabTrackingSnapshot("a").hiddenSinceMs).toBe(100);
    const firstSeq = tabTrackingSnapshot("a").lastActivatedSeq;
    noteTabActivated("a");
    expect(tabTrackingSnapshot("a").hiddenSinceMs).toBeNull();
    expect(tabTrackingSnapshot("a").lastActivatedSeq).toBeGreaterThan(firstSeq);
  });

  it("drops tracking for closed tabs", () => {
    noteTabActivated("a");
    noteTabHidden("a", 100);
    dropTabTracking("a");
    expect(tabTrackingSnapshot("a")).toEqual({ hiddenSinceMs: null, lastActivatedSeq: 0 });
  });

  it("prunes tracking maps down to live tabs", () => {
    noteTabActivated("a");
    noteTabHidden("a", 100);
    noteTabActivated("b");
    pruneTabTracking(new Set(["b"]));
    expect(tabTrackingSnapshot("a")).toEqual({ hiddenSinceMs: null, lastActivatedSeq: 0 });
    expect(tabTrackingSnapshot("b").lastActivatedSeq).toBeGreaterThan(0);
  });
});
