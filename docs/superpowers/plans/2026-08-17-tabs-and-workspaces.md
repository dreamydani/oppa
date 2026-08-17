# Terminal Tabs & Multi-Tab Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement full multi-tab terminal support in OPPA, allowing users to create multiple tabs, each containing independent split-pane layouts, complete with a sleek tab bar UI, keyboard shortcuts, and cold restore persistence.

**Architecture:** `terminalStore.ts` manages an array of `tabs: TabState[]` and an `activeTabId: string`. Each tab holds its own `layout: Layout` and `focusedPath: Path`. `TabBar.tsx` renders tabs with dynamic titles and inline renaming. `App.tsx` handles global hotkeys (`Ctrl+T`, `Ctrl+Tab`, `Alt+1..9`).

**Tech Stack:** React 19, TypeScript, Zustand, Vitest, `@testing-library/react`.

## Global Constraints

- **Split Independence**: Splitting or closing panes in one tab must never alter the layout or active sessions of background tabs.
- **Backward Compatibility**: `loadLayout` must seamlessly parse legacy single-layout saves and promote them into a single tab.
- **TDD**: Write failing tests first, verify failure, implement, verify pass, and commit.

---

### Task 1: Multi-Tab State Store & Actions (`src/store/terminalStore.ts`)

**Files:**
- Modify: `src/store/terminalStore.ts`
- Modify: `src/store/terminalStore.test.ts`

**Interfaces:**
- Produces: `export interface TabState { id: string; title?: string; layout: Layout; focusedPath: Path; }`
- Produces in `TerminalState`: `tabs: TabState[]; activeTabId: string; createTab: (cwd?: string) => Promise<string>; closeTab: (tabId?: string) => Promise<void>; selectTab: (tabId: string) => void; renameTab: (tabId: string, title: string) => void;`

- [ ] **Step 1: Write failing tests in `src/store/terminalStore.test.ts`**

Cover:
1. `createTab` creates a new tab with a fresh session, sets it active, and preserves existing tabs.
2. `closeTab` closes a tab, terminates its sessions, cleans up scrollback snapshots, and switches focus to an adjacent tab.
3. `selectTab` switches the active tab.
4. `renameTab` updates a tab's title.
5. `splitPane` splits the active tab only.
6. `saveLayout` and `loadLayout` preserve multiple tabs and their active tab across restarts.

- [ ] **Step 2: Run tests to verify failures**

Run: `pnpm vitest run src/store/terminalStore.test.ts`
Expected: FAIL

- [ ] **Step 3: Update `src/store/terminalStore.ts`**

1. Define `TabState` and update `TerminalState`.
2. Implement tab actions: `createTab`, `closeTab`, `selectTab`, `renameTab`.
3. Update `splitPane`, `closePane`, `focusPane`, `moveFocus`, `setSplitRatio` to operate on the active tab found in `state.tabs.find(t => t.id === state.activeTabId)`.
4. Update `saveLayout` to save `{ tabs, activeTabId, sessions }`.
5. Update `loadLayout` to restore `tabs`, `activeTabId`, remap leaf IDs, load scrollbacks per leaf, and support legacy `{ layout, sessions }` format fallback.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/store/terminalStore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/terminalStore.ts src/store/terminalStore.test.ts
git commit -m "feat(store): implement multi-tab state management and split isolation"
```

---

### Task 2: TabBar Component & Inline Renaming (`src/components/TabBar.tsx`)

**Files:**
- Create: `src/components/TabBar.tsx`
- Create: `src/components/TabBar.test.tsx`

**Interfaces:**
- Produces: `export function TabBar(): React.ReactElement`

- [ ] **Step 1: Write failing unit tests in `src/components/TabBar.test.tsx`**

Test that:
1. Renders all tabs from store and highlights active tab with `.active`.
2. Clicking a tab calls `selectTab`.
3. Clicking the `+` button calls `createTab`.
4. Clicking the `✕` close button on a tab calls `closeTab`.
5. Double-clicking a tab enables inline editing `<input>` and pressing `Enter` calls `renameTab`.

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest run src/components/TabBar.test.tsx`
Expected: FAIL (file not found)

