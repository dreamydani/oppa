# App & UI Appearance Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Group 3 App & UI Appearance Settings — App Theme (Dark/Light/System), App Sans-Serif Font, UI Zoom / Scale (80%-125%), Sidebar/Chrome Controls (Launch State, Status Bar, Titlebar Logo), and a clean section divider separating App & Workbench from Terminal Appearance.

**Architecture:** Rust backend persists App & UI fields in `AppearanceSettings`; TypeScript types & transport layer defensively merge defaults; `App.tsx` applies `data-theme`, `uiZoom`, `--font-sans`, and chrome toggles dynamically; `AppearanceSettingsPane` organizes App Visuals above Terminal Visuals with a clean horizontal divider.

**Tech Stack:** Tauri 2 (Rust), React 19, TypeScript, Vite, CSS Custom Properties, Zustand, Vitest.

## Global Constraints
- Minimalist UI adhering to `minimalist-skill` (`max-width: 680px`, centered layout, bento cards, tactile switches, clean separator line).
- Independent themer: App Theme (Dark/Light/System) must never mutate or overwrite Terminal Pane color themes.
- 100% live reactivity: all controls (theme, zoom, fonts, chrome toggles) immediately reflect without page refreshes or shell restarts.
- Clean TDD workflow for every task.

---

### Task 1: Rust Backend App & UI Appearance Settings Schema & Backward Compatibility

**Files:**
- Modify: `src-tauri/src/settings.rs`

**Interfaces:**
- Updates: `AppearanceSettings` struct in Rust with:
  - `pub app_theme: String` (default: `"dark"`)
  - `pub app_font_family: String` (default: `"'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"`)
  - `pub ui_zoom: f32` (default: `1.0`)
  - `pub sidebar_on_launch: String` (default: `"open"`)
  - `pub show_status_bar: bool` (default: `true`)
  - `pub show_titlebar_logo: bool` (default: `true`)

- [ ] **Step 1: Write failing Rust unit test for App & UI Appearance fields**

In `src-tauri/src/settings.rs`:
```rust
#[test]
fn app_ui_appearance_settings_defaults_and_backward_compatibility() {
    let settings = AppSettings::default();
    assert_eq!(settings.appearance.app_theme, "dark");
    assert_eq!(settings.appearance.ui_zoom, 1.0);
    assert_eq!(settings.appearance.sidebar_on_launch, "open");
    assert!(settings.appearance.show_status_bar);
    assert!(settings.appearance.show_titlebar_logo);

    let legacy_json = r#"{"general":{"default_cwd_mode":"home"},"appearance":{"theme_name":"dracula","font_size":16}}"#;
    let deserialized: AppSettings = serde_json::from_str(legacy_json).unwrap();
    assert_eq!(deserialized.appearance.theme_name, "dracula");
    assert_eq!(deserialized.appearance.app_theme, "dark");
    assert_eq!(deserialized.appearance.ui_zoom, 1.0);
    assert!(deserialized.appearance.show_status_bar);
    assert!(deserialized.appearance.show_titlebar_logo);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p oppa --lib settings` in `src-tauri`  
Expected: Compilation failure because fields do not exist yet.

- [ ] **Step 3: Implement new fields in AppearanceSettings struct**

