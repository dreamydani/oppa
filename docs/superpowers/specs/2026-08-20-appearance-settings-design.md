# OPPA Settings Group 2: Terminal Appearance & Theme Settings Design Spec

**Date:** 2026-08-20  
**Status:** Approved  
**Scope:** Group 2 Appearance Settings — Terminal Themes, Typography, Cursor, Inactive Pane Dimming, and Real-Time Live Preview  

---

## 1. Overview & Goals

The goal of Group 2 is to unlock the **Appearance** settings category in OPPA, giving users full, live-reactive control over the visual presentation of their terminals and workspace without restarting running processes.

### Key Objectives
1. **Curated Theme Catalog**: 11 xterm-compatible color palettes (OPPA Dark, Dracula, Tokyo Night, One Dark, Nord, Catppuccin Mocha, Monokai Pro, Solarized Dark, Ghostty Dark, GitHub Dark, Minimal Light).
2. **Typography & Spacing**: Font family presets, font size stepper/slider (10px–24px), line height multiplier (1.0–2.0).
3. **Cursor Customization**: Cursor style (`block`, `bar`, `underline`) and blinking toggle.
4. **Interactive Real-Time Preview**: Live mini-terminal component inside `AppearanceSettingsPane` that displays formatted prompt and ANSI color output reflecting user modifications instantly.
5. **Live Pane Reactivity**: Active `TerminalPane` instances immediately update their `term.options` without restarting the PTY child process or clearing scrollback history.

---

## 2. Data Models & Schemas

### 2.1 Rust Backend Schema (`src-tauri/src/settings.rs`)

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

### 2.2 TypeScript Frontend Schema (`src/lib/settings/types.ts`)

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

export interface AppSettings {
  general: GeneralSettings;
  appearance: AppearanceSettings;
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
```

---

## 3. Theme Catalog Architecture (`src/lib/theme/terminalThemes.ts`)

Each theme defines complete xterm-compatible tokens:
- `background`, `foreground`, `cursor`, `cursorAccent`, `selectionBackground`, `selectionForeground`
- Standard 8 ANSI colors (`black`, `red`, `green`, `yellow`, `blue`, `magenta`, `cyan`, `white`)
- Bright 8 ANSI colors (`brightBlack`, `brightRed`, `brightGreen`, `brightYellow`, `brightBlue`, `brightMagenta`, `brightCyan`, `brightWhite`)

### Supported Themes
1. **OPPA Dark**: `#0c0c0e` background, `#ededec` foreground, slate accents.
2. **Dracula**: `#282a36` background, `#f8f8f2` foreground, `#bd93f9` blue/purple.
3. **Tokyo Night**: `#1a1b26` background, `#c0caf5` foreground, `#7aa2f7` blue.
4. **One Dark**: `#282c34` background, `#abb2bf` foreground, `#61afef` blue.
5. **Nord**: `#2e3440` background, `#d8dee9` foreground, `#88c0d0` cyan/frost.
6. **Catppuccin Mocha**: `#1e1e2e` background, `#cdd6f4` foreground, `#cba6f7` mauve.
7. **Monokai Pro**: `#272822` background, `#f8f8f2` foreground, `#a6e22e` green, `#f92672` pink.
8. **Solarized Dark**: `#002b36` background, `#839496` foreground, `#268bd2` blue.
9. **Ghostty Dark**: `#121212` background, `#ffffff` foreground, monochrome/clean tones.
10. **GitHub Dark**: `#0d1117` background, `#c9d1d9` foreground, `#58a6ff` blue.
11. **Minimal Light**: `#fbfbfa` background, `#18181b` foreground, `#0969da` blue.

Helper functions:
- `getTerminalTheme(id: TerminalThemeId): ITheme`
- `getAllTerminalThemes(): Array<{ id: TerminalThemeId; name: string; isDark: boolean; previewColors: [string, string, string, string] }>`

---

## 4. UI Design & Components

### 4.1 `AppearanceSettingsPane.tsx`
Layout follows the minimalist bento grid:
1. **Interactive Preview Widget (`TerminalPreviewBox.tsx`)**:
   - Renders a styled mock terminal viewport.
   - Shows colored prompt: `oppa ~/workspace (main) $ ls -la`, ANSI color badges, and active blinking cursor.
   - Immediately reflects font family, font size, line height, cursor style, and active theme.
2. **Theme Selection Bento Card**:
   - 2-column grid of theme cards.
   - Each card displays theme name, dark/light badge, and a 4-color palette swatch.
   - Active theme card has high-contrast active border and check indicator.
3. **Typography & Dimensions Bento Card**:
   - Font Family selector with quick presets (`Geist Mono`, `JetBrains Mono`, `SF Mono`, `Fira Code`, `Cascadia Code`).
   - Font Size stepper (- / +) and interactive range slider (10px to 24px).
   - Line Height slider (1.0 to 2.0 with step 0.05).
4. **Cursor & Window Bento Card**:
   - Cursor style segmented control (`Block █`, `Beam |`, `Underline _`).
   - Cursor Blinking toggle switch.
   - Inactive Panes Dimming toggle switch.

### 4.2 `SettingsSidebar.tsx` & `SettingsView.tsx`
- Remove `disabled` state and "Coming Soon" badge from `Appearance` category in `SettingsSidebar.tsx`.
- Connect `activeSettingsTab === "appearance"` in `SettingsView.tsx` to `<AppearanceSettingsPane />`.

---

## 5. Live Terminal Reactivity

In `src/components/TerminalPane.tsx`:
- Subscribe to `useTerminalStore((s) => s.settings.appearance)`.
- Use a dedicated `useEffect` listening to `appearance` changes on `termRef.current`:
  ```typescript
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const theme = getTerminalTheme(appearance.themeName);
    term.options.theme = theme;
    term.options.fontFamily = appearance.fontFamily;
    term.options.fontSize = appearance.fontSize;
    term.options.lineHeight = appearance.lineHeight;
    term.options.cursorStyle = appearance.cursorStyle;
    term.options.cursorBlink = appearance.cursorBlink;
    fitAddonRef.current?.fit();
  }, [appearance]);
  ```

---

## 6. Testing Strategy

1. **Rust Tests (`src-tauri/src/settings.rs`)**:
   - Verify `AppearanceSettings` serialization, deserialization, and backward-compatible defaults.
2. **Frontend Unit Tests**:
   - `terminalThemes.test.ts`: Theme catalog retrieval, fallback resolution, all 11 themes valid hex values.
   - `AppearanceSettingsPane.test.tsx`: Theme selection, font size changes, line height changes, cursor toggle, store update assertions.
   - `TerminalPreviewBox.test.tsx`: Mock prompt and style application.
   - `TerminalPane.test.tsx`: Terminal options updating upon appearance settings state change.
3. **Integration Tests**:
   - Full settings persistence cycle and `App.test.tsx` integration.
