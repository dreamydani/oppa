import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, act } from "@testing-library/react";
import { useTerminalStore } from "../../store/terminalStore";
import { StatusBar } from "./StatusBar";
import {
  MANUAL_UPDATE_CHECK_EVENT,
  UPDATE_AVAILABILITY_EVENT,
} from "../UpdateBanner";
import type { UpdateAvailabilityDetail } from "../UpdateBanner";
import * as updater from "../../lib/updater";
import * as gitTransport from "../../lib/git/transport";

vi.mock("../../lib/git/transport", () => ({
  getGitStatus: vi.fn(),
  onGitChanged: vi.fn().mockResolvedValue(() => {}),
  onPrChanged: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("../../lib/updater", () => ({
  checkForNativeUpdate: vi.fn(),
  checkForUpdate: vi.fn(),
}));

const mockGetGitStatus = vi.mocked(gitTransport.getGitStatus);
const checkForNativeUpdateMock = vi.mocked(updater.checkForNativeUpdate);
const checkForUpdateMock = vi.mocked(updater.checkForUpdate);

function announceUpdate(version: string | null) {
  const detail: UpdateAvailabilityDetail = {
    version,
    phase: version ? "available" : null,
  };
  act(() => {
    window.dispatchEvent(new CustomEvent(UPDATE_AVAILABILITY_EVENT, { detail }));
  });
}

function setDismissedUpdateVersion(version: string | null) {
  useTerminalStore.setState({
    settings: {
      ...useTerminalStore.getState().settings,
      general: {
        ...useTerminalStore.getState().settings.general,
        dismissedUpdateVersion: version,
      },
    },
  });
}

describe("StatusBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkForNativeUpdateMock.mockResolvedValue(null);
    checkForUpdateMock.mockResolvedValue(null);
    setDismissedUpdateVersion(null);
    useTerminalStore.setState({
      sessions: {
        s1: {
          id: "s1",
          title: "s1",
          status: "running",
          cwd: "/home/user/project",
          cols: 120,
          rows: 30,
        },
      },
      tabs: [
        {
          id: "tab-1",
          layout: { type: "leaf", id: "s1" },
          focusedPath: [],
        },
      ],
      activeTabId: "tab-1",
      layout: { type: "leaf", id: "s1" },
      focusedPath: [],
    });
  });

  it("renders status bar container", () => {
    mockGetGitStatus.mockResolvedValue({
      is_git: false,
      branch: "",
      files: [],
      ahead: 0,
      behind: 0,
    });

    const { container } = render(<StatusBar />);
    const statusBar = container.querySelector(".status-bar");
    expect(statusBar).toBeTruthy();
  });

  it("renders git branch and ahead/behind counts when in git repository", async () => {
    mockGetGitStatus.mockResolvedValue({
      is_git: true,
      branch: "feature/ui-refresh",
      files: [{ path: "file.ts", status: "M" }],
      ahead: 2,
      behind: 1,
    });

    render(<StatusBar />);

    await waitFor(() => {
      expect(screen.getByText("feature/ui-refresh")).toBeTruthy();
    });

    expect(screen.getByText(/↑2/)).toBeTruthy();
    expect(screen.getByText(/↓1/)).toBeTruthy();
  });

  it("renders fallback git indicator when not in a git repo", async () => {
    mockGetGitStatus.mockResolvedValue({
      is_git: false,
      branch: "",
      files: [],
      ahead: 0,
      behind: 0,
    });

    render(<StatusBar />);

    await waitFor(() => {
      expect(screen.getByText(/no git|not a git/i)).toBeTruthy();
    });
  });

  it("renders active working directory badge", () => {
    mockGetGitStatus.mockResolvedValue({
      is_git: false,
      branch: "",
      files: [],
      ahead: 0,
      behind: 0,
    });

    render(<StatusBar />);
    expect(screen.getByText(/project/)).toBeTruthy();
  });

  it("renders terminal dimensions and status indicator", () => {
    mockGetGitStatus.mockResolvedValue({
      is_git: false,
      branch: "",
      files: [],
      ahead: 0,
      behind: 0,
    });

    render(<StatusBar />);
    expect(screen.getByText("120x30")).toBeTruthy();
    expect(screen.getByText(/Ready|Running/i)).toBeTruthy();
  });

  it("renders localhost badge when detectedPorts contains active servers", () => {
    mockGetGitStatus.mockResolvedValue({
      is_git: false,
      branch: "",
      files: [],
      ahead: 0,
      behind: 0,
    });
    useTerminalStore.setState({
      activeAppMode: "terminal",
      browserUrl: "",
      detectedPorts: [
        { port: 5173, url: "http://localhost:5173", title: "Localhost :5173", timestamp: Date.now() },
      ],
    });

    render(<StatusBar />);

    const badge = screen.getByText("localhost:5173");
    expect(badge).toBeTruthy();

    fireEvent.click(badge);
    expect(useTerminalStore.getState().activeAppMode).toBe("browser");
    expect(useTerminalStore.getState().browserUrl).toBe("http://localhost:5173");
  });

  it("renders multiple localhost badges when multiple ports are active", () => {
    mockGetGitStatus.mockResolvedValue({
      is_git: false,
      branch: "",
      files: [],
      ahead: 0,
      behind: 0,
    });
    useTerminalStore.setState({
      detectedPorts: [
        { port: 3000, url: "http://localhost:3000", title: "Localhost :3000", timestamp: Date.now() },
        { port: 8080, url: "http://localhost:8080", title: "Localhost :8080", timestamp: Date.now() },
      ],
    });

    render(<StatusBar />);

    expect(screen.getByText("localhost:3000")).toBeTruthy();
    expect(screen.getByText("localhost:8080")).toBeTruthy();
  });
});

