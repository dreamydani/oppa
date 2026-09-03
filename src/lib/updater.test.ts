import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { resolveChannel } from "./channel";
import {
  checkForUpdate,
  canUpgradeSafely,
  probeUpgradeSafety,
  type UpdateInfo,
  type CanUpgradeDaemonResult,
} from "./updater";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

async function setChannel(channel: "dev" | "stable") {
  invokeMock.mockResolvedValue(channel);
  await resolveChannel();
}

describe("updater seam", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // The channel cache is module-level; force a failed resolve to clear it
    // so tests don't leak a cached channel into each other (see channel.ts).
    invokeMock.mockRejectedValue(new Error("reset"));
    await resolveChannel();
  });

  it("returns null on dev and never calls check_for_update", async () => {
    await setChannel("dev");
    const result = await checkForUpdate();
    expect(result).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith("check_for_update");
  });

  it("resolves an uncached channel and returns the payload on stable", async () => {
    invokeMock.mockResolvedValueOnce("stable");
    invokeMock.mockResolvedValueOnce({ version: "0.2.3", download: "https://example.com/i.msi", available: true });
    const result = await checkForUpdate();
    expect(invokeMock).toHaveBeenNthCalledWith(1, "app_channel");
    expect(invokeMock).toHaveBeenCalledWith("check_for_update");
    expect(result?.available).toBe(true);
  });

  it("returns null without check_for_update when the uncached channel is dev", async () => {
    invokeMock.mockResolvedValueOnce("dev");
    const result = await checkForUpdate();
    expect(result).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith("check_for_update");
  });

  it("returns null without check_for_update when the uncached channel rejects", async () => {
    invokeMock.mockRejectedValueOnce(new Error("no tauri"));
    const result = await checkForUpdate();
    expect(result).toBeNull();
    expect(invokeMock).not.toHaveBeenCalledWith("check_for_update");
  });

  it("invokes check_for_update on stable and returns the update info", async () => {
    await setChannel("stable");
    const payload: UpdateInfo = {
      version: "0.2.0",
      download:
        "https://github.com/dreamydani/oppa/releases/download/v0.2.0/oppa_0.2.0_x64-setup.exe",
      available: true,
    };
    invokeMock.mockResolvedValue(payload);
    const result = await checkForUpdate();
    expect(invokeMock).toHaveBeenCalledWith("check_for_update");
    expect(result).toEqual(payload);
  });

  it("returns null when invoke rejects (offline / 404 / bad JSON)", async () => {
    await setChannel("stable");
    invokeMock.mockRejectedValue(new Error("network down"));
    const result = await checkForUpdate();
    expect(result).toBeNull();
  });

  describe("canUpgradeSafely", () => {
    const IDLE: CanUpgradeDaemonResult = { safe: true, sessionCount: 0, unknown: false };
    const BUSY: CanUpgradeDaemonResult = { safe: false, sessionCount: 3, unknown: false };
    const UNKNOWN: CanUpgradeDaemonResult = { safe: false, sessionCount: 0, unknown: true };

    it("returns 'unknown' on dev and never invokes can_upgrade_daemon", async () => {
      await setChannel("dev");
      expect(await canUpgradeSafely()).toBe("unknown");
      expect(invokeMock).not.toHaveBeenCalledWith("can_upgrade_daemon");
    });

    it("returns 'unknown' when the channel is unresolved", async () => {
      expect(await canUpgradeSafely()).toBe("unknown");
      expect(invokeMock).not.toHaveBeenCalledWith("can_upgrade_daemon");
    });

    it("maps idle to 'idle' on stable", async () => {
      await setChannel("stable");
      invokeMock.mockResolvedValue(IDLE);
      expect(await canUpgradeSafely()).toBe("idle");
    });

    it("maps busy to 'busy' and surfaces the live session count via probeUpgradeSafety", async () => {
      await setChannel("stable");
      invokeMock.mockResolvedValue(BUSY);
      expect(await canUpgradeSafely()).toBe("busy");
      // Each call is one can_upgrade_daemon round trip (app_channel excluded).
      const daemonProbes = () =>
        invokeMock.mock.calls.filter((c) => c[0] === "can_upgrade_daemon").length;
      expect(daemonProbes()).toBe(1);
      const probe = await probeUpgradeSafety();
      expect(probe).toEqual({ status: "busy", sessionCount: 3 });
      expect(daemonProbes()).toBe(2);
    });

    it("maps unknown (error / None payload) to 'unknown' — never 'idle'", async () => {
      await setChannel("stable");
      invokeMock.mockResolvedValue(UNKNOWN);
      expect(await canUpgradeSafely()).toBe("unknown");
    });

    it("returns 'unknown' when the command rejects (transport failure)", async () => {
      await setChannel("stable");
      invokeMock.mockRejectedValue(new Error("daemon unreachable"));
      expect(await canUpgradeSafely()).toBe("unknown");
    });
  });
});
