import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import { resolveChannel } from "./channel";
import {
  checkForUpdate,
  canUpgradeSafely,
  probeUpgradeSafety,
  checkForNativeUpdate,
  downloadNativeUpdate,
  installNativeUpdateAndRelaunch,
  type UpdateInfo,
  type CanUpgradeDaemonResult,
} from "./updater";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const checkMock = vi.mocked(check);
const relaunchMock = vi.mocked(relaunch);

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

  describe("native updater seam", () => {
    const IDLE: CanUpgradeDaemonResult = { safe: true, sessionCount: 0, unknown: false };
    const BUSY: CanUpgradeDaemonResult = { safe: false, sessionCount: 3, unknown: false };
    const UNKNOWN: CanUpgradeDaemonResult = { safe: false, sessionCount: 0, unknown: true };

    // A structural fake of the plugin's Update resource: only the surface the
    // seam touches (version fields + download/install) is stubbed.
    function fakeNativeUpdate() {
      return {
        version: "0.3.0",
        currentVersion: "0.2.3",
        date: "2026-09-04",
        body: "notes",
        download: vi.fn().mockResolvedValue(undefined),
        install: vi.fn().mockResolvedValue(undefined),
      };
    }

    function emitFullProgress(onEvent: (e: DownloadEvent) => void) {
      onEvent({ event: "Started", data: { contentLength: 100 } });
      onEvent({ event: "Progress", data: { chunkLength: 40 } });
      onEvent({ event: "Progress", data: { chunkLength: 60 } });
      onEvent({ event: "Finished" });
    }

    function downloadWithFullProgress() {
      return vi.fn().mockImplementation((onEvent?: (e: DownloadEvent) => void) => {
        if (onEvent) emitFullProgress(onEvent);
        return Promise.resolve();
      });
    }

    async function establishPending() {
      await setChannel("stable");
      const update = fakeNativeUpdate();
      update.download = downloadWithFullProgress();
      checkMock.mockResolvedValue(update as unknown as Update);
      const info = await checkForNativeUpdate();
      expect(info?.version).toBe("0.3.0");
      return update;
    }

    it("returns null on dev and never calls the plugin check", async () => {
      await setChannel("dev");
      expect(await checkForNativeUpdate()).toBeNull();
      expect(checkMock).not.toHaveBeenCalled();
    });

    it("returns null without plugin calls when the channel is unresolved", async () => {
      expect(await checkForNativeUpdate()).toBeNull();
      expect(checkMock).not.toHaveBeenCalled();
    });

    it("returns null when the plugin reports no update", async () => {
      await setChannel("stable");
      checkMock.mockResolvedValue(null);
      expect(await checkForNativeUpdate()).toBeNull();
    });

    it("returns the version info when an update is available", async () => {
      await setChannel("stable");
      checkMock.mockResolvedValue(fakeNativeUpdate() as unknown as Update);
      const info = await checkForNativeUpdate();
      expect(checkMock).toHaveBeenCalledTimes(1);
      expect(info).toEqual({
        version: "0.3.0",
        currentVersion: "0.2.3",
        date: "2026-09-04",
        body: "notes",
      });
    });

    it("returns null when the plugin check rejects (pre-H1 signature failure is fail-silent)", async () => {
      await setChannel("stable");
      checkMock.mockRejectedValue(new Error("signature verification failed"));
      await expect(checkForNativeUpdate()).resolves.toBeNull();
    });

    it("download emits the progress sequence then resolves ok", async () => {
      const update = await establishPending();
      const progress: Array<[number, number?]> = [];
      const result = await downloadNativeUpdate((downloaded, total) =>
        progress.push([downloaded, total]),
      );
      expect(update.download).toHaveBeenCalledTimes(1);
      expect(progress).toEqual([
        [0, 100],
        [40, 100],
        [100, 100],
      ]);
      expect(result).toEqual({ ok: true });
    });

    it("download returns an error result when the plugin download rejects", async () => {
      await establishPending();
      const update = fakeNativeUpdate();
      update.download = vi.fn().mockRejectedValue(new Error("signature verification failed"));
      checkMock.mockResolvedValue(update as unknown as Update);
      await checkForNativeUpdate();
      const result = await downloadNativeUpdate(() => {});
      expect(result).toEqual({ ok: false, error: "signature verification failed" });
    });

    it("download returns an error result with no pending update", async () => {
      await setChannel("stable");
      checkMock.mockResolvedValue(null);
      await checkForNativeUpdate();
      const result = await downloadNativeUpdate(() => {});
      expect(result).toEqual({ ok: false, error: expect.any(String) });
    });

    it("install blocks on busy without touching plugin download/install/relaunch", async () => {
      const update = await establishPending();
      invokeMock.mockResolvedValue(BUSY);
      const outcome = await installNativeUpdateAndRelaunch(() => {});
      expect(outcome).toEqual({ proceeded: false, reason: "busy", sessionCount: 3 });
      expect(update.download).not.toHaveBeenCalled();
      expect(update.install).not.toHaveBeenCalled();
      expect(relaunchMock).not.toHaveBeenCalled();
    });

    it("install proceeds on idle: download with progress, install, relaunch", async () => {
      const update = await establishPending();
      invokeMock.mockResolvedValue(IDLE);
      const progress: Array<[number, number?]> = [];
      const outcome = await installNativeUpdateAndRelaunch((downloaded, total) =>
        progress.push([downloaded, total]),
      );
      expect(outcome).toEqual({ proceeded: true });
      expect(update.download).toHaveBeenCalledTimes(1);
      expect(progress).toEqual([
        [0, 100],
        [40, 100],
        [100, 100],
      ]);
      expect(update.install).toHaveBeenCalledTimes(1);
      expect(relaunchMock).toHaveBeenCalledTimes(1);
    });

    it("install proceeds on unknown without claiming safe", async () => {
      const update = await establishPending();
      invokeMock.mockResolvedValue(UNKNOWN);
      const outcome = await installNativeUpdateAndRelaunch(() => {});
      expect(outcome).toEqual({ proceeded: true });
      expect(update.download).toHaveBeenCalledTimes(1);
      expect(update.install).toHaveBeenCalledTimes(1);
      expect(relaunchMock).toHaveBeenCalledTimes(1);
    });

    it("install skips re-download when already downloaded", async () => {
      const update = await establishPending();
      invokeMock.mockResolvedValue(IDLE);
      expect(await downloadNativeUpdate(() => {})).toEqual({ ok: true });
      const outcome = await installNativeUpdateAndRelaunch(() => {});
      expect(outcome).toEqual({ proceeded: true });
      expect(update.download).toHaveBeenCalledTimes(1);
      expect(update.install).toHaveBeenCalledTimes(1);
    });

    it("install returns an error result when the plugin install rejects", async () => {
      const update = fakeNativeUpdate();
      update.download = downloadWithFullProgress();
      update.install = vi.fn().mockRejectedValue(new Error("install failed"));
      await setChannel("stable");
      checkMock.mockResolvedValue(update as unknown as Update);
      await checkForNativeUpdate();
      invokeMock.mockResolvedValue(IDLE);
      const outcome = await installNativeUpdateAndRelaunch(() => {});
      expect(outcome).toEqual({ proceeded: false, reason: "error", error: "install failed" });
      expect(relaunchMock).not.toHaveBeenCalled();
    });
  });
});