describe("StatusBar update segment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGitStatus.mockResolvedValue({
      is_git: false,
      branch: "",
      files: [],
      ahead: 0,
      behind: 0,
    });
    checkForNativeUpdateMock.mockResolvedValue(null);
    checkForUpdateMock.mockResolvedValue(null);
    setDismissedUpdateVersion(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows dot + version when the card reports an available update", async () => {
    render(<StatusBar />);
    await act(async () => {});
    expect(screen.queryByTestId("update-segment")).toBeNull();

    announceUpdate("0.3.0");

    const segment = await screen.findByTestId("update-segment");
    expect(segment.textContent).toContain("v0.3.0");
  });

  it("finds an update on mount via the native seam", async () => {
    checkForNativeUpdateMock.mockResolvedValue({
      version: "0.3.0",
      currentVersion: "0.2.3",
    });
    render(<StatusBar />);

    expect(await screen.findByTestId("update-segment")).toBeInTheDocument();
    expect(screen.getByText("v0.3.0")).toBeInTheDocument();
  });

  it("hides the segment for the dismissed version", async () => {
    setDismissedUpdateVersion("0.3.0");
    render(<StatusBar />);
    await act(async () => {});

    announceUpdate("0.3.0");
    await act(async () => {});
    expect(screen.queryByTestId("update-segment")).toBeNull();

    setDismissedUpdateVersion(null);
  });

  it("clears the segment when availability is cleared", async () => {
    render(<StatusBar />);
    await act(async () => {});

    announceUpdate("0.3.0");
    expect(await screen.findByTestId("update-segment")).toBeInTheDocument();

    announceUpdate(null);
    await waitFor(() =>
      expect(screen.queryByTestId("update-segment")).toBeNull(),
    );
  });

  it("click runs a manual Check-now for the card", async () => {
    render(<StatusBar />);
    await act(async () => {});
    announceUpdate("0.3.0");
    const segment = await screen.findByTestId("update-segment");

    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    fireEvent.click(segment);

    const manualChecks = dispatchSpy.mock.calls.filter(
      ([event]) =>
        event instanceof CustomEvent && event.type === MANUAL_UPDATE_CHECK_EVENT,
    );
    expect(manualChecks).toHaveLength(1);
  });
});

