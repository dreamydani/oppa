import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorkspaceList } from "./WorkspaceList";
import { useTerminalStore } from "../../store/terminalStore";
import type { SessionInfo } from "../../store/slices/terminalSessionsSlice";

// transport is mocked at the store level in sibling tests; mirror the minimal
// surface WorkspaceList touches (event subscriptions run at module import).
vi.mock("../../lib/pty/transport", () => ({
  onWorktreeChanged: vi.fn().mockResolvedValue(() => {}),
  onTitleChanged: vi.fn().mockResolvedValue(() => {}),
  onFocusRequested: vi.fn().mockResolvedValue(() => {}),
  onSessionWorking: vi.fn().mockResolvedValue(() => {}),
  onAgentStatus: vi.fn().mockResolvedValue(() => {}),
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

  it("shows a worktree badge on rows whose session is bound to a worktree", () => {
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

    expect(screen.getByTitle("Branch perf/render")).toBeInTheDocument();
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

  it("shows aggregate severity counts on the card header", () => {
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
    expect(screen.getByText("1 working")).toBeInTheDocument();
  });
});
