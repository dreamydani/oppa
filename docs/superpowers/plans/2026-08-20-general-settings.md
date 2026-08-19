# OPPA Settings Framework & Group 1 (General Settings) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a robust, persistent settings foundation for OPPA with a full-page 2-column Settings view, left sidebar footer access buttons, and 100% functional Group 1 (General Settings).

**Architecture:** Rust backend persistence (`settings.json` via Tauri commands), TypeScript transport layer (`src/lib/settings/`), Zustand store state slice in `terminalStore.ts`, left sidebar footer triggers (`LeftSidebar.tsx`), and a full-page Settings view (`SettingsView.tsx` + `SettingsSidebar.tsx` + `GeneralSettingsPane.tsx` + `ShortcutsSettingsPane.tsx`) with live consumers across tabs, editor, browser, and window lifecycle.

**Tech Stack:** Tauri 2 (Rust), React 19, TypeScript, Vite, Zustand, Lucide Icons, Vitest, `@testing-library/react`.

## Global Constraints

- Never hardcode paths or platform checks; use cross-platform helpers (Meta on Mac, Ctrl on Win/Linux).
- Concise comments explaining WHY, not HOW.
- TDD: Write the failing test first, verify failure, implement, verify pass.
- All settings in Group 1 MUST be 100% functional (no dead buttons or placeholder controls).

---

### Task 1: Rust Backend Settings Persistence (`src-tauri/src/settings.rs`)

**Files:**
- Create: `src-tauri/src/settings.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/settings.rs` (inline unit tests)

**Interfaces:**
- Consumes: `tauri::{AppHandle, Manager}`
- Produces: `save_settings_at(path: &Path, json: &str) -> std::io::Result<()>`, `load_settings_at(path: &Path) -> std::io::Result<Option<String>>`, `save_settings(app: AppHandle, settings_json: String) -> Result<(), String>`, `load_settings(app: AppHandle) -> Result<Option<String>, String>`

- [ ] **Step 1: Write the failing Rust tests for settings serialization & load/save**

```rust
// In src-tauri/src/settings.rs
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("oppa-settings-{name}-{}", std::process::id()))
    }

    #[test]
    fn settings_json_round_trips_through_file() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("settings.json");
        let json = r#"{"general":{"default_cwd_mode":"home","custom_default_cwd":"","startup_behavior":"restore_previous","tab_switch_mode":"sequential","confirm_close_tab_with_multiple_panes":true,"confirm_quit_with_running_processes":true,"editor_word_wrap":true,"editor_auto_save_delay":1000,"browser_search_engine":"duckduckgo","browser_home_page":"https://duckduckgo.com"}}"#;

        save_settings_at(&path, json).unwrap();
        assert_eq!(load_settings_at(&path).unwrap().as_deref(), Some(json));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_settings_returns_none_when_file_does_not_exist() {
        let dir = temp_dir("nonexistent");
        let path = dir.join("settings.json");
        assert_eq!(load_settings_at(&path).unwrap(), None);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p oppa --lib settings` in `src-tauri`  
Expected: FAIL (file or functions not found)

- [ ] **Step 3: Implement `src-tauri/src/settings.rs` and register in `src-tauri/src/lib.rs`**

