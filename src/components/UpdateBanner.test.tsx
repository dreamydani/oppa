import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { UpdateBanner } from "./UpdateBanner";
import * as updater from "../lib/updater";
import * as opener from "@tauri-apps/plugin-opener";
import { useTerminalStore } from "../store/terminalStore";

// The updater seam is mocked at module level so each test controls whether an
// update is "available" (the seam itself already gates on the channel and
// swallows rejections — component tests exercise the banner logic, not the
// seam).
vi.mock("../lib/updater", () => ({
  checkForUpdate: vi.fn(),
  probeUpgradeSafety: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

const checkForUpdateMock = vi.mocked(updater.checkForUpdate);
const probeUpgradeSafetyMock = vi.mocked(updater.probeUpgradeSafety);
const openUrlMock = vi.mocked(opener.openUrl);

const AVAILABLE = { version: "0.2.0", download: "https://example.com/oppa-0.2.0.exe", available: true };

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

beforeEach(() => {
  checkForUpdateMock.mockReset();
  // Default: an idle daemon. Individual tests override for the busy/unknown
  // paths; existing Task 5 tests rely on the idle default to proceed.
  probeUpgradeSafetyMock.mockReset();
  probeUpgradeSafetyMock.mockResolvedValue({ status: "idle", sessionCount: 0 });
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
});
