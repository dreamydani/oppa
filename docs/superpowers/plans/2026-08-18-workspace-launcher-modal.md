# Workspace & Project Launcher Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a Raycast/Spotlight-style centered Command Palette modal for creating new workspaces, selecting project folders, and cloning repositories triggered by the Left Sidebar `+` button and `Ctrl+N` / `Cmd+N`.

**Architecture:** A Zustand-driven modal state (`isWorkspaceLauncherOpen`) toggled via the Left Sidebar `WorkspaceList` header `+` button and global `Ctrl+N` / `Cmd+N` shortcut. The modal renders in `App.tsx` with a backdrop overlay, search filtering, full keyboard navigation (Up/Down/Enter/Escape), and active mock tab creation on selection.

**Tech Stack:** React 19, TypeScript, Lucide React icons, Zustand, Vitest, `@testing-library/react`.

## Global Constraints

- Modal backdrop: `rgba(0, 0, 0, 0.65)` with `backdrop-filter: blur(4px)`.
- Modal card surface: `var(--card, #282827)` with `border: 1px solid var(--border, rgba(255, 255, 255, 0.07))`.
- Item hover/selected: `background-color: var(--muted, #2e2e2d)`.
- Primary text: `var(--foreground, #ededec)`. Muted text: `var(--muted-foreground, #9e9e9a)`.
- Keyboard navigation: Arrow Up/Down cycles selection, Enter activates, Escape dismisses.
- Shortcut badges: `font-family: var(--font-mono)`.

---

### Task 1: Store State & Actions for Workspace Launcher

**Files:**
- Modify: `src/store/terminalStore.ts`
- Test: `src/store/terminalStore.test.ts`

**Interfaces:**
- Produces:
  ```typescript
  isWorkspaceLauncherOpen: boolean;
  openWorkspaceLauncher: () => void;
  closeWorkspaceLauncher: () => void;
  toggleWorkspaceLauncher: () => void;
  ```

- [ ] **Step 1: Write failing store tests**

In `src/store/terminalStore.test.ts`:
```typescript
  describe("workspace launcher modal state", () => {
    it("defaults to isWorkspaceLauncherOpen = false", () => {
      expect(useTerminalStore.getState().isWorkspaceLauncherOpen).toBe(false);
    });

    it("opens, closes, and toggles workspace launcher modal", () => {
      useTerminalStore.getState().openWorkspaceLauncher();
      expect(useTerminalStore.getState().isWorkspaceLauncherOpen).toBe(true);

      useTerminalStore.getState().closeWorkspaceLauncher();
      expect(useTerminalStore.getState().isWorkspaceLauncherOpen).toBe(false);

      useTerminalStore.getState().toggleWorkspaceLauncher();
      expect(useTerminalStore.getState().isWorkspaceLauncherOpen).toBe(true);

      useTerminalStore.getState().toggleWorkspaceLauncher();
      expect(useTerminalStore.getState().isWorkspaceLauncherOpen).toBe(false);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/store/terminalStore.test.ts`
Expected: FAIL with missing properties/methods.

- [ ] **Step 3: Implement store state and actions**

In `src/store/terminalStore.ts`:
Add to `TerminalState` interface:
```typescript
  isWorkspaceLauncherOpen: boolean;
  openWorkspaceLauncher: () => void;
  closeWorkspaceLauncher: () => void;
  toggleWorkspaceLauncher: () => void;
```
And inside `create<TerminalState>()`:
```typescript
  isWorkspaceLauncherOpen: false,
  openWorkspaceLauncher: () => set({ isWorkspaceLauncherOpen: true }),
  closeWorkspaceLauncher: () => set({ isWorkspaceLauncherOpen: false }),
  toggleWorkspaceLauncher: () => set((s) => ({ isWorkspaceLauncherOpen: !s.isWorkspaceLauncherOpen })),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/store/terminalStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/terminalStore.ts src/store/terminalStore.test.ts
git commit -m "feat(store): add workspace launcher modal state and actions"
```

---

### Task 2: WorkspaceLauncherModal Component & Styles

**Files:**
- Create: `src/components/modal/WorkspaceLauncherModal.tsx`
- Create: `src/components/modal/WorkspaceLauncherModal.css`
- Test: `src/components/modal/WorkspaceLauncherModal.test.tsx`

