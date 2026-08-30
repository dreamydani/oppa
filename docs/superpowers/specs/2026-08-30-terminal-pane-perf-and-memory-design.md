# OPPA — Terminal Pane Performance, Memory & Visual Fidelity Design

**Date:** 2026-08-30
**Status:** Approved (user-aligned via grilling; numbers pinned: 10k/1MB, 30fps bg, freeze+stretch, 3 adaptive tiers)
**Target:** TerminalPane render path, PaneSplit/divider drag, scrollback memory, visual chrome, adaptive GPU tiers
**Branch:** `feat/terminal-pane-perf-and-memory`

---

## 1. Problem Statement

The terminal core is functionally complete: warm reattach, byte-accurate ACK
backpressure (256KB/32KB), fit coordinator, WebGL LRU registry, FLIP maximize
zoom, data multiplexer — all live in the current pipeline (per
`2026-08-24-terminal-rendering-performance-design.md`, now implemented).

The next bar, agreed with the user, is **best-in-class performance for coding-agent
CLIs** (claude code, codex, opencode, command code, agy) — the realistic workload is
**N panes, each mostly idle, occasionally bursting with rich structured output, with
typing in the focused pane staying instant**. Four gaps remain:

1. **Resize flash.** During divider drags and window resize, xterm re-measures and
   re-renders mid-stream; the full-bleed `letterSpacing`/`lineHeight` hunt re-runs on
   intermediate widths → the text "flashes and returns" the user described. The fit
   coordinator's settle logic reduces but does not eliminate mid-drag reflow.
