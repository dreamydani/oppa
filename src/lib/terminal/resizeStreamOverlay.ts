// Resize-stream freeze+stretch overlay. During a continuous resize stream
// (divider drag, window resize, maximize FLIP) the pane's xterm element is
// pinned at its last-rendered rect and stretched non-uniformly to fill the
// new box via a CSS transform — no re-measure, no reflow, no re-render
// mid-drag. On settle the overlay is removed and the real fit commits, so the
// crisp new-size content swaps in exactly once.
//
// Pure module state (no React), mirroring fitCoordinator's pattern so the
// overlay is unit-testable and driven by the shared fit pipeline.

interface OverlayEntry {
  el: HTMLElement;
  // Rect captured at begin (or last update), in CSS px.
  width: number;
  height: number;
}

const overlays = new Map<string, OverlayEntry>();

// Reduced-motion and hidden-pane guards are the caller's job; this module
// only computes and applies the stretch.

export function beginResizeStream(id: string, el: HTMLElement): void {
  const rect = el.getBoundingClientRect();
  overlays.set(id, { el, width: rect.width || 1, height: rect.height || 1 });
  el.style.willChange = "transform";
  el.style.transformOrigin = "top left";
}

export function updateResizeStream(
  id: string,
  rect: { width: number; height: number },
): void {
  const entry = overlays.get(id);
  if (!entry) return;
  const sx = rect.width / entry.width;
  const sy = rect.height / entry.height;
  entry.el.style.transform = `scale(${sx}, ${sy})`;
  entry.width = rect.width || 1;
  entry.height = rect.height || 1;
}

export function endResizeStream(id: string): void {
  const entry = overlays.get(id);
  if (!entry) return;
  entry.el.style.willChange = "";
  entry.el.style.transformOrigin = "";
  entry.el.style.transform = "";
  overlays.delete(id);
}

export function isResizeStreamActive(id: string): boolean {
  return overlays.has(id);
}

export function resizeOverlayFor(id: string): { el: HTMLElement } | undefined {
  const entry = overlays.get(id);
  return entry ? { el: entry.el } : undefined;
}

export function resetResizeStreamOverlayForTests(): void {
  for (const { el } of overlays.values()) {
    el.style.willChange = "";
    el.style.transformOrigin = "";
    el.style.transform = "";
  }
  overlays.clear();
}
