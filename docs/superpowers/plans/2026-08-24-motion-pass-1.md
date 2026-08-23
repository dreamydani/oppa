# Plan: UI Motion Pass 1 — Pane Dolly-Zoom & Sidebar Slide

Spec: `docs/superpowers/specs/2026-08-24-motion-pass-1-design.md`
Branch: `feat/motion-pass-1-dolly-sidebar`

## Commit 1 — Motion tokens + reduced-motion guard

1. **TDD**: extend `src/styles/tokens.test.ts` required-token list with the five
   motion tokens. Verify it fails.
2. Add tokens to `src/styles/theme.css` (`:root, [data-theme="dark"]` block).
3. Append global `prefers-reduced-motion: reduce` kill-switch to `theme.css`.
4. Run `pnpm vitest run src/styles`. Commit `feat(motion): design tokens and reduced-motion guard`.

## Commit 2 — Dolly-zoom pane maximize/restore

1. **TDD**: create `src/lib/pane-manager/maximizeZoom.test.ts`.
   - `computeFlipTransform`: known prev/next rects → expected
     `translate(...) scale(...)`; identity when rects equal; `null` on any
     zero-area rect.
   - Reduced-motion helper returns boolean (mock `matchMedia`).
   - Verify tests fail (module missing).
2. Implement `maximizeZoom.ts`.
3. **TDD**: extend `src/components/PaneSplit.test.tsx`:
   - Mock nonzero `getBoundingClientRect` on `.pane-leaf` elements; toggle
     maximize → assert inline transform applied synchronously after commit,
     cleared after fallback timer (fake timers).
   - A→B direct swap → transforms on both leaves.
   - Zero-area rects → no inline transform ever set.
4. Wire FLIP in `PaneSplit.tsx`: ref map of leaf rects + `useLayoutEffect` keyed
   on `maximizedSessionId`; cancel-safe (clear stale inline styles first);
   transient `is-zooming` class for `will-change`.
5. CSS in `App.css`: `.pane-hidden` → opacity/visibility cross-fade;
   `.pane-leaf.maximized` radius/border transitions; `.is-zooming` layer promo.
6. Run full renderer suite. Commit `feat(panes): dolly-zoom animation on pane maximize and restore`.

## Commit 3 — Sidebar slide animations + drag fix

1. **TDD**: update `App.test.tsx` closed-sidebar assertions (`.closed` class,
   still mounted). Add LeftSidebar/RightSidebar test cases:
   - Closed store state → `.closed` class present; open → absent.
   - Width rendered as `--sidebar-w` custom property from store width.
   - Drag start/end toggles `is-resizing` class.
   Verify new assertions fail against current code.
2. `LeftSidebar.tsx`: subscribe `leftSidebarOpen`; apply `--sidebar-w` var +
   `closed`/`is-resizing` classes; wrap top/body/footer in
   `.sidebar-slide-inner` (resize handle stays outside).
3. `RightSidebar.tsx`: remove internal early-return; same class/var/resizing
   treatment.
4. `App.tsx`: render sidebars whenever mode ≠ browser; add `app-booted` class
   ~300ms after ready.
5. CSS (`LeftSidebar.css`, `RightSidebar.css`): push/slide rules per spec —
   base rule = open duration, `.closed` rule = close duration with delayed
   visibility; parallax inner drift; `.is-resizing { transition: none }`;
   boot-gate suppression in App.css.
6. Run full renderer suite. Commit `feat(sidebar): slide in/out with parallax and 1:1 drag resize`.

## Verification

- `pnpm vitest run` green.
- `pnpm build` (tsc) clean.
- Manual checklist (user runs `pnpm tauri dev`):
  maximize/restore over live output · A→B swap · sibling fade · both sidebar
  toggles vs live terminal · drag-resize 1:1 · Ctrl+B spam · browser-mode
  instant · collapsed launch boots without flash · reduced-motion setting.

## Guardrails

- No changes to `terminalStore` action signatures or `lib/pty/transport.ts`.
- All animation state is DOM-local (classes/inline styles); store remains
  semantic source of truth.
- Every task ends with a conventional commit; ledger rulings recorded in
  commit messages where a contract shifted (App.test hidden ≠ unmounted).
