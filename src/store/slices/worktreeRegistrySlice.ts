// Worktree + repo registry state, loaded from the daemon and refreshed on
// worktree-changed events. Mutations always re-list so cards stay truthful.

import {
  ptyList,
  repoAdd,
  repoList,
  requestReviewEligibility,
  worktreeCreate,
  worktreeCreateAgent,
  worktreeCreateFleet,
  worktreeList,
  worktreeSet,
  worktreeRemove,
  worktreePurge,
  worktreePs,
} from "../../lib/pty/transport";
import type {
  Eligibility,
  FleetSlotInput,
  FleetSpawnResult,
  RepoRecord,
  WorktreeAgentHandoff,
  WorktreeListEntry,
  WorktreeRecord,
  WorktreeStatus,
} from "../../lib/pty/transport";
import type { TerminalState } from "../terminalStore";

type Set = (
  partial:
    | Partial<TerminalState>
    | ((state: TerminalState) => Partial<TerminalState>),
) => void;

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
      await get().createTab(handoff.record.path, handoff.record.id, handoff.session_id);
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

    renameWorktree: async (id, displayName) => {
      await worktreeSet(id, { displayName });
      await get().loadWorktrees();
    },

    removeWorktree: async (id, force = false, deleteBranch = false) => {
      await worktreeRemove(id, force, deleteBranch);
      await get().loadWorktrees();
    },

    purgeWorktree: async (id) => {
      await worktreePurge(id);
      await get().loadWorktrees();
    },
  };
}
