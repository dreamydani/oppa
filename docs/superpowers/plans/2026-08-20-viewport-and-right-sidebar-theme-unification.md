# Plan: Main Center Viewport & Right Sidebar Color Unification

**Spec:** `docs/superpowers/specs/2026-08-20-viewport-and-right-sidebar-theme-unification.md`  
**Goal:** Align background colors of the main center viewport (including terminal canvas and empty state canvas) and the right sidebar with the top titlebar (`#000000`), leaving all other components and colors untouched.

---

### Task 1: Update Theme Tokens & Viewport / Terminal CSS & Components
**Files:**
- Modify: `src/styles/theme.css`
- Modify: `src/styles/theme.test.ts`
- Modify: `src/App.css`
- Modify: `src/components/TerminalPane.tsx`
- Modify: `src/components/TerminalPane.css`
- Test: `src/styles/theme.test.ts`, `src/components/TerminalPane.test.tsx`

**Steps:**
1. In `src/styles/theme.css`, update `--workspace-bg: #000000;`.
2. In `src/styles/theme.test.ts`, update the test assertion for `--workspace-bg: #000000;`.
3. In `src/App.css`, update `--bg-terminal: var(--topbar-bg, #000000);` and set `.empty-workspace-view` background to `var(--topbar-bg, #000000);`.
4. In `src/components/TerminalPane.tsx`, update xterm theme `background` to `"#000000"`.
5. In `src/components/TerminalPane.css`, update `.terminal-loading-skeleton, .session-leaf-loading` `background-color: var(--topbar-bg, #000000);`.
6. Run `pnpm vitest run src/styles/theme.test.ts src/components/TerminalPane.test.tsx`.
7. Commit changes: `git add src/styles/theme.css src/styles/theme.test.ts src/App.css src/components/TerminalPane.tsx src/components/TerminalPane.css && git commit -m "style(viewport): set main viewport and terminal background to match top titlebar"`.

---

### Task 2: Update Right Sidebar Background Styling
**Files:**
- Modify: `src/components/right-sidebar/RightSidebar.css`
- Test: `src/components/right-sidebar/RightSidebar.test.tsx`, `src/components/RightSidebar.test.tsx`

**Steps:**
1. In `src/components/right-sidebar/RightSidebar.css`, update `.right-sidebar` and `.activity-bar` to `background-color: var(--topbar-bg, #000000);`.
2. Run `pnpm vitest run src/components/right-sidebar/RightSidebar.test.tsx src/components/RightSidebar.test.tsx`.
3. Commit changes: `git add src/components/right-sidebar/RightSidebar.css && git commit -m "style(sidebar): align right sidebar background with top titlebar"`.

---

### Task 3: Whole-Suite Regression Verification
**Steps:**
1. Run full test suite: `pnpm vitest run`.
2. Run production build: `pnpm tsc --noEmit && pnpm build`.
3. Run Rust tests: `cargo test -p oppa --lib` (in `src-tauri`).
