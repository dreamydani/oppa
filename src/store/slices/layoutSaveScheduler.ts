// Single trailing-debounce scheduler for layout.json persistence. Every
// slice funnels routine mutations here; the close handshake and drag-end
// call saveLayout directly instead.

import type { TerminalState } from "../terminalStore";

let layoutSaveTimer: ReturnType<typeof setTimeout> | null = null;

export function triggerDebouncedSaveLayout(
  get: () => TerminalState,
  delayMs = 2000,
): void {
  if (layoutSaveTimer) clearTimeout(layoutSaveTimer);
  layoutSaveTimer = setTimeout(() => {
    layoutSaveTimer = null;
    void get().saveLayout().catch(() => {});
  }, delayMs);
}
