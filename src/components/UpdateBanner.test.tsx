import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
import {
  UpdateBanner,
  MANUAL_UPDATE_CHECK_EVENT,
} from "./UpdateBanner";
import * as updater from "../lib/updater";
import type {
  NativeUpdateInfo,
  NativeProgressCallback,
  NativeDownloadResult,
} from "../lib/updater";
import * as opener from "@tauri-apps/plugin-opener";
import { useTerminalStore } from "../store/terminalStore";

// The updater seam is mocked at module level so each test controls whether an
// update is "available" (the seam itself already gates on the channel and
// swallows rejections — component tests exercise the banner logic, not the
// seam).
vi.mock("../lib/updater", () => ({
  checkForUpdate: vi.fn(),
  probeUpgradeSafety: vi.fn(),
  checkForNativeUpdate: vi.fn(),
  downloadNativeUpdate: vi.fn(),
  installNativeUpdateAndRelaunch: vi.fn(),
}));

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

function setAutoCheckUpdates(value: boolean) {
  useTerminalStore.setState({
    settings: {
      ...useTerminalStore.getState().settings,
      general: { ...useTerminalStore.getState().settings.general, autoCheckUpdates: value },
    },
  });
}

function setLastCheckAt(value: number | null) {
  useTerminalStore.setState({
    settings: {
      ...useTerminalStore.getState().settings,
      general: { ...useTerminalStore.getState().settings.general, lastCheckAt: value },
    },
  });
}

