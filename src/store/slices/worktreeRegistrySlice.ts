// Worktree + repo registry state, loaded from the daemon and refreshed on
// worktree-changed events. Mutations always re-list so cards stay truthful.

import {
  ptyList,
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
} from "../../lib/pty/transport";
import type {
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
