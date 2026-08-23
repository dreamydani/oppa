# UI Motion Pass 1 — Pane Dolly-Zoom & Sidebar Slide

**Date:** 2026-08-24
**Status:** Approved (user-selected options inline)
**Scope:** Renderer-only. No store contract changes, no Rust changes, no new dependencies.

## Goal

Replace two hard-cut UI transitions with intentional motion, using pure CSS
transitions driven by class flips (zero JS animation libraries, zero JS timing
code in steady state):

1. **Pane maximize/restore "dolly & zoom"** — the maximize/restore button in
   each `TerminalPaneHeader` currently snaps the pane to fullscreen
   (`position:absolute` flip) and back.
2. **Sidebar slide in/out** — left/right sidebar toggles currently unmount the
   component instantly.

## Decisions locked with user

| Decision | Choice |
|---|---|
| Animation library | None — pure CSS transitions/keyframes |
| Sibling panes during maximize | Fade/scale out behind the zooming pane |
| Direct A→B maximize swap | Animate both panes simultaneously |
| Zoom feel | Quick dolly: 220ms out / 180ms back, `cubic-bezier(0.22, 1, 0.36, 1)` |
| Sidebar layout semantics | Push (terminal area reclaims space, animated) |
| Sidebar inner content | Parallax: drifts ∓24px toward exit edge + fade inside clipped panel |
| Sidebar timing | 240ms open / 200ms close |

## Feature A — Dolly & zoom maximize

### Behavior

- Maximize: pane visually travels from its grid slot to fullscreen via FLIP
  (First-Last-Invert-Play). Border-radius 6px→0 and border fade alongside.
- Restore: reverse travel back into the recorded slot.
- Sibling leaves cross-fade out (opacity + scale 0.97) behind the zooming pane;
  they fade back on restore.
- Toggling maximize directly from pane A to pane B animates A shrinking back
  while B expands.
- Reduced-motion OS setting, happy-dom test env, or zero-area rects → instant
  state change, no animation.

### Mechanics

- Store stays the single source of truth (`toggleMaximizePane`). The animation
  is purely presentational, layered on top by `PaneSplit`.
- `transform` does not affect layout → xterm ResizeObserver fires exactly once
  per direction at the class flip → stable-fit guard commits one grid change,
  one PTY resize. No mid-flight resize thrash.
- Rapid re-toggle mid-flight clears any in-flight inline transform before a new
  FLIP starts.
- `.pane-hidden` changes from `display:none` to
  `opacity:0; visibility:hidden; pointer-events:none` (+ transition) so hidden
  panes keep valid layout boxes and can participate in the cross-fade.
  `visibility:hidden` preserves today's focus/hit-testing exclusion.

### New module

`src/lib/pane-manager/maximizeZoom.ts` — pure helpers:
- `computeFlipTransform(prevRect, nextRect)` → translate+scale strings with
  top-left origin; returns `null` when either rect has zero area.
- Reduced-motion detection helper.

Wired via `useLayoutEffect` in `PaneSplit`, which records leaf rects in a ref
map keyed by session id.

## Feature B — Sidebar slide in/out

### Behavior

- Toggle slides the panel along its screen edge; terminal viewport grows/shrinks
  smoothly (push semantics) along the same curve. Terminal surface, borders and
  rounded corners track the motion; the glyph grid re-fits exactly once at rest
  (stable-fit guard defers commit until motion ends).
- Inner content parallax: `.sidebar-slide-inner` translates ∓24px toward the
  exit edge while fading, clipped by the panel's `overflow:hidden`.
- Fully interruptible: open/close are pure class flips; rapid Ctrl+B/Ctrl+Shift+B
  spam reverses mid-flight natively. No timers, no unmount races.
- Browser mode keeps its true unmount (instant, unchanged).
- Boot gate: an `app-booted` class lands ~300ms after startup readiness so the
  `sidebarOnLaunch` flip never animates on first paint.
- Drag-resize fix (existing bug): width transition is disabled during active
  drag via `.is-resizing`, making resize track the cursor 1:1 instead of
  rubber-banding 200ms behind it.

### Mechanics

- Both sidebars render whenever `activeAppMode !== "browser"`; closed state is a
  class, not an unmount. `RightSidebar`'s internal early-return is removed
  (App remains the only mount gate).
- Width moves from inline style to the `--sidebar-w` custom property so
  stylesheet rules can override it for the closed state.
- Asymmetric durations via cascade direction: base rule carries open duration;
  `.closed` rule carries close duration (destination state wins).
- Closed state: `width: 0; margin: 0; opacity: 0; visibility: hidden` with
  visibility delayed so the fade plays before hiding.

## Motion tokens (theme.css)

```
--dur-zoom-out: 220ms;
--dur-zoom-in: 180ms;
--dur-panel-open: 240ms;
--dur-panel-close: 200ms;
--ease-dolly: cubic-bezier(0.22, 1, 0.36, 1);
```

Plus a global `@media (prefers-reduced-motion: reduce)` kill-switch.

Token one-home invariant (`tokens.test.ts`) applies: these live only in
`theme.css`.

## Test contract updates (deliberate)

- `App.test.tsx` "conditionally renders LeftSidebar and RightSidebar": closed
  sidebars now assert the `.closed` class present instead of DOM-null
  (hidden ≠ unmounted).
- Browser-mode null assertions remain valid (true unmount retained).
- All existing PaneSplit/maximize tests unaffected (zero-area gBCR guard).

## Out of scope (later passes)

Mode-switch cross-fade, tab-switch fades, modal exit animations, wizard step
transitions, settings transitions, empty-state entrances.
