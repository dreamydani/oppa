# Minimalist Three-Column UI & Frameless Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Overhaul OPPA's frontend into a minimalist three-column desktop terminal workspace with a frameless custom titlebar, collapsible left tabs/workspaces sidebar, collapsible right file explorer, and clean geometric SVG icons (zero emojis).

**Architecture:** Custom SVG icon primitives in `MinimalIcons.tsx`. `TitleBar.tsx` provides frameless window controls and sidebar toggles. `LeftSidebar.tsx` manages vertical tab cards with search filtering. `RightSidebar.tsx` provides the file explorer panel. `App.tsx` coordinates the 3-column flex layout.

**Tech Stack:** React 19, TypeScript, Zustand, Tauri 2 (`@tauri-apps/api/window`), Vitest, `@testing-library/react`.

## Global Constraints

- **Zero Emojis**: All icons must be pure geometric SVGs per `minimalist-ui`.
- **Preserve Core Logic**: Terminal PTY streams, WebGL rendering, split-pane tree, search overlay, and persistence must remain 100% functional.
- **TDD**: Write failing tests first, verify failure, implement, verify pass, and commit.

---

### Task 1: Minimalist SVG Icons & Store Sidebar State (`src/components/icons/MinimalIcons.tsx`, `src/store/terminalStore.ts`)

**Files:**
- Create: `src/components/icons/MinimalIcons.tsx`
- Modify: `src/store/terminalStore.ts`
- Modify: `src/store/terminalStore.test.ts`

**Interfaces:**
- Produces in `MinimalIcons.tsx`: `PanelLeftIcon`, `PanelRightIcon`, `TerminalIcon`, `FolderIcon`, `FileIcon`, `SettingsIcon`, `PlusIcon`, `SearchIcon`, `CloseIcon`, `MinimizeIcon`, `MaximizeIcon`, `RestoreIcon`.
- Produces in `TerminalState`: `leftSidebarOpen: boolean; rightSidebarOpen: boolean; toggleLeftSidebar: () => void; toggleRightSidebar: () => void;`

- [ ] **Step 1: Write failing unit tests in `src/store/terminalStore.test.ts`**

Test `leftSidebarOpen` and `rightSidebarOpen` defaults (true and false/true), and toggling actions.

- [ ] **Step 2: Create `src/components/icons/MinimalIcons.tsx`**

Implement crisp, technical SVG icons with 1.5px stroke and viewBox `0 0 24 24` or `0 0 16 16`.

- [ ] **Step 3: Update `src/store/terminalStore.ts`**

Add `leftSidebarOpen: true`, `rightSidebarOpen: false`, `toggleLeftSidebar`, `toggleRightSidebar`.

- [ ] **Step 4: Run tests and verify**

Run: `pnpm vitest run src/store/terminalStore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/icons/MinimalIcons.tsx src/store/terminalStore.ts src/store/terminalStore.test.ts
git commit -m "feat(ui): add minimalist SVG icons and sidebar toggle store state"
```

---

### Task 2: Frameless TitleBar & Window Controls (`src/components/TitleBar.tsx`, `tauri.conf.json`)

**Files:**
- Modify: `src-tauri/tauri.conf.json`
- Create: `src/components/TitleBar.tsx`
- Create: `src/components/TitleBar.test.tsx`

**Interfaces:**
- Produces: `export function TitleBar(): React.ReactElement`

- [ ] **Step 1: Update `src-tauri/tauri.conf.json` to enable frameless window**

Set `"decorations": false` in `tauri.conf.json`.

- [ ] **Step 2: Write failing unit tests in `src/components/TitleBar.test.tsx`**

Test that:
1. TitleBar renders sidebar toggle buttons and window controls.
2. Clicking left toggle calls `toggleLeftSidebar`.
3. Clicking right toggle calls `toggleRightSidebar`.
4. Clicking minimize, maximize, and close calls Tauri window APIs.

- [ ] **Step 3: Implement `src/components/TitleBar.tsx`**

