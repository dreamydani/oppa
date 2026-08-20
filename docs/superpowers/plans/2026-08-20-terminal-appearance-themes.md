# Terminal Appearance & Theme Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Group 2 Appearance Settings — full terminal theme catalog (11 themes), typography controls (font family, size, line height), cursor style/blinking, real-time live preview box, and live terminal pane reactivity without restarting processes.

**Architecture:** Rust backend persists `AppearanceSettings` in `settings.json`; frontend `terminalThemes.ts` provides complete xterm-compatible color tokens for 11 themes; Zustand store exposes reactive getters/actions; `TerminalPane` subscribes to appearance state and dynamically updates `term.options` in real-time.

**Tech Stack:** Tauri 2 (Rust), React 19, TypeScript, Vite, xterm.js `@xterm/xterm`, Zustand, Vitest.

## Global Constraints
- Minimalist UI adhering to `minimalist-skill` (centered layout `max-width: 680px`, bento cards, tactile controls, no clunky drop shadows).
- Zero shell restarts or scrollback loss when adjusting appearance settings.
- All 11 themes must supply complete, valid hex color tokens for standard/bright ANSI colors and terminal UI elements.
- Clean TDD workflow for every task.

---

### Task 1: Rust Backend Appearance Settings Schema & Serialization

**Files:**
- Modify: `src-tauri/src/settings.rs`

**Interfaces:**
- Produces: `AppearanceSettings` struct in Rust with `serde(default)` and `Default` impl.
- Updates: `AppSettings` struct to contain `pub general: GeneralSettings` and `pub appearance: AppearanceSettings`.

- [ ] **Step 1: Write failing Rust unit test for AppearanceSettings**

In `src-tauri/src/settings.rs`:
```rust
#[test]
fn appearance_settings_default_and_roundtrip() {
    let settings = AppSettings::default();
    assert_eq!(settings.appearance.theme_name, "oppa_dark");
    assert_eq!(settings.appearance.font_size, 14);
    assert_eq!(settings.appearance.line_height, 1.2);
    assert_eq!(settings.appearance.cursor_style, "block");
    assert!(settings.appearance.cursor_blink);
    assert!(settings.appearance.dim_inactive_panes);

    let serialized = serde_json::to_string(&settings).unwrap();
    let deserialized: AppSettings = serde_json::from_str(&serialized).unwrap();
    assert_eq!(deserialized, settings);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p oppa --lib settings` in `src-tauri`  
Expected: Compilation failure because `AppearanceSettings` and `settings.appearance` do not exist yet.

- [ ] **Step 3: Implement AppearanceSettings in Rust**

Add `AppearanceSettings` to `src-tauri/src/settings.rs`:
```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct AppearanceSettings {
    pub theme_name: String,
    pub font_family: String,
    pub font_size: u16,
    pub line_height: f32,
    pub cursor_style: String,
    pub cursor_blink: bool,
    pub dim_inactive_panes: bool,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            theme_name: "oppa_dark".into(),
            font_family: "'Geist Mono', 'SF Mono', 'JetBrains Mono', Consolas, monospace".into(),
            font_size: 14,
            line_height: 1.2,
            cursor_style: "block".into(),
            cursor_blink: true,
            dim_inactive_panes: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(default)]
pub struct AppSettings {
    pub general: GeneralSettings,
    pub appearance: AppearanceSettings,
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p oppa --lib settings` in `src-tauri`  
Expected: PASS (4/4 tests passed)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/settings.rs
git commit -m "feat: add appearance settings struct to rust backend"
```

---

### Task 2: Frontend Appearance Types & Terminal Themes Catalog

**Files:**
- Modify: `src/lib/settings/types.ts`
- Modify: `src/lib/settings/transport.ts`
- Create: `src/lib/theme/terminalThemes.ts`
- Create: `src/lib/theme/terminalThemes.test.ts`

**Interfaces:**
- Produces:
  - `TerminalThemeId` ("oppa_dark" | "dracula" | "tokyo_night" | "one_dark" | "nord" | "catppuccin_mocha" | "monokai_pro" | "solarized_dark" | "ghostty_dark" | "github_dark" | "minimal_light")
  - `TerminalCursorStyle` ("block" | "bar" | "underline")
  - `AppearanceSettings` interface and `DEFAULT_APPEARANCE_SETTINGS`
  - `getTerminalTheme(id: TerminalThemeId): ITheme`
  - `getAllTerminalThemes(): Array<{ id: TerminalThemeId; name: string; isDark: boolean; previewColors: [string, string, string, string] }>`

- [ ] **Step 1: Write failing tests for terminal themes catalog**

In `src/lib/theme/terminalThemes.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { getTerminalTheme, getAllTerminalThemes, TERMINAL_THEMES } from "./terminalThemes";