```rust
// src-tauri/src/settings.rs
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct GeneralSettings {
    pub default_cwd_mode: String,
    pub custom_default_cwd: String,
    pub startup_behavior: String,
    pub tab_switch_mode: String,
    pub confirm_close_tab_with_multiple_panes: bool,
    pub confirm_quit_with_running_processes: bool,
    pub editor_word_wrap: bool,
    pub editor_auto_save_delay: u64,
    pub browser_search_engine: String,
    pub browser_home_page: String,
}

impl Default for GeneralSettings {
    fn default() -> Self {
        Self {
            default_cwd_mode: "home".into(),
            custom_default_cwd: String::new(),
            startup_behavior: "restore_previous".into(),
            tab_switch_mode: "sequential".into(),
            confirm_close_tab_with_multiple_panes: true,
            confirm_quit_with_running_processes: true,
            editor_word_wrap: true,
            editor_auto_save_delay: 1000,
            browser_search_engine: "duckduckgo".into(),
            browser_home_page: "https://duckduckgo.com".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct AppSettings {
    pub general: GeneralSettings,
}

pub fn save_settings_at(path: &Path, json: &str) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, json)
}

pub fn load_settings_at(path: &Path) -> std::io::Result<Option<String>> {
    if path.exists() {
        std::fs::read_to_string(path).map(Some)
    } else {
        Ok(None)
    }
}

fn settings_path(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap().join("settings.json")
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings_json: String) -> Result<(), String> {
    save_settings_at(&settings_path(&app), &settings_json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_settings(app: AppHandle) -> Result<Option<String>, String> {
    load_settings_at(&settings_path(&app)).map_err(|e| e.to_string())
}
```

- [ ] **Step 4: Run cargo test to verify it passes**

Run: `cargo test -p oppa --lib settings` in `src-tauri`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/settings.rs src-tauri/src/lib.rs
git commit -m "feat: add rust settings persistence backend"
```

---

### Task 2: Frontend Settings Types & Transport Layer (`src/lib/settings/`)

**Files:**
- Create: `src/lib/settings/types.ts`
- Create: `src/lib/settings/transport.ts`
- Test: `src/lib/settings/transport.test.ts`

**Interfaces:**
- Consumes: `@tauri-apps/api/core` `invoke`
- Produces: `saveSettings(settings: AppSettings): Promise<void>`, `loadSettings(): Promise<AppSettings | null>`, `DEFAULT_APP_SETTINGS`

- [ ] **Step 1: Write the failing Vitest test for settings transport**

```typescript
// src/lib/settings/transport.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { saveSettings, loadSettings } from "./transport";
import { DEFAULT_APP_SETTINGS } from "./types";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("settings transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls save_settings with serialized JSON", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(undefined);
    await saveSettings(DEFAULT_APP_SETTINGS);
    expect(invoke).toHaveBeenCalledWith("save_settings", {
      settingsJson: JSON.stringify(DEFAULT_APP_SETTINGS),
    });
  });

  it("calls load_settings and parses JSON", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(JSON.stringify(DEFAULT_APP_SETTINGS));
    const result = await loadSettings();
    expect(invoke).toHaveBeenCalledWith("load_settings");
    expect(result).toEqual(DEFAULT_APP_SETTINGS);
  });

  it("returns null if load_settings returns null", async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null);
    const result = await loadSettings();
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/settings/transport.test.ts`  
Expected: FAIL (modules not found)

- [ ] **Step 3: Implement `types.ts` and `transport.ts`**

```typescript
// src/lib/settings/types.ts
export type DefaultCwdMode = "home" | "last_active" | "custom";
export type StartupBehavior = "restore_previous" | "workspace_launcher" | "fresh_terminal";
export type TabSwitchMode = "sequential" | "mru";
export type BrowserSearchEngine = "duckduckgo" | "google" | "bing";
export type SettingsTabId = "general" | "appearance" | "terminal" | "shortcuts";

export interface GeneralSettings {
  defaultCwdMode: DefaultCwdMode;
  customDefaultCwd: string;
  startupBehavior: StartupBehavior;
  tabSwitchMode: TabSwitchMode;
  confirmCloseTabWithMultiplePanes: boolean;
  confirmQuitWithRunningProcesses: boolean;
  editorWordWrap: boolean;
  editorAutoSaveDelay: number;
  browserSearchEngine: BrowserSearchEngine;
  browserHomePage: string;
}

