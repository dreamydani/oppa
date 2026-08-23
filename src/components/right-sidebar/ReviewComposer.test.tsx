import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ReviewComposer } from "./ReviewComposer";
import { useTerminalStore } from "../../store/terminalStore";
import * as ptyTransport from "../../lib/pty/transport";

vi.mock("../../lib/pty/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/pty/transport")>()),
  scStatus: vi.fn(),
  scStage: vi.fn().mockResolvedValue(undefined),
  scUnstage: vi.fn().mockResolvedValue(undefined),
  scDiscard: vi.fn().mockResolvedValue(undefined),
  scCommit: vi.fn().mockResolvedValue("abc1234"),
  scLocalBranches: vi.fn().mockResolvedValue({ branches: ["main", "feature"], current: "main" }),
  scCheckout: vi.fn().mockResolvedValue(undefined),
  scFileDiff: vi.fn(),
  scHistory: vi.fn().mockResolvedValue({ items: [], has_more: false }),
  scFetch: vi.fn().mockResolvedValue(undefined),
  scPull: vi.fn().mockResolvedValue({ status: "up-to-date", new_head: null }),
  scFastForward: vi.fn().mockResolvedValue({ status: "up-to-date", new_head: null }),
  scPush: vi.fn().mockResolvedValue({ pushed_to: "origin/main", was_publish: false }),
  generateCommitMessage: vi.fn().mockResolvedValue({ message: "" }),
  generatePrMessage: vi.fn(),
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

const generatePrMessageMock = vi.mocked(ptyTransport.generatePrMessage);
const requestReviewEligibilityMock = vi.mocked(ptyTransport.requestReviewEligibility);
const requestCreateReviewMock = vi.mocked(ptyTransport.requestCreateReview);
const onGitChangedMock = vi.mocked(ptyTransport.onGitChanged);

function seedStore(reviewByCwd: Record<string, unknown>) {
  useTerminalStore.setState({
    rightSidebarOpen: true,
    tabs: [{ id: "tab-1", layout: { type: "leaf", id: "s1" }, focusedPath: [] }],
    activeTabId: "tab-1",
    sessions: {
      s1: { id: "s1", title: "s1", status: "running", cwd: "/mock/repo", cols: 80, rows: 24 },
    },
    layout: { type: "leaf", id: "s1" },
    focusedPath: [],
    gitStatus: {
      entries: [],
      conflict_state: "none",
      branch: "feature",
      upstream: { has_upstream: true, ahead: 0, behind: 0, remote_branch: "origin/feature" },
      did_hit_limit: false,
      status_length: 0,
    },
    gitBranches: { branches: ["main", "feature"], current: "feature" },
    // @ts-expect-error partial for test
    reviewByCwd,
  } as unknown as Record<string, unknown>);
}