**Interfaces:**
- Consumes:
  ```typescript
  useTerminalStore((s) => s.isWorkspaceLauncherOpen)
  useTerminalStore((s) => s.closeWorkspaceLauncher)
  useTerminalStore((s) => s.createTab)
  ```
- Produces: `<WorkspaceLauncherModal />`

- [ ] **Step 1: Write component unit tests**

Create `src/components/modal/WorkspaceLauncherModal.test.tsx`:
```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorkspaceLauncherModal } from "./WorkspaceLauncherModal";
import { useTerminalStore } from "../../store/terminalStore";

describe("WorkspaceLauncherModal", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      isWorkspaceLauncherOpen: true,
      tabs: [],
      activeTabId: null,
      sessions: {},
    });
  });

  it("does not render when isWorkspaceLauncherOpen is false", () => {
    useTerminalStore.setState({ isWorkspaceLauncherOpen: false });
    const { container } = render(<WorkspaceLauncherModal />);
    expect(container.firstChild).toBeNull();
  });

  it("renders search input, action items, and recent projects", () => {
    render(<WorkspaceLauncherModal />);
    expect(screen.getByPlaceholderText(/Search or select workspace/i)).toBeInTheDocument();
    expect(screen.getByText("New Empty Workspace")).toBeInTheDocument();
    expect(screen.getByText("Open Local Project Folder...")).toBeInTheDocument();
    expect(screen.getByText("Clone Git Repository...")).toBeInTheDocument();
    expect(screen.getByText("oppa")).toBeInTheDocument();
    expect(screen.getByText("frontend-core")).toBeInTheDocument();
  });

  it("filters items in real time when typing in search input", () => {
    render(<WorkspaceLauncherModal />);
    const input = screen.getByPlaceholderText(/Search or select workspace/i);
    fireEvent.change(input, { target: { value: "clone" } });

    expect(screen.getByText("Clone Git Repository...")).toBeInTheDocument();
    expect(screen.queryByText("New Empty Workspace")).toBeNull();
  });

  it("shows empty state when no items match search query", () => {
    render(<WorkspaceLauncherModal />);
    const input = screen.getByPlaceholderText(/Search or select workspace/i);
    fireEvent.change(input, { target: { value: "nonexistent-item-xyz" } });

    expect(screen.getByText(/No matching workspaces or actions/i)).toBeInTheDocument();
  });

  it("closes modal on Escape key", () => {
    render(<WorkspaceLauncherModal />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useTerminalStore.getState().isWorkspaceLauncherOpen).toBe(false);
  });

  it("closes modal when clicking backdrop overlay", () => {
    const { container } = render(<WorkspaceLauncherModal />);
    const backdrop = container.querySelector(".launcher-backdrop");
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(useTerminalStore.getState().isWorkspaceLauncherOpen).toBe(false);
  });

  it("navigates selection with ArrowDown and ArrowUp and selects on Enter", async () => {
    render(<WorkspaceLauncherModal />);
    const input = screen.getByPlaceholderText(/Search or select workspace/i);

    // Initial selected index is 0 ("New Empty Workspace")
    fireEvent.keyDown(input, { key: "ArrowDown" });
    // Now index 1 ("Open Local Project Folder...") is selected
    fireEvent.keyDown(input, { key: "Enter" });

    // Modal should close and create a tab
    expect(useTerminalStore.getState().isWorkspaceLauncherOpen).toBe(false);
    expect(useTerminalStore.getState().tabs.length).toBe(1);
  });

  it("creates tab and closes modal when clicking an item", () => {
    render(<WorkspaceLauncherModal />);
    const item = screen.getByText("New Empty Workspace");
    fireEvent.click(item);

    expect(useTerminalStore.getState().isWorkspaceLauncherOpen).toBe(false);
    expect(useTerminalStore.getState().tabs.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/modal/WorkspaceLauncherModal.test.tsx`
Expected: FAIL with "Cannot find module".

- [ ] **Step 3: Implement `WorkspaceLauncherModal.tsx` and `WorkspaceLauncherModal.css`**

