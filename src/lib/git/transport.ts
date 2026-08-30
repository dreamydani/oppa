import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// ---- Legacy git status ----

export interface GitFileStatus {
  path: string;
  status: string;
}

export interface GitStatusResult {
  is_git: boolean;
  branch: string;
  files: GitFileStatus[];
  ahead: number;
  behind: number;
}

export async function getGitStatus(path: string): Promise<GitStatusResult> {
  return invoke<GitStatusResult>("git_status", { path });
}

// ---- IPC v4 source-control surface; every shape mirrors its serde struct verbatim ----

export type GitArea = "staged" | "unstaged" | "untracked" | "conflict";

export interface StatusEntry {
  path: string;
  index_status: string;
  worktree_status: string;
  area: GitArea;
  old_path: string | null;
}

export type ConflictState = "none" | "merge" | "rebase" | "revert" | "cherry-pick";

export interface UpstreamStatus {
  has_upstream: boolean;
  ahead: number;
  behind: number;
  remote_branch: string | null;
}

export interface SourceControlStatus {
  entries: StatusEntry[];
  conflict_state: ConflictState;
  branch: string;
  upstream: UpstreamStatus;
  did_hit_limit: boolean;
  status_length: number;
}

export interface LocalBranches {
  branches: string[];
  current: string | null;
}

export type DiffKind = "text" | "binary";

export interface DiffContent {
  kind: DiffKind;
  original_content: string;
  modified_content: string;
  truncated: boolean;
}

export interface CommitStats {
  files: number;
  insertions: number;
  deletions: number;
}

export interface HistoryItem {
  id: string;
  parent_ids: string[];
  subject: string;
  message_body: string;
  author_name: string;
  author_email: string;
  timestamp_secs: number;
  stats: CommitStats;
}

export type HistoryEntry = HistoryItem;

export interface HistoryResult {
  items: HistoryItem[];
  has_more: boolean;
}

export interface CompareEntry {
  path: string;
  change_kind: string;
  old_path: string | null;
}

export interface BranchCompare {
  base_ref: string;
  ahead: number;
  behind: number;
  changed_files: CompareEntry[];
}

export type PullStatus = "fast-forward" | "up-to-date" | "merged";

export interface PullOutcome {
  status: PullStatus;
  new_head: string | null;
}

export interface PushOutcome {
  pushed_to: string;
  was_publish: boolean;
}

export type DiffCommentSource = "diff" | "markdown";
export type DiffCommentScope = "unstaged" | "staged" | "branch";

export interface NewDiffComment {
  worktree_id: string;
  file_path: string;
  source: DiffCommentSource;
  selected_text?: string | null;
  start_line?: number | null;
  line_number: number;
  body: string;
  scope: DiffCommentScope;
  old_path?: string | null;
}

export interface DiffComment {
  id: string;
  worktree_id: string;
  file_path: string;
  source: DiffCommentSource;
  selected_text: string | null;
  start_line: number | null;
  line_number: number;
  body: string;
  scope: DiffCommentScope;
  old_path: string | null;
  created_at_ms: number;
  updated_at_ms: number | null;
  sent_at: number | null;
}

export function scStatus(cwd: string): Promise<SourceControlStatus> {
  return invoke("sc_status", { cwd });
}

export function scStage(cwd: string, paths: string[]): Promise<void> {
  return invoke("sc_stage", { cwd, paths });
}

export function scUnstage(cwd: string, paths: string[]): Promise<void> {
  return invoke("sc_unstage", { cwd, paths });
}

export function scDiscard(cwd: string, paths: string[], includeUntracked: boolean): Promise<void> {
  return invoke("sc_discard", { cwd, paths, includeUntracked });
}

export function scCommit(cwd: string, message: string): Promise<string> {
  return invoke("sc_commit", { cwd, message });
}

export function scLocalBranches(cwd: string): Promise<LocalBranches> {
  return invoke("sc_local_branches", { cwd });
}

export function scCheckout(cwd: string, branch: string): Promise<void> {
  return invoke("sc_checkout", { cwd, branch });
}

export function scFileDiff(
  cwd: string,
  path: string,
  staged: boolean,
  compareAgainstHead: boolean,
): Promise<DiffContent> {
  return invoke("sc_file_diff", { cwd, path, staged, compareAgainstHead });
}

export function scHistory(cwd: string, limit?: number): Promise<HistoryResult> {
  return invoke("sc_history", { cwd, limit: limit ?? null });
}

export function scBranchCompare(cwd: string, baseRef: string): Promise<BranchCompare> {
  return invoke("sc_branch_compare", { cwd, baseRef });
}

export function scFetch(cwd: string): Promise<void> {
  return invoke("sc_fetch", { cwd });
}

export function scPull(cwd: string, ffOnly: boolean): Promise<PullOutcome> {
  return invoke("sc_pull", { cwd, ffOnly });
}