describe("StatusBar agent fleet aggregate", () => {
  interface SeededSession {
    id: string;
    status?: string;
    state?: "working" | "blocked" | "waiting" | "done";
  }

  function sessionInfo(id: string, status = "running") {
    return { id, title: id, status, cwd: `/ws/${id}`, cols: 80, rows: 24 };
  }

  function statusEntry(state: SeededSession["state"]) {
    return { state, state_started_at_ms: 1, updated_at_ms: 2, origin: "hook" };
  }

  function seedFleet(sessions: SeededSession[], tabs: unknown[] = []) {
    const sessionMap: Record<string, unknown> = {};
    const statusBySessionId: Record<string, unknown> = {};
    for (const s of sessions) {
      sessionMap[s.id] = sessionInfo(s.id, s.status ?? "running");
      if (s.state) statusBySessionId[s.id] = statusEntry(s.state);
    }
    useTerminalStore.setState({
      sessions: sessionMap,
      statusBySessionId,
      workingBySessionId: {},
      unreadBySessionId: {},
      tabs,
      activeTabId: (tabs[0] as { id?: string } | undefined)?.id ?? "",
    } as unknown as Record<string, unknown>);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetGitStatus.mockResolvedValue({
      is_git: false,
      branch: "",
      files: [],
      ahead: 0,
      behind: 0,
    });
  });

  it("renders no aggregate when no live agent sessions have hook status", () => {
    seedFleet([{ id: "s1" }]); // live session, no hook row
    render(<StatusBar />);
    expect(screen.queryByTestId("fleet-aggregate")).toBeNull();
  });

  it("hides the aggregate when the only hooked session has exited", () => {
    seedFleet([{ id: "s1", status: "exited", state: "done" }]);
    render(<StatusBar />);
    expect(screen.queryByTestId("fleet-aggregate")).toBeNull();
  });

  it("renders counts per state over live hooked sessions", () => {
    seedFleet([
      { id: "w1", state: "working" },
      { id: "w2", state: "working" },
      { id: "b1", state: "blocked" },
      { id: "d1", state: "done" },
    ]);
    render(<StatusBar />);
    const agg = screen.getByTestId("fleet-aggregate");
    expect(agg.textContent).toContain("working 2");
    expect(agg.textContent).toContain("blocked 1");
    expect(agg.textContent).toContain("done 1");
    expect(agg.textContent).not.toContain("waiting");
  });

  it("excludes exited sessions from the counts", () => {
    seedFleet([
      { id: "w1", state: "working" },
      { id: "gone", status: "exited", state: "working" },
    ]);
    render(<StatusBar />);
    const agg = screen.getByTestId("fleet-aggregate");
    expect(agg.textContent).toContain("working 1");
    expect(agg.textContent).not.toContain("working 2");
  });

  it("click jumps to the blocked session's tab and marks it seen", () => {
    seedFleet(
      [
        { id: "w1", state: "working" },
        { id: "b1", state: "blocked" },
      ],
      [
        { id: "tab-1", layout: { type: "leaf", id: "w1" }, focusedPath: [] },
        { id: "tab-2", layout: { type: "leaf", id: "b1" }, focusedPath: [] },
      ],
    );
    useTerminalStore.setState({ activeTabId: "tab-1" } as unknown as Record<string, unknown>);
    render(<StatusBar />);

    fireEvent.click(screen.getByTestId("fleet-aggregate"));
    const state = useTerminalStore.getState();
    expect(state.activeTabId).toBe("tab-2");
    expect(state.unreadBySessionId["b1"]).toBeUndefined();
  });

  it("click prefers blocked over waiting, then working, then done", () => {
    const order: Array<SeededSession["state"]> = ["blocked", "waiting", "working", "done"];
    for (const preferred of order) {
      // Only the preferred state and every lower-priority state are present;
      // higher-priority states are removed so the preference chain is testable.
      const present = order.slice(order.indexOf(preferred));
      const tabs = present.map((state) => ({
        id: `tab-${state}`,
        layout: { type: "leaf", id: `s-${state}` },
        focusedPath: [],
      }));
      seedFleet(present.map((state) => ({ id: `s-${state}`, state })), tabs);
      useTerminalStore.setState({ activeTabId: `tab-${present[present.length - 1]}` } as unknown as Record<string, unknown>);
      render(<StatusBar />);

      fireEvent.click(screen.getByTestId("fleet-aggregate"));
      expect(useTerminalStore.getState().activeTabId).toBe(`tab-${preferred}`);
      // sanity: the session it focused carries the expected state
      expect(useTerminalStore.getState().statusBySessionId[`s-${preferred}`]?.state).toBe(preferred);
      cleanup();
    }
  });

  it("click does nothing when no hooked session has a tab", () => {
    seedFleet([{ id: "w1", state: "working" }]); // no tabs seeded
    useTerminalStore.setState({ activeTabId: "" } as unknown as Record<string, unknown>);
    render(<StatusBar />);
    fireEvent.click(screen.getByTestId("fleet-aggregate"));
    expect(useTerminalStore.getState().activeTabId).toBe("");
  });
});

