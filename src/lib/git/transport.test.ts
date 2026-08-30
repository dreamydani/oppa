import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  getGitStatus,
  scStatus,
  scStage,
  scUnstage,
  scDiscard,
  scCommit,
  scLocalBranches,
  scCheckout,
  scFileDiff,
  scHistory,
  scBranchCompare,
  scFetch,
  scPull,
  scFastForward,
  scPush,
  scUpstreamRefresh,
  scMergeToBase,
  scGenerateCommitMessage,
  generateCommitMessage,
  scGeneratePrMessage,
  generatePrMessage,
  prReviewStatus,
  requestReviewStatus,
  prCreateReview,
  requestCreateReview,
  prCheckout,
  prSync,
  prEligibility,
  requestReviewEligibility,
  diffCommentsList,
  diffCommentAdd,
  diffCommentUpdate,
  diffCommentToggle,
  diffCommentDelete,
  diffCommentsMarkSent,
  onGitChanged,
  onPrChanged,
} from "./transport";
import type {
  SourceControlStatus,
  DiffContent,
  HistoryResult,
  BranchCompare,
  PullOutcome,
  PushOutcome,
  UpstreamStatus,
  NewDiffComment,
  DiffComment,
  Eligibility,
  CreatedReview,
  PrStatus,
  MergeToBaseOutcome,
} from "./transport";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