2. **No render budget per pane.** Every pane renders at full rate; 10 panes × WebGL
   canvas redraws is the melt the user wants to avoid. There is no focused/background
   distinction in the renderer (only in the GL registry's eviction order).
3. **Unbounded memory.** xterm `scrollback: 10000` is a default, not an enforced
   budget. `cachedScrollbacks` in zustand is unbounded and survives `killSession`.
   `SerializeAddon.serialize()` runs synchronously on the UI thread during
   `saveLayout` for every dirty session (multi-MB strings, serial, un-chunked).
4. **Visual fidelity floor.** No adaptive quality tiers; chrome (rounded corners,
   active-pane glow, divider affordance) does not exist; the maximize/restore FLIP is
   already compositor-only but the resize transition is not.

Also folded in as no-choice correctness fixes:
- **Leaked store subscription** in `PaneSplit.tsx` (useEffect subscribe with no
  unsubscribe; React 19 StrictMode double-mount leaks one per mount).
- **Daemon ack wedging**: if the last attached client disconnects without ACKing,
  `pending_bytes` never drops below 32KB and the reader parks indefinitely; no reset
  on reattach.

## 2. Design

### 2.1 Resize flash-kill — freeze + stretch-to-fill

During any continuous resize stream (divider drag, window resize) and during the
maximize/restore FLIP, the terminal canvas **freezes its last rendered frame and
stretches to fill the pane** via a CSS transform. No re-measure, no reflow, no
re-render mid-drag. On stream settle (the fit coordinator's quiet commit) the pane
swaps in the crisply-rendered new-size content.

Mechanics:
- A **resize-stream overlay module** (`src/lib/terminal/resizeStreamOverlay.ts`)
  drives a single `ResizeObserver`-independent signal from the fit coordinator:
  - `beginResizeStream()` / `notifyResizeActivity()` → overlay pins the pane's
    canvas at its current rect and applies a non-uniform `scale(sx, sy)` so the
    frozen frame fills the new box (VS Code-style stretch; distortion is
    imperceptible mid-drag and the crisp swap lands on release).
  - `endResizeStream()` → remove overlay, commit the real fit.
- **Fit gating**: while a resize stream is active, `TerminalPane`'s fit path is
  deferred entirely (the existing layout-animation gate pattern, extended to
  resize-streams). The full-bleed `letterSpacing`/`lineHeight` hunt runs **only** on
  the settle commit — this kills the glyph jitter the user saw.
- The maximize/restore FLIP already animates via transform (compositor-only); the
  freeze+stretch applies during the FLIP window too, so the zooming pane never shows
  a mid-flight grid reflow. On FLIP settle, one crisp fit commits.
- **Reduced motion** (`prefers-reduced-motion`): skip the stretch, commit directly
  (matches existing `maximizeZoom.ts` behavior).

### 2.2 Per-pane render budget (priority rendering)

A **render-priority signal** determines each pane's frame cap:

| Pane state | Frame cap |
|---|---|
| Focused (active tab + focused path) | uncapped (60fps) |
| Hovered | 60fps (temporary bump) |
| Background (visible, not focused) | **30fps** |
| Idle (no new output) | ~0 (xterm's dirty-diff skips redraw) |

Mechanics:
- **xterm renderer hook**: xterm's renderers repaint on their own rAF. To cap a
  pane's rate, the app-level mechanism is to **defer `term.write()` batches for
  background panes** to a per-pane queue flushed at the cap. The focused pane's
  `term.write` is immediate (latency-critical: typing echo must never wait).
  Output is **never dropped** — backpressure semantics are untouched; a background
  pane's queue drains at 30fps and its ACKs are sent as the bytes are **parsed**,
  not as they're painted (parsing is what matters for correctness; painting is the
  budgeted part).
- **Priority source**: a `panePriority` store slice (or a module-level registry,
  mirroring `webglRegistry`'s pattern) tracking `{ focusedId, hoveredId }` derived
  from `focusedPath` + pointer events on `.pane-leaf`. The renderer subscribes O(1).
- **Hover bump**: pointerenter on a background pane bumps it to full rate while
  hovered; pointerleave returns it to the background cap. This is what makes the
  "10 agents all updating" vision work — the pane the user is looking at is always
  full-quality.
- **GL registry integration**: the LRU eviction order now uses the same priority
  signal — focused pane's slot is never evicted, hovered is second, background
  panes evict oldest-first (already the pattern; now fed by priority, not just
  focus timestamps).

### 2.3 Memory budget — enforced caps

Three bounded budgets, each with a visible marker:

1. **xterm scrollback: 10,000 lines, enforced.** When a pane's scrollback exceeds
   the cap, the oldest lines are dropped (xterm's native scrollback already
   evicts; the enforcement here is an explicit `"scrollback truncated"` marker
   written into the buffer so the user sees that history was dropped). This is the
   single biggest predictable-memory lever for 10 panes.
2. **`cachedScrollbacks`: ~1MB per session, enforced.** `cacheScrollback` truncates
   buffers past 1MB with a marker. `killSession` (and the background-tab path) now
   clears the entry — fixes the retained-string leak the audit found.
3. **Layout-save serialization: off the UI thread.** `saveLayout`'s scrollback pass
   currently calls `serializeAddon.serialize()` (O(scrollback), multi-MB strings)
   serially on the UI thread. Move the serialize + `saveScrollback` invoke into a
   chunked/async worker path (Web Worker if available, else async chunking with
   yielding), and cap each scrollback string before shipping it. The dirty-set
   already limits *which* sessions serialize; this limits *how much* each one costs.

Plus the two no-choice correctness fixes folded in (leaked `PaneSplit` subscription;
daemon ack-reset-on-reattach so a wedged session unpauses).

### 2.4 Visual polish — chrome + adaptive tiers

**Chrome (gated on Medium+ tiers):**
- Rounded pane corners (~6px) on `.pane-leaf`, consistent with the existing
  maximize FLIP's border-radius 6px→0.
- Subtle pane borders + active-pane accent glow (border-color token, no blur).
- Refined divider hit-area (wider invisible hit-target, thinner visual line) with a
  hover affordance (brightens on hover, matches the drag experience).

**Adaptive tiers** (detected once at startup, cached):
| Tier | Detection | Background cap | Chrome | AA |
|---|---|---|---|---|
| Low | 2019-era iGPU (Intel UHD 620-class) | 15fps | off | standard |
| Medium | modern iGPU | 30fps | on | standard |
| High | discrete GPU | 30fps | on | full fidelity |

- Detection: a tiny GPU-tier probe (WebGL2 renderer string → tier map) with a
  fallback to `Medium` when probing fails.
- The maximize/restore FLIP stays compositor-only at 60fps in **every** tier
  (transform-only, cheap).
- The resize freeze+stretch (2.1) applies in every tier — it's the flash-kill, not
  a fidelity feature.

### 2.5 Non-goals

- No change to backpressure semantics (256KB/32KB watermarks, byte-accurate ACKs).
- No output drops, ever — background panes queue, never discard.
- No changes to persistence formats or restore behavior (scrollback is still saved
  to disk on the dirty-set; the caps only bound in-memory buffers).
- No virtualization/unmounting of hidden tabs (live-output correctness stays).
- No WebGPU, no custom renderer, no new dependencies. All work is on top of
  xterm.js 6.0 + its existing WebGL/Canvas renderers.

## 3. Testing Strategy (TDD)

| Area | Test |
|------|------|
| Resize-stream overlay | Unit: begin/end state machine, stretch transform math, reduced-motion skip |
| Fit gating during stream | Unit/component: fits deferred while streaming, one settle commit, full-bleed hunt suppressed mid-stream |
| Pane priority | Unit: focused/hovered/background derivation, hover bump + return, idle ≈ 0 |
| Background write queue | Unit: focused immediate, background capped at 30fps, ACKs on parse not paint, zero drops under flood |
| GL registry priority | Unit: focused never evicted, hovered second, background LRU order |
| Scrollback cap | Unit: 10k enforcement, truncation marker emitted |
| cachedScrollbacks cap | Unit: 1MB truncation, `killSession` clears entry |
| saveLayout offload | Unit/component: serialize not on UI thread, chunked invoke, cap respected |
| PaneSplit subscription | Unit: subscribe/unsubscribe on mount/unmount, no StrictMode leak |
| Daemon ack reset | Rust lib: reattach with pending>low unpauses; integration: disconnect mid-flood then reattach drains |
| Chrome + tiers | Component: tier toggles chrome classes, divider hover affordance |

Manual verification (Windows): divider drag with `cat` flood + agent CLI — zero
flash, crisp settle; 10 panes with agents — focused typing instant, background
smooth at 30fps; maximize/restore — FLIP smooth, one fit on settle; `find /`
flood — scrollback truncates at 10k with marker, memory flat.

## 4. Risks & Mitigations

- **Stretch distortion during drag**: imperceptible mid-drag by design; the crisp
  swap on release is what the user perceives. Matches VS Code behavior.
- **30fps background read as lag**: mitigated by hover-bump-to-60 and idle≈0; agent
  CLIs re-render on their own timers, so 30fps is visually smooth for them.
- **Deferred writes complicate ack accounting**: ACKs are byte-accounted at parse
  time, before the paint queue — watermark math is unchanged; the queue is
  bounded by the paint budget, and overflow falls back to immediate parse+ack.
- **GPU tier probe wrong**: fallback to Medium; tier is cached but re-probable
  (settings/restart), never a hard lock.
- **Worker availability**: Web Worker may be unavailable in the Tauri webview
  sandbox; fallback is async chunked serialization with `setTimeout` yielding.

## 5. Delivery

One integrated phase, one change-set, reviewed once. Internally ordered and
validated step-by-step with conventional commits + tests per step:

1. Resize flash-kill (freeze + stretch + fit gating)
2. Pane render budget (priority + 30fps background)
3. Memory caps (scrollback 10k, cachedScrollbacks 1MB, save offload)
4. Visual chrome (corners, glow, divider)
5. Adaptive tiers (GPU probe + gating)
6. Correctness fixes (PaneSplit subscription, daemon ack reset) — landed first, as
   they're prerequisites for clean priority/render work