describe("terminalThemes catalog", () => {
  it("provides 11 complete themes with valid color values", () => {
    const all = getAllTerminalThemes();
    expect(all.length).toBe(11);
    for (const item of all) {
      const theme = getTerminalTheme(item.id);
      expect(theme.background).toBeDefined();
      expect(theme.foreground).toBeDefined();
      expect(theme.cursor).toBeDefined();
      expect(theme.black).toBeDefined();
      expect(theme.red).toBeDefined();
      expect(theme.green).toBeDefined();
      expect(theme.yellow).toBeDefined();
      expect(theme.blue).toBeDefined();
      expect(theme.magenta).toBeDefined();
      expect(theme.cyan).toBeDefined();
      expect(theme.white).toBeDefined();
    }
  });

  it("falls back to OPPA Dark for unknown theme ID", () => {
    // @ts-expect-error test invalid ID
    const theme = getTerminalTheme("nonexistent_theme");
    expect(theme).toEqual(TERMINAL_THEMES.oppa_dark);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/theme/terminalThemes.test.ts`  
Expected: FAIL (module not found)

- [ ] **Step 3: Implement types, transport defaults, and terminalThemes.ts**

Update `src/lib/settings/types.ts`:
```typescript
export type TerminalThemeId =
  | "oppa_dark"
  | "dracula"
  | "tokyo_night"
  | "one_dark"
  | "nord"
  | "catppuccin_mocha"
  | "monokai_pro"
  | "solarized_dark"
  | "ghostty_dark"
  | "github_dark"
  | "minimal_light";

export type TerminalCursorStyle = "block" | "bar" | "underline";

export interface AppearanceSettings {
  themeName: TerminalThemeId;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  dimInactivePanes: boolean;
}

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  themeName: "oppa_dark",
  fontFamily: "'Geist Mono', 'SF Mono', 'JetBrains Mono', Consolas, monospace",
  fontSize: 14,
  lineHeight: 1.2,
  cursorStyle: "block",
  cursorBlink: true,
  dimInactivePanes: true,
};

export interface AppSettings {
  general: GeneralSettings;
  appearance: AppearanceSettings;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  general: DEFAULT_APP_SETTINGS.general,
  appearance: DEFAULT_APPEARANCE_SETTINGS,
};
```

Update `src/lib/settings/transport.ts` to merge `appearance` on `loadSettings`.  
Implement `src/lib/theme/terminalThemes.ts` with all 11 themes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/theme/terminalThemes.test.ts src/lib/settings/transport.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/settings/types.ts src/lib/settings/transport.ts src/lib/settings/transport.test.ts src/lib/theme/terminalThemes.ts src/lib/theme/terminalThemes.test.ts
git commit -m "feat: add appearance settings types and terminal themes catalog"
```

---

### Task 3: Zustand Store Appearance Slice

**Files:**
- Modify: `src/store/terminalStore.ts`
- Modify: `src/store/terminalStore.test.ts`

**Interfaces:**
- Produces:
  - `state.settings.appearance: AppearanceSettings`
  - `updateAppearanceSettings: (partial: Partial<AppearanceSettings>) => void`
  - Re-exports `TerminalThemeId`, `TerminalCursorStyle`, `AppearanceSettings`, `getTerminalTheme`, `getAllTerminalThemes` from store for convenient consumer access.

- [ ] **Step 1: Write failing store tests for Appearance slice**

In `src/store/terminalStore.test.ts`:
```typescript
describe("appearance settings slice", () => {
  it("initializes with default appearance settings", () => {
    const { settings } = useTerminalStore.getState();
    expect(settings.appearance.themeName).toBe("oppa_dark");
    expect(settings.appearance.fontSize).toBe(14);
    expect(settings.appearance.lineHeight).toBe(1.2);
    expect(settings.appearance.cursorStyle).toBe("block");
    expect(settings.appearance.cursorBlink).toBe(true);
  });

  it("updates appearance settings partially and triggers persistence", async () => {
    vi.useFakeTimers();
    useTerminalStore.getState().updateAppearanceSettings({
      themeName: "tokyo_night",
      fontSize: 16,
    });

    expect(useTerminalStore.getState().settings.appearance.themeName).toBe("tokyo_night");
    expect(useTerminalStore.getState().settings.appearance.fontSize).toBe(16);
    expect(useTerminalStore.getState().settings.appearance.lineHeight).toBe(1.2);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/store/terminalStore.test.ts`  
Expected: FAIL (`updateAppearanceSettings` is not a function)

- [ ] **Step 3: Implement Appearance actions in Zustand Store**

Update `src/store/terminalStore.ts`:
- Add `updateAppearanceSettings: (partial: Partial<AppearanceSettings>) => void`
- Ensure `updateSettings` merges `appearance` correctly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/store/terminalStore.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/terminalStore.ts src/store/terminalStore.test.ts
git commit -m "feat: add appearance settings slice to terminalStore"
```

---

### Task 4: Interactive Mini Terminal Preview Component

**Files:**
- Create: `src/components/settings/TerminalPreviewBox.tsx`
- Create: `src/components/settings/TerminalPreviewBox.css`
- Create: `src/components/settings/TerminalPreviewBox.test.tsx`

**Interfaces:**
- Produces: `<TerminalPreviewBox theme={theme} fontFamily={fontFamily} fontSize={fontSize} lineHeight={lineHeight} cursorStyle={cursorStyle} cursorBlink={cursorBlink} />`

- [ ] **Step 1: Write failing unit test for TerminalPreviewBox**

In `src/components/settings/TerminalPreviewBox.test.tsx`:
```typescript
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { TerminalPreviewBox } from "./TerminalPreviewBox";
import { getTerminalTheme } from "../../lib/theme/terminalThemes";

describe("TerminalPreviewBox", () => {
  it("renders sample prompt and color swatches with applied theme styles", () => {
    const theme = getTerminalTheme("dracula");
    render(
      <TerminalPreviewBox
        theme={theme}
        fontFamily="Consolas"
        fontSize={14}
        lineHeight={1.2}
        cursorStyle="block"
        cursorBlink={true}
      />
    );

    expect(screen.getByTestId("terminal-preview-box")).toBeInTheDocument();
    expect(screen.getByText(/oppa/i)).toBeInTheDocument();
    expect(screen.getByText(/git:\(main\)/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/settings/TerminalPreviewBox.test.tsx`  
Expected: FAIL (module not found)

- [ ] **Step 3: Implement TerminalPreviewBox component & CSS**

Create `TerminalPreviewBox.tsx` with mock ANSI output, color chips, and dynamic CSS variables (`--preview-bg`, `--preview-fg`, `--preview-cursor`, `--font-mono`, etc.).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/components/settings/TerminalPreviewBox.test.tsx`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/TerminalPreviewBox.tsx src/components/settings/TerminalPreviewBox.css src/components/settings/TerminalPreviewBox.test.tsx
git commit -m "feat: add interactive terminal preview box component"
```

---

### Task 5: Appearance Settings Pane UI

**Files:**
- Create: `src/components/settings/AppearanceSettingsPane.tsx`
- Create: `src/components/settings/AppearanceSettingsPane.css`
- Create: `src/components/settings/AppearanceSettingsPane.test.tsx`

**Interfaces:**
- Produces: `<AppearanceSettingsPane />`

- [ ] **Step 1: Write failing unit test for AppearanceSettingsPane**

In `src/components/settings/AppearanceSettingsPane.test.tsx`:
```typescript
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { AppearanceSettingsPane } from "./AppearanceSettingsPane";
import { useTerminalStore } from "../../store/terminalStore";

describe("AppearanceSettingsPane", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      settings: {
        ...useTerminalStore.getState().settings,
        appearance: {
          themeName: "oppa_dark",
          fontFamily: "'Geist Mono', 'SF Mono', Consolas, monospace",
          fontSize: 14,
          lineHeight: 1.2,
          cursorStyle: "block",
          cursorBlink: true,
          dimInactivePanes: true,
        },
      },
    });
  });

  it("renders live preview, theme selector cards, and typography controls", () => {
    render(<AppearanceSettingsPane />);
    expect(screen.getByRole("region", { name: /appearance settings/i })).toBeInTheDocument();
    expect(screen.getByText("Tokyo Night")).toBeInTheDocument();
    expect(screen.getByLabelText(/font size/i)).toBeInTheDocument();
  });

  it("selects a theme when clicking a theme card", () => {
    render(<AppearanceSettingsPane />);
    const tokyoNightBtn = screen.getByRole("button", { name: /select tokyo night theme/i });
    fireEvent.click(tokyoNightBtn);
    expect(useTerminalStore.getState().settings.appearance.themeName).toBe("tokyo_night");
  });

  it("changes font size stepper and slider", () => {
    render(<AppearanceSettingsPane />);
    const increaseBtn = screen.getByRole("button", { name: /increase font size/i });
    fireEvent.click(increaseBtn);
    expect(useTerminalStore.getState().settings.appearance.fontSize).toBe(15);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/settings/AppearanceSettingsPane.test.tsx`  
Expected: FAIL (module not found)

- [ ] **Step 3: Implement AppearanceSettingsPane and CSS**

Build `AppearanceSettingsPane.tsx` adhering to `minimalist-skill` (centered `.settings-pane-container`, bento cards for Theme Catalog, Typography, Cursor/Window, and `TerminalPreviewBox`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/components/settings/AppearanceSettingsPane.test.tsx`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/AppearanceSettingsPane.tsx src/components/settings/AppearanceSettingsPane.css src/components/settings/AppearanceSettingsPane.test.tsx
git commit -m "feat: add appearance settings pane with theme catalog and typography controls"
```

---

### Task 6: Settings Sidebar & Settings View Integration

**Files:**
- Modify: `src/components/settings/SettingsSidebar.tsx`
- Modify: `src/components/settings/SettingsSidebar.test.tsx`
- Modify: `src/components/settings/SettingsView.tsx`
- Modify: `src/components/settings/SettingsView.test.tsx`

**Interfaces:**
- Enables `appearance` category tab in `SettingsSidebar` (removes disabled state & Coming Soon badge).
- Renders `<AppearanceSettingsPane />` in `SettingsView` when `activeSettingsTab === "appearance"`.

- [ ] **Step 1: Write failing test in SettingsSidebar and SettingsView**

Verify `Appearance` button is enabled and clicking it sets `activeSettingsTab: "appearance"`.

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest run src/components/settings/SettingsSidebar.test.tsx src/components/settings/SettingsView.test.tsx`  
Expected: FAIL (Appearance tab currently disabled)

- [ ] **Step 3: Enable Appearance category in SettingsSidebar and SettingsView**

Update `CATEGORIES` in `SettingsSidebar.tsx` to set `disabled: false` for `appearance`.  
Render `<AppearanceSettingsPane />` when `activeSettingsTab === "appearance"` in `SettingsView.tsx`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/components/settings/SettingsSidebar.test.tsx src/components/settings/SettingsView.test.tsx`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/SettingsSidebar.tsx src/components/settings/SettingsSidebar.test.tsx src/components/settings/SettingsView.tsx src/components/settings/SettingsView.test.tsx
git commit -m "feat: enable appearance category in settings sidebar and settings view"
```

---

### Task 7: Real-Time Live Reactivity in TerminalPane

**Files:**
- Modify: `src/components/TerminalPane.tsx`
- Modify: `src/components/TerminalPane.test.tsx`
- Modify: `src/components/TerminalPane.css` (for dimming inactive panes)

**Interfaces:**
- Consumes: `useTerminalStore((s) => s.settings.appearance)`
- Dynamically updates `term.options.theme`, `term.options.fontFamily`, `term.options.fontSize`, `term.options.lineHeight`, `term.options.cursorStyle`, `term.options.cursorBlink`, and triggers `fitAddon.fit()`.
- Applies `.dimmed` class or CSS opacity to inactive terminal panes when `appearance.dimInactivePanes` is enabled.

- [ ] **Step 1: Write failing test for TerminalPane appearance reactivity**

In `src/components/TerminalPane.test.tsx`:
```typescript
it("updates terminal options when appearance settings change", () => {
  // Mount TerminalPane and update store appearance settings
  // Assert term.options.fontSize, fontFamily, theme are updated without remounting
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/TerminalPane.test.tsx`  
Expected: FAIL

- [ ] **Step 3: Implement appearance subscription in TerminalPane**

Add `useEffect` listening to `appearance` changes on `termRef.current` and `fitAddonRef.current?.fit()`.

- [ ] **Step 4: Run all frontend and backend tests**

Run: `cargo test -p oppa --lib` and `pnpm vitest run`  
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/TerminalPane.tsx src/components/TerminalPane.test.tsx src/components/TerminalPane.css
git commit -m "feat: connect real-time appearance reactivity in TerminalPane"
```
