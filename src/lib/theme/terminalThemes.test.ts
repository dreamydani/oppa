import { describe, it, expect, beforeEach } from "vitest";
import {
  getTerminalTheme,
  getAllTerminalThemes,
  syncExtensionThemes,
  isExtensionTheme,
  extensionThemeOwner,
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
    // Widened TerminalThemeId admits arbitrary extension ids, so a plain
    // string type-checks; resolution still falls back to oppa_dark.
    const theme = getTerminalTheme("nonexistent_theme");
    expect(theme.background).toBe(TERMINAL_THEMES.oppa_dark.background);
    expect(theme.foreground).toBe(TERMINAL_THEMES.oppa_dark.foreground);
  });

  it("injects scrollbar slider slots into every returned theme", () => {
    const theme = getTerminalTheme("oppa_dark");
    // Regression: named "transparent" throws in xterm's css.toColor and falls
    // back to its #ffffff default, painting a white 1px ruler outline.
    expect(theme.overviewRulerBorder).toBe("#00000000");
    expect(theme.scrollbarSliderBackground).toBe("rgba(140, 140, 148, 0.28)");
    expect(theme.scrollbarSliderHoverBackground).toBe("rgba(140, 140, 148, 0.45)");
    expect(theme.scrollbarSliderActiveBackground).toBe("rgba(140, 140, 148, 0.6)");
    // Explicit theme values still win over the defaults.
    const customized = getTerminalTheme("dracula");
    expect(customized.background).toBe(TERMINAL_THEMES.dracula.background);
  });
});

describe("extension-contributed themes", () => {
  beforeEach(() => {
    syncExtensionThemes([]);
  });

  const midnight = {
    extension_id: "oppa.theme-pack",
    theme_id: "oppa.theme-pack:midnight",
    name: "Midnight",
    theme_type: "dark" as const,
    colors: {
      background: "#0a0e14",
      foreground: "#d5d8df",
      cursor: "#58a6ff",
      red: "#f87171",
    },
    preview_colors: ["#0a0e14", "#d5d8df", "#58a6ff", "#f87171"],
  };

  it("registers contributed themes into the catalog and resolver", () => {
    syncExtensionThemes([midnight]);

    const all = getAllTerminalThemes();
    expect(all.some((t) => t.id === "oppa.theme-pack:midnight")).toBe(true);
    // Built-ins stay first, contributions appended.
    expect(all[all.length - 1].id).toBe("oppa.theme-pack:midnight");

    const theme = getTerminalTheme("oppa.theme-pack:midnight");
    expect(theme.background).toBe("#0a0e14");
    expect(theme.foreground).toBe("#d5d8df");
    expect(isExtensionTheme("oppa.theme-pack:midnight")).toBe(true);
    expect(extensionThemeOwner("oppa.theme-pack:midnight")).toBe("oppa.theme-pack");
  });

  it("resync replaces the whole set (disable removes themes)", () => {
    syncExtensionThemes([midnight]);
    syncExtensionThemes([]);
    expect(getAllTerminalThemes().some((t) => t.id === "oppa.theme-pack:midnight")).toBe(false);
    expect(isExtensionTheme("oppa.theme-pack:midnight")).toBe(false);
    // Resolution falls back to oppa_dark once the contribution is gone.
    const fallback = getTerminalTheme("oppa.theme-pack:midnight");
    expect(fallback.background).toBe(TERMINAL_THEMES.oppa_dark.background);
  });

  it("skips entries missing background or foreground", () => {
    syncExtensionThemes([
      {
        ...midnight,
        theme_id: "bad:no-background",
        colors: { foreground: "#ffffff" },
      },
      {
        ...midnight,
        theme_id: "bad:no-foreground",
        colors: { background: "#000000" },
      },
    ]);
    expect(getAllTerminalThemes()).toHaveLength(11);
  });

  it("derives preview swatches when a manifest omits them", () => {
    syncExtensionThemes([{ ...midnight, preview_colors: [] }]);
    const entry = getAllTerminalThemes().find((t) => t.id === "oppa.theme-pack:midnight");
    expect(entry?.previewColors).toHaveLength(4);
    expect(entry?.previewColors[0]).toBe("#0a0e14");
  });
});
