import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorkspaceList } from "./WorkspaceList";
import { useTerminalStore } from "../../store/terminalStore";
import type { SessionInfo } from "../../store/slices/terminalSessionsSlice";

// transport is mocked at the store level in sibling tests; mirror the minimal
// surface WorkspaceList touches (event subscriptions run at module import).
vi.mock("../../lib/pty/transport", () => ({
  onTitleChanged: vi.fn().mockResolvedValue(() => {}),
  onFocusRequested: vi.fn().mockResolvedValue(() => {}),
  onSessionWorking: vi.fn().mockResolvedValue(() => {}),
  onAgentStatus: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("../../lib/worktree/transport", () => ({
  onWorktreeChanged: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("../../lib/git/transport", () => ({
  onGitChanged: vi.fn().mockResolvedValue(() => {}),
  onPrChanged: vi.fn().mockResolvedValue(() => {}),
}));

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s-1",
    title: "terminal",
    status: "running",
    cols: 80,
    rows: 24,
    cwd: "C:/projects/oppa",
    ...overrides,
  };
}

describe("WorkspaceList", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      tabs: [],
      activeTabId: "",
      sessions: {},
      worktrees: [],
      repos: [],
      workingBySessionId: {},
      statusBySessionId: {},
      unreadBySessionId: {},
      tabFocusHistory: [],
    });
  });

  it("shows the empty state when no workspaces are open", () => {
    render(<WorkspaceList />);
    expect(screen.getByText("No Workspaces")).toBeInTheDocument();
  });

  it("renders one card per workspace with title and its terminal rows", () => {
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-1",
          title: "oppa",
          workspaceKey: "C:/projects/oppa",
          layout: {
            type: "split",
            dir: "v",
            ratio: 0.5,
            a: { type: "leaf", id: "s-1" },
            b: { type: "leaf", id: "s-2" },
          },
          focusedPath: [0],
        },
      ],
      activeTabId: "tab-1",
      sessions: {
        "s-1": session({ id: "s-1", title: "web runtime render" }),
        "s-2": session({ id: "s-2", title: "desktop lane" }),
      },
    });

    render(<WorkspaceList />);

    expect(screen.getByText("oppa")).toBeInTheDocument();
    expect(screen.getByText("web runtime render")).toBeInTheDocument();
    expect(screen.getByText("desktop lane")).toBeInTheDocument();
  });

  it("surfaces the worktree name and branch in the row tooltip", () => {
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-1",
          title: "oppa",
          workspaceKey: "C:/projects/oppa",
          layout: { type: "leaf", id: "s-1" },
          focusedPath: [],
        },
      ],
      activeTabId: "tab-1",
      sessions: {
        "s-1": session({ id: "s-1", title: "agent run", worktreeId: "wt-1" }),
      },
      worktrees: [
        {
          record: {
            id: "wt-1",
            repo_id: "demo",
            name: "web-runtime-render",
            display_name: "PERF web runtime render",
            branch: "perf/render",
            path: "C:/projects/oppa/wt-1",
            base_ref: "main",
            parent_worktree_id: null,
            child_worktree_ids: [],
            workspace_status: "in-progress" as const,
            retired: false,
            created_at_ms: 0,
            linked_pr_url: null,
          },
          missing_on_disk: false,
        },
      ],
    });

    render(<WorkspaceList />);

    expect(screen.getByTitle("web-runtime-render · perf/render")).toBeInTheDocument();
  });

  it("collapses inactive workspaces and expands the active one", () => {
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-1",
          title: "alpha",
          layout: { type: "leaf", id: "s-1" },
          focusedPath: [],
        },
        {
          id: "tab-2",
          title: "beta",
          layout: { type: "leaf", id: "s-2" },
          focusedPath: [],
        },
      ],
      activeTabId: "tab-2",
      sessions: {
        "s-1": session({ id: "s-1", title: "alpha term" }),
        "s-2": session({ id: "s-2", title: "beta term" }),
      },
    });

    render(<WorkspaceList />);

    // beta is active → its row is visible; alpha is collapsed → row hidden
    expect(screen.getByText("beta term")).toBeInTheDocument();
    expect(screen.queryByText("alpha term")).not.toBeInTheDocument();
  });

  it("selecting a collapsed workspace expands it; clicking a row focuses that pane", () => {
    const selectTabSpy = vi.spyOn(useTerminalStore.getState(), "selectTab");
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-1",
          title: "alpha",
          layout: { type: "leaf", id: "s-1" },
          focusedPath: [],
        },
        {
          id: "tab-2",
          title: "beta",
          layout: { type: "leaf", id: "s-2" },
          focusedPath: [],
        },
      ],
      activeTabId: "tab-2",
      sessions: {
        "s-1": session({ id: "s-1", title: "alpha term" }),
        "s-2": session({ id: "s-2", title: "beta term" }),
      },
    });

    render(<WorkspaceList />);

    // Click alpha header: workspace becomes selected
    fireEvent.click(screen.getByText("alpha"));
    expect(selectTabSpy).toHaveBeenCalledWith("tab-1");
  });

  it("filters workspaces and rows by search query", () => {
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-1",
          title: "oppa",
          workspaceKey: "C:/projects/oppa",
          layout: {
            type: "split",
            dir: "v",
            ratio: 0.5,
            a: { type: "leaf", id: "s-1" },
            b: { type: "leaf", id: "s-2" },
          },
          focusedPath: [0],
        },
        {
          id: "tab-2",
          title: "unrelated",
          layout: { type: "leaf", id: "s-3" },
          focusedPath: [],
        },
      ],
      activeTabId: "tab-1",
      sessions: {
        "s-1": session({ id: "s-1", title: "web runtime render" }),
        "s-2": session({ id: "s-2", title: "server core lane" }),
        "s-3": session({ id: "s-3", title: "unrelated term" }),
      },
    });

    render(<WorkspaceList filter="server" />);

    expect(screen.getByText("oppa")).toBeInTheDocument();
    expect(screen.getByText("server core lane")).toBeInTheDocument();
    expect(screen.queryByText("unrelated")).not.toBeInTheDocument();
    expect(screen.queryByText("web runtime render")).not.toBeInTheDocument();
  });

  it("shows a gutter status dot on rows whose session has an agent status", () => {
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-1",
          title: "oppa",
          layout: { type: "leaf", id: "s-1" },
          focusedPath: [],
        },
      ],
      activeTabId: "tab-1",
      sessions: {
        "s-1": session({ id: "s-1", title: "a" }),
      },
      statusBySessionId: {
        "s-1": {
          state: "working",
          state_started_at_ms: 0,
          updated_at_ms: 0,
          origin: "hook",
        },
      },
    });

    render(<WorkspaceList />);
    expect(screen.getByLabelText("Status: working")).toBeInTheDocument();
  });

  it("shows a status dot on idle rows too", () => {
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-1",
          title: "oppa",
          layout: { type: "leaf", id: "s-1" },
          focusedPath: [],
        },
      ],
      activeTabId: "tab-1",
      sessions: { "s-1": session({ id: "s-1", title: "quiet pane" }) },
    });

    render(<WorkspaceList />);
    expect(screen.getByLabelText("Status: idle")).toBeInTheDocument();
  });

  it("shows the collapse chevron on folder headers only when there are multiple sessions", () => {
    const twoPaneLayout = {
      type: "split",
      dir: "v",
      ratio: 0.5,
      a: { type: "leaf", id: "s-1" },
      b: { type: "leaf", id: "s-2" },
    } as const;
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-1",
          title: "multi",
          layout: twoPaneLayout,
          focusedPath: [0],
        },
        {
          id: "tab-2",
          title: "single",
          layout: { type: "leaf", id: "s-3" },
          focusedPath: [],
        },
      ],
      activeTabId: "tab-1",
      sessions: {
        "s-1": session({ id: "s-1", title: "one" }),
        "s-2": session({ id: "s-2", title: "two" }),
        "s-3": session({ id: "s-3", title: "three" }),
      },
    });

    render(<WorkspaceList />);

    const multiCard = screen.getByTestId("ws-card-tab-1");
    expect(multiCard.querySelector(".ws-card-chevron")).not.toBeNull();
    expect(multiCard.querySelector(".ws-card-header")?.getAttribute("aria-expanded")).toBe(
      "true",
    );

    const singleCard = screen.getByTestId("ws-card-tab-2");
    expect(singleCard.querySelector(".ws-card-chevron")).toBeNull();
  });

  it("pins a session to the top of its folder and unpins it back", () => {
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-1",
          title: "oppa",
          layout: {
            type: "split",
            dir: "v",
            ratio: 0.5,
            a: { type: "leaf", id: "s-1" },
            b: { type: "leaf", id: "s-2" },
          },
          focusedPath: [0],
        },
      ],
      activeTabId: "tab-1",
      sessions: {
        "s-1": session({ id: "s-1", title: "first" }),
        "s-2": session({ id: "s-2", title: "second" }),
      },
    });

    const { container } = render(<WorkspaceList />);
    const rowTitles = () =>
      Array.from(container.querySelectorAll(".ws-row-title")).map((el) => el.textContent);
    expect(rowTitles()).toEqual(["first", "second"]);

    fireEvent.click(screen.getByRole("button", { name: "Pin second" }));
    expect(rowTitles()).toEqual(["second", "first"]);
    expect(screen.getByRole("button", { name: "Unpin second" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Unpin second" }));
    expect(rowTitles()).toEqual(["first", "second"]);
  });

  it("renders folder section headers for each workspace", () => {
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-1",
          title: "oppa",
          layout: { type: "leaf", id: "s-1" },
          focusedPath: [],
        },
      ],
      activeTabId: "tab-1",
      sessions: { "s-1": session({ id: "s-1", title: "a" }) },
    });

    render(<WorkspaceList />);
    const header = screen.getByText("oppa").closest(".ws-card-header");
    expect(header?.querySelector(".ws-card-avatar")).not.toBeNull();
  });

  it("shows a relative age next to the row title from the agent status timestamp", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000_000_000);
    const startedAt = Date.now() - 5 * 60_000;
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-1",
          title: "oppa",
          layout: { type: "leaf", id: "s-1" },
          focusedPath: [],
        },
      ],
      activeTabId: "tab-1",
      sessions: {
        "s-1": session({ id: "s-1", title: "agent run" }),
      },
      statusBySessionId: {
        "s-1": {
          state: "working",
          state_started_at_ms: startedAt,
          updated_at_ms: startedAt,
          origin: "hook",
        },
      },
    });

    render(<WorkspaceList />);
    expect(screen.getByText("5m")).toBeInTheDocument();
    vi.restoreAllMocks();
  });

  it("applies is-active class to the currently focused session row in the active tab", () => {
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-1",
          title: "oppa",
          layout: {
            type: "split",
            dir: "v",
            ratio: 0.5,
            a: { type: "leaf", id: "s-1" },
            b: { type: "leaf", id: "s-2" },
          },
          focusedPath: [0],
        },
      ],
      activeTabId: "tab-1",
      sessions: {
        "s-1": session({ id: "s-1", title: "active pane" }),
        "s-2": session({ id: "s-2", title: "inactive pane" }),
      },
    });

    const { container } = render(<WorkspaceList />);
    const activeRow = container.querySelector(".ws-row.is-active");
    expect(activeRow).toBeInTheDocument();
    expect(activeRow?.textContent).toContain("active pane");
  });

  it("splits the pane when the split button on a row is clicked", () => {
    const splitSpy = vi.spyOn(useTerminalStore.getState(), "splitPane").mockResolvedValue(undefined);
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-1",
          title: "oppa",
          layout: { type: "leaf", id: "s-1" },
          focusedPath: [],
        },
      ],
      activeTabId: "tab-1",
      sessions: {
        "s-1": session({ id: "s-1", title: "main pane" }),
      },
    });

    render(<WorkspaceList />);
    const splitBtn = screen.getByRole("button", { name: /split main pane/i });
    fireEvent.click(splitBtn);

    expect(splitSpy).toHaveBeenCalledWith("v");
  });

  it("closes the pane when the close button on a row is clicked", () => {
    const closeSpy = vi.spyOn(useTerminalStore.getState(), "closePane").mockResolvedValue(undefined);
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-1",
          title: "oppa",
          layout: { type: "leaf", id: "s-1" },
          focusedPath: [],
        },
      ],
      activeTabId: "tab-1",
      sessions: {
        "s-1": session({ id: "s-1", title: "pane to close" }),
      },
    });

    render(<WorkspaceList />);
    const closeBtn = screen.getByRole("button", { name: /close pane to close/i });
    fireEvent.click(closeBtn);

    expect(closeSpy).toHaveBeenCalled();
  });
});