export interface AppSettings {
  general: GeneralSettings;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  general: {
    defaultCwdMode: "home",
    customDefaultCwd: "",
    startupBehavior: "restore_previous",
    tabSwitchMode: "sequential",
    confirmCloseTabWithMultiplePanes: true,
    confirmQuitWithRunningProcesses: true,
    editorWordWrap: true,
    editorAutoSaveDelay: 1000,
    browserSearchEngine: "duckduckgo",
    browserHomePage: "https://duckduckgo.com",
  },
};
```

```typescript
// src/lib/settings/transport.ts
import { invoke } from "@tauri-apps/api/core";
import { AppSettings, DEFAULT_APP_SETTINGS } from "./types";

export async function saveSettings(settings: AppSettings): Promise<void> {
  await invoke("save_settings", {
    settingsJson: JSON.stringify(settings),
  });
}

export async function loadSettings(): Promise<AppSettings | null> {
  const raw = await invoke<string | null>("load_settings");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return {
      general: {
        ...DEFAULT_APP_SETTINGS.general,
        ...(parsed.general || {}),
      },
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/settings/transport.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/settings/types.ts src/lib/settings/transport.ts src/lib/settings/transport.test.ts
git commit -m "feat: add settings transport and types"
```

---

### Task 3: Zustand Store Settings Slice & Live Integrations (`src/store/terminalStore.ts`)

**Files:**
- Modify: `src/store/terminalStore.ts`
- Test: `src/store/terminalStore.test.ts`

**Interfaces:**
- Consumes: `src/lib/settings/transport.ts`, `src/lib/settings/types.ts`
- Produces: `settings: AppSettings`, `isSettingsOpen: boolean`, `activeSettingsTab: SettingsTabId`, `openSettings(tab?: SettingsTabId)`, `closeSettings()`, `updateSettings(partial: Partial<AppSettings>)`, `resolveDefaultCwd(): string | undefined`, `tabFocusHistory: string[]`

- [ ] **Step 1: Write the failing store tests for settings mutations and live behavior**

```typescript
// In src/store/terminalStore.test.ts
it("initializes with default settings and updates settings", async () => {
  const store = useTerminalStore.getState();
  expect(store.settings.general.defaultCwdMode).toBe("home");
  expect(store.isSettingsOpen).toBe(false);

  store.openSettings("shortcuts");
  expect(useTerminalStore.getState().isSettingsOpen).toBe(true);
  expect(useTerminalStore.getState().activeSettingsTab).toBe("shortcuts");

  store.closeSettings();
  expect(useTerminalStore.getState().isSettingsOpen).toBe(false);

  store.updateSettings({
    general: {
      ...store.settings.general,
      defaultCwdMode: "last_active",
    },
  });
  expect(useTerminalStore.getState().settings.general.defaultCwdMode).toBe("last_active");
});

it("resolves default CWD correctly based on settings", () => {
  const store = useTerminalStore.getState();
  // Home mode -> undefined (system default)
  expect(store.resolveDefaultCwd()).toBeUndefined();

  // Custom mode
  store.updateSettings({
    general: {
      ...store.settings.general,
      defaultCwdMode: "custom",
      customDefaultCwd: "D:\\custom\\project",
    },
  });
  expect(store.resolveDefaultCwd()).toBe("D:\\custom\\project");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/store/terminalStore.test.ts`  
Expected: FAIL (properties not on store)

- [ ] **Step 3: Update `src/store/terminalStore.ts` to include settings slice, auto-persistence, CWD resolution, and tab history**

Implement:
1. `settings: AppSettings` initialized to `DEFAULT_APP_SETTINGS`.
2. `isSettingsOpen: boolean`, `activeSettingsTab: SettingsTabId`.
3. `openSettings`, `closeSettings`, `updateSettings` (with debounced `saveSettings`).
4. `loadSettingsData` in store bootstrap.
5. `resolveDefaultCwd()` helper used in `createTab` and `spawnSession`.
6. Track `tabFocusHistory` in `selectTab`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/store/terminalStore.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/terminalStore.ts src/store/terminalStore.test.ts
git commit -m "feat: add settings slice and CWD resolution to terminalStore"
```

---

### Task 4: Left Sidebar Footer with Settings & Shortcuts Trigger Buttons

**Files:**
- Modify: `src/components/LeftSidebar.tsx`
- Modify: `src/components/LeftSidebar.css`
- Modify: `src/components/icons/MinimalIcons.tsx` (ensure `HelpIcon` / `SettingsIcon` exported)
- Test: `src/components/LeftSidebar.test.tsx`

**Interfaces:**
- Consumes: `useTerminalStore((s) => s.openSettings)`
- Produces: `.left-sidebar-footer` containing `<button className="sidebar-footer-btn settings" onClick={() => openSettings("general")}>` and `<button className="sidebar-footer-btn shortcuts" onClick={() => openSettings("shortcuts")}>`

- [ ] **Step 1: Write the failing test for sidebar footer buttons**

```typescript
// In src/components/LeftSidebar.test.tsx
it("renders settings and shortcuts buttons in sidebar footer and triggers openSettings", () => {
  render(<LeftSidebar />);
  const settingsBtn = screen.getByRole("button", { name: /settings/i });
  const shortcutsBtn = screen.getByRole("button", { name: /keyboard shortcuts/i });

  expect(settingsBtn).toBeInTheDocument();
  expect(shortcutsBtn).toBeInTheDocument();

  fireEvent.click(settingsBtn);
  expect(useTerminalStore.getState().isSettingsOpen).toBe(true);
  expect(useTerminalStore.getState().activeSettingsTab).toBe("general");

  fireEvent.click(shortcutsBtn);
  expect(useTerminalStore.getState().activeSettingsTab).toBe("shortcuts");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/LeftSidebar.test.tsx`  
Expected: FAIL

- [ ] **Step 3: Implement sidebar footer in `LeftSidebar.tsx` and styles in `LeftSidebar.css`**

Add `.left-sidebar-footer` with styled claymorphic action buttons at the bottom of the sidebar.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/LeftSidebar.test.tsx`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/LeftSidebar.tsx src/components/LeftSidebar.css src/components/LeftSidebar.test.tsx src/components/icons/MinimalIcons.tsx
git commit -m "feat: add settings and shortcuts footer buttons to left sidebar"
```

---

### Task 5: Settings Sidebar & Navigation (`src/components/settings/SettingsSidebar.tsx`)

**Files:**
- Create: `src/components/settings/SettingsSidebar.tsx`
- Create: `src/components/settings/SettingsSidebar.css`
- Test: `src/components/settings/SettingsSidebar.test.tsx`

**Interfaces:**
- Consumes: `useTerminalStore((s) => s.activeSettingsTab)`, `useTerminalStore((s) => s.openSettings)`, `useTerminalStore((s) => s.closeSettings)`
- Produces: `SettingsSidebar` React component with `← Back` button and category list (`General`, `Appearance`, `Terminal`, `Shortcuts`).

- [ ] **Step 1: Write failing component test**

```typescript
// src/components/settings/SettingsSidebar.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { SettingsSidebar } from "./SettingsSidebar";
import { useTerminalStore } from "../../store/terminalStore";

describe("SettingsSidebar", () => {
  it("renders back button and category buttons", () => {
    useTerminalStore.setState({ isSettingsOpen: true, activeSettingsTab: "general" });
    render(<SettingsSidebar />);

    const backBtn = screen.getByRole("button", { name: /back/i });
    expect(backBtn).toBeInTheDocument();

    const generalTab = screen.getByRole("button", { name: /general/i });
    const shortcutsTab = screen.getByRole("button", { name: /shortcuts/i });
    expect(generalTab).toBeInTheDocument();
    expect(shortcutsTab).toBeInTheDocument();

    fireEvent.click(shortcutsTab);
    expect(useTerminalStore.getState().activeSettingsTab).toBe("shortcuts");

    fireEvent.click(backBtn);
    expect(useTerminalStore.getState().isSettingsOpen).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/settings/SettingsSidebar.test.tsx`  
Expected: FAIL

- [ ] **Step 3: Implement `SettingsSidebar.tsx` and `SettingsSidebar.css`**

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/settings/SettingsSidebar.test.tsx`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/SettingsSidebar.tsx src/components/settings/SettingsSidebar.css src/components/settings/SettingsSidebar.test.tsx
git commit -m "feat: add settings sidebar navigation component"
```

---

### Task 6: General Settings Pane UI (`src/components/settings/GeneralSettingsPane.tsx`)

**Files:**
- Create: `src/components/settings/GeneralSettingsPane.tsx`
- Create: `src/components/settings/GeneralSettingsPane.css`
- Test: `src/components/settings/GeneralSettingsPane.test.tsx`

**Interfaces:**
- Consumes: `useTerminalStore((s) => s.settings)`, `useTerminalStore((s) => s.updateSettings)`
- Produces: `GeneralSettingsPane` React component with live controls for Default CWD, Startup Behavior, Tab Switch Mode, Safety Prompts, Editor Defaults, and Browser Defaults.

- [ ] **Step 1: Write failing test for GeneralSettingsPane**

```typescript
// src/components/settings/GeneralSettingsPane.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { GeneralSettingsPane } from "./GeneralSettingsPane";
import { useTerminalStore } from "../../store/terminalStore";

describe("GeneralSettingsPane", () => {
  it("updates CWD mode and switch toggles on user interaction", () => {
    render(<GeneralSettingsPane />);

    const lastActiveBtn = screen.getByRole("button", { name: /last active/i });
    fireEvent.click(lastActiveBtn);
    expect(useTerminalStore.getState().settings.general.defaultCwdMode).toBe("last_active");

    const multiPaneToggle = screen.getByLabelText(/confirm before closing multi-pane tabs/i);
    fireEvent.click(multiPaneToggle);
    expect(useTerminalStore.getState().settings.general.confirmCloseTabWithMultiplePanes).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/settings/GeneralSettingsPane.test.tsx`  
Expected: FAIL

- [ ] **Step 3: Implement `GeneralSettingsPane.tsx` and `GeneralSettingsPane.css`**

Implement claymorphic setting cards:
1. **Workspace & Startup**: Segmented CWD mode + Custom path input, Startup behavior segmented control.
2. **Navigation & Confirmations**: Tab switch mode (Sequential / MRU), Confirm multi-pane tab close toggle, Confirm quit with running processes toggle.
3. **Code Editor**: Word wrap switch, Auto-save delay select dropdown.
4. **Web Browser**: Search engine select dropdown, Home page URL input.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/settings/GeneralSettingsPane.test.tsx`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/GeneralSettingsPane.tsx src/components/settings/GeneralSettingsPane.css src/components/settings/GeneralSettingsPane.test.tsx
git commit -m "feat: add general settings pane with live controls"
```

---

### Task 7: Shortcuts Reference Pane UI (`src/components/settings/ShortcutsSettingsPane.tsx`)

**Files:**
- Create: `src/components/settings/ShortcutsSettingsPane.tsx`
- Create: `src/components/settings/ShortcutsSettingsPane.css`
- Test: `src/components/settings/ShortcutsSettingsPane.test.tsx`

**Interfaces:**
- Produces: `ShortcutsSettingsPane` displaying categorized hotkey cards (Tabs, Panes, Sidebars, App Modes, Launcher, Settings) with quick search filter.

- [ ] **Step 1: Write failing test for ShortcutsSettingsPane**

```typescript
// src/components/settings/ShortcutsSettingsPane.test.tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ShortcutsSettingsPane } from "./ShortcutsSettingsPane";

describe("ShortcutsSettingsPane", () => {
  it("renders shortcut categories and filters by query", () => {
    render(<ShortcutsSettingsPane />);
    expect(screen.getByText(/new tab/i)).toBeInTheDocument();
    expect(screen.getByText(/split horizontal/i)).toBeInTheDocument();

    const searchInput = screen.getByPlaceholderText(/search shortcuts/i);
    fireEvent.change(searchInput, { target: { value: "split" } });
    expect(screen.getByText(/split horizontal/i)).toBeInTheDocument();
    expect(screen.queryByText(/new tab/i)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/settings/ShortcutsSettingsPane.test.tsx`  
Expected: FAIL

- [ ] **Step 3: Implement `ShortcutsSettingsPane.tsx` and `ShortcutsSettingsPane.css`**

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/settings/ShortcutsSettingsPane.test.tsx`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/ShortcutsSettingsPane.tsx src/components/settings/ShortcutsSettingsPane.css src/components/settings/ShortcutsSettingsPane.test.tsx
git commit -m "feat: add shortcuts reference settings pane"
```

---

### Task 8: Full-Page Settings View & AppShell/App Integration

**Files:**
- Create: `src/components/settings/SettingsView.tsx`
- Create: `src/components/settings/SettingsView.css`
- Modify: `src/App.tsx`
- Modify: `src/components/TitleBar.tsx`
- Modify: `src/components/editor/CodeEditor.tsx` (apply `wordWrap`)
- Modify: `src/components/browser/BrowserOmnibox.tsx` (apply search engine template)
- Test: `src/components/settings/SettingsView.test.tsx`
- Test: `src/App.test.tsx`

**Interfaces:**
- Consumes: `SettingsSidebar`, `GeneralSettingsPane`, `ShortcutsSettingsPane`, `useTerminalStore`
- Produces: Integrated Full-Page Settings View responsive to <kbd>Cmd/Ctrl + ,</kbd>, <kbd>Esc</kbd>, and footer icons.

- [ ] **Step 1: Write integration tests for settings view rendering and keyboard shortcuts**

```typescript
// src/components/settings/SettingsView.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { SettingsView } from "./SettingsView";
import { useTerminalStore } from "../../store/terminalStore";

describe("SettingsView", () => {
  it("renders active pane based on activeSettingsTab", () => {
    useTerminalStore.setState({ isSettingsOpen: true, activeSettingsTab: "general" });
    const { rerender } = render(<SettingsView />);
    expect(screen.getByText(/workspace & startup/i)).toBeInTheDocument();

    useTerminalStore.setState({ activeSettingsTab: "shortcuts" });
    rerender(<SettingsView />);
    expect(screen.getByPlaceholderText(/search shortcuts/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/settings/SettingsView.test.tsx`  
Expected: FAIL

- [ ] **Step 3: Implement `SettingsView.tsx`, update `App.tsx`, `TitleBar.tsx`, `CodeEditor.tsx`, and `BrowserOmnibox.tsx`**

1. `SettingsView.tsx` coordinates `SettingsSidebar` (on left) and active category pane (on right).
2. `App.tsx` renders `SettingsView` when `isSettingsOpen === true`.
3. `App.tsx` listens for <kbd>Cmd/Ctrl + ,</kbd> to open settings, <kbd>Cmd/Ctrl + /</kbd> or <kbd>F1</kbd> to open shortcuts, and <kbd>Esc</kbd> to close settings.
4. `App.tsx` handles `Ctrl+Tab` with `tabSwitchMode` ("mru" vs "sequential").
5. `TitleBar.tsx` shows "Settings" title when `isSettingsOpen === true`.
6. `CodeEditor.tsx` passes `wordWrap: settings.general.editorWordWrap ? "on" : "off"`.
7. `BrowserOmnibox.tsx` formats queries with `settings.general.browserSearchEngine`.

- [ ] **Step 4: Run all test suites to verify everything passes**

Run: `pnpm vitest run` and `cargo test -p oppa --lib`  
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/SettingsView.tsx src/components/settings/SettingsView.css src/components/settings/SettingsView.test.tsx src/App.tsx src/components/TitleBar.tsx src/components/editor/CodeEditor.tsx src/components/browser/BrowserOmnibox.tsx
git commit -m "feat: complete full-page settings view and live consumers integration"
```
