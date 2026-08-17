# OPPA UI Frame Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Overhaul OPPA's top bar with soft-edge concave fillets, a 3-mode segmented switcher (`browser` | `terminal` | `editor`), and a grounded bottom status footer, while preserving all existing functionality.

**Architecture:** Update the CSS theme tokens and layout frame in `src/styles/theme.css` and `src/App.css`. Overhaul `TitleBar.tsx` to include the branding, sidebar toggles, segmented mode pill, and window controls with flared base fillets. Mount and style `StatusBar.tsx` as the bottom footer in `App.tsx`.

**Tech Stack:** React 19, TypeScript, Tauri 2, CSS, Vitest with React Testing Library.

## Global Constraints

- **Window Frame & Top Bar**: `#09090b` / `#000000`
- **Main Workspace Canvas**: `#18181b` / `#1c1c1f`
- **Top Bar Height**: `38px`
- **Footer Height**: `26px`
- **Soft Edge Fillets**: Pure CSS inverted-radius pseudo-elements (`10px` to `12px` radius)
- **Mode Switcher**: `browser` and `editor` are non-interactive visual tabs; `terminal` is permanently active
- **Testing**: TDD with `pnpm vitest run`

---

### Task 1: Theme Tokens & CSS Soft-Edge Inverted Fillets

**Files:**
- Modify: `src/styles/theme.css`
- Modify: `src/App.css`
- Test: `src/styles/theme.test.ts`

**Interfaces:**
- Consumes: CSS custom properties (`--bg-window`, `--bg-topbar`, `--bg-workspace`, `--radius-soft-edge`).
- Produces: CSS rules for `.app-container`, `.top-bar`, `.workspace-container`, and soft-edge corner pseudo-elements.

- [ ] **Step 1: Write the failing test for theme tokens**

In `src/styles/theme.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

describe("Theme tokens", () => {
  it("defines top bar, workspace canvas, and soft-edge tokens in theme.css", () => {
    const cssPath = path.resolve(__dirname, "theme.css");
    const content = fs.readFileSync(cssPath, "utf-8");
    expect(content).toContain("--topbar-bg");
    expect(content).toContain("--workspace-bg");
    expect(content).toContain("--soft-edge-radius");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/styles/theme.test.ts`  
Expected: FAIL

- [ ] **Step 3: Update `theme.css` and `App.css` with frame tokens and soft-edge styles**

In `src/styles/theme.css`:
```css
:root {
  /* Fonts */
  --font-sans: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --font-mono: 'SF Mono', Consolas, 'Cascadia Code', Menlo, monospace;

  /* Sizing & Radius */
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;
  --soft-edge-radius: 12px;

  /* Core Canvas & Surfaces */
  --topbar-bg: #000000;
  --workspace-bg: #18181b;
  --background: #18181b;
  --foreground: #ededec;
  --card: #222225;
  --card-foreground: #ededec;
  --sidebar: #141416;
  --sidebar-foreground: #ededec;
  --sidebar-border: rgba(255, 255, 255, 0.07);
  --border: rgba(255, 255, 255, 0.07);
  --muted: #27272a;
  --muted-foreground: #9e9e9a;
  --text-faint: #71717a;
  --accent: #27272a;
  --accent-foreground: #ffffff;
  --primary: #ededec;
  --primary-foreground: #141414;
  --destructive: #e05252;
  --ring: rgba(255, 255, 255, 0.20);

  /* Functional Tokens */
  --accent-blue: #58a6ff;

  /* Git Status Colors */
  --git-added: #4ade80;
  --git-modified: #fbbf24;
  --git-deleted: #f87171;
  --git-untracked: #a3e635;
}
```

In `src/App.css`, update `.app-container` and add soft-edge corner classes for `.workspace-container`:
```css
.app-container {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
  overflow: hidden;
  background-color: var(--topbar-bg, #000000);
}

.workspace-container {
  display: flex;
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  position: relative;
  background-color: var(--workspace-bg, #18181b);
}

/* Inverted Soft Edge Curves connecting TopBar to Workspace */
.soft-edge-left,
.soft-edge-right {
  position: absolute;
  top: 0;
  width: var(--soft-edge-radius, 12px);
  height: var(--soft-edge-radius, 12px);
  pointer-events: none;
  z-index: 20;
}

.soft-edge-left {
  left: 0;
  background: radial-gradient(
    circle at 100% 100%,
    transparent var(--soft-edge-radius, 12px),
    var(--topbar-bg, #000000) var(--soft-edge-radius, 12px)
  );
}

.soft-edge-right {
  right: 0;
  background: radial-gradient(
    circle at 0% 100%,
    transparent var(--soft-edge-radius, 12px),
    var(--topbar-bg, #000000) var(--soft-edge-radius, 12px)
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/styles/theme.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/styles/theme.css src/styles/theme.test.ts src/App.css
git commit -m "feat(theme): add topbar, workspace tokens and soft-edge corner styles"
```

