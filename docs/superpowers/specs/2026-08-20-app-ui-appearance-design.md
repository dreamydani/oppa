# OPPA Settings Group 3: App & UI Appearance Design Spec

**Date:** 2026-08-20  
**Status:** Approved  
**Scope:** Group 3 Appearance Settings — App Theme (Dark/Light/System), App Font Family, UI Zoom Scale (80%-125%), Sidebar/Chrome Controls (Launch State, Status Bar, Titlebar Logo), and Section Divider.

---

## 1. Overview & Goals

Group 3 extends the **Appearance** settings pane to give users complete control over the app workbench's visual styling, scale, and chrome layout.

### Key Objectives
1. **Independent Theming**: App & UI theme (`dark`, `light`, `system`) is fully independent of terminal pane color themes.
2. **App Theme Switching**: Dynamic light and dark mode CSS variables, with OS system preference tracking (`prefers-color-scheme`).
3. **UI Scaling (Zoom)**: Multi-step UI zoom scaling (`80%`, `90%`, `100%`, `110%`, `125%`) applied to root viewport scale.
4. **App Typography**: Global UI sans-serif font family presets and custom override stack.
5. **Sidebar & Chrome Layout**:
   - Left Sidebar launch state (`open` vs `collapsed`).
   - Status Bar visibility toggle (`showStatusBar`).
   - Titlebar brand logo toggle (`showTitlebarLogo`).
6. **Clean Section Separation**: A dedicated minimalist section divider separating "App & Workbench" controls from "Terminal Appearance".

---

## 2. Data Models & Schemas

### 2.1 Rust Backend Schema (`src-tauri/src/settings.rs`)

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct AppearanceSettings {
    // App & UI Settings
    pub app_theme: String,             // "dark" | "light" | "system" (default: "dark")
    pub app_font_family: String,       // default: "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    pub ui_zoom: f32,                  // default: 1.0 (options: 0.8, 0.9, 1.0, 1.1, 1.25)
    pub sidebar_on_launch: String,     // "open" | "collapsed" (default: "open")
    pub show_status_bar: bool,         // default: true
    pub show_titlebar_logo: bool,      // default: true

    // Terminal Settings (Group 2)
    pub theme_name: String,            // default: "oppa_dark"
    pub font_family: String,           // default: "'Geist Mono', 'SF Mono', 'JetBrains Mono', Consolas, monospace"
    pub font_size: u16,                // default: 14
    pub line_height: f32,              // default: 1.2
    pub cursor_style: String,          // default: "block"
    pub cursor_blink: bool,            // default: true
    pub dim_inactive_panes: bool,      // default: true
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            app_theme: "dark".into(),
            app_font_family: "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif".into(),
            ui_zoom: 1.0,
            sidebar_on_launch: "open".into(),
            show_status_bar: true,
            show_titlebar_logo: true,

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
```

### 2.2 TypeScript Frontend Schema (`src/lib/settings/types.ts`)

```typescript
export type AppThemeMode = "dark" | "light" | "system";
export type SidebarLaunchMode = "open" | "collapsed";

export interface AppearanceSettings {
  // App & UI Settings
  appTheme: AppThemeMode;
  appFontFamily: string;
  uiZoom: number;
  sidebarOnLaunch: SidebarLaunchMode;
  showStatusBar: boolean;
  showTitlebarLogo: boolean;

  // Terminal Settings
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

---

## 3. UI Layout & Section Division (`AppearanceSettingsPane.tsx`)

Layout structure inside `.settings-pane-container`:

1. **Header**:
   - Title: `Appearance`
   - Description: `Customize the app workbench styling, scale, chrome, and terminal aesthetics.`
2. **App & Workbench Section (`<section>`)**:
   - Section subheader: `App & Workbench`
   - **Bento Card 1: App Theme & Scaling**
     - UI Theme segmented control (`Dark 🌙`, `Light ☀️`, `System 💻`)
     - UI Zoom segmented selector (`80%`, `90%`, `100%`, `110%`, `125%`)
     - UI Font preset dropdown (`Geist`, `System UI`, `Inter`, `SF Pro / Segoe UI`, `Custom Font...`) and custom font text input
   - **Bento Card 2: Sidebar & Chrome**
     - Left Sidebar on Launch segmented control (`Open`, `Collapsed`)
     - Status Bar visibility toggle switch
     - Titlebar "oppa" Logo visibility toggle switch
3. **Section Divider (`<hr className="settings-section-divider" />`)**:
   - Clean horizontal hair-thin rule with generous vertical margins (32px) and subtle contrast (`rgba(255, 255, 255, 0.08)` / `rgba(0, 0, 0, 0.08)`).
4. **Terminal Appearance Section (`<section>`)**:
   - Section subheader: `Terminal`
   - Embedded `TerminalPreviewBox`
   - Theme Selection Cards (11 themes)
   - Typography & Dimensions Card (font family, size stepper/slider, line height)
   - Cursor & Window Card (cursor style, blink toggle, dim inactive toggle)

---

## 4. Live Reactivity & Implementation Details

1. **App Theme (`appTheme`)**:
   - React hook / effect in `App.tsx` or theme manager:
     - Sets `document.documentElement.setAttribute('data-theme', resolvedTheme)`.
     - When `appTheme === "system"`, listens to `window.matchMedia('(prefers-color-scheme: dark)')` change events.
   - Comprehensive light mode theme tokens defined in `src/App.css` for background, surface, sidebar, cards, borders, text, and titlebar.
2. **UI Zoom (`uiZoom`)**:
   - Applied dynamically to root CSS style or container zoom:
     `document.documentElement.style.zoom = String(appearance.uiZoom)` (or `document.documentElement.style.fontSize = `${appearance.uiZoom * 100}%``).
3. **App Font Family (`appFontFamily`)**:
   - Applied dynamically via `document.documentElement.style.setProperty('--font-sans', appearance.appFontFamily)`.
4. **Status Bar Visibility (`showStatusBar`)**:
   - In `src/App.tsx`: `{appearance.showStatusBar && <StatusBar />}`.
5. **Titlebar Brand Logo (`showTitlebarLogo`)**:
   - In `src/components/TitleBar.tsx`: `{appearance.showTitlebarLogo && <span className="app-brand-title">oppa</span>}`.
6. **Sidebar Launch State (`sidebarOnLaunch`)**:
   - Checked during app startup (`loadLayout`): if `sidebarOnLaunch === "collapsed"`, initial `leftSidebarOpen` is set to `false`.

---

## 5. Testing & Verification

1. **Rust Tests (`src-tauri/src/settings.rs`)**:
   - Default values for `app_theme`, `app_font_family`, `ui_zoom`, `sidebar_on_launch`, `show_status_bar`, `show_titlebar_logo`.
   - Backward compatibility for older JSON without these keys.
2. **Frontend Unit Tests**:
   - `AppearanceSettingsPane.test.tsx`: Theme segmented control, UI zoom buttons, App font dropdown/custom input, chrome switches, section divider rendering.
   - `TitleBar.test.tsx`: Logo hiding when `showTitlebarLogo: false`.
   - `App.test.tsx`: StatusBar hiding when `showStatusBar: false`, theme attribute application, UI zoom application.
