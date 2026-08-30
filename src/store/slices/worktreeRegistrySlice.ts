// Worktree + repo registry state, loaded from the daemon and refreshed on
// worktree-changed events. Mutations always re-list so cards stay truthful.

import { ptyList } from "../../lib/pty/transport";
import {
  repoAdd,
  repoList,
  worktreeCreate,
  worktreeCreateAgent,
  worktreeCreateFleet,
  worktreeList,
  worktreeSet,
  worktreeRemove,
  worktreePurge,
  worktreePs,
} from "../../lib/worktree/transport";
import type {
  FleetSlotInput,
  FleetSpawnResult,
  RepoRecord,
  WorktreeAgentHandoff,
  WorktreeListEntry,
  WorktreeRecord,
  WorktreeStatus,
} from "../../lib/worktree/transport";
import {
  requestReviewEligibility,
  scMergeToBase,
} from "../../lib/git/transport";
import type {
  Eligibility,
  MergeModeInput,
  MergeToBaseOutcome,
} from "../../lib/git/transport";
import type { TerminalSession } from "./terminalSessionsSlice";
import type { TerminalState } from "../terminalStore";

type Set = (
  partial:
    | Partial<TerminalState>
    | ((state: TerminalState) => Partial<TerminalState>),
) => void;

// F11 optional auto-status on finish; a GeneralSettings field may replace this
// module default later (deliberately kept out of the settings schema for now).
export const AUTO_STATUS_ON_FINISH = true;

// Finished stretches already handled: membership suppresses repeat calls while
// a worktree stays finished; removal on leaving finished re-arms the next one.
const autoStatusAppliedIds = new Set<string>();

/** One-shot gate: true only on the first observation of a finished stretch. */
export function consumeAutoStatusOnFinish(worktreeId: string): boolean {
  if (!AUTO_STATUS_ON_FINISH || autoStatusAppliedIds.has(worktreeId)) return false;
  autoStatusAppliedIds.add(worktreeId);
  return true;
}

/** Leaving finished re-arms auto-status for future finish transitions. */
export function resetAutoStatusOnFinish(worktreeId: string): void {
  autoStatusAppliedIds.delete(worktreeId);
}

/** Test hook: module bookkeeping must not leak between test cases. */
export function resetAutoStatusAppliedForTests(): void {
  autoStatusAppliedIds.clear();
}

// F11 v2: hook truth wins. A linked live session that reported `done` finishes
// the worktree; working/blocked/waiting keeps it active. The quietness
// heuristic applies only to hookless shells (no hook row for the session).
export function selectWorktreeFinished(
  state: Pick<
    TerminalState,
    "sessions" | "workingBySessionId" | "statusBySessionId"
  >,
  worktreeId: string,
): boolean {
  let linkedCount = 0;
  let hookBusy = false;
  let legacyBusy = false;
  for (const session of Object.values(state.sessions)) {
    if (session.worktreeId !== worktreeId || session.status === "exited") continue;
    linkedCount += 1;
    const entry = state.statusBySessionId[session.id];
    if (entry) {
      // Blocked/waiting are attention states, never finished; working likewise.
      if (entry.state !== "done") hookBusy = true;
    } else if (state.workingBySessionId[session.id]) {
      legacyBusy = true;
    }
  }
  if (linkedCount === 0) return false;
  if (hookBusy) return false;
  return !legacyBusy;
}

export interface BranchNode {
  worktreeId: string;
  name: string;
  branch: string;
  path: string;
  status: "idle" | "working" | "sleeping" | "finished" | "in-progress" | "in-review" | "completed";
  sessionIds: string[];
  prUrl: string | null;
  missingOnDisk: boolean;
  retired: boolean;
}

export interface ProjectNode {
  repoId: string;
  repoPath: string;
  repoName: string;
  branches: BranchNode[];
  totalLiveSessions: number;
}

// Extracts displayable project name from repository path or identifier fallback.
export function extractRepoName(repoPath: string, repoId?: string): string {
  if (repoPath) {
    const trimmedPath = repoPath.trim().replace(/[/\\]+$/, "");
    const segments = trimmedPath.split(/[/\\]/);
    const lastSegment = segments[segments.length - 1];
    if (lastSegment && lastSegment.length > 0) {
      return lastSegment;
    }
  }
  if (repoId && repoId.trim().length > 0) {
    return repoId.trim();
  }
  return "Untitled Project";
}