---

### Task 2: TitleBar Overhaul with 3-Mode Switcher & Flared Active Tab

**Files:**
- Modify: `src/components/TitleBar.tsx`
- Modify: `src/App.css`
- Test: `src/components/TitleBar.test.tsx`

**Interfaces:**
- Consumes: `useTerminalStore` (`leftSidebarOpen`, `rightSidebarOpen`, `toggleLeftSidebar`, `toggleRightSidebar`).
- Produces: `TitleBar` component containing brand `oppa`, segmented tabs (`browser`, `terminal`, `editor`), sidebar toggles, and window controls.

- [ ] **Step 1: Write failing tests for TitleBar mode switcher**

In `src/components/TitleBar.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { TitleBar } from "./TitleBar";

describe("TitleBar", () => {
  it("renders the oppa branding and mode switcher tabs", () => {
    render(<TitleBar />);
    expect(screen.getByText("oppa")).toBeDefined();
    expect(screen.getByText("browser")).toBeDefined();
    expect(screen.getByText("terminal")).toBeDefined();
    expect(screen.getByText("editor")).toBeDefined();
  });

  it("renders the terminal tab as active by default", () => {
    render(<TitleBar />);
    const terminalTab = screen.getByText("terminal");
    expect(terminalTab.closest(".mode-tab")).toHaveClass("active");
  });

  it("renders sidebar toggle buttons and window controls", () => {
    render(<TitleBar />);
    expect(screen.getByLabelText("Toggle Left Sidebar")).toBeDefined();
    expect(screen.getByLabelText("Toggle Right Sidebar")).toBeDefined();
    expect(screen.getByLabelText("Minimize Window")).toBeDefined();
    expect(screen.getByLabelText("Maximize Window")).toBeDefined();
    expect(screen.getByLabelText("Close Window")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/components/TitleBar.test.tsx`  
Expected: FAIL

- [ ] **Step 3: Implement new TitleBar component and CSS**

