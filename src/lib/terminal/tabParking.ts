// Cold-park policy for hidden tabs (Orca-parity): a hidden pane stays mounted
// for 30s so quick tab flips never pay a re-hydrate; a bounded hot-retain
// working set (6 tabs, 4 worktrees, 5min) stays warm beyond that. The cap (not
// the clock) is the primary evictor. Reveal cost is a flat remount + snapshot
// replay, so cutting remount *frequency* beats shaving replay.

export const TAB_COLD_PARK_DELAY_MS = 30_000;
export const TAB_HOT_RETAIN_MS = 5 * 60_000;
export const TAB_HOT_RETAIN_LIMIT = 6;
export const WORKTREE_HOT_RETAIN_LIMIT = 4;

export interface ParkableTab {
  id: string;
  isVisible: boolean;
  hiddenSinceMs: number | null;
  lastActivatedSeq: number;
  worktreeIds: string[];
}

export interface ParkPolicyOverrides {
  coldParkDelayMs?: number;
  hotRetainMs?: number;
  hotRetainLimit?: number;
  worktreeRetainLimit?: number;
}

// Visibility tracking: first-hide wins (re-hiding must not extend the lease),
// activation clears the clock and bumps recency. Kept module-level so the
// store stays serializable; reset in tests.
const hiddenSinceByTab = new Map<string, number>();
const activatedSeqByTab = new Map<string, number>();
let activationSeq = 0;

export function noteTabActivated(tabId: string): void {
  if (!tabId) return;
  activationSeq += 1;
  activatedSeqByTab.set(tabId, activationSeq);
  hiddenSinceByTab.delete(tabId);
}

export function noteTabHidden(tabId: string, nowMs: number): void {
  if (!tabId || hiddenSinceByTab.has(tabId)) return;
  hiddenSinceByTab.set(tabId, nowMs);
}

export function dropTabTracking(tabId: string): void {
  hiddenSinceByTab.delete(tabId);
  activatedSeqByTab.delete(tabId);
}

export function tabTrackingSnapshot(tabId: string): {
  hiddenSinceMs: number | null;
  lastActivatedSeq: number;
} {
  return {
    hiddenSinceMs: hiddenSinceByTab.get(tabId) ?? null,
    lastActivatedSeq: activatedSeqByTab.get(tabId) ?? 0,
  };
}

export function resetTabParkingForTests(): void {
  hiddenSinceByTab.clear();
  activatedSeqByTab.clear();
  activationSeq = 0;
}

// Drop tracking for closed tabs so the maps stay bounded by tab count.
export function pruneTabTracking(liveIds: Set<string>): void {
  for (const id of hiddenSinceByTab.keys()) {
    if (!liveIds.has(id)) hiddenSinceByTab.delete(id);
  }
  for (const id of activatedSeqByTab.keys()) {
    if (!liveIds.has(id)) activatedSeqByTab.delete(id);
  }
}

// Pure park planner: returns the ids to unmount. Visible, freshly-hidden,
// sleeping (not passed in), and hot-retained tabs are never parked.
export function planTabParking(
  tabs: ParkableTab[],
  nowMs: number,
  overrides?: ParkPolicyOverrides,
): string[] {
  const delay = overrides?.coldParkDelayMs ?? TAB_COLD_PARK_DELAY_MS;
  const hotRetain = overrides?.hotRetainMs ?? TAB_HOT_RETAIN_MS;
  const tabLimit = overrides?.hotRetainLimit ?? TAB_HOT_RETAIN_LIMIT;
  const worktreeLimit = overrides?.worktreeRetainLimit ?? WORKTREE_HOT_RETAIN_LIMIT;

  const overdue = tabs.filter(
    (t) =>
      !t.isVisible &&
      t.hiddenSinceMs !== null &&
      nowMs - t.hiddenSinceMs >= delay,
  );
  if (overdue.length === 0) return [];

  // Past the hot window everything parks regardless of caps.
  const warm = overdue.filter((t) => nowMs - (t.hiddenSinceMs ?? 0) < delay + hotRetain);
  const parkPastWindow = overdue
    .filter((t) => !warm.includes(t))
    .map((t) => t.id);

  // Worktree buckets ranked by their most recently activated tab; tabs
  // without a worktree share one bucket so plain tabs compete fairly.
  const bucketOf = (t: ParkableTab): string => t.worktreeIds[0] ?? "";
  const bucketRank = new Map<string, number>();
  for (const t of warm) {
    const bucket = bucketOf(t);
    bucketRank.set(bucket, Math.max(bucketRank.get(bucket) ?? 0, t.lastActivatedSeq));
  }
  const keptBuckets = new Set(
    [...bucketRank.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(0, worktreeLimit))
      .map(([bucket]) => bucket),
  );
  const kept = warm
    .filter((t) => keptBuckets.has(bucketOf(t)))
    .sort((a, b) => b.lastActivatedSeq - a.lastActivatedSeq)
    .slice(0, Math.max(0, tabLimit))
    .map((t) => t.id);
  const keptSet = new Set(kept);

  return [...warm.filter((t) => !keptSet.has(t.id)).map((t) => t.id), ...parkPastWindow];
}
