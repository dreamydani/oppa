import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { PrChecksCard } from "./PrChecksCard";
import { useTerminalStore } from "../../store/terminalStore";
import * as gitTransport from "../../lib/git/transport";

vi.mock("../../lib/git/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/git/transport")>()),
  scStatus: vi.fn(),
  scStage: vi.fn().mockResolvedValue(undefined),
  scUnstage: vi.fn().mockResolvedValue(undefined),
  scDiscard: vi.fn().mockResolvedValue(undefined),
  scCommit: vi.fn().mockResolvedValue("abc1234"),
  scLocalBranches: vi.fn().mockResolvedValue({ branches: ["main"], current: "main" }),
  scCheckout: vi.fn().mockResolvedValue(undefined),
  scFileDiff: vi.fn(),
  scHistory: vi.fn().mockResolvedValue({ items: [], has_more: false }),
  scFetch: vi.fn().mockResolvedValue(undefined),
  scPull: vi.fn().mockResolvedValue({ status: "up-to-date", new_head: null }),
  scFastForward: vi.fn().mockResolvedValue({ status: "up-to-date", new_head: null }),
  scPush: vi.fn().mockResolvedValue({ pushed_to: "origin/main", was_publish: false }),
  generateCommitMessage: vi.fn().mockResolvedValue({ message: "" }),
  generatePrMessage: vi.fn().mockResolvedValue({ title: "t", body: "b" }),
  requestReviewEligibility: vi.fn().mockResolvedValue({
    eligible: true,
    blocked_reason: null,
    base_ref: "main",
    owner_repo: "owner/repo",
    existing_pr_url: null,
  }),
  requestCreateReview: vi.fn().mockResolvedValue({
    pr_url: "https://github.com/owner/repo/pull/1",
    pr_number: 1,
    base_ref: "main",
    owner_repo: "owner/repo",
  }),
  requestReviewStatus: vi.fn().mockResolvedValue({
    number: 1,
    title: "t",
    url: "https://github.com/owner/repo/pull/1",
    state: "open",
    draft: false,
    mergeable: "unknown",
    base_ref_name: "main",
    head_ref_name: "feat",
    checks: [],
    fetched_at_ms: 0,
  }),
  onGitChanged: vi.fn().mockResolvedValue(() => {}),
  onPrChanged: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn().mockResolvedValue(undefined),
}));

const requestReviewStatusMock = vi.mocked(gitTransport.requestReviewStatus);
const onPrChangedMock = vi.mocked(gitTransport.onPrChanged);
const onGitChangedMock = vi.mocked(gitTransport.onGitChanged);

function seed(cwd: string, entry: Record<string, unknown>) {
  useTerminalStore.setState({
    tabs: [{ id: "tab-1", layout: { type: "leaf", id: "s1" }, focusedPath: [] }],
    activeTabId: "tab-1",
    sessions: {
      s1: { id: "s1", title: "s1", status: "running", cwd, cols: 80, rows: 24 },
    },
    layout: { type: "leaf", id: "s1" },
    focusedPath: [],
    worktrees: [],
    reviewByCwd: { [cwd]: entry } as unknown as Record<string, { eligibility?: unknown; prStatus?: unknown; loading: boolean }>,
    prStatusByWorktreeId: {},
  } as unknown as Record<string, unknown>);
}

