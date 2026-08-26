import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen, act } from "@testing-library/react";
import { WorktreePane } from "./WorktreePane";
import { useTerminalStore } from "../../store/terminalStore";
import * as transport from "../../lib/pty/transport";
import type { WorktreeRecord } from "../../lib/pty/transport";
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
}));

const worktreeSetMock = vi.mocked(transport.worktreeSet);
const worktreeRemoveMock = vi.mocked(transport.worktreeRemove);

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