describe("git transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("getGitStatus invokes git_status with path", async () => {
    const mock = { is_git: true, branch: "main", files: [], ahead: 0, behind: 0 };
    invokeMock.mockResolvedValue(mock);
    await expect(getGitStatus("/repo")).resolves.toEqual(mock);
    expect(invokeMock).toHaveBeenCalledWith("git_status", { path: "/repo" });
  });

  it("scStatus invokes sc_status with cwd", async () => {
    const mock: SourceControlStatus = {
      entries: [],
      conflict_state: "none",
      branch: "main",
      upstream: { has_upstream: false, ahead: 0, behind: 0, remote_branch: null },
      did_hit_limit: false,
      status_length: 0,
    };
    invokeMock.mockResolvedValue(mock);
    await expect(scStatus("/repo")).resolves.toEqual(mock);
    expect(invokeMock).toHaveBeenCalledWith("sc_status", { cwd: "/repo" });
  });

  it("scStage and scUnstage invoke their respective commands", async () => {
    invokeMock.mockResolvedValue(undefined);
    await scStage("/repo", ["a.txt", "b.txt"]);
    expect(invokeMock).toHaveBeenCalledWith("sc_stage", { cwd: "/repo", paths: ["a.txt", "b.txt"] });

    await scUnstage("/repo", ["a.txt"]);
    expect(invokeMock).toHaveBeenCalledWith("sc_unstage", { cwd: "/repo", paths: ["a.txt"] });
  });

  it("scDiscard invokes sc_discard with includeUntracked", async () => {
    invokeMock.mockResolvedValue(undefined);
    await scDiscard("/repo", ["a.txt"], true);
    expect(invokeMock).toHaveBeenCalledWith("sc_discard", {
      cwd: "/repo",
      paths: ["a.txt"],
      includeUntracked: true,
    });
  });

  it("scCommit invokes sc_commit with cwd and message", async () => {
    invokeMock.mockResolvedValue("sha123");
    await expect(scCommit("/repo", "feat: initial")).resolves.toBe("sha123");
    expect(invokeMock).toHaveBeenCalledWith("sc_commit", { cwd: "/repo", message: "feat: initial" });
  });

  it("scLocalBranches invokes sc_local_branches", async () => {
    const mock = { branches: ["main", "dev"], current: "main" };
    invokeMock.mockResolvedValue(mock);
    await expect(scLocalBranches("/repo")).resolves.toEqual(mock);
    expect(invokeMock).toHaveBeenCalledWith("sc_local_branches", { cwd: "/repo" });
  });

  it("scCheckout and prCheckout invoke sc_checkout with branch", async () => {
    invokeMock.mockResolvedValue(undefined);
    await scCheckout("/repo", "feature");
    expect(invokeMock).toHaveBeenCalledWith("sc_checkout", { cwd: "/repo", branch: "feature" });

    await prCheckout("/repo", "feature-2");
    expect(invokeMock).toHaveBeenCalledWith("sc_checkout", { cwd: "/repo", branch: "feature-2" });
  });

  it("scFileDiff invokes sc_file_diff with proper flags", async () => {
    const mock: DiffContent = {
      kind: "text",
      original_content: "foo",
      modified_content: "bar",
      truncated: false,
    };
    invokeMock.mockResolvedValue(mock);
    const res = await scFileDiff("/repo", "src/a.ts", true, false);
    expect(invokeMock).toHaveBeenCalledWith("sc_file_diff", {
      cwd: "/repo",
      path: "src/a.ts",
      staged: true,
      compareAgainstHead: false,
    });
    expect(res).toEqual(mock);
  });

  it("scHistory invokes sc_history with cwd and optional limit", async () => {
    const mock: HistoryResult = { items: [], has_more: false };
    invokeMock.mockResolvedValue(mock);
    await expect(scHistory("/repo", 10)).resolves.toEqual(mock);
    expect(invokeMock).toHaveBeenCalledWith("sc_history", { cwd: "/repo", limit: 10 });

    await scHistory("/repo");
    expect(invokeMock).toHaveBeenCalledWith("sc_history", { cwd: "/repo", limit: null });
  });

  it("scBranchCompare invokes sc_branch_compare", async () => {
    const mock: BranchCompare = {
      base_ref: "main",
      ahead: 2,
      behind: 1,
      changed_files: [{ path: "a.ts", change_kind: "modified", old_path: null }],
    };
    invokeMock.mockResolvedValue(mock);
    await expect(scBranchCompare("/repo", "main")).resolves.toEqual(mock);
    expect(invokeMock).toHaveBeenCalledWith("sc_branch_compare", { cwd: "/repo", baseRef: "main" });
  });

  it("scFetch, scPull, scFastForward, and prSync invoke appropriate commands", async () => {
    invokeMock.mockResolvedValue(undefined);
    await scFetch("/repo");
    expect(invokeMock).toHaveBeenCalledWith("sc_fetch", { cwd: "/repo" });

    const pullMock: PullOutcome = { status: "fast-forward", new_head: "sha456" };
    invokeMock.mockResolvedValue(pullMock);
    await expect(scPull("/repo", true)).resolves.toEqual(pullMock);
    expect(invokeMock).toHaveBeenCalledWith("sc_pull", { cwd: "/repo", ffOnly: true });

    await expect(scFastForward("/repo")).resolves.toEqual(pullMock);
    expect(invokeMock).toHaveBeenCalledWith("sc_fast_forward", { cwd: "/repo" });

    await expect(prSync("/repo")).resolves.toEqual(pullMock);
  });

  it("scPush invokes sc_push with publish and forceWithLease flags", async () => {
    const mock: PushOutcome = { pushed_to: "origin/feat", was_publish: true };
    invokeMock.mockResolvedValue(mock);
    await expect(scPush("/repo", true, false)).resolves.toEqual(mock);
    expect(invokeMock).toHaveBeenCalledWith("sc_push", {
      cwd: "/repo",
      publish: true,
      forceWithLease: false,
    });
  });

  it("scUpstreamRefresh invokes sc_upstream_refresh", async () => {
    const mock: UpstreamStatus = { has_upstream: true, ahead: 1, behind: 0, remote_branch: "origin/feat" };
    invokeMock.mockResolvedValue(mock);
    await expect(scUpstreamRefresh("/repo")).resolves.toEqual(mock);
    expect(invokeMock).toHaveBeenCalledWith("sc_upstream_refresh", { cwd: "/repo" });
  });

  it("scMergeToBase invokes sc_merge_to_base with mode", async () => {
    const mock: MergeToBaseOutcome = { merged_commit: "c1", mode: "squash", files_changed: 3 };
    invokeMock.mockResolvedValue(mock);
    await expect(scMergeToBase("/repo", "squash")).resolves.toEqual(mock);
    expect(invokeMock).toHaveBeenCalledWith("sc_merge_to_base", { cwd: "/repo", mode: "squash" });
  });

  it("scGenerateCommitMessage and generateCommitMessage invoke sc_generate_commit_message", async () => {
    invokeMock.mockResolvedValue({ message: "feat: add stuff" });
    await expect(scGenerateCommitMessage("/repo")).resolves.toEqual({ message: "feat: add stuff" });
    expect(invokeMock).toHaveBeenCalledWith("sc_generate_commit_message", { cwd: "/repo" });

    await expect(generateCommitMessage("/repo")).resolves.toEqual({ message: "feat: add stuff" });
  });

  it("scGeneratePrMessage and generatePrMessage invoke sc_generate_pr_message", async () => {
    invokeMock.mockResolvedValue({ title: "My PR", body: "PR body" });
    await expect(scGeneratePrMessage("/repo")).resolves.toEqual({ title: "My PR", body: "PR body" });
    expect(invokeMock).toHaveBeenCalledWith("sc_generate_pr_message", { cwd: "/repo" });

    await expect(generatePrMessage("/repo")).resolves.toEqual({ title: "My PR", body: "PR body" });
  });

  it("prEligibility and requestReviewEligibility invoke review_eligibility", async () => {
    const mock: Eligibility = {
      eligible: true,
      blocked_reason: null,
      base_ref: "main",
      owner_repo: "org/repo",
      existing_pr_url: null,
    };
    invokeMock.mockResolvedValue(mock);
    await expect(prEligibility("/repo")).resolves.toEqual(mock);
    expect(invokeMock).toHaveBeenCalledWith("review_eligibility", { cwd: "/repo" });

    await expect(requestReviewEligibility("/repo")).resolves.toEqual(mock);
  });

  it("prCreateReview and requestCreateReview invoke create_review", async () => {
    const mock: CreatedReview = {
      pr_url: "https://github.com/org/repo/pull/1",
      pr_number: 1,
      base_ref: "main",
      owner_repo: "org/repo",
    };
    invokeMock.mockResolvedValue(mock);
    const input = { title: "Title", body: "Body", draft: false };
    await expect(prCreateReview("/repo", input)).resolves.toEqual(mock);
    expect(invokeMock).toHaveBeenCalledWith("create_review", {
      cwd: "/repo",
      title: "Title",
      body: "Body",
      draft: false,
    });

    await expect(requestCreateReview("/repo", input)).resolves.toEqual(mock);
  });

  it("prReviewStatus and requestReviewStatus invoke review_status", async () => {
    const mock: PrStatus = {
      number: 1,
      title: "PR 1",
      url: "https://github.com/org/repo/pull/1",
      state: "OPEN",
      draft: false,
      mergeable: "MERGEABLE",
      base_ref_name: "main",
      head_ref_name: "feat",
      checks: [],
      fetched_at_ms: 12345,
    };
    invokeMock.mockResolvedValue(mock);
    await expect(prReviewStatus("/repo")).resolves.toEqual(mock);
    expect(invokeMock).toHaveBeenCalledWith("review_status", { cwd: "/repo" });

    await expect(requestReviewStatus("/repo")).resolves.toEqual(mock);
  });

  it("diff comments CRUD invokes diff_comment_* commands", async () => {
    const commentMock: DiffComment = {
      id: "c-1",
      worktree_id: "wt-1",
      file_path: "a.ts",
      source: "diff",
      selected_text: null,
      start_line: null,
      line_number: 10,
      body: "fix this",
      scope: "unstaged",
      old_path: null,
      created_at_ms: 1000,
      updated_at_ms: null,
      sent_at: null,
    };

    invokeMock.mockResolvedValue([commentMock]);
    await expect(diffCommentsList("wt-1")).resolves.toEqual([commentMock]);
    expect(invokeMock).toHaveBeenCalledWith("diff_comments_list", { worktreeId: "wt-1" });

    const newComment: NewDiffComment = {
      worktree_id: "wt-1",
      file_path: "a.ts",
      source: "diff",
      line_number: 10,
      body: "fix this",
      scope: "unstaged",
    };
    invokeMock.mockResolvedValue(commentMock);
    await expect(diffCommentAdd(newComment)).resolves.toEqual(commentMock);
    expect(invokeMock).toHaveBeenCalledWith("diff_comment_add", { comment: newComment });

    await expect(diffCommentUpdate("c-1", "updated body")).resolves.toEqual(commentMock);
    expect(invokeMock).toHaveBeenCalledWith("diff_comment_update", { id: "c-1", body: "updated body" });

    await expect(diffCommentToggle("c-1", "toggled body")).resolves.toEqual(commentMock);

    invokeMock.mockResolvedValue(undefined);
    await diffCommentDelete("c-1");
    expect(invokeMock).toHaveBeenCalledWith("diff_comment_delete", { id: "c-1" });

    invokeMock.mockResolvedValue([commentMock]);
    await expect(diffCommentsMarkSent(["c-1"])).resolves.toEqual([commentMock]);
    expect(invokeMock).toHaveBeenCalledWith("diff_comments_mark_sent", { ids: ["c-1"] });
  });

  it("onGitChanged listens to git-changed and invokes callback", async () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValue(unlisten);
    const cb = vi.fn();
    const result = await onGitChanged(cb);
    expect(listenMock).toHaveBeenCalledWith("git-changed", expect.any(Function));
    const handler = listenMock.mock.calls[0][1] as () => void;
    handler();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(result).toBe(unlisten);
  });

  it("onPrChanged listens to pr-changed and forwards payload", async () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValue(unlisten);
    const cb = vi.fn();
    const result = await onPrChanged(cb);
    expect(listenMock).toHaveBeenCalledWith("pr-changed", expect.any(Function));
    const handler = listenMock.mock.calls[0][1] as (e: { payload: { worktree_id: string | null } }) => void;
    handler({ payload: { worktree_id: "wt-1" } });
    expect(cb).toHaveBeenCalledWith({ worktree_id: "wt-1" });
    expect(result).toBe(unlisten);
  });
});
