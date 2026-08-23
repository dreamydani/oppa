import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// The ONLY module that touches Tauri APIs. Everything else goes through here.
export interface PtyDataPayload {
  id: string;
  data: string;
  bytes: number;
  seq: number;
}
export interface PtyExitPayload {
  id: string;
  code: number | null;
  error?: string;
}
export interface PtyCwdPayload {
  id: string;
  cwd: string;
}

export interface ResumePlan {
  command_line: string;
  kind: "agent-resume" | "command-relaunch";
}

export interface PtySpawnResult {
  id: string;
  is_new: boolean;
  is_warm?: boolean;
  snapshot?: string | null;
  cold_scrollback?: string | null;
  pid?: number;
  cols?: number;
  rows?: number;
  cwd?: string | null;
  resume?: ResumePlan | null;
  resume_declined_reason?: string | null;
}


// Type alias (not interface) so it satisfies InvokeArgs' index signature.
export type PtySpawnOptions = {
  id?: string;
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  resumeAgents?: boolean;
  worktreeId?: string;
};

export async function ptySpawn(opts?: PtySpawnOptions): Promise<PtySpawnResult> {
  return invoke<PtySpawnResult>("pty_spawn", opts ?? {});
}
export function ptyWrite(id: string, data: string): Promise<void> {
  return invoke("pty_write", { id, data });
}
export function ptyResize(id: string, cols: number, rows: number): Promise<void> {
  return invoke("pty_resize", { id, cols, rows });
}
export function ptyKill(id: string): Promise<void> {
  return invoke("pty_kill", { id });
}
export function ptyAck(id: string, chars: number): Promise<void> {
  return invoke("pty_ack", { id, chars });
}
export function ptyList(): Promise<string[]> {
  return invoke("pty_list");
}
export function ptyDisconnect(): Promise<void> {
  return invoke("pty_disconnect");
}
export function ptyShutdown(): Promise<void> {
  return invoke("pty_shutdown");
}
export function saveLayout(layoutJson: string): Promise<void> {
  return invoke("save_layout", { layoutJson });
}
export function loadLayout(): Promise<string | null> {
  return invoke("load_layout");
}
export async function saveScrollback(id: string, data: string): Promise<void> {
  return invoke("save_scrollback", { id, data });
}
export async function loadScrollback(id: string): Promise<string | null> {
  return invoke("load_scrollback", { id });
}
export async function deleteScrollback(id: string): Promise<void> {
  return invoke("delete_scrollback", { id });
}
export async function cleanupStaleScrollbacks(activeIds: string[]): Promise<void> {
  return invoke("cleanup_stale_scrollbacks", { activeIds });
}
// Signals the Rust close handshake that the layout save has flushed, so the
// app can exit instead of waiting out the full timeout.
export function confirmSaveComplete(): Promise<void> {
  return invoke("confirm_save_complete");
}
export async function onPtyData(cb: (p: PtyDataPayload) => void) {
  return listen<PtyDataPayload>("pty:data", (e) => cb(e.payload));
}
export async function onPtyExit(cb: (p: PtyExitPayload) => void) {
  return listen<PtyExitPayload>("pty:exit", (e) => cb(e.payload));
}
export async function onPtyCwd(cb: (p: PtyCwdPayload) => void) {
  return listen<PtyCwdPayload>("pty:cwd", (e) => cb(e.payload));
}

// Worktree engine shapes mirror the serde structs in ipc_protocol v3 exactly
// (default serde naming, so JSON keys stay snake_case).
export type WorktreeStatus = "todo" | "in-progress" | "in-review" | "completed";

export interface WorktreeRecord {
  id: string;
  repo_id: string;
  name: string;
  display_name: string | null;
  branch: string;
  path: string;
  base_ref: string;
  parent_worktree_id: string | null;
  child_worktree_ids: string[];
  workspace_status: WorktreeStatus;
  retired: boolean;
  created_at_ms: number;
  linked_pr_url: string | null;
}

export interface WorktreeListEntry {
  record: WorktreeRecord;
  missing_on_disk: boolean;
}

export interface WorktreePsEntry {
  record: WorktreeRecord;
  live_sessions: number;
}

export interface RepoRecord {
  repo_id: string;
  path: string;
  default_base_ref: string | null;
  worktree_base_path: string | null;
}

export interface WorktreeChangedPayload {
  id: string | null;
}

export interface SessionTitleChangedPayload {
  id: string;
  title: string;
}

