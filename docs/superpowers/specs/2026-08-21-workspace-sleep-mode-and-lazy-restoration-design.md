# Design Spec: Workspace Sleep Mode & Lazy Terminal Restoration

## Overview

When OPPA opens with multiple workspace tabs (e.g. 5 workspaces with 4 terminals each), it should not spawn all 20 backend shells simultaneously. Instead:
1. **Instant Startup**: On app launch, only the last active workspace tab spawns and restores its terminal sessions immediately.
2. **Sleep / Dormant State**: Inactive workspace tabs are loaded into memory with `isSleeping: true` and their sessions seeded with `status: "sleeping"`. Tab titles and working directory names remain immediately visible in the TabBar, but **zero** backend PTY processes are allocated.
3. **On-Demand Wakeup**: When the user switches to a sleeping workspace tab, OPPA seamlessly wakes that tab up in the background (`wakeTab`), spawns/attaches its PTYs, restores historical scrollback, and transitions the sessions to `"running"`.
4. **Multi-Workspace Retention**: All visited workspaces remain alive in memory and responsive without respawning.
5. **Safe State Persistence**: If OPPA quits while some workspaces are still asleep, `saveLayout()` serializes all tabs, sleeping sessions, and scrollbacks so no state or directory information is lost on subsequent launches.

---

## Architecture & Data Flow

### 1. Data Model & Types (`src/store/terminalStore.ts`)

- **SessionStatus**:
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

- **TabState**:
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

- **Store Action**:
  ```ts
  wakeTab: (tabId: string) => Promise<void>;
  ```

---

### 2. Startup Hydration (`loadLayout`)

When `loadLayout()` is called during startup:
1. Load `saved` layout snapshot from `layout.json`.
2. Determine `activeTabId`: `parsed.activeTabId && parsed.tabs.some(t => t.id === parsed.activeTabId) ? parsed.activeTabId : parsed.tabs[0]?.id`.
3. Partition tabs into:
   - **Active Tab**: `activeTab = parsed.tabs.find(t => t.id === activeTabId)`
   - **Inactive Tabs**: `inactiveTabs = parsed.tabs.filter(t => t.id !== activeTabId)`
4. Seed `sessions` in the Zustand store:
   - For all saved session IDs in `parsed.sessions`:
     - If the session belongs to `activeTab`: set `status: "restoring"`.
     - If the session belongs to an inactive tab: set `status: "sleeping"`, retaining `title`, `cwd`, `cols`, and `rows`.
5. Restore tabs in store:
   - Inactive tabs receive `isSleeping: true`.
   - Active tab receives `isSleeping: false`.
6. Restore only the active tab's sessions in parallel:
   ```ts
   const activeLeafIds = leafIds(activeTab.layout);
   await Promise.all(
     activeLeafIds.map(async (oldId) => {
       const savedSession = byId.get(oldId);
       const newId = await get().spawnSession(savedSession?.cwd, undefined, oldId);
       remap[oldId] = newId;
       // Scrollback restore and title synchronization...
     })
   );
   ```
7. Set `ready: true` in store. Active workspace renders immediately while inactive tabs sit dormant.

---

### 3. On-Demand Tab Wakeup Workflow (`selectTab` & `wakeTab`)

1. User clicks or shortcuts to a tab via `selectTab(tabId)`.
2. `selectTab` switches `activeTabId`, `layout`, and `focusedPath` immediately for instant visual response.
3. If `targetTab.isSleeping`:
   - Mark `tab.isSleeping = false`.
   - Call `wakeTab(tabId)` in the background:
     1. Retrieve all leaf session IDs in `tab.layout`.
     2. Update their statuses to `"restoring"`.
     3. For each leaf session:
        - Call `spawnSession(session.cwd, undefined, oldId)`.
        - If ID is remapped, update layout via `remapLeafIds`.
        - Load saved scrollback from disk via `loadScrollback(oldId)` and apply via `setRestoredScrollback(newId, scrollback)`.
        - Transition session to `status: "running"`.
     4. Update tab layout in store with remapped IDs and save layout.
4. `SessionLeaf` displays the animated loading skeleton while in `"restoring"` state and seamlessly transitions to the live terminal canvas when `"running"`.

---

### 4. Layout Persistence & Scrollback Preservation (`saveLayout`)

1. `saveLayout()` queries both running sessions and sleeping sessions in `state.sessions`.
2. Sleeping sessions are serialized with their saved `cwd`, `title`, `cols`, and `rows`.
3. `cleanupStaleScrollbacks(validSessionIds)` receives all known session IDs (both running and sleeping), ensuring inactive scrollback cache files are **not** purged while asleep.

---

### 5. Closing & Modifying Sleeping Tabs

- **Closing a Tab (`closeTab(tabId)`)**:
  - If closing an `isSleeping` tab, skip backend `ptyKill` (no active PTY process was spawned).
  - Remove sleeping session entries from `state.sessions` and call `deleteScrollback(id)` to clean up cached files.
- **Closing a Pane (`closePane(path)`)**:
  - If the leaf session is `"sleeping"`, remove it from `state.sessions` and clean up scrollback without calling `killSession()`.
- **Renaming / Reordering**:
  - Functions normally without requiring session wake.

---

## Error Handling & Edge Cases

1. **Missing or Corrupted Sleeping Session State**:
   - If a sleeping session fails to spawn during `wakeTab()`, `spawnSession()` catches the error and marks that session as `status: "error"`, rendering the standard pane error banner with retry options.
2. **Rapid Tab Switching (Race Condition Guard)**:
   - If the user quickly clicks between multiple sleeping tabs, each tab wakes up independently and idempotently. `startedRef` or a wake lock prevents double-spawning the same session.
3. **Single Tab Mode (No Inactive Tabs)**:
   - If only 1 tab exists, behavior is identical to normal boot.

---

## Verification Plan

### Automated Unit Tests
- `src/store/terminalStore.test.ts`:
  1. `loadLayout`: verify multi-tab restore only calls `spawnSession` for active tab; inactive tabs get `isSleeping: true` and sessions get `status: "sleeping"`.
  2. `wakeTab`: verify calling `selectTab` or `wakeTab` on sleeping tab calls `spawnSession`, restores scrollback, and transitions session to `status: "running"`.
  3. `saveLayout`: verify saving state with sleeping tabs preserves all tab and session metadata.
  4. `closeTab`: verify closing a sleeping tab deletes scrollback and updates store without invoking `ptyKill`.

### Full Test Suite
- Run `pnpm vitest run`.
- Run `cargo test -p oppa --lib` and `cargo test -p oppa --test daemon_integration_test`.
- Run `pnpm build` (tsc + vite) and `cargo check`.
