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
      });
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
