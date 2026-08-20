import React from "react";
import { useTerminalStore } from "../../store/terminalStore";
import {
  getTerminalTheme,
  getAllTerminalThemes,
} from "../../lib/theme/terminalThemes";
import type { TerminalCursorStyle } from "../../lib/settings/types";
import { TerminalPreviewBox } from "./TerminalPreviewBox";
import "./AppearanceSettingsPane.css";

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

  return (
    <div
      className="settings-pane appearance-settings-pane"
      role="region"
      aria-label="Appearance Settings"
    >
      <div className="settings-pane-container">
        {/* Header */}
        <div className="settings-pane-header">
          <h2 className="settings-pane-title">Appearance</h2>
          <p className="settings-pane-desc">
            Terminal theme, typography, cursor style, and window visual options.
          </p>
        </div>

        <div className="settings-pane-content">
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
                  aria-label="Font Family Preset"
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
              <label htmlFor="custom-font-input" className="settings-sub-label">
                Custom Font:
              </label>
              <input
                id="custom-font-input"
                type="text"
                className="settings-input custom-font-input"
                placeholder="'Geist Mono', Consolas, monospace"
                value={appearance.fontFamily}
                onChange={(e) => handleCustomFontChange(e.target.value)}
                aria-label="Custom Font Family"
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