// Maps live agent activity or persisted worktree lifecycle to branch status badge.
function computeBranchStatus(
  entry: WorktreeListEntry,
  linkedLiveSessions: TerminalSession[],
  workingBySessionId: Record<string, boolean>,
): BranchNode["status"] {
  const hasActiveWorkingSession = linkedLiveSessions.some(
    (session) => workingBySessionId[session.id] === true,
  );
  if (hasActiveWorkingSession) {
    return "working";
  }

  if (entry.record.workspace_status === "in-review") {
    return "in-review";
  }
  if (entry.record.workspace_status === "completed") {
    return "completed";
  }

  if (linkedLiveSessions.length > 0) {
    return "idle";
  }

  if (entry.record.retired) {
    return "sleeping";
  }

  if (entry.record.workspace_status === "in-progress") {
    return "in-progress";
  }
  if (entry.record.workspace_status === "todo") {
    return "sleeping";
  }
  if ((entry.record.workspace_status as string) === "finished") {
    return "finished";
  }

  return "idle";
}

// Aggregates repositories, registered worktrees, and live terminal sessions into a hierarchical tree.
export function selectProjectTree(
  state: Pick<TerminalState, "repos" | "worktrees" | "sessions" | "workingBySessionId">,
): ProjectNode[] {
  const repos = state.repos ?? [];
  const worktrees = state.worktrees ?? [];
  const sessions = state.sessions ?? {};
  const workingBySessionId = state.workingBySessionId ?? {};

  const allSessionsList = Object.values(sessions);
  const matchedWorktreeIds = new Set<string>();
  const projectNodes: ProjectNode[] = [];

  for (const repo of repos) {
    const matchingEntries = worktrees.filter(
      (entry) => entry.record.repo_id === repo.repo_id,
    );

    const branches: BranchNode[] = matchingEntries.map((entry) => {
      matchedWorktreeIds.add(entry.record.id);
      const linkedSessions = allSessionsList.filter(
        (session) => session.worktreeId === entry.record.id,
      );
      const linkedLiveSessions = linkedSessions.filter(
        (session) => session.status !== "exited",
      );

      return {
        worktreeId: entry.record.id,
        name: entry.record.display_name || entry.record.name,
        branch: entry.record.branch,
        path: entry.record.path,
        status: computeBranchStatus(entry, linkedLiveSessions, workingBySessionId),
        sessionIds: linkedSessions.map((session) => session.id),
        prUrl: entry.record.linked_pr_url ?? null,
        missingOnDisk: Boolean(entry.missing_on_disk),
        retired: Boolean(entry.record.retired),
      };
    });

    const branchWorktreeIdSet = new Set(branches.map((b) => b.worktreeId));
    const totalLiveSessions = allSessionsList.filter(
      (session) =>
        session.worktreeId &&
        branchWorktreeIdSet.has(session.worktreeId) &&
        session.status !== "exited",
    ).length;

    projectNodes.push({
      repoId: repo.repo_id,
      repoPath: repo.path,
      repoName: extractRepoName(repo.path, repo.repo_id),
      branches,
      totalLiveSessions,
    });
  }

  const orphanedEntries = worktrees.filter(
    (entry) => !matchedWorktreeIds.has(entry.record.id),
  );
  if (orphanedEntries.length > 0) {
    const orphanGroups = new Map<string, WorktreeListEntry[]>();
    for (const entry of orphanedEntries) {
      const groupKey = entry.record.repo_id || "orphaned";
      const existing = orphanGroups.get(groupKey);
      if (existing) {
        existing.push(entry);
      } else {
        orphanGroups.set(groupKey, [entry]);
      }
    }

    for (const [repoId, groupEntries] of orphanGroups.entries()) {
      const repoPath = groupEntries[0]?.record.path ?? "";
      const repoName =
        repoId === "orphaned"
          ? "Other Worktrees"
          : extractRepoName(repoId, repoId);

      const branches: BranchNode[] = groupEntries.map((entry) => {
        const linkedSessions = allSessionsList.filter(
          (session) => session.worktreeId === entry.record.id,
        );
        const linkedLiveSessions = linkedSessions.filter(
          (session) => session.status !== "exited",
        );

        return {
          worktreeId: entry.record.id,
          name: entry.record.display_name || entry.record.name,
          branch: entry.record.branch,
          path: entry.record.path,
          status: computeBranchStatus(entry, linkedLiveSessions, workingBySessionId),
          sessionIds: linkedSessions.map((session) => session.id),
          prUrl: entry.record.linked_pr_url ?? null,
          missingOnDisk: Boolean(entry.missing_on_disk),
          retired: Boolean(entry.record.retired),
        };
      });

      const branchWorktreeIdSet = new Set(branches.map((b) => b.worktreeId));
      const totalLiveSessions = allSessionsList.filter(
        (session) =>
          session.worktreeId &&
          branchWorktreeIdSet.has(session.worktreeId) &&
          session.status !== "exited",
      ).length;

      projectNodes.push({
        repoId,
        repoPath,
        repoName,
        branches,
        totalLiveSessions,
      });
    }
  }

  return projectNodes;
}

