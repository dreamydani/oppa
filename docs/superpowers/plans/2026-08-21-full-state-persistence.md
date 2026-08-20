# Full UI and Window State Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist full window state (size, position, maximized flag) and UI view state (left & right sidebars, widths, active tabs, modes, editor tabs, maximized pane) so reopening OPPA perfectly restores the previous session.

**Architecture:** Extend layout persistence schema (`layout.json`) with top-level `window` and `ui` structures. Create a window management transport helper interfacing with Tauri `getCurrentWebviewWindow()` for window geometry/maximize persistence, and wire `saveLayout` / `loadLayout` in `terminalStore` and `App.tsx`. Update `SidebarLaunchMode` to include `"remember_last"` as default.

**Tech Stack:** Tauri 2 (Rust backend + `@tauri-apps/api/window`), TypeScript, Zustand (`terminalStore`), React 19, Vitest.

## Global Constraints

- Never drop output or break warm reattachment compatibility.
- Backward compatibility: older `layout.json` without `window` or `ui` properties must load cleanly without throwing.
- Platform safety: wrap all Tauri window calls (`getCurrentWebviewWindow()`) in try/catch or helper guards so tests and headless environments run without error.
- Concise comments explaining WHY not HOW.

---

### Task 1: Add Window Transport Helper and Types

**Files:**
- Create: `src/lib/window/transport.ts`
- Test: `src/lib/window/transport.test.ts`
- Modify: `src/lib/settings/types.ts:22-28`

**Interfaces:**
- Consumes: `@tauri-apps/api/window` (`getCurrentWebviewWindow`, `PhysicalPosition`, `PhysicalSize`)
- Produces: `WindowState` interface, `getSavedWindowState(): Promise<WindowState | null>`, `applyWindowState(state: WindowState): Promise<void>`, updated `SidebarLaunchMode` type with `"remember_last"`.

- [ ] **Step 1: Write the failing test for window transport**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getSavedWindowState, applyWindowState } from "./transport";
import type { WindowState } from "./transport";

