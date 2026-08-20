import React from "react";
import { useTerminalStore } from "../../store/terminalStore";
import {
  getTerminalTheme,
  getAllTerminalThemes,
} from "../../lib/theme/terminalThemes";
import type { TerminalCursorStyle } from "../../lib/settings/types";
import { TerminalPreviewBox } from "./TerminalPreviewBox";
import "./AppearanceSettingsPane.css";

const APP_FONT_PRESETS = [
  {
    label: "Geist (Default)",
    value: "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
  {
    label: "System UI",
    value: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  },
  {
    label: "Inter",
    value: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
  },
  {
    label: "SF Pro / Segoe UI",
    value: "-apple-system, 'SF Pro Display', 'Segoe UI', sans-serif",
  },
];

const UI_ZOOM_OPTIONS = [
  { label: "80%", value: 0.8 },
  { label: "90%", value: 0.9 },
  { label: "100%", value: 1.0 },
  { label: "110%", value: 1.1 },
  { label: "125%", value: 1.25 },
];

const FONT_PRESETS = [
  {
    label: "Geist Mono",
    value: "'Geist Mono', 'SF Mono', 'JetBrains Mono', Consolas, monospace",
  },
  {
    label: "JetBrains Mono",
    value: "'JetBrains Mono', Consolas, monospace",
  },
  {
    label: "SF Mono",
    value: "'SF Mono', Monaco, monospace",
  },
  {
    label: "Fira Code",
    value: "'Fira Code', Consolas, monospace",
  },
  {
    label: "Cascadia Code",
    value: "'Cascadia Code', Consolas, monospace",
  },
];

export function AppearanceSettingsPane(): React.ReactElement {
  const appearance = useTerminalStore((s) => s.settings.appearance);
  const updateAppearanceSettings = useTerminalStore(
    (s) => s.updateAppearanceSettings
  );

  const allThemes = getAllTerminalThemes();
  const currentTheme = getTerminalTheme(appearance.themeName);
  const currentThemeInfo = allThemes.find((t) => t.id === appearance.themeName);

  const isPresetFont = FONT_PRESETS.some(
    (p) => p.value === appearance.fontFamily
  );

  const isAppPresetFont = APP_FONT_PRESETS.some(
    (p) => p.value === appearance.appFontFamily
  );

  const handleAppPresetFontChange = (val: string) => {
    if (val !== "custom") {
      updateAppearanceSettings({ appFontFamily: val });
    }
  };

  const handleAppCustomFontChange = (val: string) => {
    updateAppearanceSettings({ appFontFamily: val });
  };

  const handlePresetFontChange = (val: string) => {
    if (val !== "custom") {
      updateAppearanceSettings({ fontFamily: val });
    }
  };

  const handleCustomFontChange = (val: string) => {
    updateAppearanceSettings({ fontFamily: val });
  };

  const handleFontSizeChange = (size: number) => {
    const clamped = Math.max(10, Math.min(24, size));
    updateAppearanceSettings({ fontSize: clamped });
  };

  const handleLineHeightChange = (lh: number) => {
    const clamped = Math.max(1.0, Math.min(2.0, parseFloat(lh.toFixed(2))));
    updateAppearanceSettings({ lineHeight: clamped });
  };

  const handleCursorStyleChange = (style: TerminalCursorStyle) => {
    updateAppearanceSettings({ cursorStyle: style });
  };

  const toggleCursorBlink = () => {
    updateAppearanceSettings({ cursorBlink: !appearance.cursorBlink });
  };

  const toggleDimInactive = () => {
    updateAppearanceSettings({ dimInactivePanes: !appearance.dimInactivePanes });
  };

  const toggleStatusBar = () => {
    updateAppearanceSettings({ showStatusBar: !appearance.showStatusBar });
  };

  const toggleTitlebarLogo = () => {
    updateAppearanceSettings({ showTitlebarLogo: !appearance.showTitlebarLogo });
  };

  return (
    <div
      className="settings-pane appearance-settings-pane"
      role="region"
      aria-label="Appearance Settings"
    >
      <div className="settings-pane-container">
        {/* Main Header */}
        <div className="settings-pane-header">
          <h2 className="settings-pane-title">Appearance</h2>
          <p className="settings-pane-desc">
            Application theme, UI scale, workbench layout, and terminal visual options.
          </p>
        </div>

        <div className="settings-pane-content">
          {/* App & Workbench Section Header */}
          <div className="settings-section-header">
            <h3 className="settings-section-title">App &amp; Workbench</h3>
            <p className="settings-section-desc">
              Theme styling, interface scaling, typography, and chrome controls.
            </p>
          </div>

          {/* Bento Card 1: App Theme & Scaling */}
          <section
            className="settings-card"
            aria-labelledby="heading-app-theme-scaling"
          >
            <h3 id="heading-app-theme-scaling" className="settings-card-title">
              App Theme &amp; Scaling
            </h3>

            {/* UI Theme */}
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">UI Theme</span>
                <span className="settings-row-desc">
                  Choose the color mode for the application shell and workbench.
                </span>
              </div>
              <div className="settings-row-control">
                <div
                  className="settings-segmented-group"
                  role="group"
                  aria-label="UI Theme"
                >
                  <button
                    type="button"
                    className={`settings-segmented-btn ${appearance.appTheme === "dark" ? "active" : ""}`}
                    onClick={() => updateAppearanceSettings({ appTheme: "dark" })}
                  >
                    Dark 🌙
                  </button>
                  <button
                    type="button"
                    className={`settings-segmented-btn ${appearance.appTheme === "light" ? "active" : ""}`}
                    onClick={() => updateAppearanceSettings({ appTheme: "light" })}
                  >
                    Light ☀️
                  </button>
                  <button
                    type="button"
                    className={`settings-segmented-btn ${appearance.appTheme === "system" ? "active" : ""}`}
                    onClick={() => updateAppearanceSettings({ appTheme: "system" })}
                  >
                    System 💻
                  </button>
                </div>
              </div>
            </div>

            {/* UI Zoom / Scale */}
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">UI Zoom / Scale</span>
                <span className="settings-row-desc">
                  Adjust the scale multiplier of the entire application interface.
                </span>
              </div>
              <div className="settings-row-control">
                <div
                  className="settings-segmented-group"
                  role="group"
                  aria-label="UI Zoom / Scale"
                >
                  {UI_ZOOM_OPTIONS.map((opt) => (
                    <button
                      key={opt.label}
                      type="button"
                      className={`settings-segmented-btn ${Math.abs(appearance.uiZoom - opt.value) < 0.01 ? "active" : ""}`}
                      onClick={() => updateAppearanceSettings({ uiZoom: opt.value })}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* App UI Font */}
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">App UI Font</span>
                <span className="settings-row-desc">
                  Typeface used across menus, sidebars, tabs, and workbench.
                </span>
              </div>
              <div className="settings-row-control">
                <select
                  aria-label="App Font Family Preset"
                  className="settings-select font-preset-select"
                  value={isAppPresetFont ? appearance.appFontFamily : "custom"}
                  onChange={(e) => handleAppPresetFontChange(e.target.value)}
                >
                  {APP_FONT_PRESETS.map((preset) => (
                    <option key={preset.label} value={preset.value}>
                      {preset.label}
                    </option>
                  ))}
                  <option value="custom">Custom Font...</option>
                </select>
              </div>
            </div>

            {/* Custom App Font Family Input */}
            <div className="settings-sub-row">
              <label htmlFor="custom-app-font-input" className="settings-sub-label">
                Custom Font:
              </label>
              <input
                id="custom-app-font-input"
                type="text"
                className="settings-input custom-font-input"
                placeholder="'Geist', sans-serif"
                value={appearance.appFontFamily}
                onChange={(e) => handleAppCustomFontChange(e.target.value)}
                aria-label="Custom App Font Family"
              />
            </div>
          </section>

          {/* Bento Card 2: Sidebar & Chrome */}
          <section
            className="settings-card"
            aria-labelledby="heading-sidebar-chrome"
          >
            <h3 id="heading-sidebar-chrome" className="settings-card-title">
              Sidebar &amp; Chrome
            </h3>

            {/* Left Sidebar on Launch */}
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Left Sidebar on Launch</span>
                <span className="settings-row-desc">
                  Default workspace sidebar open state on application startup.
                </span>
              </div>
              <div className="settings-row-control">
                <div
                  className="settings-segmented-group"
                  role="group"
                  aria-label="Left Sidebar on Launch"
                >
                  <button
                    type="button"
                    className={`settings-segmented-btn ${appearance.sidebarOnLaunch === "remember_last" ? "active" : ""}`}
                    onClick={() => updateAppearanceSettings({ sidebarOnLaunch: "remember_last" })}
                  >
                    Remember Last
                  </button>
                  <button
                    type="button"
                    className={`settings-segmented-btn ${appearance.sidebarOnLaunch === "open" ? "active" : ""}`}
                    onClick={() => updateAppearanceSettings({ sidebarOnLaunch: "open" })}
                  >
                    Open
                  </button>
                  <button
                    type="button"
                    className={`settings-segmented-btn ${appearance.sidebarOnLaunch === "collapsed" ? "active" : ""}`}
                    onClick={() => updateAppearanceSettings({ sidebarOnLaunch: "collapsed" })}
                  >
                    Collapsed
                  </button>
                </div>
              </div>
            </div>

            {/* Show Status Bar */}
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Show Status Bar</span>
                <span className="settings-row-desc">
                  Display active session info, branch, and status at the bottom of the window.
                </span>
              </div>
              <div className="settings-row-control">
                <button
                  type="button"
                  role="switch"
                  aria-checked={appearance.showStatusBar}
                  aria-label="Show Status Bar"
                  className={`settings-switch ${appearance.showStatusBar ? "checked" : ""}`}
                  onClick={toggleStatusBar}
                >
                  <span className="settings-switch-thumb" />
                </button>
              </div>
            </div>

            {/* Show "oppa" Logo */}
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Show &quot;oppa&quot; Logo</span>
                <span className="settings-row-desc">
                  Display brand logo and name in the upper left corner of the titlebar.
                </span>
              </div>
              <div className="settings-row-control">
                <button
                  type="button"
                  role="switch"
                  aria-checked={appearance.showTitlebarLogo}
                  aria-label='Show "oppa" Logo'
                  className={`settings-switch ${appearance.showTitlebarLogo ? "checked" : ""}`}
                  onClick={toggleTitlebarLogo}
                >
                  <span className="settings-switch-thumb" />
                </button>
              </div>
            </div>
          </section>

          {/* Horizontal Section Divider */}
          <hr className="settings-section-divider" data-testid="appearance-section-divider" />

          {/* Terminal Appearance Section Header */}
          <div className="settings-section-header">
            <h3 className="settings-section-title">Terminal Appearance</h3>
            <p className="settings-section-desc">
              Terminal color palette, typography, cursor style, and window visual options.
            </p>
          </div>

          {/* Live Preview Bento Card */}
          <section
            className="settings-card preview-card"
            aria-labelledby="heading-live-preview"
          >
            <h3 id="heading-live-preview" className="settings-card-title">
              Live Preview
            </h3>
            <div className="settings-preview-wrapper">
              <TerminalPreviewBox
                theme={currentTheme}
                themeName={currentThemeInfo?.name ?? appearance.themeName}
                fontFamily={appearance.fontFamily}
                fontSize={appearance.fontSize}
                lineHeight={appearance.lineHeight}
                cursorStyle={appearance.cursorStyle}
                cursorBlink={appearance.cursorBlink}
              />
            </div>
          </section>

          {/* Terminal Theme Selection Bento Card */}
          <section
            className="settings-card theme-selection-card"
            aria-labelledby="heading-terminal-theme"
          >
            <h3 id="heading-terminal-theme" className="settings-card-title">
              Terminal Theme
            </h3>
            <div className="theme-grid" role="group" aria-label="Terminal Themes">
              {allThemes.map((theme) => {
                const isActive = appearance.themeName === theme.id;
                return (
                  <button
                    key={theme.id}
                    type="button"
                    className={`theme-card ${isActive ? "active" : ""}`}
                    onClick={() =>
                      updateAppearanceSettings({ themeName: theme.id })
                    }
                    aria-label={`Select ${theme.name} theme`}
                    aria-pressed={isActive}
                  >
                    <div className="theme-card-header">
                      <span className="theme-card-name">{theme.name}</span>
                      <div className="theme-card-badges">
                        <span
                          className={`theme-badge ${theme.isDark ? "badge-dark" : "badge-light"}`}
                        >
                          {theme.isDark ? "Dark" : "Light"}
                        </span>
                        {isActive && (
                          <span
                            className="theme-check-badge"
                            aria-label="Active theme"
                          >
                            <svg
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="3"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="theme-palette-swatches">
                      {theme.previewColors.map((color, idx) => (
                        <div
                          key={idx}
                          className="theme-palette-chip"
                          style={{ backgroundColor: color }}
                        />
                      ))}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Typography & Dimensions Bento Card */}
          <section
            className="settings-card typography-card"
            aria-labelledby="heading-typography-layout"
          >
            <h3 id="heading-typography-layout" className="settings-card-title">
              Typography &amp; Layout
            </h3>

            {/* Font Family */}
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Font Family</span>
                <span className="settings-row-desc">
                  Select a standard monospace typeface or enter a custom font stack.
                </span>
              </div>
              <div className="settings-row-control">
                <select
                  aria-label="Terminal Font Family Preset"
                  className="settings-select font-preset-select"
                  value={isPresetFont ? appearance.fontFamily : "custom"}
                  onChange={(e) => handlePresetFontChange(e.target.value)}
                >
                  {FONT_PRESETS.map((preset) => (
                    <option key={preset.label} value={preset.value}>
                      {preset.label}
                    </option>
                  ))}
                  <option value="custom">Custom Font...</option>
                </select>
              </div>
            </div>

            {/* Custom Font Family Input */}
            <div className="settings-sub-row">
              <label htmlFor="custom-terminal-font-input" className="settings-sub-label">
                Custom Font:
              </label>
              <input
                id="custom-terminal-font-input"
                type="text"
                className="settings-input custom-font-input"
                placeholder="'Geist Mono', Consolas, monospace"
                value={appearance.fontFamily}
                onChange={(e) => handleCustomFontChange(e.target.value)}
                aria-label="Custom Terminal Font Family"
              />
            </div>

            {/* Font Size */}
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Font Size</span>
                <span className="settings-row-desc">
                  Terminal text rendering size (10px to 24px).
                </span>
              </div>
              <div className="settings-row-control slider-control-group">
                <button
                  type="button"
                  className="settings-stepper-btn"
                  aria-label="Decrease Font Size"
                  disabled={appearance.fontSize <= 10}
                  onClick={() => handleFontSizeChange(appearance.fontSize - 1)}
                >
                  −
                </button>
                <input
                  type="range"
                  min="10"
                  max="24"
                  step="1"
                  className="settings-slider"
                  aria-label="Font Size Slider"
                  value={appearance.fontSize}
                  onChange={(e) =>
                    handleFontSizeChange(Number(e.target.value))
                  }
                />
                <button
                  type="button"
                  className="settings-stepper-btn"
                  aria-label="Increase Font Size"
                  disabled={appearance.fontSize >= 24}
                  onClick={() => handleFontSizeChange(appearance.fontSize + 1)}
                >
                  +
                </button>
                <span className="settings-value-badge" aria-label="Font Size Value">
                  {appearance.fontSize}px
                </span>
              </div>
            </div>

            {/* Line Height */}
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Line Height</span>
                <span className="settings-row-desc">
                  Row vertical spacing multiplier (1.00 to 2.00).
                </span>
              </div>
              <div className="settings-row-control slider-control-group">
                <input
                  type="range"
                  min="1.0"
                  max="2.0"
                  step="0.05"
                  className="settings-slider"
                  aria-label="Line Height Slider"
                  value={appearance.lineHeight}
                  onChange={(e) =>
                    handleLineHeightChange(Number(e.target.value))
                  }
                />
                <span className="settings-value-badge" aria-label="Line Height Value">
                  {appearance.lineHeight.toFixed(2)}
                </span>
              </div>
            </div>
          </section>

          {/* Cursor & Window Bento Card */}
          <section
            className="settings-card cursor-window-card"
            aria-labelledby="heading-cursor-window"
          >
            <h3 id="heading-cursor-window" className="settings-card-title">
              Cursor &amp; Window
            </h3>

            {/* Cursor Style */}
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Cursor Style</span>
                <span className="settings-row-desc">
                  Shape of the terminal insertion indicator.
                </span>
              </div>
              <div className="settings-row-control">
                <div
                  className="settings-segmented-group"
                  role="group"
                  aria-label="Cursor Style"
                >
                  <button
                    type="button"
                    className={`settings-segmented-btn ${appearance.cursorStyle === "block" ? "active" : ""}`}
                    onClick={() => handleCursorStyleChange("block")}
                  >
                    Block (█)
                  </button>
                  <button
                    type="button"
                    className={`settings-segmented-btn ${appearance.cursorStyle === "bar" ? "active" : ""}`}
                    onClick={() => handleCursorStyleChange("bar")}
                  >
                    Beam (|)
                  </button>
                  <button
                    type="button"
                    className={`settings-segmented-btn ${appearance.cursorStyle === "underline" ? "active" : ""}`}
                    onClick={() => handleCursorStyleChange("underline")}
                  >
                    Underline (_)
                  </button>
                </div>
              </div>
            </div>

            {/* Blinking Cursor */}
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Blinking Cursor</span>
                <span className="settings-row-desc">
                  Animate the terminal cursor with a pulsing blink effect.
                </span>
              </div>
              <div className="settings-row-control">
                <button
                  type="button"
                  role="switch"
                  aria-checked={appearance.cursorBlink}
                  aria-label="Blinking Cursor"
                  className={`settings-switch ${appearance.cursorBlink ? "checked" : ""}`}
                  onClick={toggleCursorBlink}
                >
                  <span className="settings-switch-thumb" />
                </button>
              </div>
            </div>

            {/* Dim Inactive Panes */}
            <div className="settings-row">
              <div className="settings-row-info">
                <span className="settings-row-label">Dim Inactive Panes</span>
                <span className="settings-row-desc">
                  Subtly dim unfocused terminal panes to enhance visual focus.
                </span>
              </div>
              <div className="settings-row-control">
                <button
                  type="button"
                  role="switch"
                  aria-checked={appearance.dimInactivePanes}
                  aria-label="Dim Inactive Panes"
                  className={`settings-switch ${appearance.dimInactivePanes ? "checked" : ""}`}
                  onClick={toggleDimInactive}
                >
                  <span className="settings-switch-thumb" />
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