export interface WorktreeCreateInput {
  repoPath: string;
  name?: string;
  branch?: string;
  baseRef?: string;
  parentWorktreeId?: string;
}

export interface WorktreeCreateAgentInput extends WorktreeCreateInput {
  agent?: string;
  prompt?: string;
  command?: string;
}

export interface FleetSpawnInput {
  repoPath: string;
  baseRef?: string;
  sharedPrompt?: string;
  slots: FleetSlotInput[];
}

export type FinishFailureStage = "eligibility" | "status" | "push" | "review";

export type FinishOutcome =
  | { ok: true; prUrl: string | null; pushedTo: string }
  | { ok: false; stage: FinishFailureStage; reason: string };

export interface WorktreeFinishInput {
  worktreeId: string;
}

export interface WorktreeMergeToBaseInput {
  worktreeId: string;
  mode: MergeModeInput;
}

export interface WorktreeRegistrySlice {
  worktrees: WorktreeListEntry[];
  // Per-worktree count of live daemon sessions, for card badges.
  worktreeLiveSessions: Record<string, number>;
  repos: RepoRecord[];
  loadWorktrees: () => Promise<void>;
  loadRepos: () => Promise<void>;
  addRepo: (path: string) => Promise<RepoRecord>;
  createWorktree: (input: WorktreeCreateInput) => Promise<WorktreeRecord | null>;
  createWorktreeWithAgent: (input: WorktreeCreateAgentInput) => Promise<WorktreeAgentHandoff>;
  spawnFleet: (input: FleetSpawnInput) => Promise<FleetSpawnResult>;
  finishWorktree: (input: WorktreeFinishInput) => Promise<FinishOutcome>;
  mergeWorktreeToBase: (input: WorktreeMergeToBaseInput) => Promise<MergeToBaseOutcome>;
  setWorktreeStatus: (id: string, status: WorktreeStatus) => Promise<void>;
  renameWorktree: (id: string, displayName: string) => Promise<void>;
  removeWorktree: (id: string, force?: boolean, deleteBranch?: boolean) => Promise<void>;
  purgeWorktree: (id: string) => Promise<void>;
}

