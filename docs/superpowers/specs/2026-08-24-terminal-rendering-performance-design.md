# OPPA — Terminal Rendering & Performance Design

**Date:** 2026-08-24
**Status:** Approved (user-selected: drawer toggle, Rust batching included, WebGL LRU included)
**Target:** Sidebar motion, xterm fit pipeline, PTY IPC data path, GPU renderer lifecycle, drag input path

---

## 1. Problem Statement

### 1.1 Sidebar toggle flicker (the visible complaint)

Toggling the left sidebar animates `width` + `margin` on `.left-sidebar` over 300–380 ms.
Because `.main-viewport { flex: 1 }`, the entire workspace subtree reflows **every animation
frame** (~18 frames). During the animation each pane's `ResizeObserver` fires per frame; the
stable-fit guard in `TerminalPane.tsx` (`++frame >= 8`) **forces a `fit.fit()` mid-animation**,
resizing the WebGL canvas and reflowing text to an intermediate grid, then again at settle.
Each fit also re-runs the full-bleed `letterSpacing`/`lineHeight` hunt whose optimal plan
differs between intermediate widths → horizontal glyph jitter. Net perception: flicker/flash,
then "the good one."

The same mechanics degrade divider drags and window resizes.

### 1.2 Data-path throughput ceiling

Per ≤8 KB PTY read the pipeline performs: JSON serialize (daemon) → pipe line → JSON parse
(GUI client) → broadcast Tauri event → **N mounted panes' global listeners each filter by id**
(all tabs stay live-mounted with `display:none`) → `term.write` → `onWriteParsed` → one
`pty_ack` invoke per write batch. Under bursty output this is thousands of IPC messages and
ack round-trips per second; dispatch cost scales O(panes).

### 1.3 GPU context ceiling

Every pane across every tab holds a `WebglAddon` GL context forever. Chromium caps ~16 active
WebGL contexts; beyond that, oldest contexts are silently lost (falling back via
`onContextLoss`, sometimes at focus-time with a visible flash).

---

## 2. Design

### 2.1 Phase A — Compositor-only drawer sidebar

Replace width/margin layout animation with transform-only motion. The terminal viewport takes
its final width exactly once per toggle; all visible motion is compositor-driven.

**Close (commit-first):**
1. Toggle fires → sidebar element is pinned `position: absolute` at its current geometry
   (left/top/width/height copied from its live rect) → zero visual jump.
2. Viewport instantly takes full width → exactly **one** refit cycle (Phase B gate keeps it
   to a single commit).
3. Sidebar plays `transform: translateX(calc(-100% - margin))` transition (300 ms
   `--ease-slide`), inner content parallaxes/fades as today.
4. On `transitionend` (+ timer fallback), `visibility: hidden`; inline styles cleared.

**Open (slide-in → commit under cover):**
1. Sidebar mounts absolute at `translateX(-100%)`, slides in over the still-full-width
   terminal (pure transform).
2. On `transitionend`, sidebar re-enters flex flow → viewport narrows → single refit happens
   entirely beneath the now-static opaque panel. Both reflow snaps are masked.
3. Rapid-toggle interruption: reversing mid-flight first commits any pending layout state
   (panel enters/exits flow synchronously), then plays the opposite slide from current visual
   position. Same cancel discipline as `PaneSplit`'s zoom cancels.

**Reduced motion:** `prefers-reduced-motion` skips transitions entirely (instant snap),
matching existing behavior in `maximizeZoom.ts`.

**Right sidebar:** same mechanism, mirrored direction, applied as a symmetric follow-up task.

### 2.2 Phase A support — Layout-animation gate

A tiny module (`src/lib/layout/layoutAnimationGate.ts`) exposes
`beginLayoutAnimation(kind)` / `endLayoutAnimation()` plus an `isActive()` query. While any
layout animation is active:

- TerminalPane's ResizeObserver handler records "resize pending" but does not fit.
- When the gate clears, each pending pane commits **one** fit (via the shared coordinator).
- Safety deadline: the gate auto-expires after duration + 250 ms even if `transitionend`
  never fires (hidden tab, happy-dom).

### 2.3 Phase A support — CSS containment

`.pane-leaf` gets `contain: layout paint style` (it is flex-sized by the parent, so layout
containment is safe); `.terminal-pane-wrapper` gets `contain: content`. This prevents
per-frame relayout from cascading into xterm DOM during the remaining animated-resize cases
(window resize, divider drag).

### 2.4 Phase B — Shared FitCoordinator

New module `src/lib/terminal/fitCoordinator.ts`:

- Panes register `{ id, requestFit }`; the coordinator schedules **one rAF pass** that runs
  all dirty fits (replaces N independent RAF loops).
- Settle detection: during a continuous resize stream it defers commits until proposals stop
  changing for 2 frames or a 150 ms max-delay elapses (replaces the blind 8-frame cap).
- Full-bleed spacing hunt (`applyFullBleed`) is suppressed while a resize stream is active;
  spacing changes apply only on the settle commit — kills glyph jitter mid-drag.
- Exposes `beginResizeStream()/notifyResize()/endResizeStream()` used by both the drawer gate
  and plain window/divider resizing.

