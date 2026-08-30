# OPPA — Terminal Pane Performance, Memory & Visual Fidelity Plan

**Spec:** `docs/superpowers/specs/2026-08-30-terminal-pane-perf-and-memory-design.md`
**Date:** 2026-08-30
**Status:** Ready for implementation
**Branch:** `feat/terminal-pane-perf-and-memory`
**Ledger:** `.superpowers/sdd/terminal-pane-perf-and-memory/progress.md`

---

## Execution model

Subagent-driven development per the superpowers workflow: one fresh implementer
subagent per task, a task review after each (spec compliance + code quality), a
broad final review, rulings ledgered in `.superpowers/sdd/terminal-pane-perf-and-memory/progress.md`.
Tasks 1–2 are correctness prerequisites and land first. Every task ends with a
conventional commit. `.superpowers/` is git-ignored scratch; the git history is the record.

## Task list (ordered)

### Task 1 — Fix leaked PaneSplit store subscription
**Files:** `src/components/PaneSplit.tsx`
**Do:** The maximize-snapshot `useTerminalStore.subscribe` in the `useEffect` has
no unsubscribe. Return `unsubscribe` from the effect's cleanup (alongside the
existing zoom-cancel cleanup). Verifies no StrictMode double-mount leak.
**Tests:** unit — subscribe is cleaned up on unmount; double-mount leaves one live subscription.
**Commit:** `fix(ui): unsubscribe PaneSplit maximize-snapshot store subscription`

### Task 2 — Daemon ack-reset on reattach (Rust)
**Files:** `src-tauri/src/pty/daemon_session.rs`, `src-tauri/src/pty/request_router.rs` (+ tests)
**Do:** On `CreateOrAttach` of an existing session, if `pending_bytes > 0` (a client
disconnected without acking), reset `pending_bytes` to 0 and unpause the reader.
Prevents a wedged session parking the reader forever with no client.
**Tests:** Rust lib — reattach with pending>0 resets and unpauses; integration —
disconnect mid-flood, reattach, stream drains.
**Commit:** `fix(daemon): reset pending ack balance on session reattach`

### Task 3 — Resize flash-kill: freeze + stretch-to-fill
**Files:** new `src/lib/terminal/resizeStreamOverlay.ts`, `src/lib/terminal/fitCoordinator.ts`,
`src/components/TerminalPane.tsx`, `src/components/PaneSplit.tsx` (divider wiring)
**Do:** New module drives a resize-stream state machine. During a continuous resize
stream (divider drag / window resize) and the maximize FLIP window, pin the pane's
canvas at its current rect and apply non-uniform `scale(sx, sy)` to fill the new box;
defer all fits until `endResizeStream()`; full-bleed `letterSpacing`/`lineHeight`
hunt runs only on the settle commit. Reduced-motion skips the stretch.
**Tests:** unit — begin/end state machine, stretch math, reduced-motion skip;
component — fits deferred while streaming, one settle commit, no mid-stream glyph hunt.
**Commit:** `feat(terminal): freeze-and-stretch resize stream to kill mid-drag flash`

### Task 4 — Pane render budget (priority rendering)
**Files:** new `src/lib/terminal/panePriority.ts`, new `src/lib/terminal/writeQueue.ts`,
`src/components/TerminalPane.tsx`, `src/lib/terminal/webglRegistry.ts`
**Do:** Priority registry `{ focusedId, hoveredId }` derived from `focusedPath` +
pointer events. Per-pane write queue: focused = immediate `term.write`; background =
deferred, flushed at the 30fps cap; ACKs sent at parse time, never dropped. GL
registry eviction order fed by priority (focused never evicted, hovered second).
**Tests:** unit — priority derivation, hover bump/return, idle≈0; write queue —
focused immediate, background capped, zero drops under flood, ACKs on parse.
**Commit:** `feat(terminal): per-pane render budget with priority write queue`

### Task 5 — Memory caps: scrollback, cachedScrollbacks, save offload
**Files:** `src/components/TerminalPane.tsx`, `src/store/slices/terminalSessionsSlice.ts`,
`src/store/slices/paneLayoutSlice.ts`, `src/lib/pty/transport.ts` (or layout transport)
**Do:** (1) xterm `scrollback: 10000` enforced with `"scrollback truncated"` marker.
(2) `cacheScrollback` truncates past ~1MB with marker; `killSession` clears the entry.
(3) `saveLayout` scrollback serialize moves off the UI thread — Web Worker if
available, else async chunked serialization with yielding; cap each shipped string.
**Tests:** unit — 10k enforcement + marker; 1MB truncation + killSession clears;
serialize not on UI thread (spy), chunked invoke, cap respected.
**Commit:** `feat(terminal): enforce scrollback and cache memory budgets`

### Task 6 — Visual chrome
**Files:** `src/components/PaneSplit.tsx` (+ CSS), theme tokens
**Do:** Rounded `.pane-leaf` corners (~6px, consistent with FLIP border-radius),
subtle pane borders, active-pane accent glow (border token, no blur), refined
divider hit-area + hover affordance. Chrome classes gated on tier (Task 7) via a
root data-attribute.
**Tests:** component — chrome classes applied per tier, divider hover affordance.
**Commit:** `feat(ui): terminal pane chrome — corners, glow, divider affordance`

### Task 7 — Adaptive GPU tiers
**Files:** new `src/lib/terminal/gpuTier.ts`, `App.tsx` (root data-attribute),
`src/components/PaneSplit.tsx`, `src/components/TerminalPane.tsx`, theme.css
**Do:** GPU-tier probe (WebGL2 renderer string → tier map, fallback Medium). Root
data-attribute drives chrome on/off and background-fps caps (Low 15 / Medium 30 /
High 30). FLIP stays compositor-only in every tier. Cached, re-probable.
**Tests:** unit — probe mapping + fallback; component — tier gating.
**Commit:** `feat(ui): adaptive GPU quality tiers`

### Task 8 — Broad final review
**Do:** Spec-compliance + code-quality review across all tasks. Verify: zero output
drops, backpressure semantics unchanged, all tests green (`pnpm vitest run`,
`cargo test -p oppa --lib`, `cargo test -p oppa --test daemon_integration_test`),
manual Windows check: divider drag with agent CLI flood (zero flash), 10 panes
(focused instant, background smooth), `find /` flood (memory flat at 10k cap).

---

## Acceptance criteria (from the grilling alignment)

1. Divider drag + window resize + maximize/restore: **zero flash**, crisp settle, one fit.
2. Focused pane: uncapped 60fps, typing instant. Background panes: 30fps cap,
   hover bumps to 60, idle ≈ 0. **No dropped output.**
3. Memory: scrollback hard-capped 10k, cachedScrollbacks ~1MB/session, `killSession`
   frees, save serialization off the UI thread.
4. Chrome on Medium+, off on Low. FLIP compositor-only in every tier.
5. Low tier (2019 iGPU) still smooth at default quality; High gets full fidelity.
6. 10 panes with agents = predictable footprint, no melt.
