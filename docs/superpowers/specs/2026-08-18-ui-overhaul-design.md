# OPPA UI Frame Overhaul Design Specification

**Date:** 2026-08-18  
**Status:** Approved  
**Topic:** Top bar with soft-edge concave fillets, segmented mode switcher, and bottom footer integration.

---

## 1. Overview & Goals

Overhaul the OPPA desktop frame and visual shell to match the design reference:
1. **Top Bar**: Deep black top bar (`#09090b` / `#000000`) housing the window controls, sidebar toggles, and a center segmented mode switcher (`browser` | `terminal` | `editor`).
2. **Soft Edges**: Inverted rounded corner fillets connecting the black top bar to the main workspace surface on the top-left and top-right, as well as flared base fillets for the active `terminal` tab.
3. **Mode Switcher**: Segmented pill in the top bar with `terminal` active by default; `browser` and `editor` are non-interactive visual tabs for future expansion.
4. **Footer Section**: Grounded status bar at the bottom of the window displaying active Git branch, sync counters, active directory, terminal dimensions, and PTY status.
5. **Preserved Functionality**: All existing features (Warp-style session cards in left sidebar, multi-pane splitting, setup wizard workbench, right sidebar explorer/git, modals, keyboard shortcuts, and PTY backend) remain fully functional with cohesive styling.

---

## 2. Visual Architecture & Tokens

### Palette Tokens
- **Window Frame & Top Bar**: `#09090b` / `#000000`
- **Main Workspace Canvas**: `#18181b` / `#1c1c1f`
- **Sidebar Surface**: `#141416` / `#161618`
- **Active Card / Active Tab Surface**: `#1c1c1f` / `#222225`
- **Borders & Dividers**: `rgba(255, 255, 255, 0.07)`
- **Text Primary**: `#ededec` / `#fafafa`
- **Text Muted / Faint**: `#71717a` / `#9e9e9a`
- **Accent Primary**: `#58a6ff` (or `#f59e0b` for wizard/special badges)
- **Soft Edge Radius**: `10px` to `12px` concave fillet

---

## 3. Component Details

### A. TitleBar (`src/components/TitleBar.tsx` & `src/App.css`)
- **Structure**:
  - Height: `38px`, background: `#000000`.
  - **Left Section**:
    - Sidebar toggle button (`PanelLeftIcon`) for Left Sidebar.
    - App branding label: `oppa` (clean lowercase sans-serif).
  - **Center Section**:
    - Segmented container with tabs: `browser`, `terminal`, `editor`.
    - `terminal` tab: active state with matching content background (`#18181b`), bold text, and bottom left/right inverted fillets connecting to the workspace below.
    - `browser` & `editor` tabs: muted text, non-clickable / `cursor: default`.
  - **Right Section**:
    - Sidebar toggle button (`PanelRightIcon`) for Right Sidebar.
    - Window controls: Minimize (`—`), Maximize (`□`), Close (`✕`).

### B. Soft Edge Fillets (Inverted Rounded Corners)
- **Top-Left & Top-Right Soft Edges**:
  - Implemented using CSS pseudo-elements (`::before` / `::after`) on the workspace container with concave box-shadow / radial-gradient technique, ensuring crisp rendering across display scalings without 0.5px SVG seams.
- **Center Tab Base Fillets**:
  - Smooth concave corner curves flanking the left and right base of the active `terminal` tab.

### C. Workspace Viewport & Panes (`src/App.tsx`)
- Container: `.workspace-container` with neutral dark gray canvas.
- Left Sidebar: Session cards with avatar icons, title, CWD, search filter, and double-click rename.
- Main Viewport:
  - If active tab is wizard: renders `WorkspaceSetupWizard`.
  - Otherwise: renders `PaneSplit` (binary tree terminal grid with `TerminalPaneHeader` and `TerminalPane`).
- Right Sidebar: File Explorer & Git panels with resize handle.

### D. Footer / Status Bar (`src/components/layout/StatusBar.tsx`)
- Mounted at the bottom of `.app-container` in `App.tsx`.
- Height: `26px`, background: `#09090b` with 1px border-top.
- **Left**:
  - `GitBranch` icon + branch name (e.g. `main`).
  - Sync counter (`↑1 ↓0`) when ahead/behind remote.
  - `Folder` icon + folder name (e.g. `oppa`).
- **Right**:
  - `Terminal` icon + dimensions (`cols x rows`, e.g. `120x36`).
  - Session status dot + text (`Ready` / `Running`).

---

## 4. Error Handling & Edge Cases
- **Window Resizing**: Flex layouts with min-width: 0 ensure split panes and sidebars resize smoothly without horizontal scrollbars.
- **Tauri Window Controls**: Window minimize, maximize, and close calls are safely wrapped in try/catch blocks for non-Tauri / test environments.
- **Git Status Fallback**: Gracefully renders "no git" when active CWD is not a git repository.

---

## 5. Testing & Verification
- Unit tests for `TitleBar`, `StatusBar`, `LeftSidebar`, `RightSidebar`, `PaneSplit`, and `App`.
- Verification with `pnpm vitest run` and `cargo check`.
