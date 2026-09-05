import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
import {
  UpdateBanner,
  MANUAL_UPDATE_CHECK_EVENT,
  UPDATE_AVAILABILITY_EVENT,
  type UpdateAvailabilityDetail,
} from "./UpdateBanner";
import * as updater from "../lib/updater";
import type {
  NativeUpdateInfo,
  NativeProgressCallback,
  NativeDownloadResult,
} from "../lib/updater";
import * as opener from "@tauri-apps/plugin-opener";
import { useTerminalStore } from "../store/terminalStore";

// The updater seam is mocked at module level. The card is a renderer: it must
// NEVER call the check seams (checkForNativeUpdate/checkForUpdate — the
// scheduler owns every check); it only uses the action seams
// (download/install/probe) plus the availability event bus.
vi.mock("../lib/updater", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/updater")>();
  return {
    checkForUpdate: vi.fn(),
    probeUpgradeSafety: vi.fn(),
    checkForNativeUpdate: vi.fn(),
    downloadNativeUpdate: vi.fn(),
    installNativeUpdateAndRelaunch: vi.fn(),
    classifyUpdateError: actual.classifyUpdateError,
  };
});

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

const checkForUpdateMock = vi.mocked(updater.checkForUpdate);
const probeUpgradeSafetyMock = vi.mocked(updater.probeUpgradeSafety);
const checkForNativeUpdateMock = vi.mocked(updater.checkForNativeUpdate);
const downloadNativeUpdateMock = vi.mocked(updater.downloadNativeUpdate);
const installNativeUpdateAndRelaunchMock = vi.mocked(
  updater.installNativeUpdateAndRelaunch,
);
const openUrlMock = vi.mocked(opener.openUrl);

const AVAILABLE = { version: "0.2.0", download: "https://example.com/oppa-0.2.0.exe", available: true };
const NATIVE: NativeUpdateInfo = { version: "0.3.0", currentVersion: "0.2.3" };

function setDismissed(version: string | null) {
  useTerminalStore.setState({
    settings: {
      ...useTerminalStore.getState().settings,
      general: { ...useTerminalStore.getState().settings.general, dismissedUpdateVersion: version },
    },
  });
}

function getDismissed() {
  return useTerminalStore.getState().settings.general.dismissedUpdateVersion;
}

function announce(detail: UpdateAvailabilityDetail) {
  act(() => {
    window.dispatchEvent(new CustomEvent(UPDATE_AVAILABILITY_EVENT, { detail }));
  });
}

function announceNative(version = NATIVE.version) {
  announce({ version, phase: "available", engine: "native", currentVersion: NATIVE.currentVersion });
}

function announceLegacy() {
  announce({ version: AVAILABLE.version, phase: "available", engine: "legacy", download: AVAILABLE.download });
}

function announceCleared() {
  announce({ version: null, phase: null });
}

function dispatchManualCheck() {
  act(() => {
    window.dispatchEvent(new CustomEvent(MANUAL_UPDATE_CHECK_EVENT));
  });
}

function clearedAvailabilityCount(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.filter(([event]) => {
    if (!(event instanceof CustomEvent)) return false;
    if (event.type !== UPDATE_AVAILABILITY_EVENT) return false;
    return (event as CustomEvent<UpdateAvailabilityDetail>).detail.version === null;
  }).length;
}

