// Process-wide WebGL context budget. Chromium silently drops the oldest GL
// context past ~16; this registry caps active WebglAddons well below that and
// downgrades the least-recently-focused pane to the Canvas renderer instead.

import { getPanePriority } from "./panePriority";

type DowngradeFn = () => void;

interface GlEntry {
  downgrade: DowngradeFn;
  lastFocusedAt: number;
}

const entries = new Map<string, GlEntry>();
let maxActive = 8;

export function acquireGlSlot(id: string, downgrade: DowngradeFn): boolean {
  const existing = entries.get(id);
  if (existing) {
    existing.lastFocusedAt = Date.now();
    return true;
  }
  if (entries.size >= maxActive) {
    evictOldest();
  }
  entries.set(id, { downgrade, lastFocusedAt: Date.now() });
  return true;
}

// Focus signal: refreshes recency so the focused pane is never the victim.
export function touchGlSlot(id: string): void {
  const entry = entries.get(id);
  if (entry) entry.lastFocusedAt = Date.now();
}

export function releaseGlSlot(id: string): void {
  entries.delete(id);
}

function evictOldest(): void {
  let oldestId: string | null = null;
  let oldestAt = Infinity;
  for (const [id, entry] of entries) {
    // The focused pane's GL slot is never evicted; hovered is second, so
    // background panes are the LRU pool even if they were focused recently.
    const priority = getPanePriority(id);
    if (priority === "focused") continue;
    const key = priority === "hovered" ? entry.lastFocusedAt + 1 : entry.lastFocusedAt;
    if (key < oldestAt) {
      oldestAt = key;
      oldestId = id;
    }
  }
  if (oldestId === null) return;
  const victim = entries.get(oldestId);
  entries.delete(oldestId);
  // The pane swaps to CanvasAddon; never the DOM renderer.
  try {
    victim?.downgrade();
  } catch {
    // A failed renderer swap must not break acquisition of the new slot.
  }
}

export function setMaxActiveContextsForTests(max: number): void {
  maxActive = max;
}

export function resetWebglRegistryForTests(): void {
  entries.clear();
  maxActive = 8;
}
