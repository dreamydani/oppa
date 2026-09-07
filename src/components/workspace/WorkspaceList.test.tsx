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

  it("renders the working loader on rows whose session is working", () => {
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

    const { container } = render(<WorkspaceList />);
    const loader = screen.getByRole("status", { name: /working/i });
    expect(loader).toBeInTheDocument();
    // Cline-style dot grid: exactly 8 dots chase in sequence.
    expect(loader.querySelectorAll(".agent-working-dot")).toHaveLength(8);
    // The loader replaces the status circle entirely — no duplicate dot.
    expect(container.querySelector(".ws-status-circle")).toBeNull();
  });

  it("renders the working loader from the quiet-watcher fallback too", () => {
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
      workingBySessionId: { "s-1": true },
    });

    render(<WorkspaceList />);
    expect(screen.getByRole("status", { name: /working/i })).toBeInTheDocument();
  });

  it("renders a green done dot for hook-classified done state", () => {
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
          state: "done",
          state_started_at_ms: 0,
          updated_at_ms: 0,
          origin: "hook",
        },
      },
    });

    const { container } = render(<WorkspaceList />);
    const dot = container.querySelector(".ws-status-circle.done");
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute("aria-label")).toBe("Status: done");
  });

  it("renders no status indicator on idle rows", () => {
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

    const { container } = render(<WorkspaceList />);
    expect(container.querySelector(".ws-status-circle")).toBeNull();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("renders no status indicator on exited rows", () => {
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
        "s-1": session({ id: "s-1", title: "dead pane", status: "exited" }),
      },
    });

    const { container } = render(<WorkspaceList />);
    expect(container.querySelector(".ws-status-circle")).toBeNull();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
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
    // Card rows only: the Pinned section mirrors titles above the cards.
    const rowTitles = () =>
      Array.from(container.querySelectorAll(".ws-card .ws-row-title")).map((el) => el.textContent);
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

  it("groups cards under Active and Recents section headers with counts", () => {
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

    const { container } = render(<WorkspaceList />);
    const headers = Array.from(
      container.querySelectorAll(".ws-section-header"),
    ).map((el) => el.textContent);
    expect(headers).toEqual(["Active1", "Recents1"]);
  });

  it("shows a Pinned section once a session is pinned, hidden again on unpin", () => {
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
    expect(container.querySelector(".ws-section-pinned")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Pin second" }));
    const pinned = container.querySelector(".ws-section-pinned");
    expect(pinned).not.toBeNull();
    expect(pinned?.textContent).toContain("second");

    fireEvent.click(screen.getByRole("button", { name: "Unpin second" }));
    expect(container.querySelector(".ws-section-pinned")).toBeNull();
  });

  it("sectionFilter=active shows only the active card", () => {
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

    render(<WorkspaceList sectionFilter="active" />);
    expect(screen.getByText("beta")).toBeInTheDocument();
    expect(screen.queryByText("alpha")).not.toBeInTheDocument();
  });

  it("sectionFilter=worktrees keeps only rows bound to a worktree", () => {
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
        "s-1": session({ id: "s-1", title: "plain pane", cwd: "C:/projects/oppa" }),
        "s-2": session({ id: "s-2", title: "agent run", worktreeId: "wt-1" }),
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

    render(<WorkspaceList sectionFilter="worktrees" />);
    expect(screen.getByText("PERF web runtime render")).toBeInTheDocument();
    expect(screen.queryByText("plain pane")).not.toBeInTheDocument();
  });

  it("sectionFilter=attention keeps only rows that need attention", () => {
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
        "s-1": session({ id: "s-1", title: "quiet pane" }),
        "s-2": session({ id: "s-2", title: "busy pane" }),
      },
      workingBySessionId: { "s-2": true },
    });

    render(<WorkspaceList sectionFilter="attention" />);
    expect(screen.getByText("busy pane")).toBeInTheDocument();
    expect(screen.queryByText("quiet pane")).not.toBeInTheDocument();
  });

  it("shows the cwd basename and branch as row context", () => {    useTerminalStore.setState({
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
        "s-1": session({ id: "s-1", title: "agent run", worktreeId: "wt-1", cwd: "C:/projects/oppa/wt-1" }),
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
    expect(screen.getByText("wt-1 · perf/render")).toBeInTheDocument();
  });

  function worktreeState(overrides = {}) {
    return {
      tabs: [
        {
          id: "tab-1",
          title: "oppa",
          workspaceKey: "C:/projects/oppa",
          layout: { type: "leaf" as const, id: "s-1" },
          focusedPath: [],
        },
      ],
      activeTabId: "tab-1",
      sessions: {
        "s-1": session({ id: "s-1", title: "agent run", worktreeId: "wt-1", cwd: "C:/projects/oppa/wt-1" }),
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
            ...overrides,
          },
          missing_on_disk: false,
        },
      ],
    };
  }

  it("shows the worktree status pill with its base ref", () => {
    useTerminalStore.setState(worktreeState());

    render(<WorkspaceList />);
    expect(screen.getByText("in-progress → main")).toBeInTheDocument();
  });

  it("renders a PR badge linking the worktree pull request", () => {
    useTerminalStore.setState(
      worktreeState({ linked_pr_url: "https://example.com/owner/repo/pull/12" }),
    );

    render(<WorkspaceList />);
    const badge = screen.getByRole("link", { name: /open PR #12/i });
    expect(badge.getAttribute("href")).toBe("https://example.com/owner/repo/pull/12");
  });

  it("marks worktrees missing on disk", () => {
    const state = worktreeState();
    state.worktrees[0].missing_on_disk = true;
    useTerminalStore.setState(state);

    const { container } = render(<WorkspaceList />);
    const row = container.querySelector(".ws-row");
    expect(row?.classList.contains("ws-row-missing")).toBe(true);
    expect(screen.getByTitle(/missing on disk/i)).toBeInTheDocument();
  });

  it("dims retired worktrees", () => {
    useTerminalStore.setState(worktreeState({ retired: true }));

    const { container } = render(<WorkspaceList />);
    expect(container.querySelector(".ws-row.retired")).not.toBeNull();
  });

  it("renders blocked and waiting status dots instead of silence", () => {
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
        "s-1": session({ id: "s-1", title: "blocked pane" }),
        "s-2": session({ id: "s-2", title: "waiting pane" }),
      },
      statusBySessionId: {
        "s-1": {
          state: "blocked",
          state_started_at_ms: 0,
          updated_at_ms: 0,
          origin: "hook",
        },
        "s-2": {
          state: "waiting",
          state_started_at_ms: 0,
          updated_at_ms: 0,
          origin: "hook",
        },
      },
    });

    const { container } = render(<WorkspaceList />);
    expect(container.querySelector(".ws-status-circle.blocked")).not.toBeNull();
    expect(container.querySelector(".ws-status-circle.waiting")).not.toBeNull();
  });

  it("bolds rows with unseen agent updates", () => {
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
      unreadBySessionId: { "s-1": true },
    });

    const { container } = render(<WorkspaceList />);
    expect(container.querySelector(".ws-row.is-unread")).not.toBeNull();
  });

  it("focuses the pane when Enter is pressed on a row", () => {
    const focusSpy = vi.spyOn(useTerminalStore.getState(), "focusPane");
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
      sessions: { "s-1": session({ id: "s-1", title: "main pane" }) },
    });

    const { container } = render(<WorkspaceList />);
    const row = container.querySelector(".ws-row")!;
    expect(row.getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(row, { key: "Enter" });

    expect(focusSpy).toHaveBeenCalled();
  });

  it("pins and closes the row from keyboard shortcuts", () => {
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
      sessions: { "s-1": session({ id: "s-1", title: "main pane" }) },
    });

    const { container } = render(<WorkspaceList />);
    const row = container.querySelector(".ws-row")!;

    fireEvent.keyDown(row, { key: "p" });
    expect(screen.getByRole("button", { name: "Unpin main pane" })).toBeDefined();

    fireEvent.keyDown(row, { key: "Delete" });
    expect(closeSpy).toHaveBeenCalled();
  });

  it("opens a context menu on right-click with pin and copy-path actions", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
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
        "s-1": session({ id: "s-1", title: "main pane", cwd: "C:/projects/oppa" }),
      },
    });

    const { container } = render(<WorkspaceList />);
    fireEvent.contextMenu(container.querySelector(".ws-row")!);

    fireEvent.click(screen.getByRole("menuitem", { name: /copy path/i }));
    expect(writeText).toHaveBeenCalledWith("C:/projects/oppa");
    if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor);
  });

  it("anchors the context menu at the cursor, fixed above the rows", () => {
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
      sessions: { "s-1": session({ id: "s-1", title: "main pane" }) },
    });

    const { container } = render(<WorkspaceList />);
    fireEvent.contextMenu(container.querySelector(".ws-row")!, {
      clientX: 100,
      clientY: 200,
    });

    const menu = screen.getByRole("menu");
    // Fixed positioning is inline so no stylesheet rule (.ws-row
    // .worktree-card-menu) can drag it back to row-anchored absolute.
    expect(menu.style.position).toBe("fixed");
    expect(menu.classList.contains("ws-row-menu")).toBe(true);
    expect(menu.style.left).toBe("100px");
    expect(menu.style.top).toBe("200px");
  });

  it("clamps the context menu inside the viewport near the corner", () => {
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
      sessions: { "s-1": session({ id: "s-1", title: "main pane" }) },
    });

    const { container } = render(<WorkspaceList />);
    fireEvent.contextMenu(container.querySelector(".ws-row")!, {
      clientX: window.innerWidth - 10,
      clientY: window.innerHeight - 10,
    });

    const menu = screen.getByRole("menu");
    const left = parseFloat(menu.style.left);
    const top = parseFloat(menu.style.top);
    expect(left).toBeLessThan(window.innerWidth - 10);
    expect(top).toBeLessThan(window.innerHeight - 10);
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
  });

  it("closes the context menu when the sidebar scrolls", () => {
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
      sessions: { "s-1": session({ id: "s-1", title: "main pane" }) },
    });

    const { container } = render(<WorkspaceList />);
    fireEvent.contextMenu(container.querySelector(".ws-row")!, {
      clientX: 100,
      clientY: 200,
    });
    expect(screen.queryByRole("menu")).not.toBeNull();

    fireEvent.scroll(container.querySelector(".workspace-list")!);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("shows an all-caught-up empty state for the attention view", () => {    useTerminalStore.setState({
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

    render(<WorkspaceList sectionFilter="attention" />);
    expect(screen.getByText("All caught up")).toBeInTheDocument();
  });

  it("offers a New Worktree button from the worktrees empty state", () => {
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
      sessions: { "s-1": session({ id: "s-1", title: "plain pane" }) },
    });

    render(<WorkspaceList sectionFilter="worktrees" />);
    fireEvent.click(screen.getByRole("button", { name: /new worktree/i }));
    expect(useTerminalStore.getState().isWorktreeCreateOpen).toBe(true);
  });

  function twoCardState() {
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-1",
          title: "alpha",
          layout: {
            type: "split" as const,
            dir: "v" as const,
            ratio: 0.5,
            a: { type: "leaf" as const, id: "s-1" },
            b: { type: "leaf" as const, id: "s-2" },
          },
          focusedPath: [0],
        },
        {
          id: "tab-2",
          title: "beta",
          layout: { type: "leaf" as const, id: "s-3" },
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
  }

  it("collapses the active card and re-expands it on header click", () => {
    twoCardState();
    const { container } = render(<WorkspaceList />);
    const header = screen.getByText("alpha").closest(".ws-card-header")!;

    expect(screen.getByText("one")).toBeInTheDocument();
    fireEvent.click(header);
    expect(screen.queryByText("one")).not.toBeInTheDocument();
    expect(header.querySelector(".ws-card-chevron.expanded")).toBeNull();

    fireEvent.click(header);
    expect(screen.getByText("one")).toBeInTheDocument();
    expect(
      container.querySelector(".ws-card-chevron.expanded"),
    ).not.toBeNull();
  });

  it("expands an inactive card on header click", () => {
    twoCardState();
    render(<WorkspaceList />);

    // beta is collapsed by default: its single row is hidden.
    expect(screen.queryByText("three")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("beta").closest(".ws-card-header")!);
    expect(screen.getByText("three")).toBeInTheDocument();
  });

  it("toggles the card from the keyboard", () => {
    twoCardState();
    render(<WorkspaceList />);
    const header = screen.getByText("alpha").closest(".ws-card-header")!;

    fireEvent.keyDown(header, { key: "Enter" });
    expect(screen.queryByText("one")).not.toBeInTheDocument();

    fireEvent.keyDown(header, { key: "Enter" });
    expect(screen.getByText("one")).toBeInTheDocument();
  });
});