beforeEach(() => {
  checkForUpdateMock.mockReset();
  // Default: an idle daemon. Individual tests override for the busy/unknown
  // paths; existing Task 5 tests rely on the idle default to proceed.
  probeUpgradeSafetyMock.mockReset();
  probeUpgradeSafetyMock.mockResolvedValue({ status: "idle", sessionCount: 0 });
  // Default: no native update, so the legacy browser flow drives the card
  // unless a test opts into the native engine.
  checkForNativeUpdateMock.mockReset();
  checkForNativeUpdateMock.mockResolvedValue(null);
  downloadNativeUpdateMock.mockReset();
  downloadNativeUpdateMock.mockResolvedValue({ ok: true });
  installNativeUpdateAndRelaunchMock.mockReset();
  installNativeUpdateAndRelaunchMock.mockResolvedValue({ proceeded: true });
  openUrlMock.mockReset();
  // mockReset() clears the module-level mockResolvedValue above, so restore
  // the "resolves to undefined" default — openUrl must return a Promise for
  // the component's `.catch` chain to work.
  openUrlMock.mockResolvedValue(undefined);
  setDismissed(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UpdateBanner", () => {
  it("performs zero seam checks on mount; the scheduler owns every check", async () => {
    render(<UpdateBanner />);
    await act(async () => {});
    expect(screen.queryByTestId("update-banner")).not.toBeInTheDocument();
    expect(checkForNativeUpdateMock).not.toHaveBeenCalled();
    expect(checkForUpdateMock).not.toHaveBeenCalled();
  });

  it("renders the legacy banner with both buttons when a legacy availability arrives", async () => {
    render(<UpdateBanner />);
    await act(async () => {});
    announceLegacy();
    expect(await screen.findByText(/A new version of OPPA is available/)).toBeInTheDocument();
    expect(screen.getByText(/v0\.2\.0/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
    // The card rendered from the event — no check seam ran.
    expect(checkForNativeUpdateMock).not.toHaveBeenCalled();
    expect(checkForUpdateMock).not.toHaveBeenCalled();
  });

  it("renders nothing when availability is cleared", async () => {
    render(<UpdateBanner />);
    await act(async () => {});
    announceNative();
    await screen.findByRole("button", { name: "Download now" });
    announceCleared();
    await waitFor(() => expect(screen.queryByTestId("update-banner")).toBeNull());
  });

  it("renders nothing when the dismissed version equals the announced version", async () => {
    setDismissed("0.3.0");
    render(<UpdateBanner />);
    await act(async () => {});
    announceNative();
    await act(async () => {});
    expect(screen.queryByText(/v0\.3\.0/)).not.toBeInTheDocument();
  });

  it("shows the banner again when a newer version than the dismissed one is announced", async () => {
    setDismissed("0.1.9");
    render(<UpdateBanner />);
    await act(async () => {});
    announceLegacy();
    expect(await screen.findByText(/A new version of OPPA is available/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update now" })).toBeInTheDocument();
  });

  it("Not now hides the banner and persists dismissedUpdateVersion", async () => {
    render(<UpdateBanner />);
    await act(async () => {});
    announceLegacy();
    await screen.findByText(/A new version of OPPA is available/);

    act(() => {
      screen.getByRole("button", { name: "Not now" }).click();
    });

    expect(screen.queryByText(/A new version of OPPA is available/)).not.toBeInTheDocument();
    expect(getDismissed()).toBe("0.2.0");
  });

  it("Update now opens the download URL via the opener plugin", async () => {
    render(<UpdateBanner />);
    await act(async () => {});
    announceLegacy();
    await screen.findByText(/A new version of OPPA is available/);

    act(() => {
      screen.getByRole("button", { name: "Update now" }).click();
    });

    await waitFor(() =>
      expect(openUrlMock).toHaveBeenCalledWith("https://example.com/oppa-0.2.0.exe"),
    );
  });

  it("Update now shows the in-progress state and falls back to window.open when the opener rejects", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    openUrlMock.mockRejectedValue(new Error("no opener"));
    render(<UpdateBanner />);
    await act(async () => {});
    announceLegacy();
    await screen.findByText(/A new version of OPPA is available/);

    act(() => {
      screen.getByRole("button", { name: "Update now" }).click();
    });
    await waitFor(() =>
      expect(openSpy).toHaveBeenCalledWith(
        "https://example.com/oppa-0.2.0.exe",
        "_blank",
        "noopener,noreferrer",
      ),
    );
    expect(screen.getByText(/Downloading update/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
    openSpy.mockRestore();
  });

  // ---- task 7: session-running warning (seam-driven "Update now" flow) ----

  it("Update now probes the daemon and proceeds immediately when idle", async () => {
    probeUpgradeSafetyMock.mockResolvedValue({ status: "idle", sessionCount: 0 });
    render(<UpdateBanner />);
    await act(async () => {});
    announceLegacy();
    await screen.findByText(/A new version of OPPA is available/);

    act(() => {
      screen.getByRole("button", { name: "Update now" }).click();
    });

    expect(probeUpgradeSafetyMock).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(openUrlMock).toHaveBeenCalledWith("https://example.com/oppa-0.2.0.exe"),
    );
    // No warning state appears on the idle path.
    expect(screen.queryByText(/sessions are still running/i)).not.toBeInTheDocument();
  });

  it("Update now shows the session warning with the live count when busy", async () => {
    probeUpgradeSafetyMock.mockResolvedValue({ status: "busy", sessionCount: 3 });
    render(<UpdateBanner />);
    await act(async () => {});
    announceLegacy();
    await screen.findByText(/A new version of OPPA is available/);

    act(() => {
      screen.getByRole("button", { name: "Update now" }).click();
    });

    // The interruption is an informed choice: no URL opens until confirmed.
    expect(openUrlMock).not.toHaveBeenCalled();
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/3 sessions are still running/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update anyway" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
  });

  it("Update anyway on the busy warning proceeds with the v1 action", async () => {
    probeUpgradeSafetyMock.mockResolvedValue({ status: "busy", sessionCount: 2 });
    render(<UpdateBanner />);
    await act(async () => {});
    announceLegacy();
    await screen.findByText(/A new version of OPPA is available/);

    act(() => {
      screen.getByRole("button", { name: "Update now" }).click();
    });
    await screen.findByRole("alert");

    act(() => {
      screen.getByRole("button", { name: "Update anyway" }).click();
    });

    await waitFor(() =>
      expect(openUrlMock).toHaveBeenCalledWith("https://example.com/oppa-0.2.0.exe"),
    );
  });

  it("Not now on the busy warning dismisses the warning and keeps the banner", async () => {
    probeUpgradeSafetyMock.mockResolvedValue({ status: "busy", sessionCount: 1 });
    render(<UpdateBanner />);
    await act(async () => {});
    announceLegacy();
    await screen.findByText(/A new version of OPPA is available/);

    act(() => {
      screen.getByRole("button", { name: "Update now" }).click();
    });
    await screen.findByRole("alert");

    act(() => {
      screen.getByRole("button", { name: "Not now" }).click();
    });

    expect(openUrlMock).not.toHaveBeenCalled();
    // Warning is gone, banner stays (same version is not dismissed).
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText(/A new version of OPPA is available/)).toBeInTheDocument();
    expect(getDismissed()).toBeNull();
  });

  it("Update now proceeds without claiming safe when the probe is unknown", async () => {
    probeUpgradeSafetyMock.mockResolvedValue({ status: "unknown", sessionCount: 0 });
    render(<UpdateBanner />);
    await act(async () => {});
    announceLegacy();
    await screen.findByText(/A new version of OPPA is available/);

    act(() => {
      screen.getByRole("button", { name: "Update now" }).click();
    });

    // Unknown → proceed to the download URL (opening it cannot kill
    // sessions), but never present the update as safe.
    await waitFor(() =>
      expect(openUrlMock).toHaveBeenCalledWith("https://example.com/oppa-0.2.0.exe"),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("Update now proceeds when the upgrade probe rejects (transport failure)", async () => {
    probeUpgradeSafetyMock.mockRejectedValue(new Error("daemon unreachable"));
    render(<UpdateBanner />);
    await act(async () => {});
    announceLegacy();
    await screen.findByText(/A new version of OPPA is available/);

    act(() => {
      screen.getByRole("button", { name: "Update now" }).click();
    });

    await waitFor(() =>
      expect(openUrlMock).toHaveBeenCalledWith("https://example.com/oppa-0.2.0.exe"),
    );
  });

  // ---- task 6: native-preferred dual engine (announced by the scheduler) ----

  it("renders Download now for a native availability without calling seams", async () => {
    render(<UpdateBanner />);
    await act(async () => {});
    announceNative();

    expect(await screen.findByText(/v0\.3\.0/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
    expect(checkForNativeUpdateMock).not.toHaveBeenCalled();
    expect(checkForUpdateMock).not.toHaveBeenCalled();
  });

  it("falls back to the legacy browser flow for a legacy availability (no plugin download)", async () => {
    render(<UpdateBanner />);
    await act(async () => {});
    announceLegacy();
    await screen.findByText(/A new version of OPPA is available/);

    act(() => {
      screen.getByRole("button", { name: "Update now" }).click();
    });

    await waitFor(() =>
      expect(openUrlMock).toHaveBeenCalledWith("https://example.com/oppa-0.2.0.exe"),
    );
    expect(downloadNativeUpdateMock).not.toHaveBeenCalled();
  });

  it("suppresses the card when the dismissed version equals the native version", async () => {
    setDismissed("0.3.0");
    render(<UpdateBanner />);
    await act(async () => {});
    announceNative();
    await act(async () => {});
    expect(screen.queryByText(/v0\.3\.0/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download now" })).not.toBeInTheDocument();
  });

  it("Not now on a native update persists dismissedUpdateVersion", async () => {
    render(<UpdateBanner />);
    await act(async () => {});
    announceNative();
    await screen.findByRole("button", { name: "Download now" });

    act(() => {
      screen.getByRole("button", { name: "Not now" }).click();
    });

    expect(screen.queryByText(/v0\.3\.0/)).not.toBeInTheDocument();
    expect(getDismissed()).toBe("0.3.0");
  });

  it("shows a checking state with no buttons on a manual request, then renders on availability", async () => {
    render(<UpdateBanner />);
    await act(async () => {});
    expect(screen.queryByTestId("update-banner")).not.toBeInTheDocument();

    dispatchManualCheck();

    // The scheduler owns the check: the card shows progress but calls no seam.
    expect(await screen.findByText(/Checking for updates/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(checkForNativeUpdateMock).not.toHaveBeenCalled();
    expect(checkForUpdateMock).not.toHaveBeenCalled();

    announceNative();
    expect(await screen.findByRole("button", { name: "Download now" })).toBeInTheDocument();
    expect(screen.queryByText(/Checking for updates/)).not.toBeInTheDocument();
  });

  it("downloads with percent progress (no cancel) then offers Restart now + Later", async () => {
    let progressCb!: NativeProgressCallback;
    let resolveDownload!: (value: NativeDownloadResult) => void;
    downloadNativeUpdateMock.mockImplementation((cb: NativeProgressCallback) => {
      progressCb = cb;
      return new Promise<NativeDownloadResult>((resolve) => { resolveDownload = resolve; });
    });
    render(<UpdateBanner />);
    await act(async () => {});
    announceNative();
    await screen.findByRole("button", { name: "Download now" });

    fireEvent.click(screen.getByRole("button", { name: "Download now" }));
    expect(await screen.findByRole("progressbar")).toBeInTheDocument();

    act(() => {
      progressCb(50, 100);
    });
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText(/50%/)).toBeInTheDocument();
    // Orca parity: collapse is allowed during download, but no cancel /
    // Download / Restart actions.
    expect(screen.queryByRole("button", { name: "Download now" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Restart now" })).toBeNull();
    expect(screen.getByRole("button", { name: "Collapse update card" })).toBeInTheDocument();

    await act(async () => {
      progressCb(100, 100);
      resolveDownload({ ok: true });
    });
    expect(await screen.findByRole("button", { name: "Restart now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Later" })).toBeInTheDocument();
  });

  it("surfaces a download failure as an error card; Retry re-downloads", async () => {
    downloadNativeUpdateMock
      .mockResolvedValueOnce({ ok: false, error: "network unreachable" })
      .mockResolvedValue({ ok: true });
    render(<UpdateBanner />);
    await act(async () => {});
    announceNative();
    await screen.findByRole("button", { name: "Download now" });

    fireEvent.click(screen.getByRole("button", { name: "Download now" }));
    expect(await screen.findByText(/network unreachable/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Restart now" })).toBeInTheDocument();
    expect(downloadNativeUpdateMock).toHaveBeenCalledTimes(2);
  });

  it("blocks retry on signature failures and links GitHub releases", async () => {
    downloadNativeUpdateMock.mockResolvedValue({ ok: false, error: "signature verification failed" });
    render(<UpdateBanner />);
    await act(async () => {});
    announceNative();
    await screen.findByRole("button", { name: "Download now" });

    fireEvent.click(screen.getByRole("button", { name: "Download now" }));
    expect(await screen.findByText(/signature verification failed/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(screen.getAllByText(/Download from GitHub releases/).length).toBeGreaterThan(0);
  });

  it("shows Restart without re-checking (installs what was checked)", async () => {
    render(<UpdateBanner />);
    await act(async () => {});
    announceNative();
    await screen.findByRole("button", { name: "Download now" });

    fireEvent.click(screen.getByRole("button", { name: "Download now" }));
    expect(await screen.findByRole("button", { name: "Restart now" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Restart now" }));
    await waitFor(() =>
      expect(installNativeUpdateAndRelaunchMock).toHaveBeenCalledTimes(1),
    );
    // The pending update is installed as checked — no fresh check in between.
    expect(checkForNativeUpdateMock).not.toHaveBeenCalled();
    expect(checkForUpdateMock).not.toHaveBeenCalled();
  });

  it("Restart now shows the busy warning; Update-anyway re-attempts the install", async () => {
    installNativeUpdateAndRelaunchMock
      .mockResolvedValueOnce({ proceeded: false, reason: "busy", sessionCount: 2 })
      .mockResolvedValue({ proceeded: true });
    render(<UpdateBanner />);
    await act(async () => {});
    announceNative();
    await screen.findByRole("button", { name: "Download now" });

    fireEvent.click(screen.getByRole("button", { name: "Download now" }));
    await screen.findByRole("button", { name: "Restart now" });

    fireEvent.click(screen.getByRole("button", { name: "Restart now" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/2 sessions are still running/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update anyway" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Update anyway" }));
    await waitFor(() =>
      expect(installNativeUpdateAndRelaunchMock).toHaveBeenCalledTimes(2),
    );
  });

  it("Not now on the native busy warning returns to the downloaded card", async () => {
    installNativeUpdateAndRelaunchMock.mockResolvedValue({
      proceeded: false,
      reason: "busy",
      sessionCount: 1,
    });
    render(<UpdateBanner />);
    await act(async () => {});
    announceNative();
    await screen.findByRole("button", { name: "Download now" });

    fireEvent.click(screen.getByRole("button", { name: "Download now" }));
    await screen.findByRole("button", { name: "Restart now" });

    fireEvent.click(screen.getByRole("button", { name: "Restart now" }));
    await screen.findByRole("alert");

    act(() => {
      screen.getByRole("button", { name: "Not now" }).click();
    });

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart now" })).toBeInTheDocument();
    expect(getDismissed()).toBeNull();
  });

  it("surfaces an install failure as an error card; Dismiss persists the version", async () => {
    installNativeUpdateAndRelaunchMock.mockResolvedValue({
      proceeded: false,
      reason: "error",
      error: "install failed",
    });
    render(<UpdateBanner />);
    await act(async () => {});
    announceNative();
    await screen.findByRole("button", { name: "Download now" });

    fireEvent.click(screen.getByRole("button", { name: "Download now" }));
    await screen.findByRole("button", { name: "Restart now" });

    fireEvent.click(screen.getByRole("button", { name: "Restart now" }));
    expect(await screen.findByText(/install failed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();

    act(() => {
      screen.getByRole("button", { name: "Dismiss" }).click();
    });
    expect(screen.queryByTestId("update-banner")).not.toBeInTheDocument();
    expect(getDismissed()).toBe("0.3.0");
  });

  it("Later hides the downloaded card without dismissing; the next announcement re-offers", async () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    render(<UpdateBanner />);
    await act(async () => {});
    announceNative();
    await screen.findByRole("button", { name: "Download now" });

    fireEvent.click(screen.getByRole("button", { name: "Download now" }));
    await screen.findByRole("button", { name: "Restart now" });

    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(screen.queryByTestId("update-banner")).toBeNull();
    expect(getDismissed()).toBeNull();
    // The segment clears through the availability contract.
    expect(clearedAvailabilityCount(dispatchSpy)).toBeGreaterThan(0);

    // No dismissal persisted, so the next announcement offers it again.
    announceNative();
    expect(await screen.findByRole("button", { name: "Download now" })).toBeInTheDocument();
  });

  it("clears a stale card when availability is cleared", async () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    render(<UpdateBanner />);
    await act(async () => {});
    announceNative();
    await screen.findByRole("button", { name: "Download now" });

    announceCleared();

    await waitFor(() => expect(screen.queryByTestId("update-banner")).toBeNull());
    expect(clearedAvailabilityCount(dispatchSpy)).toBeGreaterThan(0);
  });

  it("keeps the segment dot during downloading; clears it on error", async () => {
    let resolveDownload!: (value: NativeDownloadResult) => void;
    downloadNativeUpdateMock.mockImplementation(
      () => new Promise<NativeDownloadResult>((resolve) => { resolveDownload = resolve; }),
    );
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    render(<UpdateBanner />);
    await act(async () => {});
    announceNative();
    await screen.findByRole("button", { name: "Download now" });

    fireEvent.click(screen.getByRole("button", { name: "Download now" }));
    await screen.findByRole("progressbar");
    // Download pending: no cleared availability — the dot stays.
    const clearedBefore = clearedAvailabilityCount(dispatchSpy);
    expect(screen.getByTestId("update-banner")).toBeInTheDocument();

    await act(async () => {
      resolveDownload({ ok: false, error: "boom" });
    });
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
    // The error card itself is visible; the dot clears to avoid double-signaling.
    expect(clearedAvailabilityCount(dispatchSpy)).toBeGreaterThan(clearedBefore);
  });

  it("keeps the segment dot while opening the legacy browser download", async () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    render(<UpdateBanner />);
    await act(async () => {});
    announceLegacy();
    await screen.findByText(/A new version of OPPA is available/);
    const clearedBefore = clearedAvailabilityCount(dispatchSpy);

    act(() => {
      screen.getByRole("button", { name: "Update now" }).click();
    });
    await waitFor(() =>
      expect(openUrlMock).toHaveBeenCalledWith("https://example.com/oppa-0.2.0.exe"),
    );
    expect(clearedAvailabilityCount(dispatchSpy)).toBe(clearedBefore);
  });

  it("renders Orca-parity rich card: version, restore copy, and release notes", async () => {
    render(<UpdateBanner />);
    await act(async () => {});
    announce({
      version: "0.3.0",
      phase: "available",
      engine: "native",
      currentVersion: "0.2.5",
      body: "Fixes terminals",
      releaseUrl: "https://github.com/dreamydani/oppa/releases/tag/v0.3.0",
    });
    expect(await screen.findByText(/Oppa v0\.3\.0 is ready/)).toBeInTheDocument();
    expect(screen.getByText(/Sessions restore after restart/)).toBeInTheDocument();
    expect(screen.getByText(/Fixes terminals/)).toBeInTheDocument();
    expect(screen.getByText(/Release notes/)).toBeInTheDocument();
    expect(screen.getByTestId("update-banner")).toHaveAttribute("aria-label", "Update available");
  });

  it("collapse hides the card without clearing availability (segment owns it)", async () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    render(<UpdateBanner />);
    await act(async () => {});
    announceNative();
    await screen.findByRole("button", { name: "Download now" });

    fireEvent.click(screen.getByRole("button", { name: "Download now" }));
    expect(await screen.findByRole("progressbar")).toBeInTheDocument();
    const clearedBefore = clearedAvailabilityCount(dispatchSpy);

    fireEvent.click(screen.getByRole("button", { name: "Collapse update card" }));
    await waitFor(() => expect(screen.queryByTestId("update-banner")).toBeNull());
    expect(clearedAvailabilityCount(dispatchSpy)).toBe(clearedBefore);
  });

  it("manual check with no update shows transient latest card", async () => {
    render(<UpdateBanner />);
    await act(async () => {});
    dispatchManualCheck();
    expect(await screen.findByText(/Checking for updates/)).toBeInTheDocument();
    announce({ version: null, phase: null });
    // presentAvailability flips checking → not-available synchronously.
    expect(await screen.findByText(/latest version/)).toBeInTheDocument();
  });

  it("Restart now passes a layout flush to the install seam (Orca-style restore)", async () => {
    render(<UpdateBanner />);
    await act(async () => {});
    announceNative();
    await screen.findByRole("button", { name: "Download now" });

    fireEvent.click(screen.getByRole("button", { name: "Download now" }));
    expect(await screen.findByRole("button", { name: "Restart now" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Restart now" }));
    await waitFor(() => expect(installNativeUpdateAndRelaunchMock).toHaveBeenCalledTimes(1));
    const [, options] = installNativeUpdateAndRelaunchMock.mock.calls[0] as unknown as [
      unknown,
      { onBeforeInstall?: () => Promise<unknown> }?,
    ];
    expect(typeof options?.onBeforeInstall).toBe("function");
  });
});
