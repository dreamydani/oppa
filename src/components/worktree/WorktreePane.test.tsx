import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen, act } from "@testing-library/react";
import { WorktreePane } from "./WorktreePane";
import { useTerminalStore } from "../../store/terminalStore";
import {
  resetAutoStatusAppliedForTests,
  selectWorktreeFinished,
} from "../../store/slices/worktreeRegistrySlice";
import * as transport from "../../lib/pty/transport";
import type { PushOutcome, SourceControlStatus, WorktreeRecord } from "../../lib/pty/transport";
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
  requestReviewEligibility: vi.fn().mockResolvedValue({ eligible: true, blocked_reason: null, base_ref: 'main', owner_repo: 'owner/repo', existing_pr_url: null }),
  requestCreateReview: vi.fn().mockResolvedValue({ pr_url: 'https://example.com/pr/1', pr_number: 1, base_ref: 'main', owner_repo: 'owner/repo' }),
  requestReviewStatus: vi.fn().mockResolvedValue({ number: 1, title: 't', url: 'https://example.com/pr/1', state: 'open', draft: false, mergeable: 'unknown', base_ref_name: 'main', head_ref_name: 'feat', checks: [], fetched_at_ms: 0 }),
  onTitleChanged: vi.fn().mockResolvedValue(() => {}),
  onFocusRequested: vi.fn().mockResolvedValue(() => {}),
  onSessionWorking: vi.fn().mockResolvedValue(() => {}),
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

const worktreeSetMock = vi.mocked(transport.worktreeSet);
const worktreeRemoveMock = vi.mocked(transport.worktreeRemove);
const worktreeListMock = vi.mocked(transport.worktreeList);
const scStatusMock = vi.mocked(transport.scStatus);
const scStageMock = vi.mocked(transport.scStage);
const scCommitMock = vi.mocked(transport.scCommit);
const scPushMock = vi.mocked(transport.scPush);
const eligibilityMock = vi.mocked(transport.requestReviewEligibility);
const createReviewMock = vi.mocked(transport.requestCreateReview);
const scMergeToBaseMock = vi.mocked(transport.scMergeToBase);
const worktreePsMock = vi.mocked(transport.worktreePs);

function record(overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    id: "demo::C:/ws/feat-a",
    repo_id: "demo",
    name: "feat-a",
    display_name: null,
    branch: "feat-a",
    path: "C:/ws/feat-a",
    base_ref: "main",
    parent_worktree_id: null,
    child_worktree_ids: [],
    workspace_status: "todo",
    retired: false,
    created_at_ms: 1723900000000,
    linked_pr_url: null,
    ...overrides,
  };
}

