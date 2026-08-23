// FLIP helpers for the pane maximize/restore dolly-zoom. Pure math + minimal
// DOM orchestration so both are unit-testable outside React.

export interface FlipRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface FlipTransform {
  transform: string;
  transformOrigin: string;
}

// Slightly above the longest zoom duration; guarantees inline styles clear
// even when transitionend never fires (happy-dom, hidden tab, reduced motion).
const CLEANUP_FALLBACK_MS = 500;

// Mirror of theme.css motion tokens (--dur-zoom-out/in, --ease-dolly); JS
// needs numeric values for the cleanup fallback timer.
export const ZOOM_OUT_MS = 220;
export const ZOOM_IN_MS = 180;
export const EASE_DOLLY = "cubic-bezier(0.22, 1, 0.36, 1)";

function usableRect(rect: FlipRect): boolean {
  return (
    Number.isFinite(rect.left) &&
    Number.isFinite(rect.top) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

// Transform that visually pins an element already laid out at `next` back to
// where it appeared at `prev`. Top-left origin keeps translate/scale order
// stable across aspect changes.
export function computeFlipTransform(
  prev: FlipRect,
  next: FlipRect,
): FlipTransform | null {
  if (!usableRect(prev) || !usableRect(next)) return null;
  const dx = prev.left - next.left;
  const dy = prev.top - next.top;
  const sx = prev.width / next.width;
  const sy = prev.height / next.height;
  return {
    transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
    transformOrigin: "top left",
  };
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

// Applies the inverted start state, releases it under a transform transition,
// and cleans up inline styles on transitionend with a timer fallback.
// Returns a cancel() that stops everything synchronously.
export function playFlip(
  el: HTMLElement,
  flip: FlipTransform,
  durationMs: number,
  easing: string,
): () => void {
  el.style.willChange = "transform";
  el.style.transition = "none";
  el.style.transformOrigin = flip.transformOrigin;
  el.style.transform = flip.transform;
  // Flush styles so the inverted frame is committed before releasing.
  void el.offsetWidth;

  el.style.transition = `transform ${durationMs}ms ${easing}, border-radius ${durationMs}ms ease`;
  el.style.transform = "";

  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    el.removeEventListener("transitionend", onEnd);
    clearTimeout(timer);    el.style.willChange = "";
    el.style.transition = "";
    el.style.transform = "";
    el.style.transformOrigin = "";
  };
  const onEnd = (e: TransitionEvent) => {
    if (e.propertyName === "transform") cleanup();
  };
  const timer = setTimeout(cleanup, durationMs + CLEANUP_FALLBACK_MS);
  el.addEventListener("transitionend", onEnd);

  return () => cleanup();
}