Create `src/components/modal/WorkspaceLauncherModal.tsx`:
```tsx
import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  Search,
  TerminalSquare,
  Folder,
  GitBranch,
  FolderGit2,
  CornerDownLeft,
} from "lucide-react";
import { useTerminalStore } from "../../store/terminalStore";
import "./WorkspaceLauncherModal.css";

interface LauncherItem {
  id: string;
  category: "ACTIONS" | "RECENT PROJECTS";
  title: string;
  subtitle?: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  shortcut?: string;
  onSelect: () => void | Promise<void>;
}

export function WorkspaceLauncherModal(): React.ReactElement | null {
  const isOpen = useTerminalStore((s) => s.isWorkspaceLauncherOpen);
  const closeLauncher = useTerminalStore((s) => s.closeWorkspaceLauncher);
  const createTab = useTerminalStore((s) => s.createTab);

  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const isMac = typeof navigator !== "undefined" && /(Mac|iPhone|iPod|iPad)/i.test(navigator.userAgent);
  const modKey = isMac ? "⌘" : "Ctrl+";

  const allItems: LauncherItem[] = useMemo(() => [
    {
      id: "action-new-empty",
      category: "ACTIONS",
      title: "New Empty Workspace",
      subtitle: "Start a fresh terminal session",
      icon: TerminalSquare,
      shortcut: "↵",
      onSelect: () => {
        void createTab();
        closeLauncher();
      },
    },
    {
      id: "action-open-folder",
      category: "ACTIONS",
      title: "Open Local Project Folder...",
      subtitle: "Select a folder from your filesystem",
      icon: Folder,
      shortcut: `${modKey}O`,
      onSelect: () => {
        void createTab();
        closeLauncher();
      },
    },
    {
      id: "action-clone-repo",
      category: "ACTIONS",
      title: "Clone Git Repository...",
      subtitle: "Clone from GitHub, GitLab, or URL",
      icon: GitBranch,
      shortcut: `${modKey}G`,
      onSelect: () => {
        void createTab();
        closeLauncher();
      },
    },
    {
      id: "recent-oppa",
      category: "RECENT PROJECTS",
      title: "oppa",
      subtitle: "D:/oppa/oppa",
      icon: FolderGit2,
      onSelect: () => {
        void createTab();
        closeLauncher();
      },
    },
    {
      id: "recent-frontend-core",
      category: "RECENT PROJECTS",
      title: "frontend-core",
      subtitle: "~/dev/frontend-core",
      icon: Folder,
      onSelect: () => {
        void createTab();
        closeLauncher();
      },
    },
    {
      id: "recent-terminal-engine",
      category: "RECENT PROJECTS",
      title: "terminal-engine",
      subtitle: "~/projects/terminal-engine",
      icon: Folder,
      onSelect: () => {
        void createTab();
        closeLauncher();
      },
    },
  ], [createTab, closeLauncher, modKey]);

  const filteredItems = useMemo(() => {
    if (!query.trim()) return allItems;
    const q = query.toLowerCase();
    return allItems.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        (item.subtitle && item.subtitle.toLowerCase().includes(q))
    );
  }, [allItems, query]);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeLauncher();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, closeLauncher]);

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filteredItems.length > 0) {
        setSelectedIndex((prev) => (prev + 1) % filteredItems.length);
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filteredItems.length > 0) {
        setSelectedIndex((prev) => (prev - 1 + filteredItems.length) % filteredItems.length);
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      const selected = filteredItems[selectedIndex];
      if (selected) {
        selected.onSelect();
      }
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="launcher-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeLauncher();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Workspace and Project Selector"
    >
      <div className="launcher-card">
        <div className="launcher-search-row">
          <Search size={16} className="launcher-search-icon" />
          <input
            ref={inputRef}
            type="text"
            className="launcher-search-input"
            placeholder="Search or select workspace, project, or command..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleInputKeyDown}
          />
          <kbd className="launcher-esc-badge" onClick={closeLauncher}>
            ESC
          </kbd>
        </div>

        <div className="launcher-list" role="listbox">
          {filteredItems.length === 0 ? (
            <div className="launcher-empty">No matching workspaces or actions</div>
          ) : (
            filteredItems.map((item, idx) => {
              const isSelected = idx === selectedIndex;
              const Icon = item.icon;
              const prevItem = filteredItems[idx - 1];
              const showCategory = !prevItem || prevItem.category !== item.category;

              return (
                <React.Fragment key={item.id}>
                  {showCategory && (
                    <div className="launcher-category-header">{item.category}</div>
                  )}
                  <div
                    role="option"
                    aria-selected={isSelected}
                    className={`launcher-item ${isSelected ? "selected" : ""}`}
                    onClick={() => item.onSelect()}
                    onMouseEnter={() => setSelectedIndex(idx)}
                  >
                    <div className="launcher-item-left">
                      <div className="launcher-item-icon">
                        <Icon size={16} />
                      </div>
                      <div className="launcher-item-info">
                        <span className="launcher-item-title">{item.title}</span>
                        {item.subtitle && (
                          <span className="launcher-item-subtitle">{item.subtitle}</span>
                        )}
                      </div>
                    </div>
                    {item.shortcut && (
                      <kbd className="launcher-item-shortcut">{item.shortcut}</kbd>
                    )}
                  </div>
                </React.Fragment>
              );
            })
          )}
        </div>

        <div className="launcher-footer">
          <span className="launcher-footer-hint">
            <kbd>↑</kbd> <kbd>↓</kbd> to navigate
          </span>
          <span className="launcher-footer-hint">
            <kbd>↵</kbd> to select
          </span>
          <span className="launcher-footer-hint">
            <kbd>ESC</kbd> to close
          </span>
        </div>
      </div>
    </div>
  );
}
```

