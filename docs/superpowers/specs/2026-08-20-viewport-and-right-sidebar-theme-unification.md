# Design Specification: Main Center Viewport & Right Sidebar Color Unification

**Date:** 2026-08-20  
**Feature:** Unify background color of the Main Center Viewport (workspace canvas, terminal panes, empty state canvas) and Right Sidebar with Top Titlebar (`#000000`).

---

## 1. Objectives & Scope

### 1.1 Objective
Align the background color of:
1. **Main Center Viewport** (including terminal canvas, terminal panes, loading skeletons, pane-root, and empty workspace canvas)
2. **Right Sidebar** (sidebar container and activity bar)

to match the **Top Titlebar** color (`var(--topbar-bg, #000000)`).

### 1.2 Non-Goals / Invariants
- **Do not change any other colors**:
  - Left Sidebar stays `var(--sidebar)` (`#141416`).
  - Status Bar stays `var(--topbar-bg, #000000)` / status styling.
  - Buttons, tab badges, borders, text, and floating cards retain their current contrast colors.
  - Empty Workspace card (`.empty-workspace-card`) remains a dark matte clay surface (`#141419`), sitting cleanly on top of the `#000000` canvas.

---

## 2. Technical Design

### 2.1 Color Tokens & Theme (`src/styles/theme.css`, `src/App.css`)
- `src/styles/theme.css`:
  - Update `--workspace-bg` from `#18181b` to `#000000`.
- `src/App.css`:
  - Update `--bg-terminal` from `var(--background, #141414)` to `var(--topbar-bg, #000000)`.
  - Ensure `.workspace-container`, `.pane-root`, `.pane-leaf`, `.pane-leaf.maximized`, `.terminal-pane`, and `.terminal-pane-wrapper` resolve to `#000000`.
  - Update `.empty-workspace-view` background-color to `var(--topbar-bg, #000000)`.

### 2.2 Terminal Component (`src/components/TerminalPane.tsx`, `src/components/TerminalPane.css`)
- `src/components/TerminalPane.tsx`:
  - Update xterm `theme.background` to `"#000000"`.
- `src/components/TerminalPane.css`:
  - Update `.terminal-loading-skeleton` and `.session-leaf-loading` `background-color` to `var(--topbar-bg, #000000)`.

### 2.3 Right Sidebar (`src/components/right-sidebar/RightSidebar.css`)
- `src/components/right-sidebar/RightSidebar.css`:
  - Update `.right-sidebar` `background-color: var(--topbar-bg, #000000);`.
  - Update `.activity-bar` `background-color: var(--topbar-bg, #000000);`.

---

## 3. Verification & Testing

1. `src/styles/theme.test.ts`: Verify theme token assertions pass.
2. `src/components/TerminalPane.test.tsx`: Verify 32/32 tests pass.
3. `src/components/right-sidebar/RightSidebar.test.tsx`: Verify 11/11 tests pass.
4. Full vitest suite: 522/522 tests pass.
5. Production build (`pnpm build`) and Rust tests (`cargo test -p oppa --lib`) succeed.