describe("PrChecksCard", () => {
  const cwd = "/mock/repo";

  beforeEach(() => {
    vi.clearAllMocks();
    requestReviewStatusMock.mockResolvedValue({
      number: 1,
      title: "t",
      url: "https://github.com/owner/repo/pull/1",
      state: "open",
      draft: false,
      mergeable: "unknown",
      base_ref_name: "main",
      head_ref_name: "feat",
      checks: [],
      fetched_at_ms: 0,
    });
    useTerminalStore.setState({
      reviewByCwd: {},
      prStatusByWorktreeId: {},
    } as unknown as Record<string, unknown>);
  });

  it("renders nothing when no pr linked", () => {
    seed(cwd, { loading: false, eligibility: { eligible: false, blocked_reason: "dirty", base_ref: "main", owner_repo: "owner/repo", existing_pr_url: null } } as unknown as Record<string, unknown>);
    const { container } = render(<PrChecksCard cwd={cwd} />);
    expect(container.querySelector('[data-testid="pr-checks-card"]')).toBeNull();
    expect(container.querySelector('[data-testid="pr-checks-loading"]')).toBeNull();
    expect(screen.queryByTestId("pr-checks-card")).toBeNull();
  });

  it("shows loading state when linked but status pending", () => {
    seed(cwd, {
      loading: true,
      eligibility: { eligible: true, blocked_reason: null, base_ref: "main", owner_repo: "owner/repo", existing_pr_url: "https://github.com/owner/repo/pull/5" },
    } as unknown as Record<string, unknown>);
    render(<PrChecksCard cwd={cwd} />);
    expect(screen.getByTestId("pr-checks-loading")).toBeInTheDocument();
    expect(screen.getByText(/Loading PR status/i)).toBeInTheDocument();
  });

  it("renders header with number title state draft", () => {
    seed(cwd, {
      loading: false,
      eligibility: { eligible: true, blocked_reason: null, base_ref: "main", owner_repo: "owner/repo", existing_pr_url: "https://github.com/owner/repo/pull/12" },
      prStatus: {
        number: 12,
        title: "Add checks card",
        url: "https://github.com/owner/repo/pull/12",
        state: "open",
        draft: true,
        mergeable: "unknown",
        base_ref_name: "main",
        head_ref_name: "feat",
        checks: [],
        fetched_at_ms: Date.now(),
      },
    } as unknown as Record<string, unknown>);
    render(<PrChecksCard cwd={cwd} />);
    expect(screen.getByTestId("pr-checks-card")).toBeInTheDocument();
    expect(screen.getByTestId("pr-checks-number").textContent).toBe("#12");
    expect(screen.getByTestId("pr-checks-title").textContent).toBe("Add checks card");
    expect(screen.getByTestId("pr-state-badge").textContent).toBe("open");
    expect(screen.getByTestId("pr-draft-chip")).toBeInTheDocument();
    expect(screen.getByTestId("pr-draft-chip").textContent).toBe("draft");
  });

  it("state badge classes per state", () => {
    const cases: Array<[string, string]> = [
      ["open", "state-open"],
      ["closed", "state-closed"],
      ["merged", "state-merged"],
    ];
    for (const [state, cls] of cases) {
      seed(cwd, {
        loading: false,
        eligibility: { eligible: true, blocked_reason: null, base_ref: "main", owner_repo: "owner/repo", existing_pr_url: "https://github.com/owner/repo/pull/1" },
        prStatus: {
          number: 1,
          title: "t",
          url: "https://github.com/owner/repo/pull/1",
          state,
          draft: false,
          mergeable: "unknown",
          base_ref_name: "main",
          head_ref_name: "feat",
          checks: [],
          fetched_at_ms: 0,
        },
      } as unknown as Record<string, unknown>);
      const { unmount } = render(<PrChecksCard cwd={cwd} />);
      expect(screen.getByTestId("pr-state-badge").className).toContain(cls);
      unmount();
    }
  });

  it("renders check rows with correct dot colors per state", () => {
    seed(cwd, {
      loading: false,
      eligibility: { eligible: true, blocked_reason: null, base_ref: "main", owner_repo: "owner/repo", existing_pr_url: "https://github.com/owner/repo/pull/1" },
      prStatus: {
        number: 1,
        title: "t",
        url: "https://github.com/owner/repo/pull/1",
        state: "open",
        draft: false,
        mergeable: "unknown",
        base_ref_name: "main",
        head_ref_name: "feat",
        checks: [
          { name: "ci passing", state: "passing" },
          { name: "ci failing", state: "failing" },
          { name: "ci pending", state: "pending" },
          { name: "ci skipping", state: "skipping" },
        ],
        fetched_at_ms: 0,
      },
    } as unknown as Record<string, unknown>);
    render(<PrChecksCard cwd={cwd} />);
    const rows = screen.getAllByTestId("pr-check-row");
    expect(rows).toHaveLength(4);
    const dots = screen.getAllByTestId("pr-check-dot");
    expect(dots[0].className).toContain("dot-passing");
    expect(dots[0].textContent).toBe("●");
    expect(dots[1].className).toContain("dot-failing");
    expect(dots[1].textContent).toBe("●");
    expect(dots[2].className).toContain("dot-pending");
    expect(dots[2].textContent).toBe("●");
    expect(dots[3].className).toContain("dot-skipping");
    expect(dots[3].textContent).toBe("○");
    expect(screen.getByText("ci passing")).toBeInTheDocument();
    expect(screen.getByText("passing")).toBeInTheDocument();
  });

  it("empty checks message", () => {
    seed(cwd, {
      loading: false,
      eligibility: { eligible: true, blocked_reason: null, base_ref: "main", owner_repo: "owner/repo", existing_pr_url: "https://github.com/owner/repo/pull/1" },
      prStatus: {
        number: 1,
        title: "t",
        url: "https://github.com/owner/repo/pull/1",
        state: "open",
        draft: false,
        mergeable: "unknown",
        base_ref_name: "main",
        head_ref_name: "feat",
        checks: [],
        fetched_at_ms: 0,
      },
    } as unknown as Record<string, unknown>);
    render(<PrChecksCard cwd={cwd} />);
    expect(screen.getByTestId("pr-checks-empty")).toBeInTheDocument();
    expect(screen.getByText("No checks reported")).toBeInTheDocument();
  });

  it("refresh button calls transport", async () => {
    seed(cwd, {
      loading: false,
      eligibility: { eligible: true, blocked_reason: null, base_ref: "main", owner_repo: "owner/repo", existing_pr_url: "https://github.com/owner/repo/pull/1" },
      prStatus: {
        number: 1,
        title: "t",
        url: "https://github.com/owner/repo/pull/1",
        state: "open",
        draft: false,
        mergeable: "unknown",
        base_ref_name: "main",
        head_ref_name: "feat",
        checks: [],
        fetched_at_ms: 0,
      },
    } as unknown as Record<string, unknown>);
    render(<PrChecksCard cwd={cwd} />);
    requestReviewStatusMock.mockClear();
    fireEvent.click(screen.getByTestId("pr-checks-refresh"));
    await waitFor(() => expect(requestReviewStatusMock).toHaveBeenCalledWith(cwd));
  });

  it("open PR link calls opener", async () => {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    const url = "https://github.com/owner/repo/pull/42";
    seed(cwd, {
      loading: false,
      eligibility: { eligible: true, blocked_reason: null, base_ref: "main", owner_repo: "owner/repo", existing_pr_url: url },
      prStatus: {
        number: 42,
        title: "t",
        url,
        state: "open",
        draft: false,
        mergeable: "unknown",
        base_ref_name: "main",
        head_ref_name: "feat",
        checks: [],
        fetched_at_ms: 0,
      },
    } as unknown as Record<string, unknown>);
    render(<PrChecksCard cwd={cwd} />);
    fireEvent.click(screen.getByTestId("open-pr-link-checks"));
    await waitFor(() => expect(vi.mocked(openUrl)).toHaveBeenCalledWith(url));
  });

  it("open PR falls back to window.open when opener rejects", async () => {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    vi.mocked(openUrl).mockRejectedValueOnce(new Error("no opener"));
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const url = "https://github.com/owner/repo/pull/99";
    seed(cwd, {
      loading: false,
      eligibility: { eligible: true, blocked_reason: null, base_ref: "main", owner_repo: "owner/repo", existing_pr_url: url },
      prStatus: {
        number: 99,
        title: "t",
        url,
        state: "open",
        draft: false,
        mergeable: "unknown",
        base_ref_name: "main",
        head_ref_name: "feat",
        checks: [],
        fetched_at_ms: 0,
      },
    } as unknown as Record<string, unknown>);
    render(<PrChecksCard cwd={cwd} />);
    fireEvent.click(screen.getByTestId("open-pr-link-checks"));
    await waitFor(() => expect(openSpy).toHaveBeenCalledWith(url, "_blank", "noopener,noreferrer"));
    openSpy.mockRestore();
  });

  it("triggers initial fetch when linked but no prStatus", async () => {
    seed(cwd, {
      loading: false,
      eligibility: { eligible: true, blocked_reason: null, base_ref: "main", owner_repo: "owner/repo", existing_pr_url: "https://github.com/owner/repo/pull/5" },
    } as unknown as Record<string, unknown>);
    requestReviewStatusMock.mockClear();
    render(<PrChecksCard cwd={cwd} />);
    await waitFor(() => expect(requestReviewStatusMock).toHaveBeenCalledWith(cwd));
  });

  it("subscribes to pr-changed and git-changed for refresh", async () => {
    seed(cwd, {
      loading: false,
      eligibility: { eligible: true, blocked_reason: null, base_ref: "main", owner_repo: "owner/repo", existing_pr_url: "https://github.com/owner/repo/pull/1" },
      prStatus: {
        number: 1,
        title: "t",
        url: "https://github.com/owner/repo/pull/1",
        state: "open",
        draft: false,
        mergeable: "unknown",
        base_ref_name: "main",
        head_ref_name: "feat",
        checks: [],
        fetched_at_ms: 0,
      },
    } as unknown as Record<string, unknown>);
    render(<PrChecksCard cwd={cwd} />);
    await waitFor(() => expect(onPrChangedMock).toHaveBeenCalled());
    await waitFor(() => expect(onGitChangedMock).toHaveBeenCalled());
  });
});
