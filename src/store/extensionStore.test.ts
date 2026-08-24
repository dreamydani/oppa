import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleExtensionCrash,
  useExtensionStore,
} from "./extensionStore";
import { syncExtensionThemes, isExtensionTheme } from "../lib/theme/terminalThemes";
import type { ExtensionListItem } from "../lib/extensions/extensionTransport";

vi.mock("../lib/extensions/extensionTransport", () => ({
  listExtensions: vi.fn(),
  setExtensionEnabled: vi.fn(),
  getContributions: vi.fn(),
  getExtensionFingerprint: vi.fn(),
  grantExtensionConsent: vi.fn(),
  CONSENT_REQUIRED_PREFIX: "consent required:",
}));

import {
  listExtensions,
  setExtensionEnabled,
  getContributions,
  getExtensionFingerprint,
  grantExtensionConsent,
  CONSENT_REQUIRED_PREFIX,
} from "../lib/extensions/extensionTransport";

const listExtensionsMock = vi.mocked(listExtensions);
const setEnabledMock = vi.mocked(setExtensionEnabled);
const getContributionsMock = vi.mocked(getContributions);
const getFingerprintMock = vi.mocked(getExtensionFingerprint);
const grantConsentMock = vi.mocked(grantExtensionConsent);

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
    is_scriptable: false,
    capabilities: [],
    consent_required: false,
    crash_error: null,
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

  describe("consent flow (scriptable extensions)", () => {
    function scriptExt(enabled: boolean) {
      return {
        ...themePack(enabled),
        id: "acme.notifier",
        name: "Notifier",
        is_scriptable: true,
        capabilities: ["notifications", "events"],
      };
    }

    beforeEach(() => {
      vi.mocked(setExtensionEnabled).mockClear?.();
    });

    it("opens the consent dialog when the backend demands consent", async () => {
      listExtensionsMock.mockResolvedValue([scriptExt(false)]);
      getContributionsMock.mockResolvedValue({ themes: [] });
      setEnabledMock.mockRejectedValue(
        new Error(`${CONSENT_REQUIRED_PREFIX} needs approval`),
      );
      await useExtensionStore.getState().load();

      // Boot policy leaves unconsented scriptable exts disabled; user flips on.
      await useExtensionStore.getState().toggleExtension("acme.notifier", true);

      const state = useExtensionStore.getState();
      expect(state.pendingConsentId).toBe("acme.notifier");
      // Switch rolled back — nothing runs without approval.
      expect(state.extensions[0].enabled).toBe(false);
    });

    it("grantConsentAndEnable enables and closes the dialog", async () => {
      // load -> disabled; post-grant refresh reports it enabled.
      listExtensionsMock
        .mockResolvedValueOnce([scriptExt(false)])
        .mockResolvedValue([scriptExt(true)]);
      getContributionsMock.mockResolvedValue({ themes: [] });
      await useExtensionStore.getState().load();
      setEnabledMock.mockRejectedValue(
        new Error(`${CONSENT_REQUIRED_PREFIX} needs approval`),
      );
      await useExtensionStore.getState().toggleExtension("acme.notifier", true);
      expect(useExtensionStore.getState().pendingConsentId).toBe("acme.notifier");

      getFingerprintMock.mockResolvedValue("fp-123");
      grantConsentMock.mockResolvedValue(undefined);

      await useExtensionStore.getState().grantConsentAndEnable("acme.notifier");

      expect(grantConsentMock).toHaveBeenCalledWith("acme.notifier", "fp-123");
      const state = useExtensionStore.getState();
      expect(state.pendingConsentId).toBeNull();
      expect(state.extensions[0].enabled).toBe(true);
    });

    it("dismissConsent closes the dialog without enabling", async () => {
      listExtensionsMock.mockResolvedValue([scriptExt(false)]);
      getContributionsMock.mockResolvedValue({ themes: [] });
      await useExtensionStore.getState().load();
      setEnabledMock.mockRejectedValue(
        new Error(`${CONSENT_REQUIRED_PREFIX} x`),
      );
      await useExtensionStore.getState().toggleExtension("acme.notifier", true);
      expect(useExtensionStore.getState().pendingConsentId).not.toBeNull();

      useExtensionStore.getState().dismissConsent();
      expect(useExtensionStore.getState().pendingConsentId).toBeNull();
      expect(useExtensionStore.getState().extensions[0].enabled).toBe(false);
    });
  });

  it("crash events disable the extension and surface the reason", () => {
    listExtensionsMock.mockResolvedValue([
      {
        ...themePack(true),
        id: "acme.notifier",
        name: "Notifier",
        is_scriptable: true,
      },
    ]);
    getContributionsMock.mockResolvedValue(MIDNIGHT_CONTRIBUTION);
    return useExtensionStore.getState().load().then(() => {
      handleExtensionCrash({ id: "acme.notifier", reason: "watchdog abort" });

      const ext = useExtensionStore.getState().extensions[0];
      expect(ext.enabled).toBe(false);
      expect(ext.crash_error).toBe("watchdog abort");
    });
  });
});
