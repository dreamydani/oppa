import { describe, it, expect, vi, beforeEach } from "vitest";
import { useExtensionStore } from "./extensionStore";
import { syncExtensionThemes, isExtensionTheme } from "../lib/theme/terminalThemes";
import type { ExtensionListItem } from "../lib/extensions/extensionTransport";

vi.mock("../lib/extensions/extensionTransport", () => ({
  listExtensions: vi.fn(),
  setExtensionEnabled: vi.fn(),
  getContributions: vi.fn(),
}));

import {
  listExtensions,
  setExtensionEnabled,
  getContributions,
} from "../lib/extensions/extensionTransport";

const listExtensionsMock = vi.mocked(listExtensions);
const setEnabledMock = vi.mocked(setExtensionEnabled);
const getContributionsMock = vi.mocked(getContributions);

function themePack(enabled: boolean): ExtensionListItem {
  return {
    id: "oppa.theme-pack",
    name: "Oppa Theme Pack",
    version: "1.0.0",
    description: "Extra terminal themes.",
    is_builtin: true,
    enabled,
    error: null,
    theme_count: 3,
    snippet_count: 0,
    command_count: 0,
  };
}

const MIDNIGHT_CONTRIBUTION = {
  themes: [
    {
      extension_id: "oppa.theme-pack",
      theme_id: "oppa.theme-pack:midnight",
      name: "Midnight",
      theme_type: "dark" as const,
      colors: { background: "#0a0e14", foreground: "#d5d8df" },
      preview_colors: ["#0a0e14", "#d5d8df", "#58a6ff", "#f87171"] as [
        string,
        string,
        string,
        string,
      ],
    },
  ],
};

describe("extensionStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncExtensionThemes([]);
    useExtensionStore.setState({ status: "idle", extensions: [], loadError: null });
  });

  it("loads extensions and registers their theme contributions", async () => {
    listExtensionsMock.mockResolvedValue([themePack(true)]);
    getContributionsMock.mockResolvedValue(MIDNIGHT_CONTRIBUTION);

    await useExtensionStore.getState().load();

    const state = useExtensionStore.getState();
    expect(state.status).toBe("ready");
    expect(state.extensions).toHaveLength(1);
    expect(state.extensions[0].id).toBe("oppa.theme-pack");
    expect(isExtensionTheme("oppa.theme-pack:midnight")).toBe(true);
  });

  it("reports unavailable instead of throwing when the backend has no registry", async () => {
    listExtensionsMock.mockRejectedValue(new Error("command not registered"));

    await useExtensionStore.getState().load();

    const state = useExtensionStore.getState();
    expect(state.status).toBe("unavailable");
    expect(state.loadError).toContain("command not registered");
    expect(state.extensions).toEqual([]);
  });

  it("toggleExtension flips state optimistically and persists", async () => {
    listExtensionsMock.mockResolvedValue([themePack(true)]);
    getContributionsMock.mockResolvedValue(MIDNIGHT_CONTRIBUTION);
    setEnabledMock.mockResolvedValue(undefined);
    await useExtensionStore.getState().load();

    // Disable also drops the contribution from the theme registry.
    getContributionsMock.mockResolvedValue({ themes: [] });
    await useExtensionStore.getState().toggleExtension("oppa.theme-pack", false);

    expect(setEnabledMock).toHaveBeenCalledWith("oppa.theme-pack", false);
    expect(useExtensionStore.getState().extensions[0].enabled).toBe(false);
    expect(isExtensionTheme("oppa.theme-pack:midnight")).toBe(false);
  });

  it("rolls back the optimistic flip when persistence fails", async () => {
    listExtensionsMock.mockResolvedValue([themePack(true)]);
    getContributionsMock.mockResolvedValue(MIDNIGHT_CONTRIBUTION);
    await useExtensionStore.getState().load();

    setEnabledMock.mockRejectedValue(new Error("disk full"));
    await expect(
      useExtensionStore.getState().toggleExtension("oppa.theme-pack", false),
    ).rejects.toThrow("disk full");

    // The switch never lies.
    expect(useExtensionStore.getState().extensions[0].enabled).toBe(true);
  });
});