TerminalPane keeps its mount/settle/appearance fit paths but delegates scheduling through the
coordinator. Behavior contract preserved: every fit ends in `schedulePtyResize()` (100 ms
coalesced debounce unchanged).

### 2.5 Phase C1 — pty:data multiplexer

`src/lib/pty/dataMultiplexer.ts`: exactly ONE global `listen("pty:data")` installed lazily;
routes payloads to handlers in `Map<sessionId, Set<handler>>`. TerminalPane registers per
session id instead of calling `onPtyData`. Dispatch becomes O(1) per chunk regardless of pane
count. Public transport API gains `subscribePtyData(id, cb) => unsubscribe`;
`onPtyData` remains exported for compatibility/tests.

### 2.6 Phase C2 — ACK coalescing

TerminalPane accumulates parsed byte counts in a ref and flushes at most once per animation
frame per session (`requestAnimationFrame`; falls back to 16 ms timeout when rAF unavailable
in tests). Watermark math is unchanged — totals eventually acked, bytes counted identically;
only invoke frequency drops (from per-write-batch to ≤60/s worst case, typically far less).

### 2.7 Phase C3 — Rust chunk batcher

In the daemon session reader path, move emission into a dedicated batcher thread:

```
reader thread ──raw chunks──► crossbeam/std mpsc ──► batcher thread
                                                      │ recv_timeout(8ms)
                                                      │ drain up to 32KB or flush on timeout
                                                      ▼
                                        DaemonEvent::Data { data, bytes = Σchunks }
```

- UTF-8 decode runs **once per accumulated batch**: raw bytes concatenate in a `Vec<u8>`;
  `Utf8ChunkDecoder` processes the whole buffer (its state already carries split sequences
  across calls). No lossy conversion of partial code points.
- Byte accounting: `pending` watermark counter stays on the reader thread (incremented at
  read time, before enqueue). Batch `bytes` = exact sum of accumulated chunks, so renderer
  ACKs reconcile identically.
- `seq`: one monotonic value per batch (renderer does not order by seq; kept for parity).
- Flush guarantees: max latency 8 ms beyond first queued chunk; max size 32 KB (4× current
  chunk size); final flush on session drop so no tail output is lost before `Exit`.

### 2.8 Phase D — WebGL context LRU

`src/lib/terminal/webglRegistry.ts`: process-wide registry capping active WebglAddons
(default 8). TerminalPane asks the registry before loading `WebglAddon`;

- Denied → load `CanvasAddon` (never the DOM renderer).
- Focus grant / tab activation → upgrade: load Canvas first? No — upgrade loads WebglAddon,
  then disposes Canvas (renderer swap never touches the buffer; scrollback preserved).
- Downgrade (LRU eviction when a new pane needs a slot): load CanvasAddon **before** disposing
  WebglAddon to avoid a DOM-renderer frame.
- Registry tracks `{ id, lastFocusedAt }`; hidden tabs and unfocused panes are eviction
  candidates; the focused pane's slot is never evicted.

### 2.9 Phase E — Input-path rAF throttling

- `SplitDivider` pointermove: coalesce `setRatio` store updates to once per animation frame
  (latest ratio wins); ratio committed to store on trailing frame; `saveLayout` unchanged
  (once on drag end).
- LeftSidebar resize handle: same rAF coalescing for `setLeftSidebarWidth`.

---

## 3. Non-Goals

- No change to backpressure semantics (256 KB / 32 KB watermarks, byte-accurate ACKs).
- No change to persistence formats or restore behavior.
- No virtualization/unmounting of hidden tabs (live-output correctness stays).
- Right-sidebar drawer symmetry is included only as a mechanical mirror task; no redesign.

## 4. Testing Strategy (TDD)

| Area | Test |
|------|------|
| Layout-animation gate | Unit: begin/end/expiry, pending-fit semantics |
| Drawer close/open | Component: class/inline-state transitions, single refit commit, interruption reversal, reduced-motion snap |
| FitCoordinator | Unit: rAF coalescing, settle detection, spacing-hunt suppression, max-delay |
| Data multiplexer | Unit: routing by id, subscribe/unsubscribe, single underlying listener |
| ACK coalescer | Unit (fake timers/rAF): flush cadence, totals exact, unmount flushes remainder |
| Rust batcher | Unit: 8 ms/32KB policy, UTF-8 splits across batches, tail flush on drop |
| Daemon integration | Burst throughput: event count bounded, byte total + ordering preserved, watermarks pause/resume |
| WebGL registry | Unit: cap enforcement, LRU eviction order, focused-slot protection, hot swap ordering |
| Drag throttling | Unit/component: store updates ≤1 per frame |

Manual verification (Windows): sidebar toggle smoothness under `cat` flood, divider drag,
window resize, many-tab GL stability, DevTools performance trace showing no long-frame storms
during toggles.

## 5. Risks & Mitigations

- **Drawer overlap visuals:** open-path commit-under-cover relies on opaque panel; theme bg
  mismatch would leak. Mitigation: panel carries session/workspace bg tokens as today.
- **Batcher adds up-to-8 ms latency:** imperceptible vs frame budget; typing echo unaffected
  (input path untouched).
- **WebGL hot-swap glyph metrics:** renderer swap can momentarily re-rasterize; acceptable
  and rare (focus events only).
