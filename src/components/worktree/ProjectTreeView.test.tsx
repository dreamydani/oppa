import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { ProjectTreeView } from "./ProjectTreeView";
import { useTerminalStore } from "../../store/terminalStore";
import type { RepoRecord, WorktreeRecord } from "../../lib/pty/transport";
import type { SessionInfo } from "../../store/slices/terminalSessionsSlice";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/pty/transport", () => ({
  ptySpawn: vi.fn(),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  ptyResize: vi.fn().mockResolvedValue(undefined),
  ptyAck: vi.fn().mockResolvedValue(undefined),
  ptyWrite: vi.fn(),
  saveLayout: vi.fn().mockResolvedValue(undefined),
  loadLayout: vi.fn().mockResolvedValue(null),
  saveScrollback: vi.fn().mockResolvedValue(undefined),
  loadScrollback: vi.fn().mockResolvedValue(null),
  deleteScrollback: vi.fn().mockResolvedValue(undefined),
  cleanupStaleScrollbacks: vi.fn().mockResolvedValue(undefined),
  onPtyData: vi.fn(),
  onPtyExit: vi.fn(),
  onPtyCwd: vi.fn(),
  onWorktreeChanged: vi.fn().mockResolvedValue(() => {}),
  onGitChanged: vi.fn().mockResolvedValue(() => {}),
  onPrChanged: vi.fn().mockResolvedValue(() => {}),
  requestReviewEligibility: vi.fn().mockResolvedValue({
    eligible: true,
    blocked_reason: null,
    base_ref: "main",
    owner_repo: "owner/repo",
    existing_pr_url: null,
  }),
  requestCreateReview: vi.fn().mockResolvedValue({
    pr_url: "https://example.com/pr/1",
    pr_number: 1,
    base_ref: "main",
    owner_repo: "owner/repo",
  }),
  requestReviewStatus: vi.fn().mockResolvedValue({
    number: 1,
    title: "t",
    url: "https://example.com/pr/1",
    state: "open",
    draft: false,
    mergeable: "unknown",
    base_ref_name: "main",
    head_ref_name: "feat",
    checks: [],
    fetched_at_ms: 0,
  }),
  onTitleChanged: vi.fn().mockResolvedValue(() => {}),
  onFocusRequested: vi.fn().mockResolvedValue(() => {}),
  onSessionWorking: vi.fn().mockResolvedValue(() => {}),
  onAgentStatus: vi.fn().mockResolvedValue(() => {}),
  worktreeList: vi.fn().mockResolvedValue([]),
  worktreePs: vi.fn().mockResolvedValue([]),
  worktreeCreate: vi.fn(),
  worktreeSet: vi.fn().mockResolvedValue(null),
  worktreeRemove: vi.fn().mockResolvedValue(undefined),
  worktreePurge: vi.fn().mockResolvedValue(undefined),
  repoAdd: vi.fn().mockResolvedValue([]),
  repoList: vi.fn().mockResolvedValue([]),
  ptyList: vi.fn().mockResolvedValue([]),
  agentProfiles: vi.fn().mockResolvedValue([]),
  worktreeCreateAgent: vi.fn(),
  scStatus: vi.fn(),
  scStage: vi.fn().mockResolvedValue(undefined),
  scCommit: vi.fn().mockResolvedValue("head123"),
  scPush: vi.fn().mockResolvedValue({ pushed_to: "origin/feat-a", was_publish: false }),
  scMergeToBase: vi.fn(),
}));

function repo(overrides: Partial<RepoRecord> = {}): RepoRecord {
  return {
    repo_id: "repo-1",
    path: "C:/projects/oppa",
    default_base_ref: "main",
    worktree_base_path: null,
    ...overrides,
  };
}

function wtRecord(overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    id: "repo-1::C:/projects/oppa/wt-feat",
    repo_id: "repo-1",
    name: "feat-auth",
    display_name: null,
    branch: "feat-auth",
    path: "C:/projects/oppa/wt-feat",
    base_ref: "main",
    parent_worktree_id: null,
    child_worktree_ids: [],
    workspace_status: "in-progress",
    retired: false,
    created_at_ms: 1723900000000,
    linked_pr_url: null,
    ...overrides,
  };
}

function session(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    title: "",
    status: "running",
    cwd: "C:/projects/oppa/wt-feat",
    cols: 80,
    rows: 24,
    ...overrides,
  };
}