describe("ReviewComposer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requestReviewEligibilityMock.mockResolvedValue({
      eligible: true,
      blocked_reason: null,
      base_ref: "main",
      owner_repo: "owner/repo",
      existing_pr_url: null,
    });
    generatePrMessageMock.mockResolvedValue({ title: "feat: ai title", body: "ai body" });
    // Ensure default store clean
    useTerminalStore.setState({
      reviewByCwd: {},
    } as unknown as Record<string, unknown>);
  });

  it("calls refreshReviewEligibility on mount", async () => {
    seedStore({});
    render(<ReviewComposer />);
    await waitFor(() => expect(requestReviewEligibilityMock).toHaveBeenCalledWith("/mock/repo"));
  });

  it("shows loading spinner while pending with no eligibility", async () => {
    seedStore({ "/mock/repo": { loading: true } });
    render(<ReviewComposer />);
    expect(screen.getByTestId("review-loading")).toBeInTheDocument();
    expect(screen.getByText(/Checking pull request eligibility/i)).toBeInTheDocument();
  });

  it("eligible renders form with title, body, draft and buttons", async () => {
    seedStore({
      "/mock/repo": {
        loading: false,
        eligibility: {
          eligible: true,
          blocked_reason: null,
          base_ref: "main",
          owner_repo: "owner/repo",
          existing_pr_url: null,
        },
      },
    });
    render(<ReviewComposer />);
    expect(screen.getByTestId("review-composer")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Brief title")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Describe the change...")).toBeInTheDocument();
    expect(screen.getByTestId("review-draft-checkbox")).toBeInTheDocument();
    expect(screen.getByTestId("review-ai-btn")).toBeInTheDocument();
    expect(screen.getByTestId("review-create-btn")).toBeInTheDocument();
    expect(screen.getByText("Create Pull Request")).toBeInTheDocument();
  });

  it("blocked per reason renders correct human copy and kebab", async () => {
    const cases: Array<[string, string]> = [
      ["detached-head", "Checkout a branch first."],
      ["unsupported-provider", "This repository is not on GitHub."],
      ["gh-missing", "Install gh CLI."],
      ["gh-not-authed", "Run gh auth login."],
      ["auth-required", "Run gh auth login."],
      ["default-branch", "Switch to your feature branch."],
      ["dirty", "Commit or stash changes first."],
      ["no-upstream", "Push your branch first."],
      ["needs-sync", "Pull upstream first."],
      ["needs-push", "Push your changes first."],
      ["base-not-on-remote", "Push the base branch first."],
    ];
    for (const [reason, copy] of cases) {
      seedStore({
        "/mock/repo": {
          loading: false,
          eligibility: {
            eligible: false,
            blocked_reason: reason,
            base_ref: "main",
            owner_repo: "owner/repo",
            existing_pr_url: null,
          },
        },
      });
      const { unmount } = render(<ReviewComposer />);
      expect(screen.getByTestId("review-blocked")).toBeInTheDocument();
      expect(screen.getByText(copy)).toBeInTheDocument();
      expect(screen.getByText(`blocked: ${reason}`)).toBeInTheDocument();
      unmount();
    }
  });

  it("existing_pr shows open link not form", async () => {
    const url = "https://github.com/owner/repo/pull/7";
    seedStore({
      "/mock/repo": {
        loading: false,
        eligibility: {
          eligible: true,
          blocked_reason: null,
          base_ref: "main",
          owner_repo: "owner/repo",
          existing_pr_url: url,
        },
      },
    });
    render(<ReviewComposer />);
    expect(screen.getByTestId("review-existing")).toBeInTheDocument();
    expect(screen.getByTestId("open-pr-link")).toBeInTheDocument();
    expect(screen.getByText(url)).toBeInTheDocument();
    expect(screen.queryByTestId("review-title-input")).toBeNull();
    expect(screen.queryByTestId("review-composer")).toBeNull();
  });

  it("existing_pr open link calls opener", async () => {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    const url = "https://github.com/owner/repo/pull/8";
    seedStore({
      "/mock/repo": {
        loading: false,
        eligibility: {
          eligible: true,
          blocked_reason: null,
          base_ref: "main",
          owner_repo: "owner/repo",
          existing_pr_url: url,
        },
      },
    });
    render(<ReviewComposer />);
    fireEvent.click(screen.getByTestId("open-pr-link"));
    await waitFor(() => expect(vi.mocked(openUrl)).toHaveBeenCalledWith(url));
  });

  it("AI generate fills title and body", async () => {
    generatePrMessageMock.mockResolvedValue({ title: "feat: ai title", body: "ai body content" });
    seedStore({
      "/mock/repo": {
        loading: false,
        eligibility: {
          eligible: true,
          blocked_reason: null,
          base_ref: "main",
          owner_repo: "owner/repo",
          existing_pr_url: null,
        },
      },
    });
    render(<ReviewComposer />);
    fireEvent.click(screen.getByTestId("review-ai-btn"));
    expect(screen.getByText(/Generating/)).toBeInTheDocument();
    await waitFor(() => expect(generatePrMessageMock).toHaveBeenCalledWith("/mock/repo"));
    await waitFor(() =>
      expect((screen.getByTestId("review-title-input") as HTMLInputElement).value).toBe(
        "feat: ai title",
      ),
    );
    expect((screen.getByTestId("review-body-input") as HTMLTextAreaElement).value).toBe(
      "ai body content",
    );
  });

  it("AI generate shows error inline on failure", async () => {
    generatePrMessageMock.mockRejectedValue(new Error("agent timed out"));
    seedStore({
      "/mock/repo": {
        loading: false,
        eligibility: {
          eligible: true,
          blocked_reason: null,
          base_ref: "main",
          owner_repo: "owner/repo",
          existing_pr_url: null,
        },
      },
    });
    render(<ReviewComposer />);
    fireEvent.click(screen.getByTestId("review-ai-btn"));
    await waitFor(() => expect(screen.getByTestId("review-ai-error")).toBeInTheDocument());
    expect(screen.getByTestId("review-ai-error").textContent).toMatch(/agent timed out/);
  });

  it("AI generate button disabled while generating", async () => {
    let resolve: (v: { title: string; body: string }) => void = () => {};
    generatePrMessageMock.mockReturnValue(
      new Promise((res) => {
        resolve = res;
      }),
    );
    seedStore({
      "/mock/repo": {
        loading: false,
        eligibility: {
          eligible: true,
          blocked_reason: null,
          base_ref: "main",
          owner_repo: "owner/repo",
          existing_pr_url: null,
        },
      },
    });
    render(<ReviewComposer />);
    const btn = screen.getByTestId("review-ai-btn") as HTMLButtonElement;
    fireEvent.click(btn);
    expect(btn.disabled).toBe(true);
    resolve({ title: "t", body: "b" });
    await waitFor(() => expect(btn.disabled).toBe(false));
  });

  it("submit disabled on empty title and enabled after typing", async () => {
    seedStore({
      "/mock/repo": {
        loading: false,
        eligibility: {
          eligible: true,
          blocked_reason: null,
          base_ref: "main",
          owner_repo: "owner/repo",
          existing_pr_url: null,
        },
      },
    });
    render(<ReviewComposer />);
    const createBtn = screen.getByTestId("review-create-btn") as HTMLButtonElement;
    expect(createBtn.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("review-title-input"), { target: { value: "My PR" } });
    expect(createBtn.disabled).toBe(false);
    fireEvent.change(screen.getByTestId("review-title-input"), { target: { value: "   " } });
    expect(createBtn.disabled).toBe(true);
  });

  it("create success calls transport and on error shows inline", async () => {
    seedStore({
      "/mock/repo": {
        loading: false,
        eligibility: {
          eligible: true,
          blocked_reason: null,
          base_ref: "main",
          owner_repo: "owner/repo",
          existing_pr_url: null,
        },
      },
    });
    render(<ReviewComposer />);
    fireEvent.change(screen.getByTestId("review-title-input"), { target: { value: "feat: test" } });
    fireEvent.change(screen.getByTestId("review-body-input"), { target: { value: "body text" } });
    fireEvent.click(screen.getByTestId("review-draft-checkbox"));
    fireEvent.click(screen.getByTestId("review-create-btn"));
    await waitFor(() => expect(requestCreateReviewMock).toHaveBeenCalledWith("/mock/repo", {
      title: "feat: test",
      body: "body text",
      draft: true,
    }));

    // Error path
    requestCreateReviewMock.mockRejectedValueOnce(new Error("pr create failed: needs-push"));
    fireEvent.click(screen.getByTestId("review-create-btn"));
    await waitFor(() => expect(screen.getByTestId("review-create-error")).toBeInTheDocument());
    expect(screen.getByTestId("review-create-error").textContent).toMatch(/pr create failed/);
  });

  it("create button shows creating spinner and disables during creation", async () => {
    let resolveCreate: (v: unknown) => void = () => {};
    requestCreateReviewMock.mockReturnValue(
      new Promise((res) => {
        resolveCreate = res as unknown as (v: unknown) => void;
      }),
    );
    seedStore({
      "/mock/repo": {
        loading: false,
        eligibility: {
          eligible: true,
          blocked_reason: null,
          base_ref: "main",
          owner_repo: "owner/repo",
          existing_pr_url: null,
        },
      },
    });
    render(<ReviewComposer />);
    fireEvent.change(screen.getByTestId("review-title-input"), { target: { value: "t" } });
    const btn = screen.getByTestId("review-create-btn") as HTMLButtonElement;
    fireEvent.click(btn);
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/Creating/)).toBeInTheDocument();
    resolveCreate({ pr_url: "https://github.com/owner/repo/pull/9", pr_number: 9, base_ref: "main", owner_repo: "owner/repo" });
    await waitFor(() => expect(btn.disabled).toBe(false));
  });

  it("title input maxlength 200", async () => {
    seedStore({
      "/mock/repo": {
        loading: false,
        eligibility: {
          eligible: true,
          blocked_reason: null,
          base_ref: "main",
          owner_repo: "owner/repo",
          existing_pr_url: null,
        },
      },
    });
    render(<ReviewComposer />);
    const input = screen.getByTestId("review-title-input") as HTMLInputElement;
    expect(input.getAttribute("maxlength")).toBe("200");
  });

  it("registers git-changed listener for eligibility refresh", async () => {
    seedStore({
      "/mock/repo": {
        loading: false,
        eligibility: {
          eligible: true,
          blocked_reason: null,
          base_ref: "main",
          owner_repo: "owner/repo",
          existing_pr_url: null,
        },
      },
    });
    render(<ReviewComposer />);
    await waitFor(() => expect(onGitChangedMock).toHaveBeenCalled());
  });

  it("shows stacked chip when base is another worktree branch", async () => {
    useTerminalStore.setState({
      // @ts-expect-error partial
      worktrees: [
        { record: { id: "a", branch: "feature-parent", path: "/ws/parent" } },
        { record: { id: "b", branch: "feature-child", path: "/mock/repo" } },
      ],
    } as unknown as Record<string, unknown>);
    seedStore({
      "/mock/repo": {
        loading: false,
        eligibility: {
          eligible: true,
          blocked_reason: null,
          base_ref: "feature-parent",
          owner_repo: "owner/repo",
          existing_pr_url: null,
        },
      },
    });
    render(<ReviewComposer />);
    expect(screen.getByTestId("stacked-chip")).toBeInTheDocument();
    expect(screen.getByText(/stacked onto feature-parent/)).toBeInTheDocument();
  });

  it("does not show stacked chip for main base", async () => {
    useTerminalStore.setState({
      // @ts-expect-error partial
      worktrees: [{ record: { id: "a", branch: "feature-parent", path: "/ws/parent" } }],
    } as unknown as Record<string, unknown>);
    seedStore({
      "/mock/repo": {
        loading: false,
        eligibility: {
          eligible: true,
          blocked_reason: null,
          base_ref: "main",
          owner_repo: "owner/repo",
          existing_pr_url: null,
        },
      },
    });
    render(<ReviewComposer />);
    expect(screen.queryByTestId("stacked-chip")).toBeNull();
  });
});