export function createWorktreeRegistrySlice(
  set: Set,
  get: () => TerminalState,
): WorktreeRegistrySlice {
  return {
    worktrees: [],
    worktreeLiveSessions: {},
    repos: [],

    loadWorktrees: async () => {
      // Both reads fail soft so a stopped daemon never blanks the cards.
      const [entries, psEntries] = await Promise.all([
        worktreeList().catch(() => null),
        worktreePs().catch(() => null),
      ]);
      if (!entries) return;
      const liveSessions: Record<string, number> = {};
      for (const entry of psEntries ?? []) {
        liveSessions[entry.record.id] = entry.live_sessions;
      }
      set({ worktrees: entries, worktreeLiveSessions: liveSessions });
    },

    loadRepos: async () => {
      try {
        set({ repos: await repoList() });
      } catch {
        // Keep previous repos on failure
      }
    },

    addRepo: async (path) => {
      const records = await repoAdd(path);
      const record = records[0];
      if (!record) throw new Error(`repo_add returned no record for ${path}`);
      await get().loadRepos();
      return record;
    },

    createWorktree: async (input) => {
      const record = await worktreeCreate(input);
      await Promise.all([get().loadWorktrees(), get().loadRepos()]);
      return record;
    },

    createWorktreeWithAgent: async (input) => {
      const handoff = await worktreeCreateAgent(input);
      await Promise.all([get().loadWorktrees(), get().loadRepos()]);
      // Attach only when ListSessions confirms the daemon actually spawned the agent
      const liveSessions = await ptyList().catch(() => [] as string[]);
      if (!liveSessions.includes(handoff.session_id)) return handoff;
      // New agent lands in the ACTIVE workspace's grid (the always-grid rule);
      // only when nothing is active does it open its own workspace tab.
      const activeTabId = get().activeTabId;
      if (activeTabId) {
        await get().mergeSessionsIntoWorkspace(activeTabId, [handoff.session_id], {
          worktreeIdsBySession: { [handoff.session_id]: handoff.record.id },
          ...(input.repoPath ? { workspaceKey: input.repoPath } : {}),
        });
      } else {
        await get().createTab(handoff.record.path, handoff.record.id, handoff.session_id);
      }
      return handoff;
    },

    spawnFleet: async (input) => {
      const result = await worktreeCreateFleet(input);
      // One IPC call lands every slot; a single re-list keeps cards truthful.
      await get().loadWorktrees();
      return result;
    },

    // Finish chain: commit-all → push → create review → in-review. Push runs
    // BEFORE review creation because a PR needs the branch on the remote, but
    // eligibility is probed first so a blocked review never blocks the push.
    finishWorktree: async ({ worktreeId }) => {
      const entry = get().worktrees.find((w) => w.record.id === worktreeId);
      if (!entry) {
        return { ok: false, stage: "status", reason: `unknown worktree ${worktreeId}` };
      }
      const { record } = entry;
      const cwd = record.path;
      const displayName = record.display_name || record.name;
      const fail = (stage: FinishFailureStage, error: unknown): FinishOutcome => ({
        ok: false,
        stage,
        reason: error instanceof Error ? error.message : String(error),
      });

      await get().refreshGitStatus(cwd);
      // refreshGitStatus keeps the previous snapshot on daemon hiccups; without
      // a fresh read we must not mutate this working copy.
      const status = get().gitStatus;
      if (!status) {
        return { ok: false, stage: "status", reason: "git status unavailable for this worktree" };
      }

      const conflicted = status.entries.filter((e) => e.area === "conflict");
      if (conflicted.length > 0 || status.conflict_state !== "none") {
        const reason =
          conflicted.length > 0
            ? `${conflicted.length} conflicted file${conflicted.length === 1 ? "" : "s"} — resolve first`
            : `${status.conflict_state} in progress — resolve conflicts first`;
        return { ok: false, stage: "status", reason };
      }

      try {
        const dirtyPaths = status.entries.filter((e) => e.area !== "conflict").map((e) => e.path);
        if (dirtyPaths.length > 0) await get().stage(dirtyPaths, cwd);
        // Deterministic message: no agent commit-message wrapper is wired into
        // the registry yet, so finish must never block on one.
        await get().commit(`finish: merge work from ${displayName}`, cwd);
      } catch (e) {
        return fail("status", e);
      }

      let eligibility: Eligibility | null = null;
      let probeError: string | null = null;
      try {
        eligibility = await requestReviewEligibility(cwd);
      } catch (e) {
        probeError = e instanceof Error ? e.message : String(e);
      }

      // Publish when the branch was never pushed; upstream state cannot change
      // mid-chain from staging/committing alone.
      const publish = !(status.upstream?.has_upstream ?? false);
      let pushedTo: string;
      try {
        pushedTo = (await get().push({ publish }, cwd)).pushed_to;
      } catch (e) {
        return fail("push", e);
      }

      // Best-effort chip flip; the PR itself is the source of truth for success.
      const markInReview = () =>
        get().setWorktreeStatus(record.id, "in-review").catch(() => {});

      if (eligibility?.existing_pr_url) {
        await markInReview();
        return { ok: true, prUrl: eligibility.existing_pr_url, pushedTo };
      }
      if (!eligibility || !eligibility.eligible) {
        return {
          ok: false,
          stage: "eligibility",
          reason: eligibility?.blocked_reason ?? probeError ?? "review eligibility unavailable",
        };
      }
      try {
        const created = await get().createReview(cwd, {
          title: displayName,
          body: `Automated finish for branch ${record.branch}`,
          draft: false,
        });
        await markInReview();
        return { ok: true, prUrl: created.pr_url, pushedTo };
      } catch (e) {
        // Commit+push landed; leave the card status alone instead of regressing.
        return fail("review", e);
      }
    },

    setWorktreeStatus: async (id, status) => {
      await worktreeSet(id, { workspaceStatus: status });
      await get().loadWorktrees();
    },

    // Guarded local merge (F10): the backend owns every guard and returns
    // plain-language reasons; we just resolve cwd and refresh both surfaces.
    mergeWorktreeToBase: async ({ worktreeId, mode }) => {
      const entry = get().worktrees.find((w) => w.record.id === worktreeId);
      if (!entry) throw new Error(`unknown worktree ${worktreeId}`);
      const cwd = entry.record.path;
      const outcome = await scMergeToBase(cwd, mode);
      await Promise.all([get().loadWorktrees(), get().refreshGitStatus(cwd)]);
      return outcome;
    },

    renameWorktree: async (id, displayName) => {
      await worktreeSet(id, { displayName });
      await get().loadWorktrees();
    },

    removeWorktree: async (id, force = false, deleteBranch = false) => {
      if (force) {
        const state = get();
        for (const [sId, session] of Object.entries(state.sessions)) {
          if (session.worktreeId === id) {
            await get().killSession(sId).catch(() => {});
          }
        }
      }
      await worktreeRemove(id, force, deleteBranch);
      await get().loadWorktrees();
    },

    purgeWorktree: async (id) => {
      await worktreePurge(id);
      await get().loadWorktrees();
    },
  };
}