describe("WorktreePane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTerminalStore.setState({
      worktrees: [
        {
          record: record({
            id: "demo::C:/ws/feat-a",
            name: "feat-a",
            display_name: "Feat A",
            branch: "feat-a",
            workspace_status: "in-progress",
          }),
          missing_on_disk: false,
        },
        {
          record: record({
            id: "demo::C:/ws/old-thing",
            name: "old-thing",
            display_name: null,
            branch: "old-thing",
            workspace_status: "completed",
            retired: true,
            created_at_ms: 1723900000001,
          }),
          missing_on_disk: true,
        },
      ],
      worktreeLiveSessions: { "demo::C:/ws/feat-a": 2 },
    });
  });

  it("renders active and retired cards with status chips and warning states", () => {
    const { container } = render(<WorktreePane />);

    expect(screen.getByText("Feat A")).toBeDefined();
    expect(screen.getByText("In Progress")).toBeDefined();
    expect(screen.getByText("2 live")).toBeDefined();

    const retiredCard = screen.getByText("retired").closest(".worktree-card")!;
    expect(retiredCard.className).toContain("retired");
    expect(retiredCard.className).toContain("missing");
    expect(screen.getByText("retired")).toBeDefined();
    expect(screen.getByText(/missing on disk/i)).toBeDefined();

    // Active card keeps a status chip; tombstone does not
    const activeCard = screen.getByText("Feat A").closest(".worktree-card")!;
    expect(activeCard.querySelectorAll(".worktree-status-chip").length).toBe(1);
    expect(retiredCard.querySelectorAll(".worktree-status-chip").length).toBe(0);
    void container;
  });

  it("card kebab menu triggers the set-status action", async () => {
    render(<WorktreePane />);

    fireEvent.click(screen.getByRole("button", { name: /actions for feat a/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Completed" }));

    await vi.waitFor(() => {
      expect(worktreeSetMock).toHaveBeenCalledWith("demo::C:/ws/feat-a", {
        workspaceStatus: "completed",
      });
    });
  });

  it("remove flow surfaces the teardown-refusal reason inside the confirm dialog", async () => {
    worktreeRemoveMock.mockRejectedValue(
      "cannot remove worktree demo::C:/ws/feat-a: live sessions present: s-1 (cwd inside worktree)",
    );

    render(<WorktreePane />);
    fireEvent.click(screen.getByRole("button", { name: /actions for feat a/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /remove/i }));

    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));

    await vi.waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/live sessions present/);
    });
  });

  it("shows Force Remove when remove is rejected by live sessions and clicking it retries with force", async () => {
    worktreeRemoveMock.mockRejectedValueOnce(
      "cannot remove worktree demo::C:/ws/feat-a: live sessions present: s-1 (cwd inside worktree)",
    );
    worktreeRemoveMock.mockResolvedValueOnce(undefined);

    render(<WorktreePane />);
    fireEvent.click(screen.getByRole("button", { name: /actions for feat a/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /remove/i }));

    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));

    await vi.waitFor(() => {
      expect(screen.getByRole("button", { name: /force remove/i })).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: /force remove/i }));

    await vi.waitFor(() => {
      expect(worktreeRemoveMock).toHaveBeenLastCalledWith("demo::C:/ws/feat-a", true, false);
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
  });

  it("purge is only offered for retired tombstones", () => {
    render(<WorktreePane />);

    fireEvent.click(screen.getByRole("button", { name: /actions for feat a/i }));
    expect(screen.queryByRole("menuitem", { name: /purge/i })).toBeNull();

    fireEvent.click(document.body);
    fireEvent.click(screen.getByRole("button", { name: /actions for old-thing/i }));
    expect(screen.getByRole("menuitem", { name: /purge/i })).toBeDefined();
    expect(screen.queryByRole("menuitem", { name: /open terminal here/i })).toBeNull();
  });

  it("renders empty state with a create button when no worktrees exist", () => {
    useTerminalStore.setState({ worktrees: [] });
    render(<WorktreePane />);

    expect(screen.getByText(/no workspaces yet/i)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /new worktree/i }));
    expect(useTerminalStore.getState().isWorktreeCreateOpen).toBe(true);
  });

  it("shows PR badge with number when linked_pr_url exists and hides when missing", () => {
    useTerminalStore.setState({
      worktrees: [
        { record: record({ id: "demo::C:/ws/with-pr", name: "with-pr", linked_pr_url: "https://github.com/owner/repo/pull/42", path: "C:/ws/with-pr" }), missing_on_disk: false },
        { record: record({ id: "demo::C:/ws/no-pr", name: "no-pr", linked_pr_url: null, path: "C:/ws/no-pr" }), missing_on_disk: false },
      ],
      worktreeLiveSessions: {},
      reviewByCwd: {},
      prStatusByWorktreeId: {},
    } as unknown as Record<string, unknown>);
    render(<WorktreePane />);
    const badges = screen.getAllByTestId("pr-badge");
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toContain("#42");
    expect(screen.getByTestId("pr-open-link")).toBeInTheDocument();
    // no-pr card has no badge
    const withPrCard = screen.getByText("with-pr").closest(".worktree-card")!;
    const noPrCard = screen.getByText("no-pr").closest(".worktree-card")!;
    expect(withPrCard.querySelector('[data-testid="pr-badge"]')).not.toBeNull();
    expect(noPrCard.querySelector('[data-testid="pr-badge"]')).toBeNull();
  });

  it("badge falls back to #PR when url has no pull number", () => {
    useTerminalStore.setState({
      worktrees: [
        { record: record({ id: "demo::C:/ws/weird", name: "weird", linked_pr_url: "https://github.com/owner/repo/issues/9", path: "C:/ws/weird" }), missing_on_disk: false },
      ],
      worktreeLiveSessions: {},
      reviewByCwd: {},
      prStatusByWorktreeId: {},
    } as unknown as Record<string, unknown>);
    render(<WorktreePane />);
    expect(screen.getByTestId("pr-badge").textContent).toContain("#PR");
  });

  it("badge dot color reflects cached prStatus state", () => {
    const cases: Array<[string, string]> = [
      ["open", "dot-open"],
      ["merged", "dot-merged"],
      ["closed", "dot-closed"],
    ];
    for (const [state, cls] of cases) {
      useTerminalStore.setState({
        worktrees: [
          { record: record({ id: "demo::C:/ws/pr", name: "pr", linked_pr_url: "https://github.com/owner/repo/pull/7", path: "C:/ws/pr" }), missing_on_disk: false },
        ],
        worktreeLiveSessions: {},
        reviewByCwd: {},
        prStatusByWorktreeId: {
          "demo::C:/ws/pr": { number: 7, title: "t", url: "https://github.com/owner/repo/pull/7", state, draft: false, mergeable: "unknown", base_ref_name: "main", head_ref_name: "feat", checks: [], fetched_at_ms: 0 },
        },
      } as unknown as Record<string, unknown>);
      const { unmount } = render(<WorktreePane />);
      expect(screen.getByTestId("pr-badge-dot").className).toContain(cls);
      unmount();
    }
  });

  it("badge dot uses cwd cache when id cache missing and falls back to unknown gray", () => {
    useTerminalStore.setState({
      worktrees: [
        { record: record({ id: "demo::C:/ws/pr2", name: "pr2", linked_pr_url: "https://github.com/owner/repo/pull/8", path: "C:/ws/pr2" }), missing_on_disk: false },
      ],
      worktreeLiveSessions: {},
      reviewByCwd: {
        "C:/ws/pr2": { loading: false, prStatus: { number: 8, title: "t", url: "https://github.com/owner/repo/pull/8", state: "open", draft: false, mergeable: "unknown", base_ref_name: "main", head_ref_name: "feat", checks: [], fetched_at_ms: 0 } },
      },
      prStatusByWorktreeId: {},
    } as unknown as Record<string, unknown>);
    const { unmount } = render(<WorktreePane />);
    expect(screen.getByTestId("pr-badge-dot").className).toContain("dot-open");
    unmount();
    // no cache -> unknown gray
    useTerminalStore.setState({
      worktrees: [
        { record: record({ id: "demo::C:/ws/unknown", name: "unknown", linked_pr_url: "https://github.com/owner/repo/pull/9", path: "C:/ws/unknown" }), missing_on_disk: false },
      ],
      worktreeLiveSessions: {},
      reviewByCwd: {},
      prStatusByWorktreeId: {},
    } as unknown as Record<string, unknown>);
    render(<WorktreePane />);
    expect(screen.getByTestId("pr-badge-dot").className).toContain("dot-unknown");
  });

  it("badge open PR link calls opener", async () => {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    const url = "https://github.com/owner/repo/pull/55";
    useTerminalStore.setState({
      worktrees: [
        { record: record({ id: "demo::C:/ws/open", name: "open", linked_pr_url: url, path: "C:/ws/open" }), missing_on_disk: false },
      ],
      worktreeLiveSessions: {},
      reviewByCwd: {},
      prStatusByWorktreeId: {},
    } as unknown as Record<string, unknown>);
    render(<WorktreePane />);
    fireEvent.click(screen.getByTestId("pr-open-link"));
    await vi.waitFor(() => expect(vi.mocked(openUrl)).toHaveBeenCalledWith(url));
  });
});