- [ ] **Step 3: Implement `src/components/TabBar.tsx`**

```tsx
import React, { useState, useRef, useEffect } from "react";
import { useTerminalStore } from "../store/terminalStore";
import { focus } from "../lib/pane-manager/layout";

export function TabBar() {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const sessions = useTerminalStore((s) => s.sessions);
  const selectTab = useTerminalStore((s) => s.selectTab);
  const createTab = useTerminalStore((s) => s.createTab);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const renameTab = useTerminalStore((s) => s.renameTab);

  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingTabId) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingTabId]);

  const handleStartRename = (tabId: string, currentTitle: string) => {
    setEditingTabId(tabId);
    setEditTitle(currentTitle);
  };

  const handleSaveRename = (tabId: string) => {
    if (editTitle.trim()) {
      renameTab(tabId, editTitle.trim());
    }
    setEditingTabId(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent, tabId: string) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSaveRename(tabId);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setEditingTabId(null);
    }
  };

  const getTabLabel = (tab: (typeof tabs)[0]) => {
    if (tab.title) return tab.title;
    const leafId = focus(tab.layout, tab.focusedPath);
    const session = sessions[leafId];
    if (session?.cwd) {
      const parts = session.cwd.split(/[/\\]/).filter(Boolean);
      return parts[parts.length - 1] || "terminal";
    }
    return "terminal";
  };

  return (
    <div className="tab-bar" role="tablist" aria-label="Terminal Tabs">
      <div className="tab-list">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const label = getTabLabel(tab);
          const isEditing = editingTabId === tab.id;

          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              className={`tab-item ${isActive ? "active" : ""}`}
              onClick={() => !isEditing && selectTab(tab.id)}
              onDoubleClick={() => handleStartRename(tab.id, tab.title || label)}
            >
              {isEditing ? (
                <input
                  ref={editInputRef}
                  type="text"
                  className="tab-rename-input"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onBlur={() => handleSaveRename(tab.id)}
                  onKeyDown={(e) => handleKeyDown(e, tab.id)}
                  aria-label="Rename tab"
                />
              ) : (
                <span className="tab-title" title={label}>
                  {label}
                </span>
              )}
              {tabs.length > 1 && (
                <button
                  type="button"
                  className="tab-close-btn"
                  title="Close Tab (Ctrl+W)"
                  aria-label="Close tab"
                  onClick={(e) => {
                    e.stopPropagation();
                    void closeTab(tab.id);
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="tab-add-btn"
        title="New Tab (Ctrl+T)"
        aria-label="New Tab"
        onClick={() => void createTab()}
      >
        +
      </button>
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/components/TabBar.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/TabBar.tsx src/components/TabBar.test.tsx
git commit -m "feat(ui): add TabBar component with dynamic titles and inline rename"
```

---

### Task 3: App Integration, Styling & Global Keyboard Shortcuts (`src/App.tsx`, `App.css`)

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/App.css`
- Modify: `src/App.test.tsx`

**Interfaces:**
- Keyboard Shortcuts: `Ctrl+T` (new tab), `Ctrl+Tab` / `Ctrl+Shift+Tab` (tab cycling), `Alt+1..9` (tab switching).

- [ ] **Step 1: Update `src/App.tsx`**

Integrate `TabBar` at top and add global `keydown` listener for tab switching & creation.

- [ ] **Step 2: Add styles in `src/App.css`**

Add styling for `.tab-bar`, `.tab-list`, `.tab-item`, `.tab-title`, `.tab-close-btn`, `.tab-add-btn`, `.tab-rename-input`.

- [ ] **Step 3: Run frontend tests**

Run: `pnpm vitest run`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx src/App.css src/App.test.tsx
git commit -m "feat(ui): wire TabBar and global keyboard shortcuts into App"
```

---

### Task 4: Full Project Verification

- [ ] **Step 1: Run full test and build suite**

Run:
1. `pnpm vitest run`
2. `pnpm build`
3. `cargo test -p oppa --lib`
4. `cargo check` in `src-tauri`

- [ ] **Step 2: Commit any final cleanup if needed**
