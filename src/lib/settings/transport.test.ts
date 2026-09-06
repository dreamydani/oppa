import { describe, it, expect, vi, beforeEach } from "vitest";
import { saveSettings, loadSettings } from "./transport";
import { DEFAULT_APP_SETTINGS } from "./types";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const invokeMock = vi.mocked(invoke);

describe("settings transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("saveSettings", () => {
    it("calls save_settings with serialized JSON", async () => {
      invokeMock.mockResolvedValueOnce(undefined);
      await saveSettings(DEFAULT_APP_SETTINGS);
      expect(invokeMock).toHaveBeenCalledWith("save_settings", {
        settingsJson: JSON.stringify(DEFAULT_APP_SETTINGS),
      });
    });

    it("handles save error gracefully", async () => {
      invokeMock.mockRejectedValueOnce(new Error("IPC failure"));
      await expect(saveSettings(DEFAULT_APP_SETTINGS)).resolves.toBeUndefined();
    });
  });

  describe("loadSettings", () => {
    it("calls load_settings and parses JSON", async () => {
      invokeMock.mockResolvedValueOnce(JSON.stringify(DEFAULT_APP_SETTINGS));
      const result = await loadSettings();
      expect(invokeMock).toHaveBeenCalledWith("load_settings");
      expect(result).toEqual(DEFAULT_APP_SETTINGS);
    });

    it("merges partial loaded settings with defaults", async () => {
      const partial = {
        general: {
          defaultCwdMode: "custom",
          customDefaultCwd: "/custom/path",
        },
      };
      invokeMock.mockResolvedValueOnce(JSON.stringify(partial));
      const result = await loadSettings();
      expect(result).toEqual({
        general: {
          ...DEFAULT_APP_SETTINGS.general,
          defaultCwdMode: "custom",
          customDefaultCwd: "/custom/path",
        },
        appearance: DEFAULT_APP_SETTINGS.appearance,
      });
    });

    it("merges partial appearance settings with defaults", async () => {
      const partial = {
        appearance: {
          themeName: "tokyo_night",
          fontSize: 16,
        },
      };
      invokeMock.mockResolvedValueOnce(JSON.stringify(partial));
      const result = await loadSettings();
      expect(result).toEqual({
        general: DEFAULT_APP_SETTINGS.general,
        appearance: {
          ...DEFAULT_APP_SETTINGS.appearance,
          themeName: "tokyo_night",
          fontSize: 16,
        },
      });
    });

    it("merges legacy appearance settings and fills in default app & ui appearance fields", async () => {
      const legacy = {
        appearance: {
          themeName: "dracula",
          fontSize: 16,
        },
      };
      invokeMock.mockResolvedValueOnce(JSON.stringify(legacy));
      const result = await loadSettings();
      expect(result?.appearance.themeName).toBe("dracula");
      expect(result?.appearance.appTheme).toBe("dark");
      expect(result?.appearance.appFontFamily).toBe(
        "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
      );
      expect(result?.appearance.uiZoom).toBe(1.0);
      expect(result?.appearance.sidebarOnLaunch).toBe("remember_last");
      expect(result?.appearance.showStatusBar).toBe(true);
      expect(result?.appearance.showTitlebarLogo).toBe(true);
    });

    it("preserves custom app & ui appearance fields", async () => {
      const custom = {
        appearance: {
          appTheme: "light",
          appFontFamily: "Inter, sans-serif",
          uiZoom: 1.1,
          sidebarOnLaunch: "collapsed",
          showStatusBar: false,
          showTitlebarLogo: false,
          themeName: "solarized_dark",
        },
      };
      invokeMock.mockResolvedValueOnce(JSON.stringify(custom));
      const result = await loadSettings();
      expect(result?.appearance.appTheme).toBe("light");
      expect(result?.appearance.appFontFamily).toBe("Inter, sans-serif");
      expect(result?.appearance.uiZoom).toBe(1.1);
      expect(result?.appearance.sidebarOnLaunch).toBe("collapsed");
      expect(result?.appearance.showStatusBar).toBe(false);
      expect(result?.appearance.showTitlebarLogo).toBe(false);
      expect(result?.appearance.themeName).toBe("solarized_dark");
    });

    it("normalizes snake_case legacy appearance keys to camelCase", async () => {
      const legacy = {
        appearance: {
          theme_name: "dracula",
          font_size: 16,
          app_theme: "light",
          ui_zoom: 1.1,
        },
      };
      invokeMock.mockResolvedValueOnce(JSON.stringify(legacy));
      const result = await loadSettings();
      expect(result?.appearance.themeName).toBe("dracula");
      expect(result?.appearance.fontSize).toBe(16);
      expect(result?.appearance.appTheme).toBe("light");
      expect(result?.appearance.uiZoom).toBe(1.1);
    });

    it("falls back to default theme for unknown theme ids", async () => {
      const bad = {
        appearance: {
          themeName: "not_a_real_theme_xyz",
        },
      };
      invokeMock.mockResolvedValueOnce(JSON.stringify(bad));
      const result = await loadSettings();
      expect(result?.appearance.themeName).toBe("oppa_dark");
    });

    it("returns null if load_settings returns null", async () => {
      invokeMock.mockResolvedValueOnce(null);
      const result = await loadSettings();
      expect(result).toBeNull();
    });

    it("returns null if load_settings returns empty string", async () => {
      invokeMock.mockResolvedValueOnce("");
      const result = await loadSettings();
      expect(result).toBeNull();
    });

    it("returns null if JSON is invalid", async () => {
      invokeMock.mockResolvedValueOnce("invalid-json{");
      const result = await loadSettings();
      expect(result).toBeNull();
    });

    it("returns null if invoke rejects", async () => {
      invokeMock.mockRejectedValueOnce(new Error("IPC failure"));
      const result = await loadSettings();
      expect(result).toBeNull();
    });
  });
});
