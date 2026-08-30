import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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

export interface FleetSlotInput {
  name?: string | null;
  agent?: string | null;
  command?: string | null;
  prompt?: string | null;
}

export interface FleetSlotResult {
  index: number;
  ok: boolean;
  record: WorktreeRecord | null;
  session_id: string | null;
  error: string | null;
}

export interface FleetSpawnResult {
  results: FleetSlotResult[];
}

export type FleetSpawnOptions = {
  repoPath: string;
  baseRef?: string;
  sharedPrompt?: string;
  slots: FleetSlotInput[];
};

export function worktreeCreate(opts: WorktreeCreateOptions): Promise<WorktreeRecord | null> {
  return invoke("worktree_create", opts as unknown as Record<string, unknown>);
}

export function agentProfiles(): Promise<AgentProfile[]> {
  return invoke("agent_profiles");
}

export function worktreeCreateAgent(
  opts: WorktreeCreateAgentOptions,
): Promise<WorktreeAgentHandoff> {
  return invoke("worktree_create_agent", opts as unknown as Record<string, unknown>);
}

export async function worktreeCreateFleet(opts: FleetSpawnOptions): Promise<FleetSpawnResult> {
  const raw = await invoke<FleetSlotResult[] | FleetSpawnResult>(
    "worktree_create_fleet",
    opts as unknown as Record<string, unknown>,
  );
  if (Array.isArray(raw)) {
    return { results: raw };
  }
  return raw ?? { results: [] };
}

export const fleetSpawn = worktreeCreateFleet;

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
