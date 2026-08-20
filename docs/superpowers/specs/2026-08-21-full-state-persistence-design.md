# Design Spec: Full UI and Window State Persistence

## Overview

When the user exits and relaunches OPPA, the app should restore its complete visual and operational state exactly where it was left off. This includes:
1. **Window State**: Window dimensions (`width`, `height`), position (`x`, `y`), and whether the window was maximized (`isMaximized`) or fullscreen (`isFullscreen`).
2. **Sidebar States**:
   - Left sidebar open/collapsed status and width.
   - Right sidebar open/collapsed status, width, and active tab (`explorer` vs. `git`).
3. **App View & Pane State**:
   - Active app mode (`terminal`, `editor`, `browser`).
   - Maximized terminal pane (`maximizedSessionId`).
   - Open editor tabs, active file path, and editor view mode.
   - Embedded browser URL and device preset.
4. **Settings Alignment**:
   - Update `appearance.sidebarOnLaunch` to include `"remember_last"` as the default setting, alongside `"open"` and `"collapsed"`.

---

## Architecture & Data Flow

### 1. Window State Persistence
- **Storage**: In `layout.json` under a top-level `window` key (e.g. `{ width, height, x, y, isMaximized }`).
- **Save Trigger**:
  - Saved during the close handshake via `app:before-close` and `beforeunload`.
  - Also queried directly from Tauri's webview window (`getCurrentWebviewWindow()`) before serializing `layout.json`.
- **Restore Trigger**:
  - During app startup in `App.tsx` / Tauri initialization:
    - If `window.isMaximized` is true, call `window.maximize()`.
    - Else if `width` and `height` are present and valid, call `window.setSize()` and `window.setPosition()` with screen boundary checks.

### 2. Layout Snapshot Extension (`terminalStore.ts`)
The `saveLayout()` snapshot payload is extended to include:
```json
{
  "version": 2,
  "window": {
    "width": 1280,
    "height": 800,
    "x": 100,
    "y": 100,
    "isMaximized": true
  },
  "ui": {
    "leftSidebarOpen": true,
    "leftSidebarWidth": 240,
    "rightSidebarOpen": true,
    "rightSidebarWidth": 280,
    "rightSidebarTab": "explorer",
    "activeAppMode": "terminal",
    "maximizedSessionId": null,
    "editorTabs": [],
    "activeEditorPath": null,
    "editorViewMode": "edit",
    "browserUrl": "",
    "devicePreset": "responsive"
  },
  "tabs": [...],
  "activeTabId": "tab-1",
  "sessions": [...]
}
```

### 3. Settings Evolution
- Add `"remember_last"` to `SidebarLaunchMode`:
  ```ts
  export type SidebarLaunchMode = "remember_last" | "open" | "collapsed";
  ```
- Default `DEFAULT_APPEARANCE_SETTINGS.sidebarOnLaunch` is `"remember_last"`.
- On launch in `App.tsx`:
  - If `sidebarOnLaunch === "collapsed"`, force `leftSidebarOpen: false`.
  - If `sidebarOnLaunch === "open"`, force `leftSidebarOpen: true`.
  - If `sidebarOnLaunch === "remember_last"`, keep the restored `leftSidebarOpen` state from `layout.json`.

---

## Error Handling & Edge Cases

1. **Missing or Legacy `layout.json` (Backward Compatibility)**:
   - If `window` or `ui` is missing in `layout.json`, fall back gracefully to default window dimensions and store defaults without throwing.
2. **Disconnected Displays (Offscreen Coordinates)**:
   - If saved `x` and `y` place the window off-screen on startup, fallback to centered or default placement.
3. **Headless / Unit Test Environment**:
   - When running in browser tests / vitest where Tauri window APIs are unavailable or mocked, gracefully skip native window resizing/maximizing.

---

## Verification Plan

1. **Unit & Store Tests**:
   - Test `terminalStore.saveLayout` and `loadLayout` for the new `ui` and `window` properties.
   - Test `sidebarOnLaunch` behavior for `"remember_last"`, `"open"`, and `"collapsed"`.
2. **Settings Component Tests**:
   - Update `AppearanceSettingsPane.test.tsx` to verify `"remember_last"` segmented button option.
3. **End-to-End Persistence Check**:
   - Verify layout save and load roundtrip with left + right sidebars open, custom widths, and maximized window.