describe("window transport", () => {
  it("extracts window state safely", async () => {
    const state = await getSavedWindowState();
    expect(state).toBeDefined();
  });

  it("applies window state when maximized", async () => {
    const state: WindowState = {
      width: 1200,
      height: 800,
      x: 100,
      y: 100,
      isMaximized: true,
    };
    await expect(applyWindowState(state)).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/window/transport.test.ts`
Expected: FAIL (cannot find module)

- [ ] **Step 3: Implement window transport & update settings types**

In `src/lib/settings/types.ts`:
Update `SidebarLaunchMode` to:
```ts
export type SidebarLaunchMode = "remember_last" | "open" | "collapsed";
```
and `DEFAULT_APPEARANCE_SETTINGS.sidebarOnLaunch = "remember_last"`.

Create `src/lib/window/transport.ts`:
```ts
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";

export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  isMaximized: boolean;
}

export async function getSavedWindowState(): Promise<WindowState | null> {
  try {
    const win = getCurrentWebviewWindow();
    const isMaximized = await win.isMaximized();
    const size = await win.innerSize();
    const pos = await win.outerPosition();
    return {
      width: size.width,
      height: size.height,
      x: pos.x,
      y: pos.y,
      isMaximized,
    };
  } catch {
    return null;
  }
}

export async function applyWindowState(state: WindowState): Promise<void> {
  try {
    const win = getCurrentWebviewWindow();
    if (state.isMaximized) {
      await win.maximize();
      return;
    }
    if (state.width > 0 && state.height > 0) {
      await win.setSize(new PhysicalSize(state.width, state.height));
    }
    if (typeof state.x === "number" && typeof state.y === "number") {
      // Don't position completely offscreen (negative or huge coordinates)
      if (state.x >= 0 && state.y >= 0) {
        await win.setPosition(new PhysicalPosition(state.x, state.y));
      }
    }
  } catch {
    // Non-Tauri / test environments
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/window/transport.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/window/transport.ts src/lib/window/transport.test.ts src/lib/settings/types.ts
git commit -m "feat: add window state transport and remember_last sidebar setting"
```

---

### Task 2: Extend Layout Snapshot and Store State Persistence

**Files:**
- Modify: `src/store/terminalStore.ts:1120-1335`
- Test: `src/store/terminalStore.test.ts`

**Interfaces:**
- Consumes: `getSavedWindowState` from `src/lib/window/transport`
- Produces: `saveLayout()` saving `ui` and `window` objects, `loadLayout()` restoring `ui` fields (`leftSidebarOpen`, `leftSidebarWidth`, `rightSidebarOpen`, `rightSidebarWidth`, `rightSidebarTab`, `activeAppMode`, `maximizedSessionId`, `editorTabs`, `activeEditorPath`, `editorViewMode`, `browserUrl`, `devicePreset`).

- [ ] **Step 1: Write the failing tests for layout save and load with UI/window state**

In `src/store/terminalStore.test.ts`, add test cases:
```ts
it("persists and restores UI sidebar, app mode, and maximized pane state", async () => {
  useTerminalStore.setState({
    leftSidebarOpen: true,
    leftSidebarWidth: 310,
    rightSidebarOpen: true,
    rightSidebarWidth: 350,
    rightSidebarTab: "git",
    activeAppMode: "editor",
    maximizedSessionId: "sess-1",
  });

  await useTerminalStore.getState().saveLayout();
  expect(saveLayoutMock).toHaveBeenCalled();
  const savedJson = JSON.parse(saveLayoutMock.mock.calls[0][0]);
  expect(savedJson.ui).toEqual(
    expect.objectContaining({
      leftSidebarOpen: true,
      leftSidebarWidth: 310,
      rightSidebarOpen: true,
      rightSidebarWidth: 350,
      rightSidebarTab: "git",
      activeAppMode: "editor",
      maximizedSessionId: "sess-1",
    })
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/store/terminalStore.test.ts -t "persists and restores UI sidebar"`
Expected: FAIL

- [ ] **Step 3: Update saveLayout and loadLayout in terminalStore.ts**

In `src/store/terminalStore.ts`:
1. In `saveLayout`:
   Include `window` (from `await getSavedWindowState()`) and `ui` state:
   ```ts
   const {
     activeTabId,
     sessions,
     serializers,
     cachedScrollbacks,
     leftSidebarOpen,
     leftSidebarWidth,
     rightSidebarOpen,
     rightSidebarWidth,
     rightSidebarTab,
     activeAppMode,
     maximizedSessionId,
     editorTabs,
     activeEditorPath,
     editorViewMode,
     browserUrl,
     devicePreset,
   } = get();
   const windowState = await getSavedWindowState();
   const snapshot = {
     version: 2,
     ...(windowState ? { window: windowState } : {}),
     ui: {
       leftSidebarOpen,
       leftSidebarWidth,
       rightSidebarOpen,
       rightSidebarWidth,
       rightSidebarTab,
       activeAppMode,
       maximizedSessionId,
       editorTabs,
       activeEditorPath,
       editorViewMode,
       browserUrl,
       devicePreset,
     },
     tabs: currentTabs.map(...),
     activeTabId: activeTabId || currentTabs[0]?.id || "tab-1",
     sessions: Object.values(sessions).map(...),
   };
   ```

2. In `loadLayout`:
   Restore the `ui` object into state:
   ```ts
   if (parsed.ui) {
     set((state) => ({
       leftSidebarOpen: parsed.ui!.leftSidebarOpen ?? state.leftSidebarOpen,
       leftSidebarWidth: parsed.ui!.leftSidebarWidth ?? state.leftSidebarWidth,
       rightSidebarOpen: parsed.ui!.rightSidebarOpen ?? state.rightSidebarOpen,
       rightSidebarWidth: parsed.ui!.rightSidebarWidth ?? state.rightSidebarWidth,
       rightSidebarTab: parsed.ui!.rightSidebarTab ?? state.rightSidebarTab,
       activeAppMode: parsed.ui!.activeAppMode ?? state.activeAppMode,
       maximizedSessionId: parsed.ui!.maximizedSessionId ?? state.maximizedSessionId,
       editorTabs: parsed.ui!.editorTabs ?? state.editorTabs,
       activeEditorPath: parsed.ui!.activeEditorPath ?? state.activeEditorPath,
       editorViewMode: parsed.ui!.editorViewMode ?? state.editorViewMode,
       browserUrl: parsed.ui!.browserUrl ?? state.browserUrl,
       devicePreset: parsed.ui!.devicePreset ?? state.devicePreset,
     }));
   }
   if (parsed.window) {
     void applyWindowState(parsed.window);
   }
   ```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/store/terminalStore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/terminalStore.ts src/store/terminalStore.test.ts
git commit -m "feat: persist and restore full UI and window state in layout snapshot"
```

---

### Task 3: Integrate Window & Sidebar Launch in App.tsx & Settings

**Files:**
- Modify: `src/App.tsx:100-130`
- Modify: `src/components/settings/AppearanceSettingsPane.tsx`
- Test: `src/App.test.tsx`
- Test: `src/components/settings/AppearanceSettingsPane.test.tsx`

**Interfaces:**
- Consumes: `terminalStore`, `SidebarLaunchMode`
- Produces: Seamless launch sequence in `App.tsx` respecting `"remember_last"`, `"open"`, and `"collapsed"`, plus UI controls in settings for the 3 options.

- [ ] **Step 1: Write failing tests for App.tsx startup behavior and AppearanceSettingsPane**

In `src/App.test.tsx`:
Test that when `sidebarOnLaunch === "remember_last"`, `leftSidebarOpen` retains its loaded value (true or false).

In `src/components/settings/AppearanceSettingsPane.test.tsx`:
Add test for `"remember_last"` segmented button option.

- [ ] **Step 2: Run tests to verify failures**

Run: `pnpm vitest run src/components/settings/AppearanceSettingsPane.test.tsx`
Expected: FAIL (missing "remember_last" test case or button)

- [ ] **Step 3: Implement the App.tsx startup logic and AppearanceSettingsPane UI**

In `src/App.tsx`:
```ts
const currentSettings = useTerminalStore.getState().settings;
if (currentSettings.appearance.sidebarOnLaunch === "collapsed") {
  useTerminalStore.setState({ leftSidebarOpen: false });
} else if (currentSettings.appearance.sidebarOnLaunch === "open") {
  useTerminalStore.setState({ leftSidebarOpen: true });
}
// If "remember_last", we leave the restored state untouched.
```

In `src/components/settings/AppearanceSettingsPane.tsx`:
Add `"remember_last"` to the segmented button controls for `sidebarOnLaunch` ("Remember Last", "Open", "Collapsed").

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/App.test.tsx src/components/settings/AppearanceSettingsPane.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/App.test.tsx src/components/settings/AppearanceSettingsPane.tsx src/components/settings/AppearanceSettingsPane.test.tsx
git commit -m "feat: respect remember_last sidebar launch mode in App and Settings"
```

---

### Task 4: Full Suite Verification & Build Check

**Files:**
- Test all: Rust tests and Frontend tests

- [ ] **Step 1: Run all vitest tests**

Run: `pnpm vitest run`
Expected: All tests PASS.

- [ ] **Step 2: Run Rust tests and cargo check**

Run: `cargo check` and `cargo test -p oppa --lib` in `src-tauri`
Expected: PASS.

- [ ] **Step 3: Run full frontend build**

Run: `pnpm build`
Expected: Clean build without errors.

- [ ] **Step 4: Commit**

```bash
git commit --allow-empty -m "chore: verify full test suite passes for full state persistence"
```
