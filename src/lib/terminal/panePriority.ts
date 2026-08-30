// Per-pane render priority registry. The focused pane gets the full frame
// budget; hovered panes get a temporary bump; everything else renders at the
// background cap. Pure module state so TerminalPane and the GL registry can
// consult it O(1) without store round-trips.

export type PanePriority = "focused" | "hovered" | "background";

let focusedPane: string | null = null;
let hoveredPane: string | null = null;

export function setFocusedPane(id: string | null): void {
  focusedPane = id;
}

export function setHoveredPane(id: string | null): void {
  hoveredPane = id;
}

export function getPanePriority(id: string): PanePriority {
  if (focusedPane === id) return "focused";
  if (hoveredPane === id) return "hovered";
  return "background";
}

export function getFocusedPane(): string | null {
  return focusedPane;
}

export function resetPanePriorityForTests(): void {
  focusedPane = null;
  hoveredPane = null;
}
