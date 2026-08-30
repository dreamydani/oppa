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
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

const checkForUpdateMock = vi.mocked(updater.checkForUpdate);
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
  openUrlMock.mockReset();
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

    expect(openUrlMock).toHaveBeenCalledWith("https://example.com/oppa-0.2.0.exe");
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
      expect(screen.getByText(/Downloading update/i)).toBeInTheDocument(),
    );
    expect(openSpy).toHaveBeenCalledWith(
      "https://example.com/oppa-0.2.0.exe",
      "_blank",
      "noopener,noreferrer",
    );
    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
    openSpy.mockRestore();
  });
});
