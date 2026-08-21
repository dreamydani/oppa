# Workspace Sleep Mode & Lazy Terminal Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement lazy workspace loading and terminal sleep mode so OPPA boots instantly by restoring only the active workspace on startup, keeping inactive workspaces in a lightweight dormant state and waking them on-demand when clicked.

**Architecture:** Extend Zustand `terminalStore.ts` with a `"sleeping"` session status and `isSleeping` tab flag. In `loadLayout()`, spawn only the active tab's PTY sessions, seeding inactive tabs with metadata without spawning backend processes. In `selectTab()`, trigger an on-demand `wakeTab()` that spawns PTYs, loads scrollback, and transitions sessions to `"running"`. Ensure `saveLayout()`, `closeTab()`, and `closePane()` safely handle sleeping sessions without data loss or phantom kill calls.

**Tech Stack:** React 19, TypeScript, Zustand, Tauri 2, Vitest, @testing-library/react.

## Global Constraints

- Keep platform-dependent behavior behind runtime checks (macOS, Linux, Windows).
- Never touch Tauri APIs directly from UI components; route through `src/lib/pty/transport.ts` and `src/store/terminalStore.ts`.
- Concise comments ONLY — explain WHY, not HOW.
- Descriptive variable names; never use vague names (`helpers`, `utils`, `common`).
- TDD: Write failing test first, verify failure, implement, verify pass, commit.

---

### Task 1: Data Model Updates & Startup Hydration (`loadLayout`)

**Files:**
- Modify: `src/store/terminalStore.ts`
- Modify: `src/store/terminalStore.test.ts`

**Interfaces:**
- Consumes: `SessionStatus`, `TabState`, `loadLayout`
- Produces: `SessionStatus` with `"sleeping"`, `TabState.isSleeping?: boolean`, `loadLayout` lazy spawn behavior

- [ ] **Step 1: Write the failing tests in `terminalStore.test.ts`**

Add tests to `src/store/terminalStore.test.ts` verifying that `loadLayout()` only calls `spawnSession` for the active tab's sessions, while marking inactive tabs as `isSleeping: true` with session statuses set to `"sleeping"`.

```ts
    it("loadLayout only spawns sessions for the active tab and marks inactive tabs as sleeping", async () => {
      const layoutData = {
        version: 2,
        activeTabId: "tab-1",
        tabs: [
          {
            id: "tab-1",
            title: "Project Active",
            layout: { type: "leaf", id: "sess-active-1" },
            focusedPath: [],
          },
          {
            id: "tab-2",
            title: "Project Dormant",
            layout: { type: "leaf", id: "sess-dormant-1" },
            focusedPath: [],
          },
        ],
        sessions: [
          {
            id: "sess-active-1",
            title: "Active Shell",
            status: "running",
            cwd: "C:/projects/active",
            cols: 80,
            rows: 24,
          },
          {
            id: "sess-dormant-1",
            title: "Dormant Shell",
            status: "running",
            cwd: "C:/projects/dormant",
            cols: 80,
            rows: 24,
          },
        ],
      };

      (transportLoadLayout as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        JSON.stringify(layoutData),
      );

      await useTerminalStore.getState().loadLayout();

      const state = useTerminalStore.getState();
      expect(state.tabs).toHaveLength(2);
      expect(state.activeTabId).toBe("tab-1");

      const activeTab = state.tabs.find((t) => t.id === "tab-1");
      const dormantTab = state.tabs.find((t) => t.id === "tab-2");

      expect(activeTab?.isSleeping).toBeFalsy();
      expect(dormantTab?.isSleeping).toBe(true);

      expect(state.sessions["sess-active-1"]).toBeDefined();
      expect(state.sessions["sess-active-1"].status).toBe("running");

      expect(state.sessions["sess-dormant-1"]).toBeDefined();
      expect(state.sessions["sess-dormant-1"].status).toBe("sleeping");
      expect(state.sessions["sess-dormant-1"].cwd).toBe("C:/projects/dormant");

      // Verify spawnSession was only called for the active tab's session
      expect(ptySpawn).toHaveBeenCalledWith(
        expect.objectContaining({ id: "sess-active-1", cwd: "C:/projects/active" }),
      );
      expect(ptySpawn).not.toHaveBeenCalledWith(
        expect.objectContaining({ id: "sess-dormant-1" }),
      );
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/store/terminalStore.test.ts`
Expected: FAIL because `loadLayout` currently spawns all sessions indiscriminately and `SessionStatus` / `TabState` do not yet support `"sleeping"`.