describe("WorktreePane linked terminals", () => {
  const WID = "demo::C:/ws/feat-a";

  function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
    return {
      id: "s-fix",
      title: "",
      status: "running",
      cwd: "C:/ws/feat-a",
      cols: 80,
      rows: 24,
      ...overrides,
    };
  }

  function seedStore(sessions: Record<string, SessionInfo>, extra: Record<string, unknown> = {}) {
    useTerminalStore.setState({
      worktrees: [
        {
          record: record({
            id: WID,
            name: "feat-a",
            display_name: "Feat A",
            branch: "feat-a",
            workspace_status: "in-progress",
          }),
          missing_on_disk: false,
        },
      ],
      worktreeLiveSessions: {},
      reviewByCwd: {},
      prStatusByWorktreeId: {},
      sessions,
      workingBySessionId: {},
      tabs: [],
      activeTabId: "",
      ...extra,
    });
  }

  it("lists linked terminal titles with a working/idle dot on the bound card", () => {
    seedStore(
      { "s-fix": session({ id: "s-fix", title: "fix-login-timeout", worktreeId: WID }) },
      { workingBySessionId: { "s-fix": true } },
    );
    render(<WorktreePane />);

    const card = screen.getByText("Feat A").closest(".worktree-card")!;
    expect(card.textContent).toContain("1 terminal");
    const row = card.querySelector(".worktree-terminal-row")!;
    expect(row.textContent).toContain("fix-login-timeout");
    expect(row.querySelector(".worktree-terminal-dot")!.className).toContain("working");

    // Idle transition flips the dot in place.
    act(() => {
      useTerminalStore.setState({ workingBySessionId: { "s-fix": false } });
    });
    expect(row.querySelector(".worktree-terminal-dot")!.className).not.toContain("working");
  });

  it("excludes exited bound sessions from the linked list", () => {
    seedStore({
      gone: session({ id: "gone", title: "done-deal", status: "exited", worktreeId: WID }),
      alive: session({ id: "alive", title: "still-going", worktreeId: WID }),
    });
    render(<WorktreePane />);

    const card = screen.getByText("Feat A").closest(".worktree-card")!;
    const titles = Array.from(card.querySelectorAll(".worktree-terminal-title")).map(
      (el) => el.textContent,
    );
    expect(titles).toEqual(["still-going"]);
  });

  it("clicking a linked terminal selects the tab containing it", () => {
    seedStore(
      { "s-fix": session({ id: "s-fix", title: "fix-login-timeout", worktreeId: WID }) },
      {
        tabs: [
          { id: "t1", layout: { type: "leaf", id: "other" }, focusedPath: [] },
          {
            id: "t2",
            layout: {
              type: "split",
              dir: "h" as const,
              ratio: 0.5,
              a: { type: "leaf" as const, id: "x1" },
              b: { type: "leaf" as const, id: "s-fix" },
            },
            focusedPath: [1],
          },
        ],
        activeTabId: "t1",
      },
    );
    render(<WorktreePane />);

    fireEvent.click(screen.getByText("fix-login-timeout"));
    expect(useTerminalStore.getState().activeTabId).toBe("t2");
  });

  it("shows no terminal rows for an unbound worktree", () => {
    seedStore({ stray: session({ id: "stray", title: "stray" }) });
    render(<WorktreePane />);

    const card = screen.getByText("Feat A").closest(".worktree-card")!;
    expect(card.querySelector(".worktree-terminals")).toBeNull();
    expect(card.querySelectorAll(".worktree-terminal-row").length).toBe(0);
  });
});