Update `AppearanceSettings` in `src-tauri/src/settings.rs`:
```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct AppearanceSettings {
    // App & UI Settings
    pub app_theme: String,
    pub app_font_family: String,
    pub ui_zoom: f32,
    pub sidebar_on_launch: String,
    pub show_status_bar: bool,
    pub show_titlebar_logo: bool,

    // Terminal Settings
    pub theme_name: String,
    pub font_family: String,
    pub font_size: u16,
    pub line_height: f32,
    pub cursor_style: String,
    pub cursor_blink: bool,
    pub dim_inactive_panes: bool,
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p oppa --lib settings` in `src-tauri`  
Expected: PASS (6/6 tests passed)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/settings.rs
git commit -m "feat: add app and ui appearance fields to rust settings backend"
```

---

### Task 2: Frontend Types, Transport Defaults, and Store Appearance Slice

**Files:**
- Modify: `src/lib/settings/types.ts`
- Modify: `src/lib/settings/transport.ts`
- Modify: `src/lib/settings/transport.test.ts`
- Modify: `src/store/terminalStore.test.ts`

**Interfaces:**
- Produces:
  - `AppThemeMode`: `"dark" | "light" | "system"`
  - `SidebarLaunchMode`: `"open" | "collapsed"`
  - Updated `AppearanceSettings` and `DEFAULT_APPEARANCE_SETTINGS` in `types.ts`

- [ ] **Step 1: Write failing tests for frontend App & UI settings**

In `src/lib/settings/transport.test.ts`:
```typescript
it("merges appTheme, uiZoom, sidebarOnLaunch, and chrome toggles with defaults", () => {
  const loaded = loadSettingsFromStorage();
  expect(loaded.appearance.appTheme).toBe("dark");
  expect(loaded.appearance.uiZoom).toBe(1.0);
  expect(loaded.appearance.sidebarOnLaunch).toBe("open");
  expect(loaded.appearance.showStatusBar).toBe(true);
  expect(loaded.appearance.showTitlebarLogo).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/settings/transport.test.ts`  
Expected: FAIL

- [ ] **Step 3: Update types.ts and transport.ts**

Update `src/lib/settings/types.ts`:
```typescript
export type AppThemeMode = "dark" | "light" | "system";
export type SidebarLaunchMode = "open" | "collapsed";

export interface AppearanceSettings {
  appTheme: AppThemeMode;
  appFontFamily: string;
  uiZoom: number;
  sidebarOnLaunch: SidebarLaunchMode;
  showStatusBar: boolean;
  showTitlebarLogo: boolean;

  themeName: TerminalThemeId;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  dimInactivePanes: boolean;
}

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  appTheme: "dark",
  appFontFamily: "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  uiZoom: 1.0,
  sidebarOnLaunch: "open",
  showStatusBar: true,
  showTitlebarLogo: true,

  themeName: "oppa_dark",
  fontFamily: "'Geist Mono', 'SF Mono', 'JetBrains Mono', Consolas, monospace",
  fontSize: 14,
  lineHeight: 1.2,
  cursorStyle: "block",
  cursorBlink: true,
  dimInactivePanes: true,
};
```

Update `src/lib/settings/transport.ts` to merge new fields.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/settings/transport.test.ts src/store/terminalStore.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/settings/types.ts src/lib/settings/transport.ts src/lib/settings/transport.test.ts src/store/terminalStore.test.ts
git commit -m "feat: add app and ui appearance types and transport defaults"
```

---

### Task 3: App Theme, UI Zoom, and Font CSS Tokens & Dynamic Runtime Reactivity

**Files:**
- Modify: `src/App.css`
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`

**Interfaces:**
- Dynamically sets `data-theme="dark" | "light"` on `document.documentElement` based on `appearance.appTheme`.
- Listens to `window.matchMedia('(prefers-color-scheme: dark)')` when `appTheme === "system"`.
- Dynamically applies `appearance.uiZoom` to `document.documentElement.style.zoom`.
- Dynamically applies `appearance.appFontFamily` to `--font-sans`.

- [ ] **Step 1: Write failing test in App.test.tsx for theme, zoom, and font reactivity**

In `src/App.test.tsx`:
```typescript
it("updates data-theme, uiZoom, and --font-sans on documentElement when appearance changes", async () => {
  render(<App />);
  act(() => {
    useTerminalStore.getState().updateAppearanceSettings({
      appTheme: "light",
      uiZoom: 1.1,
      appFontFamily: "Inter, sans-serif",
    });
  });

  expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  expect(document.documentElement.style.zoom).toBe("1.1");
  expect(document.documentElement.style.getPropertyValue("--font-sans")).toBe("Inter, sans-serif");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/App.test.tsx`  
Expected: FAIL

- [ ] **Step 3: Implement theme, zoom, and font effect in App.tsx and add light theme tokens in App.css**

In `src/App.css`, define `[data-theme="light"]` variables.  
In `src/App.tsx`, add a reactive `useEffect` applying `data-theme`, `zoom`, `--font-sans`, and system media query listener.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/App.test.tsx`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/App.css src/App.tsx src/App.test.tsx
git commit -m "feat: connect app theme, ui zoom, and font family runtime reactivity"
```

---

### Task 4: Chrome Controls Live Reactivity (TitleBar Logo, StatusBar, and Sidebar Launch)

**Files:**
- Modify: `src/components/TitleBar.tsx`
- Modify: `src/components/TitleBar.test.tsx`
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`

**Interfaces:**
- In `TitleBar.tsx`: conditionally render `<span className="app-brand-title">oppa</span>` based on `appearance.showTitlebarLogo`.
- In `App.tsx`: conditionally render `<StatusBar />` based on `appearance.showStatusBar`.
- In `App.tsx` / `loadLayout`: initial sidebar state respects `appearance.sidebarOnLaunch`.

- [ ] **Step 1: Write failing tests in TitleBar.test.tsx and App.test.tsx**

Verify that `oppa` logo hides when `showTitlebarLogo: false`, and `StatusBar` hides when `showStatusBar: false`.

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest run src/components/TitleBar.test.tsx src/App.test.tsx`  
Expected: FAIL

- [ ] **Step 3: Implement chrome visibility in TitleBar.tsx and App.tsx**

Update `TitleBar.tsx` to read `appearance.showTitlebarLogo`.  
Update `App.tsx` to read `appearance.showStatusBar` and `appearance.sidebarOnLaunch`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/components/TitleBar.test.tsx src/App.test.tsx`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/TitleBar.tsx src/components/TitleBar.test.tsx src/App.tsx src/App.test.tsx
git commit -m "feat: wire showTitlebarLogo and showStatusBar chrome controls"
```

---

### Task 5: Appearance Settings Pane UI with App & Workbench Section and Divider

**Files:**
- Modify: `src/components/settings/AppearanceSettingsPane.tsx`
- Modify: `src/components/settings/AppearanceSettingsPane.css`
- Modify: `src/components/settings/AppearanceSettingsPane.test.tsx`

**Interfaces:**
- Renders **App & Workbench** section at top:
  - App Theme segmented control (`Dark 🌙`, `Light ☀️`, `System 💻`)
  - UI Zoom segmented buttons (`80%`, `90%`, `100%`, `110%`, `125%`)
  - App UI Font preset dropdown + custom input
  - Sidebar on Launch segmented control (`Open`, `Collapsed`)
  - Status Bar visibility toggle switch
  - Titlebar Logo visibility toggle switch
- Renders **Section Divider (`<hr className="settings-section-divider" />`)**.
- Renders **Terminal** section below with existing preview box and terminal settings.

- [ ] **Step 1: Write failing tests in AppearanceSettingsPane.test.tsx**

In `src/components/settings/AppearanceSettingsPane.test.tsx`:
```typescript
it("renders App & Workbench section, section divider, and updates appTheme and uiZoom", () => {
  render(<AppearanceSettingsPane />);
  expect(screen.getByText("App & Workbench")).toBeInTheDocument();
  expect(screen.getByTestId("appearance-section-divider")).toBeInTheDocument();

  const lightThemeBtn = screen.getByRole("button", { name: /light/i });
  fireEvent.click(lightThemeBtn);
  expect(useTerminalStore.getState().settings.appearance.appTheme).toBe("light");

  const zoom110Btn = screen.getByRole("button", { name: /110%/i });
  fireEvent.click(zoom110Btn);
  expect(useTerminalStore.getState().settings.appearance.uiZoom).toBe(1.1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/settings/AppearanceSettingsPane.test.tsx`  
Expected: FAIL

- [ ] **Step 3: Implement App & Workbench UI section and Divider in AppearanceSettingsPane.tsx**

Update `AppearanceSettingsPane.tsx` and `AppearanceSettingsPane.css`.

- [ ] **Step 4: Run all frontend and backend tests**

Run: `cargo test -p oppa --lib` and `pnpm vitest run`  
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/AppearanceSettingsPane.tsx src/components/settings/AppearanceSettingsPane.css src/components/settings/AppearanceSettingsPane.test.tsx
git commit -m "feat: add app and workbench appearance section with horizontal divider"
```