Create `src/components/modal/WorkspaceLauncherModal.css`:
```css
.launcher-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 14vh;
  background-color: rgba(0, 0, 0, 0.65);
  backdrop-filter: blur(4px);
  animation: launcherFadeIn 0.12s ease-out;
}

@keyframes launcherFadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.launcher-card {
  width: 540px;
  max-width: 90vw;
  max-height: 480px;
  display: flex;
  flex-direction: column;
  background-color: var(--card, #282827);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.07));
  border-radius: var(--radius-lg, 8px);
  box-shadow: 0 16px 36px rgba(0, 0, 0, 0.6);
  overflow: hidden;
  animation: launcherScaleIn 0.15s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes launcherScaleIn {
  from {
    transform: scale(0.97);
    opacity: 0;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}

.launcher-search-row {
  display: flex;
  align-items: center;
  padding: 12px 14px;
  gap: 10px;
  border-bottom: 1px solid var(--border, rgba(255, 255, 255, 0.07));
}

.launcher-search-icon {
  color: var(--muted-foreground, #9e9e9a);
  flex-shrink: 0;
}

.launcher-search-input {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--foreground, #ededec);
  font-family: var(--font-sans);
  font-size: 14px;
  outline: none;
}

.launcher-search-input::placeholder {
  color: var(--muted-foreground, #9e9e9a);
}

.launcher-esc-badge {
  font-family: var(--font-mono);
  font-size: 10px;
  padding: 2px 5px;
  border-radius: var(--radius-sm, 4px);
  background: rgba(255, 255, 255, 0.06);
  color: var(--muted-foreground, #9e9e9a);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.07));
  cursor: pointer;
}

.launcher-list {
  padding: 6px;
  overflow-y: auto;
  max-height: 340px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.launcher-category-header {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--muted-foreground, #9e9e9a);
  padding: 8px 8px 4px 8px;
  text-transform: uppercase;
}

.launcher-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-radius: var(--radius-sm, 4px);
  cursor: pointer;
  user-select: none;
  transition: background-color 0.1s ease, color 0.1s ease;
}

.launcher-item:hover,
.launcher-item.selected {
  background-color: var(--muted, #2e2e2d);
}

.launcher-item-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1;
}

.launcher-item-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted-foreground, #9e9e9a);
  flex-shrink: 0;
}

.launcher-item.selected .launcher-item-icon {
  color: var(--foreground, #ededec);
}

.launcher-item-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.25;
}

.launcher-item-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--foreground, #ededec);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.launcher-item-subtitle {
  font-size: 11px;
  color: var(--muted-foreground, #9e9e9a);
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}

.launcher-item-shortcut {
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 2px 6px;
  border-radius: var(--radius-sm, 4px);
  background: rgba(255, 255, 255, 0.05);
  color: var(--muted-foreground, #9e9e9a);
  border: 1px solid var(--border, rgba(255, 255, 255, 0.07));
  margin-left: 8px;
  flex-shrink: 0;
}

.launcher-empty {
  padding: 24px;
  text-align: center;
  font-size: 12px;
  color: var(--muted-foreground, #9e9e9a);
}

.launcher-footer {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px;
  background-color: var(--sidebar, #212120);
  border-top: 1px solid var(--border, rgba(255, 255, 255, 0.07));
  font-size: 11px;
  color: var(--muted-foreground, #9e9e9a);
}

.launcher-footer-hint kbd {
  font-family: var(--font-mono);
  font-size: 10px;
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 4px;
  border-radius: 3px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.07));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/modal/WorkspaceLauncherModal.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/modal/WorkspaceLauncherModal.tsx src/components/modal/WorkspaceLauncherModal.css src/components/modal/WorkspaceLauncherModal.test.tsx
git commit -m "feat(modal): create WorkspaceLauncherModal with Raycast-style command palette"
```