export interface SessionFocusRequestedPayload {
  id: string;
}

export type WorktreeCreateOptions = {
  repoPath: string;
  name?: string;
  branch?: string;
  baseRef?: string;
  parentWorktreeId?: string;
  workspaceDir?: string;
  nestWorkspaces?: boolean;
};

// setParent disambiguates "clear parent" from "leave parent untouched".
export type WorktreeSetOptions = {
  parentWorktreeId?: string | null;
  workspaceStatus?: WorktreeStatus;
  displayName?: string | null;
};

export function worktreeCreate(opts: WorktreeCreateOptions): Promise<WorktreeRecord | null> {
  return invoke("worktree_create", opts as unknown as Record<string, unknown>);
}

// Mirrors catalog::PromptDelivery's kebab-case serde representation
export type PromptDelivery = "arg" | "stdin" | "paste-on-ready";

export interface AgentProfile {
  id: string;
  displayName: string;
  promptDelivery: PromptDelivery;
}

// AgentHandoff response shape: session_id doubles as the agent pane handle
export interface WorktreeAgentHandoff {
  record: WorktreeRecord;
  session_id: string;
}

export type WorktreeCreateAgentOptions = WorktreeCreateOptions & {
  agent?: string;
  prompt?: string;
  command?: string;
};

export function agentProfiles(): Promise<AgentProfile[]> {
  return invoke("agent_profiles");
}
export function worktreeCreateAgent(
  opts: WorktreeCreateAgentOptions,
): Promise<WorktreeAgentHandoff> {
  return invoke("worktree_create_agent", opts as unknown as Record<string, unknown>);
}
export function worktreeList(): Promise<WorktreeListEntry[]> {
  return invoke("worktree_list");
}
export function worktreeShow(id: string): Promise<WorktreeRecord | null> {
  return invoke("worktree_show", { id });
}
export function worktreeCurrent(cwd: string): Promise<WorktreeRecord | null> {
  return invoke("worktree_current", { cwd });
}
export function worktreeSet(
  id: string,
  opts: WorktreeSetOptions,
): Promise<WorktreeRecord | null> {
  const args: Record<string, unknown> = { id, setParent: "parentWorktreeId" in opts };
  if ("parentWorktreeId" in opts) args.parentWorktreeId = opts.parentWorktreeId ?? null;
  if (opts.workspaceStatus !== undefined) args.workspaceStatus = opts.workspaceStatus;
  if ("displayName" in opts) args.displayName = opts.displayName ?? null;
  return invoke("worktree_set", args);
}
export function worktreeRemove(id: string, force: boolean, deleteBranch: boolean): Promise<void> {
  return invoke("worktree_remove", { id, force, deleteBranch });
}
export function worktreePurge(id: string): Promise<void> {
  return invoke("worktree_purge", { id });
}
export function worktreePs(): Promise<WorktreePsEntry[]> {
  return invoke("worktree_ps");
}
export function worktreeLineage(id: string): Promise<WorktreeRecord[]> {
  return invoke("worktree_lineage", { id });
}
export function repoAdd(path: string): Promise<RepoRecord[]> {
  return invoke("repo_add", { path });
}
export function repoList(): Promise<RepoRecord[]> {
  return invoke("repo_list");
}
export async function onWorktreeChanged(cb: (p: WorktreeChangedPayload) => void) {
  return listen<WorktreeChangedPayload>("worktree-changed", (e) => cb(e.payload));
}
export async function onTitleChanged(cb: (p: SessionTitleChangedPayload) => void) {
  return listen<SessionTitleChangedPayload>("session-title-changed", (e) => cb(e.payload));
}
export async function onFocusRequested(cb: (p: SessionFocusRequestedPayload) => void) {
  return listen<SessionFocusRequestedPayload>("session-focus-requested", (e) => cb(e.payload));
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
export function generateCommitMessage(cwd: string): Promise<CommitMessage> {
  return invoke("sc_generate_commit_message", { cwd });
}
export function diffCommentsList(worktreeId: string): Promise<DiffComment[]> {
  return invoke("diff_comments_list", { worktreeId });
}
export function diffCommentAdd(comment: NewDiffComment): Promise<DiffComment> {
  return invoke("diff_comment_add", { comment });
}
export function diffCommentUpdate(id: string, body: string): Promise<DiffComment> {
  return invoke("diff_comment_update", { id, body });
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
