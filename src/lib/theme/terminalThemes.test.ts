import { describe, it, expect } from "vitest";
import {
  getTerminalTheme,
  getAllTerminalThemes,
  TERMINAL_THEMES,
} from "./terminalThemes";
import type { TerminalThemeId } from "../settings/types";

describe("terminalThemes catalog", () => {
  it("provides 11 complete themes with valid color values", () => {
    const all = getAllTerminalThemes();
    expect(all.length).toBe(11);

    const expectedIds: TerminalThemeId[] = [
      "oppa_dark",
      "dracula",
      "tokyo_night",
      "one_dark",
      "nord",
      "catppuccin_mocha",
      "monokai_pro",
      "solarized_dark",
      "ghostty_dark",
      "github_dark",
      "minimal_light",
    ];

    expect(all.map((t) => t.id)).toEqual(expectedIds);

    for (const item of all) {
      expect(item.id).toBeDefined();
      expect(item.name).toBeTruthy();
      expect(typeof item.isDark).toBe("boolean");
      expect(item.previewColors).toHaveLength(4);

      const theme = getTerminalTheme(item.id);
      expect(theme.background).toMatch(/^#|^rgba/);
      expect(theme.foreground).toMatch(/^#/);
      expect(theme.cursor).toMatch(/^#/);
      expect(theme.cursorAccent).toBeDefined();
      expect(theme.selectionBackground).toBeDefined();
      expect(theme.black).toMatch(/^#/);
      expect(theme.red).toMatch(/^#/);
      expect(theme.green).toMatch(/^#/);
      expect(theme.yellow).toMatch(/^#/);
      expect(theme.blue).toMatch(/^#/);
      expect(theme.magenta).toMatch(/^#/);
      expect(theme.cyan).toMatch(/^#/);
      expect(theme.white).toMatch(/^#/);
      expect(theme.brightBlack).toMatch(/^#/);
      expect(theme.brightRed).toMatch(/^#/);
      expect(theme.brightGreen).toMatch(/^#/);
      expect(theme.brightYellow).toMatch(/^#/);
      expect(theme.brightBlue).toMatch(/^#/);
      expect(theme.brightMagenta).toMatch(/^#/);
      expect(theme.brightCyan).toMatch(/^#/);
      expect(theme.brightWhite).toMatch(/^#/);
    }
  });

  it("identifies Minimal Light as light theme and others as dark", () => {
    const all = getAllTerminalThemes();
    const lightThemes = all.filter((t) => !t.isDark);
    expect(lightThemes).toHaveLength(1);
    expect(lightThemes[0].id).toBe("minimal_light");
  });

  it("falls back to OPPA Dark for unknown theme ID", () => {
    // @ts-expect-error testing invalid ID fallback
    const theme = getTerminalTheme("nonexistent_theme");
    expect(theme.background).toBe(TERMINAL_THEMES.oppa_dark.background);
    expect(theme.foreground).toBe(TERMINAL_THEMES.oppa_dark.foreground);
  });

  it("injects scrollbar slider slots into every returned theme", () => {
    const theme = getTerminalTheme("oppa_dark");
    expect(theme.overviewRulerBorder).toBe("transparent");
    expect(theme.scrollbarSliderBackground).toBe("rgba(140, 140, 148, 0.28)");
    expect(theme.scrollbarSliderHoverBackground).toBe("rgba(140, 140, 148, 0.45)");
    expect(theme.scrollbarSliderActiveBackground).toBe("rgba(140, 140, 148, 0.6)");
    // Explicit theme values still win over the defaults.
    const customized = getTerminalTheme("dracula");
    expect(customized.background).toBe(TERMINAL_THEMES.dracula.background);
  });
});