---

### Task 3: Integration into LeftSidebar & App / Global Shortcut

**Files:**
- Modify: `src/components/sidebar/WorkspaceList.tsx`
- Modify: `src/App.tsx`
- Test: `src/components/sidebar/LeftSidebar.test.tsx`
- Test: `src/App.test.tsx`

**Interfaces:**
- Consumes:
  ```typescript
  useTerminalStore((s) => s.openWorkspaceLauncher)
  useTerminalStore((s) => s.toggleWorkspaceLauncher)
  ```

- [ ] **Step 1: Update `WorkspaceList.tsx` to trigger `openWorkspaceLauncher`**

In `src/components/sidebar/WorkspaceList.tsx`:
Replace `onClick={() => void createTab()}` with `onClick={() => openWorkspaceLauncher()}`:
```tsx
  const openWorkspaceLauncher = useTerminalStore((s) => s.openWorkspaceLauncher);
  ...
  <button
    type="button"
    className="workspace-icon-btn"
    title="New Workspace"
    aria-label="New Workspace"
    onClick={() => openWorkspaceLauncher()}
  >
    <Plus size={14} />
  </button>
```

- [ ] **Step 2: Update `App.tsx` with `<WorkspaceLauncherModal />` and `Ctrl+N` / `Cmd+N` listener**

In `src/App.tsx`:
```tsx
import { WorkspaceLauncherModal } from "./components/modal/WorkspaceLauncherModal";
```
Inside the `App` component's keyboard shortcut listener:
```tsx
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMod = e.ctrlKey || e.metaKey;
      if (isMod && e.key.toLowerCase() === "n") {
        e.preventDefault();
        useTerminalStore.getState().toggleWorkspaceLauncher();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
```
And mount `<WorkspaceLauncherModal />` inside the root `<div className="app-container">`:
```tsx
  return (
    <div className="app-container">
      <TitleBar />
      ...
      <StatusBar />
      <WorkspaceLauncherModal />
    </div>
  );
```

- [ ] **Step 3: Update `LeftSidebar.test.tsx` and `App.test.tsx`**

In `src/components/sidebar/LeftSidebar.test.tsx`:
Verify clicking the `+` button calls `openWorkspaceLauncher` (or sets `isWorkspaceLauncherOpen = true`).

In `src/App.test.tsx`:
Verify pressing `Ctrl+N` / `Cmd+N` opens the `WorkspaceLauncherModal`.

- [ ] **Step 4: Run component tests**

Run: `pnpm vitest run src/components/sidebar/LeftSidebar.test.tsx src/App.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/sidebar/WorkspaceList.tsx src/App.tsx src/components/sidebar/LeftSidebar.test.tsx src/App.test.tsx
git commit -m "feat(ui): connect LeftSidebar '+' button and Ctrl+N shortcut to WorkspaceLauncherModal"
```

---

### Task 4: Full System Verification and Build Check

**Files:**
- Verify: Full codebase

- [ ] **Step 1: Run complete vitest test suite**

Run: `pnpm vitest run`
Expected: 20/20 test files pass.

- [ ] **Step 2: Run frontend build check**

Run: `pnpm build`
Expected: Zero type errors, build completes cleanly into `dist/`.

- [ ] **Step 3: Run backend cargo check and cargo tests**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Run: `cargo test -p oppa --lib --manifest-path src-tauri/Cargo.toml`
Expected: Zero errors, all Rust tests pass.

- [ ] **Step 4: Final verification and commit if needed**