describe("WorktreePane finish chain", () => {
  const WID = "demo::C:/ws/feat-a";

  function gitStatus(
    overrides: Partial<SourceControlStatus> = {},
  ): SourceControlStatus {
    return {
      entries: [
        { path: "src/a.ts", index_status: "M", worktree_status: "M", area: "staged", old_path: null },
        { path: "src/b.ts", index_status: " ", worktree_status: "M", area: "unstaged", old_path: null },
        { path: "notes.md", index_status: "?", worktree_status: "?", area: "untracked", old_path: null },
      ],
      conflict_state: "none",
      branch: "feat-a",
      upstream: { has_upstream: true, ahead: 1, behind: 0, remote_branch: "origin/feat-a" },
      did_hit_limit: false,
      status_length: 0,
      ...overrides,
    };
  }

  function seedFinishCard(retired = false) {
    useTerminalStore.setState({
      worktrees: [
        {
          record: record({
            id: WID,
            name: "feat-a",
            display_name: "Feat A",
            branch: "feat-a",
            workspace_status: retired ? "completed" : "in-progress",
            retired,
          }),
          missing_on_disk: false,
        },
      ],
      worktreeLiveSessions: {},
      reviewByCwd: {},
      prStatusByWorktreeId: {},
      sessions: {},
      workingBySessionId: {},
      tabs: [],
      activeTabId: "",
      gitStatus: null,
    } as unknown as Record<string, unknown>);
  }

  // Wires every transport so the whole chain lands; `order` receives one tag
  // per completed call for exact sequencing assertions.
  function primeHappyPath(order?: string[]) {
    scStatusMock.mockResolvedValue(gitStatus());
    scStageMock.mockImplementation(async () => {
      order?.push("stage");
    });
    scCommitMock.mockImplementation(async () => {
      order?.push("commit");
      return "head123";
    });
    scPushMock.mockImplementation(async () => {
      order?.push("push");
      return { pushed_to: "origin/feat-a", was_publish: false };
    });
    eligibilityMock.mockResolvedValue({
      eligible: true,
      blocked_reason: null,
      base_ref: "main",
      owner_repo: "owner/repo",
      existing_pr_url: null,
    });
    createReviewMock.mockImplementation(async () => {
      order?.push("review");
      return { pr_url: "https://github.com/owner/repo/pull/9", pr_number: 9, base_ref: "main", owner_repo: "owner/repo" };
    });
    worktreeSetMock.mockImplementation(async () => {
      order?.push("status");
      return null;
    });
    // The post-success reload must keep the card mounted for inline feedback.
    worktreeListMock.mockResolvedValue([
      {
        record: record({ id: WID, name: "feat-a", display_name: "Feat A", branch: "feat-a", workspace_status: "in-review" }),
        missing_on_disk: false,
      },
    ]);
  }

  function openFinishMenu() {
    fireEvent.click(screen.getByRole("button", { name: /actions for feat a/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /finish/i }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    seedFinishCard();
  });

  it("chains stage→commit→push→create→in-review and confirms with the PR number", async () => {
    const order: string[] = [];
    primeHappyPath(order);

    render(<WorktreePane />);
    openFinishMenu();

    await vi.waitFor(() => {
      expect(screen.getByText(/PR #9 created/i)).toBeInTheDocument();
    });
    expect(order).toEqual(["stage", "commit", "push", "review", "status"]);
    expect(scStageMock).toHaveBeenCalledWith("C:/ws/feat-a", ["src/a.ts", "src/b.ts", "notes.md"]);
    expect(scCommitMock).toHaveBeenCalledWith("C:/ws/feat-a", "finish: merge work from Feat A");
    expect(scPushMock).toHaveBeenCalledWith("C:/ws/feat-a", false, false);
    expect(createReviewMock).toHaveBeenCalledWith("C:/ws/feat-a", {
      title: "Feat A",
      body: "Automated finish for branch feat-a",
      draft: false,
    });
    expect(worktreeSetMock).toHaveBeenCalledWith(WID, { workspaceStatus: "in-review" });
  });

  it("shows an inline spinner while the chain is running", async () => {
    primeHappyPath();
    let resolvePush!: (value: PushOutcome) => void;
    scPushMock.mockReturnValueOnce(new Promise<PushOutcome>((res) => { resolvePush = res; }));

    render(<WorktreePane />);
    openFinishMenu();

    await vi.waitFor(() => {
      expect(screen.getByText(/finishing…/i)).toBeInTheDocument();
    });
    resolvePush({ pushed_to: "origin/feat-a", was_publish: false });
    await vi.waitFor(() => {
      expect(screen.getByText(/PR #9 created/i)).toBeInTheDocument();
    });
  });

  it("conflicted working copy fails early with a reason and mutates nothing", async () => {
    scStatusMock.mockResolvedValue(
      gitStatus({
        entries: [
          { path: "src/a.ts", index_status: "U", worktree_status: "U", area: "conflict", old_path: null },
          { path: "src/b.ts", index_status: "U", worktree_status: "U", area: "conflict", old_path: null },
        ],
        conflict_state: "merge",
      }),
    );

    render(<WorktreePane />);
    openFinishMenu();

    await vi.waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/2 conflicted files — resolve first/);
    });
    expect(scStageMock).not.toHaveBeenCalled();
    expect(scCommitMock).not.toHaveBeenCalled();
    expect(scPushMock).not.toHaveBeenCalled();
    expect(worktreeSetMock).not.toHaveBeenCalled();
  });

  it("blocked eligibility surfaces the actionable reason and never creates a review", async () => {
    primeHappyPath();
    eligibilityMock.mockResolvedValue({
      eligible: false,
      blocked_reason: "gh-missing",
      base_ref: null,
      owner_repo: null,
      existing_pr_url: null,
    });

    render(<WorktreePane />);
    openFinishMenu();

    // Human copy from the shared blocked-reason table, not the machine key.
    await vi.waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/install gh cli/i);
    });
    expect(scPushMock).toHaveBeenCalled();
    expect(createReviewMock).not.toHaveBeenCalled();
    expect(worktreeSetMock).not.toHaveBeenCalled();
  });

  it("retired cards offer no Finish action", () => {
    seedFinishCard(true);
    render(<WorktreePane />);

    fireEvent.click(screen.getByRole("button", { name: /actions for feat a/i }));
    expect(screen.queryByRole("menuitem", { name: /finish/i })).toBeNull();
  });
});

