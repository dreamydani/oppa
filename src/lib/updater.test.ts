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
  classifyUpdateError,
  downloadNativeUpdate,
  installNativeUpdateAndRelaunch,
  isNativeVersionForChannel,
  type UpdateInfo,
  type CanUpgradeDaemonResult,
} from "./updater";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const checkMock = vi.mocked(check);
const relaunchMock = vi.mocked(relaunch);

async function setChannel(channel: "dev" | "stable" | "rc") {
  invokeMock.mockResolvedValue(channel);
  await resolveChannel();
}

describe("updater seam", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // Module-level singletons leak across tests: the staged native update
    // (plus its downloaded flag) must be released, or a same-version
    // re-check in the next test would inherit the previous test's flag.
    try {
      invokeMock.mockResolvedValue("stable");
      await resolveChannel();
      checkMock.mockResolvedValue(null);
      await checkForNativeUpdate();
    } catch {
      // Release path is fail-silent by design; teardown must never throw.
    }
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

  it("invokes check_for_update on rc like stable", async () => {
    await setChannel("rc");
    const payload: UpdateInfo = {
      version: "0.3.0-rc.1",
      download: "https://example.com/rc.msi",
      available: true,
    };
    invokeMock.mockResolvedValue(payload);
    const result = await checkForUpdate();
    expect(invokeMock).toHaveBeenCalledWith("check_for_update");
    expect(result).toEqual(payload);
  });

  it("rc native check uses the plugin feed (stable+rc native)", async () => {
    // WHY: tauri.conf.json endpoints lists stable latest.json plus the pinned
    // rc feed; rc builds use the native flow like stable.
    await setChannel("rc");
    checkMock.mockResolvedValue({
      version: "0.3.0-rc.1",
      currentVersion: "0.3.0-rc.0",
    } as unknown as Update);
    const info = await checkForNativeUpdate();
    expect(checkMock).toHaveBeenCalled();
    expect(info?.version).toBe("0.3.0-rc.1");
  });

  it("stable native check ignores prerelease versions from the rc feed", async () => {
    await setChannel("stable");
    checkMock.mockResolvedValue({
      version: "0.3.0-rc.1",
      currentVersion: "0.2.5",
    } as unknown as Update);
    const info = await checkForNativeUpdate();
    expect(info).toBeNull();
  });

  it("rc native check accepts stable promotions", async () => {
    await setChannel("rc");
    checkMock.mockResolvedValue({
      version: "0.2.6",
      currentVersion: "0.2.6-rc.1",
    } as unknown as Update);
    const info = await checkForNativeUpdate();
    expect(info?.version).toBe("0.2.6");
  });

  it("invokes check_for_update on stable and returns the update info", async () => {    await setChannel("stable");
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

    it("probe self-resolves an uncached stable channel then probes the daemon", async () => {
      // Same getChannel() ?? resolveChannel().catch() pattern as the checks:
      // uncached + stable must still reach can_upgrade_daemon.
      invokeMock.mockResolvedValueOnce("stable");
      invokeMock.mockResolvedValue({ safe: true, sessionCount: 0, unknown: false });
      const probe = await probeUpgradeSafety();
      expect(invokeMock).toHaveBeenCalledWith("app_channel");
      expect(invokeMock).toHaveBeenCalledWith("can_upgrade_daemon");
      expect(probe).toEqual({ status: "idle", sessionCount: 0 });
    });

    it("probe returns unknown without invoke when the uncached channel is dev", async () => {
      invokeMock.mockResolvedValueOnce("dev");
      const probe = await probeUpgradeSafety();
      expect(invokeMock).toHaveBeenCalledWith("app_channel");
      expect(invokeMock).not.toHaveBeenCalledWith("can_upgrade_daemon");
      expect(probe).toEqual({ status: "unknown", sessionCount: 0 });
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

    it("closes the displaced pending Update when a newer check supersedes it", async () => {
      await setChannel("stable");
      const first = fakeNativeUpdate();
      const closeFirst = vi.fn().mockResolvedValue(undefined);
      (first as unknown as { close: () => Promise<void> }).close = closeFirst;
      checkMock.mockResolvedValue(first as unknown as Update);
      await checkForNativeUpdate();

      const second = fakeNativeUpdate();
      const closeSecond = vi.fn().mockResolvedValue(undefined);
      (second as unknown as { close: () => Promise<void> }).close = closeSecond;
      checkMock.mockResolvedValue(second as unknown as Update);
      const info = await checkForNativeUpdate();

      expect(info?.version).toBe("0.3.0");
      expect(closeFirst).toHaveBeenCalledTimes(1);
      expect(closeSecond).not.toHaveBeenCalled();
    });

    it("tolerates a displaced pending Update without close (struct fakes)", async () => {
      await setChannel("stable");
      checkMock.mockResolvedValue(fakeNativeUpdate() as unknown as Update);
      await checkForNativeUpdate();
      checkMock.mockResolvedValue(fakeNativeUpdate() as unknown as Update);
      await expect(checkForNativeUpdate()).resolves.not.toBeNull();
    });

    it("tolerates a displaced close that rejects (already released)", async () => {
      await setChannel("stable");
      const first = fakeNativeUpdate();
      (first as unknown as { close: () => Promise<void> }).close = vi
        .fn()
        .mockRejectedValue(new Error("gone"));
      checkMock.mockResolvedValue(first as unknown as Update);
      await checkForNativeUpdate();
      checkMock.mockResolvedValue(fakeNativeUpdate() as unknown as Update);
      await expect(checkForNativeUpdate()).resolves.not.toBeNull();
    });

    it("closes the displaced pending Update when a check resolves empty", async () => {
      await setChannel("stable");
      const first = fakeNativeUpdate();
      const closeFirst = vi.fn().mockResolvedValue(undefined);
      (first as unknown as { close: () => Promise<void> }).close = closeFirst;
      checkMock.mockResolvedValue(first as unknown as Update);
      await checkForNativeUpdate();

      checkMock.mockResolvedValue(null);
      await expect(checkForNativeUpdate()).resolves.toBeNull();
      expect(closeFirst).toHaveBeenCalledTimes(1);
    });

    it("closes the displaced pending Update when the check rejects", async () => {
      await setChannel("stable");
      const first = fakeNativeUpdate();
      const closeFirst = vi.fn().mockResolvedValue(undefined);
      (first as unknown as { close: () => Promise<void> }).close = closeFirst;
      checkMock.mockResolvedValue(first as unknown as Update);
      await checkForNativeUpdate();

      checkMock.mockRejectedValue(new Error("offline"));
      await expect(checkForNativeUpdate()).resolves.toBeNull();
      expect(closeFirst).toHaveBeenCalledTimes(1);
    });

    it("preserves the staged pending Update on empty when asked", async () => {
      await setChannel("stable");
      const first = fakeNativeUpdate();
      const closeFirst = vi.fn().mockResolvedValue(undefined);
      (first as unknown as { close: () => Promise<void> }).close = closeFirst;
      checkMock.mockResolvedValue(first as unknown as Update);
      await checkForNativeUpdate();

      checkMock.mockResolvedValue(null);
      await expect(
        checkForNativeUpdate({ preservePendingOnEmpty: true }),
      ).resolves.toBeNull();
      expect(closeFirst).not.toHaveBeenCalled();

      // The survivor is still staged: superseding it closes it exactly once.
      checkMock.mockResolvedValue(fakeNativeUpdate() as unknown as Update);
      await checkForNativeUpdate();
      expect(closeFirst).toHaveBeenCalledTimes(1);
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

    it("install does not reject when the probe payload is malformed (degrades to unknown, proceeds)", async () => {
      const update = await establishPending();
      invokeMock.mockResolvedValue(null as unknown as CanUpgradeDaemonResult);
      const outcome = await installNativeUpdateAndRelaunch(() => {});
      expect(outcome).toEqual({ proceeded: true });
      expect(update.download).toHaveBeenCalledTimes(1);
      expect(update.install).toHaveBeenCalledTimes(1);
    });

    it("keeps nativeUpdateDownloaded=true on a same-version re-check", async () => {
      const update = await establishPending();
      invokeMock.mockResolvedValue({ safe: true, sessionCount: 0, unknown: false });
      expect(await downloadNativeUpdate(() => {})).toEqual({ ok: true });
      expect(update.download).toHaveBeenCalledTimes(1);
      // Same version re-check (new plugin resource, same version string).
      const sameVersion = fakeNativeUpdate();
      checkMock.mockResolvedValue(sameVersion as unknown as Update);
      const info = await checkForNativeUpdate();
      expect(info?.version).toBe("0.3.0");
      // Still downloaded: no second plugin download.
      expect(await downloadNativeUpdate(() => {})).toEqual({ ok: true });
      expect(update.download).toHaveBeenCalledTimes(1);
      expect(sameVersion.download).not.toHaveBeenCalled();
    });

    it("install returns an error value (no throw) when install ok but relaunch rejects", async () => {
      const update = await establishPending();
      invokeMock.mockResolvedValue(IDLE);
      relaunchMock.mockRejectedValue(new Error("relaunch denied"));
      const outcome = await installNativeUpdateAndRelaunch(() => {});
      expect(update.install).toHaveBeenCalledTimes(1);
      expect(outcome).toEqual({ proceeded: false, reason: "error", error: "relaunch denied" });
    });

    it("install runs onBeforeInstall flush before plugin install", async () => {
      const update = await establishPending();
      invokeMock.mockResolvedValue(IDLE);
      relaunchMock.mockResolvedValue(undefined);
      const order: string[] = [];
      update.install = vi.fn().mockImplementation(() => {
        order.push("install");
        return Promise.resolve();
      });
      const onBeforeInstall = vi.fn().mockImplementation(() => {
        order.push("flush");
        return Promise.resolve();
      });
      const outcome = await installNativeUpdateAndRelaunch(() => {}, { onBeforeInstall });
      expect(outcome).toEqual({ proceeded: true });
      expect(onBeforeInstall).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["flush", "install"]);
    });

    it("install proceeds when onBeforeInstall flush rejects (restore is best-effort)", async () => {
      const update = await establishPending();
      invokeMock.mockResolvedValue(IDLE);
      relaunchMock.mockResolvedValue(undefined);
      const onBeforeInstall = vi.fn().mockRejectedValue(new Error("disk full"));
      const outcome = await installNativeUpdateAndRelaunch(() => {}, { onBeforeInstall });
      expect(outcome).toEqual({ proceeded: true });
      expect(update.install).toHaveBeenCalledTimes(1);
    });
  });

  describe("channel version gate + error taxonomy", () => {
    it("stable rejects prerelease, rc accepts both", () => {
      expect(isNativeVersionForChannel("0.3.0", "stable")).toBe(true);
      expect(isNativeVersionForChannel("0.3.0-rc.1", "stable")).toBe(false);
      expect(isNativeVersionForChannel("0.3.0-rc.1", "rc")).toBe(true);
      expect(isNativeVersionForChannel("0.2.6", "rc")).toBe(true);
    });

    it("classifies signature / network / install / generic", () => {
      expect(classifyUpdateError("signature verification failed", "download")).toBe("signature");
      expect(classifyUpdateError("not signed by owner", "download")).toBe("signature");
      expect(classifyUpdateError("network unreachable", "download")).toBe("network");
      expect(classifyUpdateError("failed to fetch", "download")).toBe("network");
      expect(classifyUpdateError("install failed", "install")).toBe("install");
      expect(classifyUpdateError("boom", "download")).toBe("generic");
    });
  });
});