```tsx
import { useTerminalStore } from "../store/terminalStore";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  PanelLeftIcon,
  PanelRightIcon,
  MinimizeIcon,
  MaximizeIcon,
  CloseIcon,
} from "./icons/MinimalIcons";

export function TitleBar() {
  const leftOpen = useTerminalStore((s) => s.leftSidebarOpen);
  const rightOpen = useTerminalStore((s) => s.rightSidebarOpen);
  const toggleLeft = useTerminalStore((s) => s.toggleLeftSidebar);
  const toggleRight = useTerminalStore((s) => s.toggleRightSidebar);

  const handleMinimize = () => {
    try {
      getCurrentWindow().minimize();
    } catch {}
  };

  const handleMaximize = () => {
    try {
      getCurrentWindow().toggleMaximize();
    } catch {}
  };

  const handleClose = () => {
    try {
      getCurrentWindow().close();
    } catch {}
  };

  return (
    <header className="title-bar" data-tauri-drag-region>
      <div className="title-bar-left">
        <button
          type="button"
          className={`title-bar-icon-btn ${leftOpen ? "active" : ""}`}
          onClick={toggleLeft}
          title="Toggle Left Sidebar"
          aria-label="Toggle Left Sidebar"
        >
          <PanelLeftIcon />
        </button>
        <span className="app-brand-title">OPPA</span>
      </div>

      <div className="title-bar-center" data-tauri-drag-region />

      <div className="title-bar-right">
        <button
          type="button"
          className={`title-bar-icon-btn ${rightOpen ? "active" : ""}`}
          onClick={toggleRight}
          title="Toggle Right Sidebar"
          aria-label="Toggle Right Sidebar"
        >
          <PanelRightIcon />
        </button>
        <div className="window-controls">
          <button
            type="button"
            className="window-control-btn window-minimize"
            onClick={handleMinimize}
            title="Minimize"
            aria-label="Minimize Window"
          >
            <MinimizeIcon />
          </button>
          <button
            type="button"
            className="window-control-btn window-maximize"
            onClick={handleMaximize}
            title="Maximize"
            aria-label="Maximize Window"
          >
            <MaximizeIcon />
          </button>
          <button
            type="button"
            className="window-control-btn window-close"
            onClick={handleClose}
            title="Close"
            aria-label="Close Window"
          >
            <CloseIcon />
          </button>
        </div>
      </div>
    </header>
  );
}
```

- [ ] **Step 4: Run tests and verify**

Run: `pnpm vitest run src/components/TitleBar.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/tauri.conf.json src/components/TitleBar.tsx src/components/TitleBar.test.tsx
git commit -m "feat(ui): add frameless TitleBar with sidebar toggles and window controls"
```

---

### Task 3: Left Sidebar Tabs & Right Sidebar File Explorer (`src/components/LeftSidebar.tsx`, `RightSidebar.tsx`)

**Files:**
- Create: `src/components/LeftSidebar.tsx`
- Create: `src/components/LeftSidebar.test.tsx`
- Create: `src/components/RightSidebar.tsx`
- Create: `src/components/RightSidebar.test.tsx`

**Interfaces:**
- Produces: `export function LeftSidebar(): React.ReactElement`
- Produces: `export function RightSidebar(): React.ReactElement`

- [ ] **Step 1: Write failing unit tests in `LeftSidebar.test.tsx` and `RightSidebar.test.tsx`**

Test tab search filtering, tab card selection, new tab creation, hover close button, and file explorer header.

- [ ] **Step 2: Implement `src/components/LeftSidebar.tsx`**

Features:
- Search input with `SearchIcon` and query state filtering tabs by title/cwd.
- New Tab `+` button (`PlusIcon`).
- Vertical list of tab cards with `TerminalIcon`, title, relative path, and `CloseIcon` on hover.
- Project Folder section displaying active directory.
- Bottom footer with `SettingsIcon` (visual only).

- [ ] **Step 3: Implement `src/components/RightSidebar.tsx`**

Features:
- Header: "File Explorer" with `PanelRightIcon` toggle.
- File tree list with `FolderIcon` and `FileIcon`.

- [ ] **Step 4: Run tests and verify**

Run: `pnpm vitest run src/components/LeftSidebar.test.tsx src/components/RightSidebar.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/LeftSidebar.tsx src/components/LeftSidebar.test.tsx src/components/RightSidebar.tsx src/components/RightSidebar.test.tsx
git commit -m "feat(ui): add LeftSidebar workspace tabs and RightSidebar file explorer"
```

---

### Task 4: App Shell Integration, Minimalist CSS Theme & Full Verification (`src/App.tsx`, `src/App.css`)

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/App.css`
- Modify: `src/App.test.tsx`

**Requirements:**
1. In `src/App.tsx`:
   - Assemble top `TitleBar`, left `LeftSidebar` (if open), center `PaneSplit`, and right `RightSidebar` (if open).
2. In `src/App.css`:
   - Implement dark minimalist theme tokens:
     - `--bg-app: #0c0e12`
     - `--bg-sidebar: #12151b`
     - `--bg-card: #181c24`
     - `--border-subtle: #252a34`
     - `--text-primary: #e2e4e9`
     - `--text-muted: #7e8695`
   - Style TitleBar, LeftSidebar, RightSidebar, Tab cards, File explorer with smooth transitions.
3. Run full verification suite.

- [ ] **Step 1: Update `src/App.tsx` and `src/App.css`**
- [ ] **Step 2: Run all tests and builds**

Run:
1. `pnpm vitest run`
2. `pnpm build`
3. `cargo check` in `src-tauri`
4. `cargo test -p oppa --lib` in `src-tauri`

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx src/App.css src/App.test.tsx
git commit -m "feat(ui): assemble three-column minimalist layout in App"
```