describe("finishWorktree store orchestration", () => {
  const WID = "demo::C:/ws/feat-a";
  const PATH = "C:/ws/feat-a";

  function seedRegistry() {
    useTerminalStore.setState({
      worktrees: [
        {
          record: record({ id: WID, name: "feat-a", display_name: "Feat A", branch: "feat-a" }),
          missing_on_disk: false,
        },
      ],
      gitStatus: null,
    } as unknown as Record<string, unknown>);
  }

  function primeTransports() {
    scStatusMock.mockResolvedValue({
      entries: [
        { path: "src/a.ts", index_status: " ", worktree_status: "M", area: "unstaged", old_path: null },
      ],
      conflict_state: "none",
      branch: "feat-a",
      upstream: { has_upstream: true, ahead: 1, behind: 0, remote_branch: "origin/feat-a" },
      did_hit_limit: false,
      status_length: 0,
    });
    scStageMock.mockResolvedValue(undefined);
    scCommitMock.mockResolvedValue("head123");
    scPushMock.mockResolvedValue({ pushed_to: "origin/feat-a", was_publish: false });
    eligibilityMock.mockResolvedValue({
      eligible: true,
      blocked_reason: null,
      base_ref: "main",
      owner_repo: "owner/repo",
      existing_pr_url: null,
    });
    createReviewMock.mockResolvedValue({
      pr_url: "https://github.com/owner/repo/pull/9",
      pr_number: 9,
      base_ref: "main",
      owner_repo: "owner/repo",
    });
    worktreeSetMock.mockResolvedValue(null);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    seedRegistry();
  });

  it("returns ok with pr url + push target following the exact chain order", async () => {
    primeTransports();
    const order: string[] = [];
    scStageMock.mockImplementation(async () => { order.push("stage"); });
    scCommitMock.mockImplementation(async () => { order.push("commit"); return "head123"; });
    scPushMock.mockImplementation(async () => { order.push("push"); return { pushed_to: "origin/feat-a", was_publish: false }; });
    createReviewMock.mockImplementation(async () => { order.push("review"); return { pr_url: "https://github.com/owner/repo/pull/9", pr_number: 9, base_ref: "main", owner_repo: "owner/repo" }; });
    worktreeSetMock.mockImplementation(async () => { order.push("status"); return null; });

    const outcome = await useTerminalStore.getState().finishWorktree({ worktreeId: WID });

    expect(outcome).toEqual({ ok: true, prUrl: "https://github.com/owner/repo/pull/9", pushedTo: "origin/feat-a" });
    expect(order).toEqual(["stage", "commit", "push", "review", "status"]);
  });

  it("publishes (sets upstream) when the branch has no upstream", async () => {
    primeTransports();
    scStatusMock.mockResolvedValue({
      entries: [],
      conflict_state: "none",
      branch: "feat-a",
      upstream: { has_upstream: false, ahead: 0, behind: 0, remote_branch: null },
      did_hit_limit: false,
      status_length: 0,
    });

    await useTerminalStore.getState().finishWorktree({ worktreeId: WID });

    expect(scPushMock).toHaveBeenCalledWith(PATH, true, false);
  });

  it("fails at stage status on conflicts before any mutation", async () => {
    primeTransports();
    scStatusMock.mockResolvedValue({
      entries: [
        { path: "a", index_status: "U", worktree_status: "U", area: "conflict", old_path: null },
        { path: "b", index_status: "U", worktree_status: "U", area: "conflict", old_path: null },
        { path: "c", index_status: "U", worktree_status: "U", area: "conflict", old_path: null },
      ],
      conflict_state: "none",
      branch: "feat-a",
      upstream: { has_upstream: true, ahead: 0, behind: 0, remote_branch: null },
      did_hit_limit: false,
      status_length: 0,
    });

    const outcome = await useTerminalStore.getState().finishWorktree({ worktreeId: WID });

    expect(outcome).toEqual({ ok: false, stage: "status", reason: "3 conflicted files — resolve first" });
    expect(scStageMock).not.toHaveBeenCalled();
    expect(scCommitMock).not.toHaveBeenCalled();
    expect(scPushMock).not.toHaveBeenCalled();
  });

  it("surfaces blocked eligibility without creating a review or touching status", async () => {
    primeTransports();
    eligibilityMock.mockResolvedValue({
      eligible: false,
      blocked_reason: "needs-push",
      base_ref: null,
      owner_repo: null,
      existing_pr_url: null,
    });

    const outcome = await useTerminalStore.getState().finishWorktree({ worktreeId: WID });

    expect(outcome).toEqual({ ok: false, stage: "eligibility", reason: "needs-push" });
    expect(scPushMock).toHaveBeenCalled();
    expect(createReviewMock).not.toHaveBeenCalled();
    expect(worktreeSetMock).not.toHaveBeenCalled();
  });

  it("existing PR url short-circuits creation but still marks in-review", async () => {
    primeTransports();
    eligibilityMock.mockResolvedValue({
      eligible: false,
      blocked_reason: "existing-review",
      base_ref: "main",
      owner_repo: "owner/repo",
      existing_pr_url: "https://github.com/owner/repo/pull/7",
    });

    const outcome = await useTerminalStore.getState().finishWorktree({ worktreeId: WID });

    expect(outcome).toEqual({ ok: true, prUrl: "https://github.com/owner/repo/pull/7", pushedTo: "origin/feat-a" });
    expect(createReviewMock).not.toHaveBeenCalled();
    expect(worktreeSetMock).toHaveBeenCalledWith(WID, { workspaceStatus: "in-review" });
  });

  it("maps push failure to stage push without review or status calls", async () => {
    primeTransports();
    scPushMock.mockRejectedValue(new Error("remote rejected"));

    const outcome = await useTerminalStore.getState().finishWorktree({ worktreeId: WID });

    expect(outcome).toEqual({ ok: false, stage: "push", reason: "remote rejected" });
    expect(createReviewMock).not.toHaveBeenCalled();
    expect(worktreeSetMock).not.toHaveBeenCalled();
  });

  it("does not regress status when review creation fails after landing the push", async () => {
    primeTransports();
    createReviewMock.mockRejectedValue(new Error("gh: review body too large"));

    const outcome = await useTerminalStore.getState().finishWorktree({ worktreeId: WID });

    expect(outcome).toEqual({ ok: false, stage: "review", reason: "gh: review body too large" });
    expect(scCommitMock).toHaveBeenCalled();
    expect(scPushMock).toHaveBeenCalled();
    expect(worktreeSetMock).not.toHaveBeenCalled();
  });

  it("fails cleanly for unknown worktree ids", async () => {
    primeTransports();

    const outcome = await useTerminalStore.getState().finishWorktree({ worktreeId: "nope" });

    expect(outcome).toEqual({ ok: false, stage: "status", reason: expect.stringMatching(/unknown worktree nope/) });
    expect(scStatusMock).not.toHaveBeenCalled();
  });
});