describe("ProjectTreeView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTerminalStore.setState({
      repos: [repo()],
      worktrees: [
        {
          record: wtRecord(),
          missing_on_disk: false,
        },
        {
          record: wtRecord({
            id: "repo-1::C:/projects/oppa/wt-fix",
            name: "fix-bug",
            branch: "fix-bug",
            path: "C:/projects/oppa/wt-fix",
            workspace_status: "in-review",
            linked_pr_url: "https://github.com/owner/repo/pull/123",
          }),
          missing_on_disk: false,
        },
      ],
      sessions: {
        "s-1": session("s-1", {
          worktreeId: "repo-1::C:/projects/oppa/wt-feat",
          title: "Vite Dev",
        }),
        "s-2": session("s-2", {
          worktreeId: "repo-1::C:/projects/oppa/wt-feat",
          title: "Agent Worker",
        }),
      },
      workingBySessionId: { "s-2": true },
      tabs: [],
      activeTabId: "",
      isWorktreeCreateOpen: false,
    });
  });

  it("renders project header with name, path tooltip, and live session count", () => {
    render(<ProjectTreeView />);

    expect(screen.getByText("oppa")).toBeDefined();
    const header = screen.getByText("oppa").closest(".project-node-header");
    expect(header).not.toBeNull();
    expect(screen.getByTitle("C:/projects/oppa")).toBeDefined();
    expect(header?.textContent).toContain("2 live");
  });

  it("renders branch rows under project header with status indicators and session counts", () => {
    render(<ProjectTreeView />);

    expect(screen.getByText("feat-auth")).toBeDefined();
    expect(screen.getByText("fix-bug")).toBeDefined();

    // feat-auth has an active working session -> status is working
    expect(screen.getByText("working")).toBeDefined();
    // fix-bug has in-review status
    expect(screen.getByText("in-review")).toBeDefined();
    // PR badge with #123
    expect(screen.getByText("#123")).toBeDefined();
  });

  it("clicking branch opens a new tab if no existing tab has the branch", async () => {
    const createTabSpy = vi.spyOn(useTerminalStore.getState(), "createTab");

    render(<ProjectTreeView />);

    fireEvent.click(screen.getByText("fix-bug"));

    expect(createTabSpy).toHaveBeenCalledWith(
      "C:/projects/oppa/wt-fix",
      "repo-1::C:/projects/oppa/wt-fix",
    );
  });

  it("clicking branch focuses existing tab when branch already has an active tab", () => {
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-1",
          layout: { type: "leaf", id: "s-1" },
          focusedPath: [],
        },
        {
          id: "tab-2",
          layout: { type: "leaf", id: "s-other" },
          focusedPath: [],
        },
      ],
      activeTabId: "tab-2",
    });

    render(<ProjectTreeView />);

    fireEvent.click(screen.getByText("feat-auth"));

    expect(useTerminalStore.getState().activeTabId).toBe("tab-1");
  });

  it("action buttons (+ Worktree, Tile Grid) trigger respective actions", () => {
    const tileSpy = vi.spyOn(useTerminalStore.getState(), "tileProjectBranches");

    render(<ProjectTreeView />);

    const tileBtn = screen.getByTitle("Tile branches in grid");
    fireEvent.click(tileBtn);
    expect(tileSpy).toHaveBeenCalledWith("repo-1");

    const addBtn = screen.getByTitle("New Worktree");
    fireEvent.click(addBtn);
    expect(useTerminalStore.getState().isWorktreeCreateOpen).toBe(true);
  });

  it("collapses and expands branches when project header chevron is clicked", () => {
    render(<ProjectTreeView />);

    expect(screen.getByText("feat-auth")).toBeDefined();

    const collapseBtn = screen.getByLabelText("Toggle oppa project");
    fireEvent.click(collapseBtn);

    expect(screen.queryByText("feat-auth")).toBeNull();

    fireEvent.click(collapseBtn);
    expect(screen.getByText("feat-auth")).toBeDefined();
  });

  it("filters branches by search query", () => {
    const { rerender } = render(<ProjectTreeView filter="bug" />);

    expect(screen.queryByText("feat-auth")).toBeNull();
    expect(screen.getByText("fix-bug")).toBeDefined();

    rerender(<ProjectTreeView filter="nonexistent" />);
    expect(screen.getByText("No Matches")).toBeDefined();
  });

  it("lists sub-sessions when multiple sessions exist for a branch and allows clicking to focus", () => {
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-split",
          layout: {
            type: "split",
            dir: "h",
            ratio: 0.5,
            a: { type: "leaf", id: "s-1" },
            b: { type: "leaf", id: "s-2" },
          },
          focusedPath: [0],
        },
      ],
      activeTabId: "tab-split",
    });

    render(<ProjectTreeView />);

    // feat-auth has 2 sessions: s-1 ("Vite Dev") and s-2 ("Agent Worker")
    expect(screen.getByText("Vite Dev")).toBeDefined();
    expect(screen.getByText("Agent Worker")).toBeDefined();

    // Click sub-session s-2
    fireEvent.click(screen.getByText("Agent Worker"));
    expect(useTerminalStore.getState().activeTabId).toBe("tab-split");
  });

  it("renders friendly empty state when no projects or worktrees exist", () => {
    useTerminalStore.setState({
      repos: [],
      worktrees: [],
      sessions: {},
    });

    render(<ProjectTreeView />);

    expect(screen.getByText("No Projects Yet")).toBeDefined();
    const newBtn = screen.getByRole("button", { name: /new worktree/i });
    expect(newBtn).toBeDefined();

    fireEvent.click(newBtn);
    expect(useTerminalStore.getState().isWorktreeCreateOpen).toBe(true);
  });
});