- [ ] **Step 3: Update `src/store/terminalStore.ts`**

1. Update `SessionStatus`:
```ts
export type SessionStatus =
  | "sleeping"
  | "spawning"
  | "loading"
  | "restoring"
  | "running"
  | "exited"
  | "error";
```

2. Update `TabState`:
```ts
export interface TabState {
  id: string;
  title?: string;
  layout: Layout;
  focusedPath: Path;
  isWizard?: boolean;
  isSleeping?: boolean;
}
```

3. In `loadLayout()`, partition the sessions:
- Identify `activeTabId`:
```ts
const activeTabId =
  parsed.activeTabId && restoredTabs.some((t) => t.id === parsed.activeTabId)
    ? parsed.activeTabId
    : restoredTabs[0].id;
```
- Collect `activeOldIds = new Set<string>()` from the active tab's layout.
- Collect `dormantOldIds = new Set<string>()` from all other tabs' layouts.
- Seed `state.sessions`:
  - For active sessions: set `status: "restoring"`.
  - For dormant sessions: set `status: "sleeping"`, saving `title`, `cwd`, `cols`, `rows`.
- Inactive tabs receive `isSleeping: true`.
- Call `spawnSession` and `loadScrollback` ONLY for `activeOldIds`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/store/terminalStore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/store/terminalStore.ts src/store/terminalStore.test.ts
git commit -m "feat: lazy load tabs on startup with sleeping session state"
```

---

### Task 2: On-Demand Tab Wakeup (`wakeTab` & `selectTab`)

**Files:**
- Modify: `src/store/terminalStore.ts`
- Modify: `src/store/terminalStore.test.ts`

**Interfaces:**
- Consumes: `wakeTab: (tabId: string) => Promise<void>`, `selectTab: (tabId: string) => void`
- Produces: On-demand PTY spawn, scrollback reattachment, and layout remapping for sleeping tabs

- [ ] **Step 1: Write the failing tests in `terminalStore.test.ts`**

Add tests verifying that calling `selectTab()` on a sleeping tab triggers `wakeTab()`, spawns its sessions, restores scrollback, updates tab to `isSleeping: false`, and marks sessions as `"running"`.

```ts
    it("selectTab on a sleeping tab wakes up its sessions on-demand", async () => {
      useTerminalStore.setState({
        tabs: [
          {
            id: "tab-1",
            title: "Tab 1",
            layout: { type: "leaf", id: "sess-1" },
            focusedPath: [],
            isSleeping: false,
          },
          {
            id: "tab-2",
            title: "Tab 2",
            layout: { type: "leaf", id: "sess-2" },
            focusedPath: [],
            isSleeping: true,
          },
        ],
        activeTabId: "tab-1",
        sessions: {
          "sess-1": {
            id: "sess-1",
            title: "Shell 1",
            status: "running",
            cols: 80,
            rows: 24,
          },
          "sess-2": {
            id: "sess-2",
            title: "Shell 2",
            status: "sleeping",
            cwd: "C:/projects/proj2",
            cols: 80,
            rows: 24,
          },
        },
      });

      (loadScrollback as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
        "cached scrollback output for sess-2",
      );

      // Select sleeping tab
      useTerminalStore.getState().selectTab("tab-2");

      const stateImmediately = useTerminalStore.getState();
      expect(stateImmediately.activeTabId).toBe("tab-2");
      expect(stateImmediately.tabs.find((t) => t.id === "tab-2")?.isSleeping).toBe(false);

      // Await wakeTab completion
      await useTerminalStore.getState().wakeTab("tab-2");

      const stateAfterWake = useTerminalStore.getState();
      expect(stateAfterWake.sessions["sess-2"]?.status).toBe("running");
      expect(stateAfterWake.restoredScrollbacks["sess-2"]).toBe(
        "cached scrollback output for sess-2",
      );
      expect(ptySpawn).toHaveBeenCalledWith(
        expect.objectContaining({ id: "sess-2", cwd: "C:/projects/proj2" }),
      );
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/store/terminalStore.test.ts`
Expected: FAIL because `wakeTab` is not defined and `selectTab` does not wake sleeping tabs.

- [ ] **Step 3: Implement `wakeTab` and update `selectTab` in `src/store/terminalStore.ts`**

1. Add `wakeTab` to `TerminalState` interface:
```ts
  wakeTab: (tabId: string) => Promise<void>;
```

2. Implement `wakeTab`:
```ts
  wakeTab: async (tabId: string) => {
    const state = get();
    const tab = state.tabs.find((t) => t.id === tabId);
    if (!tab || tab.isWizard) return;

    const ids = leafIds(tab.layout).filter(Boolean);
    const sleepingIds = ids.filter((id) => state.sessions[id]?.status === "sleeping");
    if (sleepingIds.length === 0) return;

    // Set sessions to restoring state immediately
    set((s) => {
      const updated = { ...s.sessions };
      for (const id of sleepingIds) {
        if (updated[id]) {
          updated[id] = { ...updated[id], status: "restoring" };
        }
      }
      return { sessions: updated };
    });

    const remap: Record<string, string> = {};

    await Promise.all(
      sleepingIds.map(async (oldId) => {
        const savedSession = get().sessions[oldId];
        const newId = await get().spawnSession(savedSession?.cwd, undefined, oldId);
        remap[oldId] = newId;

        if (oldId !== newId) {
          set((s) => {
            const sessions = { ...s.sessions };
            delete sessions[oldId];
            return { sessions };
          });
        }

        if (savedSession?.title && savedSession.title !== newId) {
          get().renameSession(newId, savedSession.title);
        }

        const prev = await loadScrollback(oldId);
        if (prev) {
          if (!get().restoredScrollbacks[newId]) {
            get().setRestoredScrollback(newId, prev);
            set((s) => {
              const sess = s.sessions[newId];
              if (!sess) return s;
              return {
                sessions: {
                  ...s.sessions,
                  [newId]: { ...sess, isRestored: true },
                },
              };
            });
          }
          await saveScrollback(newId, prev);
          if (oldId !== newId) {
            await deleteScrollback(oldId);
          }
        }
      }),
    );

    // Remap layout if any IDs changed
    set((s) => {
      const currentTabs = getSyncedTabs(s);
      const remappedTabs = currentTabs.map((t) => {
        if (t.id !== tabId) return t;
        const remappedLayout = remapLeafIds(t.layout, remap);
        return {
          ...t,
          isSleeping: false,
          layout: remappedLayout,
        };
      });
      const updatedActiveTab = remappedTabs.find((t) => t.id === s.activeTabId);
      return {
        tabs: remappedTabs,
        ...(updatedActiveTab ? { layout: updatedActiveTab.layout } : {}),
      };
    });

    void get().saveLayout().catch(() => {});
  },
```

3. Update `selectTab(tabId)`:
```ts
  selectTab: (tabId) => {
    const state = get();
    const currentTabs = getSyncedTabs(state);
    const tab = currentTabs.find((t) => t.id === tabId);
    if (!tab) return;

    const wasSleeping = Boolean(tab.isSleeping);
    const updatedTabs = wasSleeping
      ? currentTabs.map((t) => (t.id === tabId ? { ...t, isSleeping: false } : t))
      : currentTabs;

    set({
      tabs: updatedTabs,
      activeTabId: tab.id,
      layout: tab.layout,
      focusedPath: tab.focusedPath,
      tabFocusHistory: [tab.id, ...state.tabFocusHistory.filter((id) => id !== tab.id)],
    });

    if (wasSleeping) {
      void get().wakeTab(tabId);
    }
    void get().saveLayout().catch(() => {});
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/store/terminalStore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/store/terminalStore.ts src/store/terminalStore.test.ts
git commit -m "feat: wake sleeping workspace sessions on demand during tab switch"
```

---

### Task 3: Persistence & Lifecycle for Sleeping Workspaces

**Files:**
- Modify: `src/store/terminalStore.ts`
- Modify: `src/store/terminalStore.test.ts`

**Interfaces:**
- Consumes: `saveLayout`, `closeTab`, `closePane`
- Produces: Safe layout persistence of dormant sessions without scrollback purging; no-op `ptyKill` when closing sleeping sessions

- [ ] **Step 1: Write the failing tests in `terminalStore.test.ts`**

Add tests for:
1. `saveLayout()` serializing both running and sleeping sessions and passing all IDs to `cleanupStaleScrollbacks`.
2. `closeTab()` on a sleeping tab deleting session entries and scrollback without calling `ptyKill`.

```ts
    it("saveLayout preserves sleeping sessions and prevents their scrollback cleanup", async () => {
      useTerminalStore.setState({
        tabs: [
          {
            id: "tab-1",
            title: "Active Tab",
            layout: { type: "leaf", id: "sess-1" },
            focusedPath: [],
            isSleeping: false,
          },
          {
            id: "tab-2",
            title: "Sleeping Tab",
            layout: { type: "leaf", id: "sess-2" },
            focusedPath: [],
            isSleeping: true,
          },
        ],
        sessions: {
          "sess-1": { id: "sess-1", title: "Active", status: "running", cols: 80, rows: 24, cwd: "C:/a" },
          "sess-2": { id: "sess-2", title: "Sleeping", status: "sleeping", cols: 80, rows: 24, cwd: "C:/b" },
        },
      });

      await useTerminalStore.getState().saveLayout();

      expect(transportSaveLayout).toHaveBeenCalledWith(
        expect.stringContaining('"id":"sess-2"'),
      );
      expect(cleanupStaleScrollbacks).toHaveBeenCalledWith(
        expect.arrayContaining(["sess-1", "sess-2"]),
      );
    });

    it("closeTab on a sleeping tab cleans up sessions without calling ptyKill", async () => {
      useTerminalStore.setState({
        tabs: [
          {
            id: "tab-1",
            title: "Tab 1",
            layout: { type: "leaf", id: "sess-1" },
            focusedPath: [],
            isSleeping: false,
          },
          {
            id: "tab-2",
            title: "Tab 2",
            layout: { type: "leaf", id: "sess-2" },
            focusedPath: [],
            isSleeping: true,
          },
        ],
        activeTabId: "tab-1",
        sessions: {
          "sess-1": { id: "sess-1", title: "Active", status: "running", cols: 80, rows: 24 },
          "sess-2": { id: "sess-2", title: "Sleeping", status: "sleeping", cols: 80, rows: 24 },
        },
      });

      (ptyKill as unknown as ReturnType<typeof vi.fn>).mockClear();

      await useTerminalStore.getState().closeTab("tab-2");

      expect(ptyKill).not.toHaveBeenCalledWith("sess-2");
      expect(deleteScrollback).toHaveBeenCalledWith("sess-2");
      expect(useTerminalStore.getState().sessions["sess-2"]).toBeUndefined();
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/store/terminalStore.test.ts`
Expected: FAIL because `closeTab` calls `killSession` which invokes `ptyKill` unconditionally.

- [ ] **Step 3: Update `closeTab` and `closePane` in `src/store/terminalStore.ts`**

In `closeTab` and `closePane`:
Check `session.status === "sleeping"` before calling `killSession(id)`. If the session is sleeping:
- Skip `ptyKill(id)`
- Clean up `deleteScrollback(id)`
- Delete from `state.sessions`

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/store/terminalStore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add src/store/terminalStore.ts src/store/terminalStore.test.ts
git commit -m "fix: prevent unnecessary ptyKill when closing sleeping sessions and preserve scrollback in saveLayout"
```

---

### Task 4: UI Smoothness, Component Integration, & Verification

**Files:**
- Modify: `src/components/SessionLeaf.tsx`
- Modify: `src/components/TabBar.tsx`
- Modify: `src/components/SessionLeaf.test.tsx`
- Modify: `src/components/TabBar.test.tsx`

**Interfaces:**
- Consumes: `SessionLeaf`, `TabBar`, `terminalStore`
- Produces: Seamless rendering of sleeping/restoring states with loading shimmer and correct tab label extraction

- [ ] **Step 1: Write/update component tests**

In `src/components/TabBar.test.tsx`:
Add a test verifying that `TabBar` renders the working directory or title for a sleeping tab whose session status is `"sleeping"`.

In `src/components/SessionLeaf.test.tsx`:
Add a test verifying that `SessionLeaf` displays the loading shimmer when a session has `status: "sleeping"` or `status: "restoring"`.

- [ ] **Step 2: Run tests to verify failure/pass**

Run: `pnpm vitest run src/components/TabBar.test.tsx src/components/SessionLeaf.test.tsx`

- [ ] **Step 3: Implement adjustments in `SessionLeaf.tsx` and `TabBar.tsx`**

Ensure `SessionLeaf` renders the loading shimmer if `session.status === "sleeping"` or `session.status === "restoring"`, transitioning to `TerminalPane` when `"running"`.

- [ ] **Step 4: Run full test suite**

Run:
```bash
pnpm vitest run
cargo test -p oppa --lib
cargo test -p oppa --test daemon_integration_test
pnpm build
cargo check
```
Expected: All tests pass and TypeScript + Rust builds succeed with 0 errors.

- [ ] **Step 5: Commit changes**

```bash
git add src/components/SessionLeaf.tsx src/components/TabBar.tsx src/components/SessionLeaf.test.tsx src/components/TabBar.test.tsx
git commit -m "feat: ensure seamless UI shimmer transitions and label resolution for sleeping workspaces"
```