In `src/components/TitleBar.tsx`:
```tsx
import type { ReactElement } from "react";
import { useTerminalStore } from "../store/terminalStore";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  PanelLeftIcon,
  PanelRightIcon,
  MinimizeIcon,
  MaximizeIcon,
  CloseIcon,
} from "./icons/MinimalIcons";

export function TitleBar(): ReactElement {
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
        <span className="app-brand-title">oppa</span>
      </div>

      <div className="title-bar-center" data-tauri-drag-region>
        <div className="mode-switcher-pill" data-tauri-drag-region="false">
          <span className="mode-tab disabled" title="Browser (Coming soon)">
            browser
          </span>
          <span className="mode-tab active" title="Terminal (Active)">
            terminal
            <span className="tab-flare-left" />
            <span className="tab-flare-right" />
          </span>
          <span className="mode-tab disabled" title="Editor (Coming soon)">
            editor
          </span>
        </div>
      </div>

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

In `src/App.css`, style `.mode-switcher-pill`, `.mode-tab`, and the flared bottom curves:
```css
.title-bar {
  height: 38px;
  background-color: var(--topbar-bg, #000000);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px;
  user-select: none;
  flex-shrink: 0;
  position: relative;
  z-index: 30;
  -webkit-app-region: drag;
}

.app-brand-title {
  font-size: 13px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--text-primary, #ededec);
  margin-left: 2px;
}

.title-bar-center {
  flex: 1;
  height: 100%;
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.mode-switcher-pill {
  display: inline-flex;
  align-items: center;
  background-color: #000000;
  height: 32px;
  position: relative;
  -webkit-app-region: no-drag;
}

.mode-tab {
  font-size: 12px;
  font-weight: 500;
  padding: 6px 14px;
  color: var(--text-muted, #71717a);
  position: relative;
  user-select: none;
  cursor: default;
  display: flex;
  align-items: center;
  justify-content: center;
}

.mode-tab.disabled {
  opacity: 0.6;
}

.mode-tab.active {
  background-color: var(--workspace-bg, #18181b);
  color: var(--text-primary, #ededec);
  font-weight: 600;
  border-top-left-radius: 8px;
  border-top-right-radius: 8px;
  height: 34px;
  margin-bottom: -1px;
}

/* Flared Inverted Base Fillets for the Active Center Tab */
.tab-flare-left,
.tab-flare-right {
  position: absolute;
  bottom: 0;
  width: 8px;
  height: 8px;
  pointer-events: none;
}

.tab-flare-left {
  left: -8px;
  background: radial-gradient(
    circle at 0% 0%,
    transparent 8px,
    var(--workspace-bg, #18181b) 8px
  );
}

.tab-flare-right {
  right: -8px;
  background: radial-gradient(
    circle at 100% 0%,
    transparent 8px,
    var(--workspace-bg, #18181b) 8px
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/components/TitleBar.test.tsx`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/TitleBar.tsx src/components/TitleBar.test.tsx src/App.css
git commit -m "feat(titlebar): add mode switcher pill and flared active tab fillets"
```

---

### Task 3: Bottom Footer (StatusBar) Mounting in App Root

**Files:**
- Modify: `src/components/layout/StatusBar.tsx`
- Modify: `src/components/layout/StatusBar.css`
- Modify: `src/App.tsx`
- Test: `src/App.test.tsx`
- Test: `src/components/layout/StatusBar.test.tsx`

**Interfaces:**
- Consumes: `useTerminalStore` (`getActiveCwd`, `sessions`, `tabs`, `activeTabId`), `getGitStatus`.
- Produces: Grounded `StatusBar` footer rendered in `App.tsx`.

- [ ] **Step 1: Write failing tests in App.test.tsx for StatusBar presence**

In `src/App.test.tsx`:
```tsx
it("renders the bottom status bar footer in the app shell", async () => {
  render(<App />);
  expect(screen.getByRole("contentinfo")).toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/App.test.tsx`  
Expected: FAIL

- [ ] **Step 3: Update `App.tsx` and `StatusBar.tsx`**

In `src/App.tsx`, import and render `StatusBar` beneath `.workspace-container`:
```tsx
import { StatusBar } from "./components/layout/StatusBar";

// Inside App component return:
return (
  <div className="app-container">
    <TitleBar />
    <div className="workspace-container">
      <div className="soft-edge-left" />
      {leftSidebarOpen && <LeftSidebar />}
      <main className="main-viewport">
        {activeTab?.isWizard ? (
          <WorkspaceSetupWizard tabId={activeTab.id} />
        ) : (
          <PaneSplit />
        )}
      </main>
      {rightSidebarOpen && <RightSidebar />}
      <div className="soft-edge-right" />
    </div>
    <StatusBar />
    <WorkspaceLauncherModal />
  </div>
);
```

In `src/components/layout/StatusBar.css`:
```css
.status-bar {
  height: 26px;
  background-color: var(--topbar-bg, #000000);
  border-top: 1px solid var(--border-divider, rgba(255, 255, 255, 0.07));
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  font-family: var(--font-sans);
  font-size: 11px;
  color: var(--text-muted, #71717a);
  user-select: none;
  flex-shrink: 0;
  z-index: 20;
}

.status-bar-section {
  display: flex;
  align-items: center;
  gap: 16px;
}

.status-bar-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-variant-numeric: tabular-nums;
}

.status-bar-item.git-item {
  color: var(--text-primary, #ededec);
}

.status-bar-git-branch {
  font-weight: 500;
}

.status-bar-git-sync {
  color: var(--accent-blue, #58a6ff);
  font-family: var(--font-mono);
  font-size: 10px;
}

.status-indicator-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background-color: var(--git-added, #4ade80);
}

.status-indicator-dot.error {
  background-color: var(--destructive, #e05252);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/App.test.tsx src/components/layout/StatusBar.test.tsx`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/components/layout/StatusBar.tsx src/components/layout/StatusBar.css src/App.test.tsx
git commit -m "feat(layout): mount and style bottom status bar footer"
```

---

### Task 4: Full App Integration & Verification

**Files:**
- Modify: `src/App.css`
- Test: All Vitest test suites (`pnpm vitest run`)
- Check: `cargo check` in `src-tauri`

- [ ] **Step 1: Run full test suite**

Run: `pnpm vitest run`  
Expected: All 25 test suites pass

- [ ] **Step 2: Run Rust cargo check**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`  
Expected: SUCCESS with 0 errors

- [ ] **Step 3: Commit any final styling adjustments**

```bash
git add .
git commit -m "feat: complete UI frame overhaul with soft edges, mode switcher, and footer"
```