export function scFastForward(cwd: string): Promise<PullOutcome> {
  return invoke("sc_fast_forward", { cwd });
}

export function scPush(
  cwd: string,
  publish: boolean,
  forceWithLease: boolean,
): Promise<PushOutcome> {
  return invoke("sc_push", { cwd, publish, forceWithLease });
}

export function scUpstreamRefresh(cwd: string): Promise<UpstreamStatus> {
  return invoke("sc_upstream_refresh", { cwd });
}

export interface CommitMessage {
  message: string;
}

// Read-only op: never fires git-changed; backend falls back to a heuristic
// message instead of erroring when no agent resolves.
export function scGenerateCommitMessage(cwd: string): Promise<CommitMessage> {
  return invoke("sc_generate_commit_message", { cwd });
}
export const generateCommitMessage = scGenerateCommitMessage;

export function diffCommentsList(worktreeId: string): Promise<DiffComment[]> {
  return invoke("diff_comments_list", { worktreeId });
}

export function diffCommentAdd(comment: NewDiffComment): Promise<DiffComment> {
  return invoke("diff_comment_add", { comment });
}

export function diffCommentUpdate(id: string, body: string): Promise<DiffComment> {
  return invoke("diff_comment_update", { id, body });
}

export function diffCommentToggle(id: string, body: string): Promise<DiffComment> {
  return diffCommentUpdate(id, body);
}

export function diffCommentDelete(id: string): Promise<void> {
  return invoke("diff_comment_delete", { id });
}

export function diffCommentsMarkSent(ids: string[]): Promise<DiffComment[]> {
  return invoke("diff_comments_mark_sent", { ids });
}

// Payload-less nudge from the daemon after any source-control mutation anywhere.
export async function onGitChanged(cb: () => void) {
  return listen("git-changed", () => cb());
}

// ---- v5 hosted-review surface; TS types serde-exact to Rust hosted_reviews.rs ----

export type ForgeProvider = "github" | "unsupported";

export type BlockedReason =
  | "detached-head"
  | "existing-review"
  | "unsupported-provider"
  | "default-branch"
  | "dirty"
  | "no-upstream"
  | "needs-sync"
  | "auth-required"
  | "needs-push"
  | "base-not-on-remote"
  | "gh-missing"
  | "gh-not-authed";

export interface Eligibility {
  eligible: boolean;
  blocked_reason: BlockedReason | null;
  base_ref: string | null;
  owner_repo: string | null;
  existing_pr_url: string | null;
}

export type PrEligibility = Eligibility;

export interface CreatedReview {
  pr_url: string;
  pr_number: number | null;
  base_ref: string;
  owner_repo: string;
}

export type CheckState = "passing" | "failing" | "pending" | "skipping";

export interface CheckRun {
  name: string;
  state: CheckState;
}

export interface PrStatus {
  number: number;
  title: string;
  url: string;
  state: string;
  draft: boolean;
  mergeable: string;
  base_ref_name: string;
  head_ref_name: string;
  checks: CheckRun[];
  fetched_at_ms: number;
}

export interface PrChangedPayload {
  worktree_id: string | null;
}

export function prEligibility(cwd: string): Promise<Eligibility> {
  return invoke("review_eligibility", { cwd });
}
export const requestReviewEligibility = prEligibility;

export function prCreateReview(
  cwd: string,
  input: { title: string; body: string; draft: boolean },
): Promise<CreatedReview> {
  return invoke("create_review", { cwd, title: input.title, body: input.body, draft: input.draft });
}
export const requestCreateReview = prCreateReview;

export function prReviewStatus(cwd: string): Promise<PrStatus> {
  return invoke("review_status", { cwd });
}
export const requestReviewStatus = prReviewStatus;

export function prCheckout(cwd: string, branch: string): Promise<void> {
  return scCheckout(cwd, branch);
}

export function prSync(cwd: string): Promise<PullOutcome> {
  return scFastForward(cwd);
}

export async function onPrChanged(cb: (p: PrChangedPayload) => void) {
  return listen<PrChangedPayload>("pr-changed", (e) => cb(e.payload));
}

export interface PrMessage {
  title: string;
  body: string;
}

export function scGeneratePrMessage(cwd: string): Promise<PrMessage> {
  return invoke("sc_generate_pr_message", { cwd });
}
export const generatePrMessage = scGeneratePrMessage;

// ---- v6 fleets: guarded merge of an agent branch into its base ref ----

export type MergeModeInput = "squash" | "merge";

export interface MergeToBaseOutcome {
  merged_commit: string;
  mode: string;
  files_changed: number;
}

export function scMergeToBase(cwd: string, mode: MergeModeInput): Promise<MergeToBaseOutcome> {
  return invoke("sc_merge_to_base", { cwd, mode });
}