describe("WorktreePane finished detection", () => {
  const WID = "demo::C:/ws/feat-a";

  function boundSession(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
    return {
      id,
      title: "",
      status: "running",
      cwd: "C:/ws/feat-a",
      cols: 80,
      rows: 24,
      worktreeId: WID,
      ...overrides,
    };
  }

  function registryEntry(
    workspaceStatus: WorktreeRecord["workspace_status"] = "in-progress",
  ): { record: WorktreeRecord; missing_on_disk: boolean } {
    return {
      record: record({
        id: WID,
        name: "feat-a",
        display_name: "Feat A",
        branch: "feat-a",
        workspace_status: workspaceStatus,
      }),
      missing_on_disk: false,
    };
  }

  function seedFinishedCard(
    workspaceStatus: WorktreeRecord["workspace_status"],
    sessions: Record<string, SessionInfo>,
    workingBySessionId: Record<string, boolean>,
  ) {
    useTerminalStore.setState({
      worktrees: [registryEntry(workspaceStatus)],
      worktreeLiveSessions: {},
      reviewByCwd: {},
      prStatusByWorktreeId: {},
      sessions,
      workingBySessionId,
      tabs: [],
      activeTabId: "",
    } as unknown as Record<string, unknown>);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetAutoStatusAppliedForTests();
    // Reloads triggered by setWorktreeStatus must keep the seeded card mounted.
    worktreeListMock.mockResolvedValue([registryEntry()]);
    worktreePsMock.mockResolvedValue([]);
    worktreeSetMock.mockResolvedValue(null);
  });

  it("selector counts a worktree finished only with ≥1 live session and all idle", () => {
    seedFinishedCard("todo", {}, {});
    expect(selectWorktreeFinished(useTerminalStore.getState(), WID)).toBe(false);

    useTerminalStore.setState({
      sessions: { s1: boundSession("s1") },
      workingBySessionId: { s1: true },
    });
    expect(selectWorktreeFinished(useTerminalStore.getState(), WID)).toBe(false);

    useTerminalStore.setState({ workingBySessionId: { s1: false } });
    expect(selectWorktreeFinished(useTerminalStore.getState(), WID)).toBe(true);

    // Exited sessions never count toward the linked set.
    useTerminalStore.setState({ sessions: { gone: boundSession("gone", { status: "exited" }) } });
    expect(selectWorktreeFinished(useTerminalStore.getState(), WID)).toBe(false);
  });

  it("shows the finished chip only while every linked session is idle", () => {
    seedFinishedCard("todo", {}, {});
    render(<WorktreePane />);
    const card = () => screen.getByText("Feat A").closest(".worktree-card")!;

    // No linked terminals -> never finished.
    expect(card().querySelector(".worktree-finished-chip")).toBeNull();

    useTerminalStore.setState({
      sessions: { s1: boundSession("s1") },
      workingBySessionId: { s1: true },
    });
    expect(card().querySelector(".worktree-finished-chip")).toBeNull();

    act(() => {
      useTerminalStore.setState({ workingBySessionId: { s1: false } });
    });
    expect(card().querySelector(".worktree-finished-chip")).not.toBeNull();
    expect(worktreeSetMock).not.toHaveBeenCalled();

    // Any session flipping back to working drops the chip immediately.
    act(() => {
      useTerminalStore.setState({
        sessions: { s1: boundSession("s1"), s2: boundSession("s2") },
        workingBySessionId: { s1: false, s2: true },
      });
    });
    expect(card().querySelector(".worktree-finished-chip")).toBeNull();
  });

  it("promotes in-progress to in-review exactly once per finish and not on rerenders", async () => {
    seedFinishedCard("in-progress", { s1: boundSession("s1") }, { s1: false });
    const { rerender } = render(<WorktreePane />);

    await vi.waitFor(() => {
      expect(worktreeSetMock).toHaveBeenCalledTimes(1);
    });
    expect(worktreeSetMock).toHaveBeenCalledWith(WID, { workspaceStatus: "in-review" });

    // Flush the post-call reload so its state swap lands before rerender checks.
    await act(async () => {});
    await act(async () => {
      useTerminalStore.setState({ reviewByCwd: {} });
    });
    rerender(<WorktreePane />);
    await act(async () => {});
    expect(worktreeSetMock).toHaveBeenCalledTimes(1);
  });

  it("leaving finished clears the chip and re-arms auto-status for the next finish", async () => {
    seedFinishedCard("in-progress", { s1: boundSession("s1") }, { s1: false });
    render(<WorktreePane />);
    await vi.waitFor(() => expect(worktreeSetMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      useTerminalStore.setState({ workingBySessionId: { s1: true } });
    });
    const card = screen.getByText("Feat A").closest(".worktree-card")!;
    expect(card.querySelector(".worktree-finished-chip")).toBeNull();

    await act(async () => {
      useTerminalStore.setState({ workingBySessionId: { s1: false } });
    });
    expect(card.querySelector(".worktree-finished-chip")).not.toBeNull();
    await vi.waitFor(() => expect(worktreeSetMock).toHaveBeenCalledTimes(2));
  });

  it("never auto-promotes when the current status is not in-progress", async () => {
    for (const status of ["todo", "completed"] as const) {
      seedFinishedCard(status, { s1: boundSession("s1") }, { s1: false });
      const { unmount } = render(<WorktreePane />);
      await act(async () => {});
      expect(
        screen.getByText("Feat A").closest(".worktree-card")!.querySelector(".worktree-finished-chip"),
      ).not.toBeNull();
      expect(worktreeSetMock).not.toHaveBeenCalled();
      unmount();
    }
  });
});

