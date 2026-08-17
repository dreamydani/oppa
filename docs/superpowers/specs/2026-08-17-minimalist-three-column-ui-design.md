# OPPA — Minimalist Three-Column UI & Frameless Window Design

Date: 2026-08-17
Status: Approved

## Purpose

Overhaul OPPA's frontend UI into a premium, minimalist three-column desktop workspace following `minimalist-ui`, `taste-skill`, and `redesign-skill`.

Specifically, this overhaul delivers:
1. **Frameless Custom Window Titlebar (`TitleBar.tsx`)**:
   - Custom draggable top titlebar region (`data-tauri-drag-region`).
   - Left sidebar toggle icon (collapse/expand).
   - Right sidebar toggle icon (collapse/expand).
   - Window control actions: Minimize (`—`), Maximize/Restore (`□`), and Close (`✕`).
2. **Left Sidebar — Tabs & Workspaces (`LeftSidebar.tsx`)**:
   - Tab search input with live tab title/CWD filtering.
   - New tab button (`+`).
   - Vertical tab list cards displaying crisp terminal icon, title, relative path, and hover close button.
   - Project folder contextual workspace section.
   - Bottom settings button with visual tooltip.
3. **Main Center Viewport (`MainViewport.tsx`)**:
   - Houses the core terminal engine (split panes, WebGL 60fps rendering, in-pane search overlay, live backpressure).
4. **Right Sidebar — File Explorer (`RightSidebar.tsx`)**:
   - Collapsible panel with folder/file tree view of the active workspace.
   - Collapse/expand toggle button.
5. **Iconography & Styling Directives**:
   - **Zero emojis**: All icons are custom, high-precision SVG primitives (1.5px stroke, technical aesthetic).
   - **Minimalist dark palette**: `#0c0e12` canvas, `#12151b` sidebars, `#181c24` active cards, `#252a34` subtle 1px dividers, `#e2e4e9` text.

---

## Component Architecture

```
src/
├── components/
│   ├── icons/
│   │   └── MinimalIcons.tsx    # Clean, geometric SVG icons (PanelLeft, PanelRight, Terminal, Folder, File, Settings, Plus, Search, Close, WindowControls)
│   ├── TitleBar.tsx            # Frameless titlebar with left/right sidebar toggles and window controls
│   ├── LeftSidebar.tsx         # Workspace & tab cards list, search filter, project folder, settings
│   ├── RightSidebar.tsx        # Collapsible file explorer panel
│   ├── PaneSplit.tsx           # Existing terminal split tree
│   ├── TerminalPane.tsx        # Existing WebGL xterm.js pane
│   ├── TerminalSearch.tsx      # Existing in-pane search overlay
│   └── Toolbar.tsx             # Simplified or integrated with titlebar
├── store/
│   ├── terminalStore.ts        # Preserved core logic + sidebar visibility state (leftSidebarOpen, rightSidebarOpen)
│   └── terminalStore.test.ts   # Unit tests
└── App.tsx                     # Top-level 3-column layout shell
```

---

## State & Layout Model

```typescript
export interface TerminalState {
  // Existing state & actions (tabs, activeTabId, sessions, splitPane, etc.)
  ...
  // UI Panels state
  leftSidebarOpen: boolean;
  rightSidebarOpen: boolean;
  toggleLeftSidebar: () => void;
  toggleRightSidebar: () => void;
}
```

---

## Testing & Verification Plan

### Frontend Tests (`pnpm vitest run`):
1. `TitleBar.test.tsx`:
   - Verify titlebar renders, toggle buttons invoke `toggleLeftSidebar` and `toggleRightSidebar`.
   - Verify window control buttons trigger minimize, maximize, close.
2. `LeftSidebar.test.tsx`:
   - Verify tab card rendering, search filtering, tab selection, and tab creation.
3. `RightSidebar.test.tsx`:
   - Verify explorer header, toggle button, and file tree render.
4. Full test suite verification across all existing tests (172+ tests).

### Build Verification:
- `pnpm vitest run`
- `pnpm build`
- `cargo check` and `cargo test -p oppa --lib`