function dispatchManualCheck() {
  act(() => {
    window.dispatchEvent(new CustomEvent(MANUAL_UPDATE_CHECK_EVENT));
  });
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
  setAutoCheckUpdates(true);
  // lastCheckAt persists in the store across tests; reset so each test starts
  // with no recorded check (the 6h-floor test sets its own value).
  setLastCheckAt(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UpdateBanner", () => {
  it("renders the banner with both buttons when an update is available", async () => {
    checkForUpdateMock.mockResolvedValue(AVAILABLE);
    render(<UpdateBanner />);
    expect(await screen.findByText(/A new version of OPPA is available/)).toBeInTheDocument();
    expect(screen.getByText(/v0\.2\.0/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
  });

  it("renders nothing when checkForUpdate returns null", async () => {
    checkForUpdateMock.mockResolvedValue(null);
    render(<UpdateBanner />);
    await act(async () => {});
    expect(screen.queryByText(/A new version of OPPA is available/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update now" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Not now" })).not.toBeInTheDocument();
  });

  it("renders nothing when checkForUpdate rejects (offline / backend failure)", async () => {
    checkForUpdateMock.mockRejectedValue(new Error("offline"));
    render(<UpdateBanner />);
    await act(async () => {});
    expect(screen.queryByText(/A new version of OPPA is available/)).not.toBeInTheDocument();
  });

  it("renders nothing when the dismissed version equals the available version", async () => {
    setDismissed("0.2.0");
    checkForUpdateMock.mockResolvedValue(AVAILABLE);
    render(<UpdateBanner />);
    await act(async () => {});
    expect(screen.queryByText(/A new version of OPPA is available/)).not.toBeInTheDocument();
  });

  it("shows the banner again when a newer version than the dismissed one is available", async () => {
    setDismissed("0.1.9");
    checkForUpdateMock.mockResolvedValue(AVAILABLE);
    render(<UpdateBanner />);
    expect(await screen.findByText(/A new version of OPPA is available/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update now" })).toBeInTheDocument();
  });

  it("Not now hides the banner and persists dismissedUpdateVersion", async () => {
    checkForUpdateMock.mockResolvedValue(AVAILABLE);
    render(<UpdateBanner />);
    await screen.findByText(/A new version of OPPA is available/);

    act(() => {
      screen.getByRole("button", { name: "Not now" }).click();
    });

    expect(screen.queryByText(/A new version of OPPA is available/)).not.toBeInTheDocument();
    expect(getDismissed()).toBe("0.2.0");
  });

  it("Update now opens the download URL via the opener plugin", async () => {
    checkForUpdateMock.mockResolvedValue(AVAILABLE);
    render(<UpdateBanner />);
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
    checkForUpdateMock.mockResolvedValue(AVAILABLE);
    render(<UpdateBanner />);
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
    checkForUpdateMock.mockResolvedValue(AVAILABLE);
    probeUpgradeSafetyMock.mockResolvedValue({ status: "idle", sessionCount: 0 });
    render(<UpdateBanner />);
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
    checkForUpdateMock.mockResolvedValue(AVAILABLE);
    probeUpgradeSafetyMock.mockResolvedValue({ status: "busy", sessionCount: 3 });
    render(<UpdateBanner />);
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
    checkForUpdateMock.mockResolvedValue(AVAILABLE);
    probeUpgradeSafetyMock.mockResolvedValue({ status: "busy", sessionCount: 2 });
    render(<UpdateBanner />);
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
    checkForUpdateMock.mockResolvedValue(AVAILABLE);
    probeUpgradeSafetyMock.mockResolvedValue({ status: "busy", sessionCount: 1 });
    render(<UpdateBanner />);
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
    checkForUpdateMock.mockResolvedValue(AVAILABLE);
    probeUpgradeSafetyMock.mockResolvedValue({ status: "unknown", sessionCount: 0 });
    render(<UpdateBanner />);
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
    checkForUpdateMock.mockResolvedValue(AVAILABLE);
    probeUpgradeSafetyMock.mockRejectedValue(new Error("daemon unreachable"));
    render(<UpdateBanner />);
    await screen.findByText(/A new version of OPPA is available/);

    act(() => {
      screen.getByRole("button", { name: "Update now" }).click();
    });

    await waitFor(() =>
      expect(openUrlMock).toHaveBeenCalledWith("https://example.com/oppa-0.2.0.exe"),
    );
  });

  it("re-checks once on focus when the mount check was empty", async () => {
    checkForUpdateMock.mockResolvedValueOnce(null);
    checkForUpdateMock.mockResolvedValueOnce(AVAILABLE);
    render(<UpdateBanner />);
    await act(async () => {});
    expect(screen.queryByText(/A new version of OPPA is available/)).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(await screen.findByText(/A new version of OPPA is available/)).toBeInTheDocument();
    expect(checkForUpdateMock).toHaveBeenCalledTimes(2);
  });

  it("retries on the next focus when the focus re-check was also empty", async () => {
    checkForUpdateMock.mockResolvedValueOnce(null);
    checkForUpdateMock.mockResolvedValueOnce(null);
    checkForUpdateMock.mockResolvedValueOnce(AVAILABLE);
    render(<UpdateBanner />);
    await act(async () => {});

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => {});
    expect(screen.queryByText(/A new version of OPPA is available/)).not.toBeInTheDocument();
    // The empty focus check stamped nothing, so recovery is not suppressed.
    expect(useTerminalStore.getState().settings.general.lastCheckAt).toBeNull();

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(await screen.findByText(/A new version of OPPA is available/)).toBeInTheDocument();
    expect(checkForUpdateMock).toHaveBeenCalledTimes(3);
  });

  it("skips the focus re-check within 6h of the last check", async () => {    useTerminalStore.setState({
      settings: {
        ...useTerminalStore.getState().settings,
        general: { ...useTerminalStore.getState().settings.general, lastCheckAt: Date.now() },
      },
    });
    checkForUpdateMock.mockResolvedValue(null);
    render(<UpdateBanner />);
    await act(async () => {});

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => {});

    expect(checkForUpdateMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/A new version of OPPA is available/)).not.toBeInTheDocument();
  });

  // ---- task 6: native-preferred dual engine ----

  it("prefers native: shows Download now and never calls the legacy check", async () => {
    checkForNativeUpdateMock.mockResolvedValue(NATIVE);
    checkForUpdateMock.mockResolvedValue(AVAILABLE);
    render(<UpdateBanner />);

    expect(await screen.findByText(/v0\.3\.0/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
    // One card, two engines, native preferred — the legacy flow never runs.
    expect(checkForUpdateMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/v0\.2\.0/)).not.toBeInTheDocument();
  });

  it("falls back to the legacy browser flow when native is null (no plugin download)", async () => {
    checkForNativeUpdateMock.mockResolvedValue(null);
    checkForUpdateMock.mockResolvedValue(AVAILABLE);
    render(<UpdateBanner />);
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
    checkForNativeUpdateMock.mockResolvedValue(NATIVE);
    render(<UpdateBanner />);
    await act(async () => {});
    expect(screen.queryByText(/v0\.3\.0/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Download now" })).not.toBeInTheDocument();
  });

  it("Not now on a native update persists dismissedUpdateVersion", async () => {
    checkForNativeUpdateMock.mockResolvedValue(NATIVE);
    render(<UpdateBanner />);
    await screen.findByRole("button", { name: "Download now" });

    act(() => {
      screen.getByRole("button", { name: "Not now" }).click();
    });

    expect(screen.queryByText(/v0\.3\.0/)).not.toBeInTheDocument();
    expect(getDismissed()).toBe("0.3.0");
  });

  it("shows a checking state with no buttons while a manual check is pending", async () => {
    checkForNativeUpdateMock.mockResolvedValue(null);
    checkForUpdateMock.mockResolvedValue(null);
    render(<UpdateBanner />);
    await act(async () => {});
    expect(screen.queryByTestId("update-banner")).not.toBeInTheDocument();

    let resolveCheck!: (value: NativeUpdateInfo | null) => void;
    checkForNativeUpdateMock.mockImplementation(
      () => new Promise<NativeUpdateInfo | null>((resolve) => { resolveCheck = resolve; }),
    );
    dispatchManualCheck();

    expect(await screen.findByText(/Checking for updates/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();

    await act(async () => {
      resolveCheck(null);
    });
    expect(screen.queryByText(/Checking for updates/)).not.toBeInTheDocument();
  });

  it("downloads with percent progress (no cancel) then offers Restart now + Later", async () => {
    checkForNativeUpdateMock.mockResolvedValue(NATIVE);
    let progressCb!: NativeProgressCallback;
    let resolveDownload!: (value: NativeDownloadResult) => void;
    downloadNativeUpdateMock.mockImplementation((cb: NativeProgressCallback) => {
      progressCb = cb;
      return new Promise<NativeDownloadResult>((resolve) => { resolveDownload = resolve; });
    });
    render(<UpdateBanner />);
    await screen.findByRole("button", { name: "Download now" });

    fireEvent.click(screen.getByRole("button", { name: "Download now" }));
    expect(await screen.findByRole("progressbar")).toBeInTheDocument();

    act(() => {
      progressCb(50, 100);
    });
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText(/50%/)).toBeInTheDocument();
    // No cancel button during download.
    expect(screen.queryByRole("button")).toBeNull();

    await act(async () => {
      progressCb(100, 100);
      resolveDownload({ ok: true });
    });
    expect(await screen.findByRole("button", { name: "Restart now" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Later" })).toBeInTheDocument();
  });

  it("surfaces a download failure as an error card; Retry re-downloads", async () => {
    checkForNativeUpdateMock.mockResolvedValue(NATIVE);
    downloadNativeUpdateMock
      .mockResolvedValueOnce({ ok: false, error: "signature verification failed" })
      .mockResolvedValue({ ok: true });
    render(<UpdateBanner />);
    await screen.findByRole("button", { name: "Download now" });

    fireEvent.click(screen.getByRole("button", { name: "Download now" }));
    expect(await screen.findByText(/signature verification failed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("button", { name: "Restart now" })).toBeInTheDocument();
    expect(downloadNativeUpdateMock).toHaveBeenCalledTimes(2);
  });

  it("shows Restart without re-checking (installs what was checked)", async () => {
    checkForNativeUpdateMock.mockResolvedValue(NATIVE);
    render(<UpdateBanner />);
    await screen.findByRole("button", { name: "Download now" });

    fireEvent.click(screen.getByRole("button", { name: "Download now" }));
    expect(await screen.findByRole("button", { name: "Restart now" })).toBeInTheDocument();
    const checksBefore = checkForNativeUpdateMock.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Restart now" }));
    await waitFor(() =>
      expect(installNativeUpdateAndRelaunchMock).toHaveBeenCalledTimes(1),
    );
    // The pending update is installed as checked — no fresh check in between.
    expect(checkForNativeUpdateMock.mock.calls.length).toBe(checksBefore);
  });

  it("Restart now shows the busy warning; Update-anyway re-attempts the install", async () => {
    checkForNativeUpdateMock.mockResolvedValue(NATIVE);
    installNativeUpdateAndRelaunchMock
      .mockResolvedValueOnce({ proceeded: false, reason: "busy", sessionCount: 2 })
      .mockResolvedValue({ proceeded: true });
    render(<UpdateBanner />);
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
    checkForNativeUpdateMock.mockResolvedValue(NATIVE);
    installNativeUpdateAndRelaunchMock.mockResolvedValue({
      proceeded: false,
      reason: "busy",
      sessionCount: 1,
    });
    render(<UpdateBanner />);
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
    checkForNativeUpdateMock.mockResolvedValue(NATIVE);
    installNativeUpdateAndRelaunchMock.mockResolvedValue({
      proceeded: false,
      reason: "error",
      error: "install failed",
    });
    render(<UpdateBanner />);
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

  it("manual Check-now bypasses the 6h floor but stays channel-gated via the seam", async () => {
    setLastCheckAt(Date.now());
    checkForNativeUpdateMock.mockResolvedValue(null);
    checkForUpdateMock.mockResolvedValue(null);
    render(<UpdateBanner />);
    await act(async () => {});
    expect(checkForNativeUpdateMock).toHaveBeenCalledTimes(1);

    // Focus re-check stays floored.
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await act(async () => {});
    expect(checkForNativeUpdateMock).toHaveBeenCalledTimes(1);

    // Manual Check-now forces a fresh check despite the floor.
    checkForNativeUpdateMock.mockResolvedValue(NATIVE);
    dispatchManualCheck();
    expect(await screen.findByRole("button", { name: "Download now" })).toBeInTheDocument();
    expect(checkForNativeUpdateMock).toHaveBeenCalledTimes(2);
  });

  it("skips auto-checks when autoCheckUpdates is off, but manual checks still run", async () => {
    setAutoCheckUpdates(false);
    checkForNativeUpdateMock.mockResolvedValue(NATIVE);
    checkForUpdateMock.mockResolvedValue(AVAILABLE);
    render(<UpdateBanner />);
    await act(async () => {});

    expect(checkForNativeUpdateMock).not.toHaveBeenCalled();
    expect(checkForUpdateMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("update-banner")).not.toBeInTheDocument();

    dispatchManualCheck();
    expect(await screen.findByRole("button", { name: "Download now" })).toBeInTheDocument();
    expect(checkForNativeUpdateMock).toHaveBeenCalledTimes(1);
  });
});