describe("WorktreePane merge to base", () => {
  const WID = "demo::C:/ws/feat-a";

  function seedMergeCard(overrides: Partial<WorktreeRecord> = {}) {
    useTerminalStore.setState({
      worktrees: [
        {
          record: record({
            id: WID,
            name: "feat-a",
            display_name: "Feat A",
            branch: "feat-a",
            base_ref: "main",
            ...overrides,
          }),
          missing_on_disk: false,
        },
      ],
      worktreeLiveSessions: {},
      reviewByCwd: {},
      prStatusByWorktreeId: {},
      sessions: {},
      workingBySessionId: {},
      tabs: [],
      activeTabId: "",
    } as unknown as Record<string, unknown>);
    worktreeListMock.mockResolvedValue([
      { record: record({ id: WID, name: "feat-a", display_name: "Feat A", branch: "feat-a", base_ref: "main" }), missing_on_disk: false },
    ]);
    worktreePsMock.mockResolvedValue([]);
  }

  function openMergeMenu() {
    fireEvent.click(screen.getByRole("button", { name: /actions for feat a/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /merge into main/i }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    scMergeToBaseMock.mockResolvedValue({ merged_commit: "abc1234", mode: "squash", files_changed: 2 });
    seedMergeCard();
  });

  it("offers Merge into <base_ref> only on live cards that have a base_ref", () => {
    render(<WorktreePane />);
    fireEvent.click(screen.getByRole("button", { name: /actions for feat a/i }));
    expect(screen.getByRole("menuitem", { name: /merge into main/i })).toBeDefined();

    // A card without a base_ref has nothing to merge into.
    fireEvent.click(document.body);
    useTerminalStore.setState({
      worktrees: [
        {
          record: record({ id: WID, name: "feat-a", display_name: "Feat A", branch: "feat-a", base_ref: "" }),
          missing_on_disk: false,
        },
      ],
    } as unknown as Record<string, unknown>);
    fireEvent.click(screen.getByRole("button", { name: /actions for feat a/i }));
    expect(screen.queryByRole("menuitem", { name: /merge into/i })).toBeNull();
  });

  it("confirm defaults to squash and calls transport with cwd=record.path then refreshes", async () => {
    render(<WorktreePane />);
    openMergeMenu();

    // Squash is preselected; the dialog explains where the merge runs.
    const squashRadio = screen.getByRole("radio", { name: /squash/i }) as HTMLInputElement;
    expect(squashRadio.checked).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /^merge$/i }));

    await vi.waitFor(() => {
      expect(scMergeToBaseMock).toHaveBeenCalledWith("C:/ws/feat-a", "squash");
    });
    await vi.waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
    expect(worktreeListMock).toHaveBeenCalled();
    expect(scStatusMock).toHaveBeenCalledWith("C:/ws/feat-a");
  });

  it("passes the merge-commit mode through when selected", async () => {
    render(<WorktreePane />);
    openMergeMenu();

    fireEvent.click(screen.getByRole("radio", { name: /merge commit/i }));
    fireEvent.click(screen.getByRole("button", { name: /^merge$/i }));

    await vi.waitFor(() => {
      expect(scMergeToBaseMock).toHaveBeenCalledWith("C:/ws/feat-a", "merge");
    });
  });

  it("surfaces guard refusals inline instead of closing the dialog", async () => {
    scMergeToBaseMock.mockRejectedValue(
      "main checkout has uncommitted changes — commit or stash there first",
    );

    render(<WorktreePane />);
    openMergeMenu();
    fireEvent.click(screen.getByRole("button", { name: /^merge$/i }));

    await vi.waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/uncommitted changes/);
    });
    expect(screen.getByRole("alertdialog")).toBeDefined();
    expect(worktreeListMock).not.toHaveBeenCalled();
  });

  it("store action rejects with the backend reason for unknown ids", async () => {
    await expect(
      useTerminalStore.getState().mergeWorktreeToBase({ worktreeId: "nope", mode: "squash" }),
    ).rejects.toThrow(/unknown worktree nope/);
    expect(scMergeToBaseMock).not.toHaveBeenCalled();
  });
});
