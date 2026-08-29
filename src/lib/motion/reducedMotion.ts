// Shared reduced-motion probe. Previously duplicated verbatim in
// lib/layout/sideDrawer.ts and lib/pane-manager/maximizeZoom.ts; every motion
// consumer must agree on one answer or a drawer can slide while a zoom snaps.

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
