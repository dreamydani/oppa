// Source-control panel state: git status/branches/history/compare, diff
// notes (daemon-persisted per worktree), and hosted-review eligibility /
// status caches. All mutations refresh status so CLI-side changes converge.

import { ptyWrite } from "../../lib/pty/transport";
import {
  scStatus,
  scStage,
  scUnstage,
  scDiscard,
  scCommit,
  scLocalBranches,
  scCheckout,
  scBranchCompare,
  scFetch,
  scHistory,
  scPull,
  scFastForward,
  scPush,
  diffCommentsList,
  diffCommentAdd,
  diffCommentUpdate,
  diffCommentDelete,
  diffCommentsMarkSent,
  requestReviewEligibility,
  requestCreateReview,
  requestReviewStatus,
} from "../../lib/git/transport";
import type {
  BranchCompare,
  CreatedReview,
  DiffComment,
  Eligibility,
  HistoryResult,
  LocalBranches,
  NewDiffComment,
  PrStatus,
  PullOutcome,
  PushOutcome,
  SourceControlStatus,
} from "../../lib/git/transport";
import { focus } from "../../lib/pane-manager/layout";
import type { TerminalState } from "../terminalStore";
import { getActiveTab } from "./layoutQueries";

type Set = (
  partial:
    | Partial<TerminalState>
    | ((state: TerminalState) => Partial<TerminalState>),
) => void;

export interface SourceControlSlice {
  // Git slice: daemon-owned source-control state; mutations refresh status so
  // the panel and StatusBar stay in sync with CLI/daemon-side changes too.
  gitStatus: SourceControlStatus | null;
  gitBranches: LocalBranches | null;
  gitHistory: HistoryResult | null;
  gitCompare: BranchCompare | null;
  refreshGitStatus: (cwd?: string) => Promise<void>;
  stage: (paths: string[], cwd?: string) => Promise<void>;
  unstage: (paths: string[], cwd?: string) => Promise<void>;
  discard: (paths: string[], includeUntracked?: boolean, cwd?: string) => Promise<void>;
  commit: (message: string, cwd?: string) => Promise<string>;
  checkout: (branch: string, cwd?: string) => Promise<void>;
  loadBranches: (cwd?: string) => Promise<void>;
  loadHistory: (limit?: number, cwd?: string) => Promise<void>;
  compareBase: (baseRef: string, cwd?: string) => Promise<void>;
  fetch: (cwd?: string) => Promise<void>;
  pull: (ffOnly?: boolean, cwd?: string) => Promise<PullOutcome>;
  ff: (cwd?: string) => Promise<PullOutcome>;
  push: (
    opts?: { publish?: boolean; forceWithLease?: boolean },
    cwd?: string,
  ) => Promise<PushOutcome>;
  getActiveWorktreeId: () => string;
  // Diff notes: daemon-persisted per worktree; "" key never used since notes
  // require a worktree-bound tab.
  diffComments: Record<string, DiffComment[]>;
  loadComments: (worktreeId: string) => Promise<void>;
  addComment: (worktreeId: string, comment: NewDiffComment) => Promise<DiffComment>;
  updateComment: (id: string, body: string) => Promise<void>;
  deleteComment: (id: string) => Promise<void>;
  markCommentsSent: (ids: string[]) => Promise<void>;
  // Hosted reviews: keyed by cwd; debounced refresh on PrChanged like git-changed
  reviewByCwd: Record<string, { eligibility?: Eligibility; prStatus?: PrStatus; loading: boolean }>;
  // Registry-level cache for worktree cards keyed by worktree id
  prStatusByWorktreeId: Record<string, PrStatus>;
  setReviewEligibility: (cwd: string, eligibility: Eligibility) => void;
  setPrStatus: (cwd: string, prStatus: PrStatus) => void;
  setPrStatusByWorktreeId: (worktreeId: string, prStatus: PrStatus) => void;
  refreshReviewEligibility: (cwd?: string) => Promise<void>;
  createReview: (cwd: string, input: { title: string; body: string; draft: boolean }) => Promise<CreatedReview>;
  refreshReviewStatus: (cwd?: string) => Promise<void>;
  sendToSession: (sessionId: string, data: string) => Promise<void>;
}

export function createSourceControlSlice(
  set: Set,
  get: () => TerminalState,
): SourceControlSlice {
  return {
    gitStatus: null,
    gitBranches: null,
    gitHistory: null,
    gitCompare: null,
    diffComments: {},
    reviewByCwd: {},
    prStatusByWorktreeId: {},

    refreshGitStatus: async (cwd) => {
      const dir = cwd ?? get().getActiveCwd();
      if (!dir) return;
      try {
        set({ gitStatus: await scStatus(dir) });
      } catch {
        // Non-repo or stopped daemon keeps the previous snapshot
      }
    },

    stage: async (paths, cwd) => {
      const dir = cwd ?? get().getActiveCwd();
      if (!dir || paths.length === 0) return;
      await scStage(dir, paths);
      await get().refreshGitStatus();
    },

    unstage: async (paths, cwd) => {
      const dir = cwd ?? get().getActiveCwd();
      if (!dir || paths.length === 0) return;
      await scUnstage(dir, paths);
      await get().refreshGitStatus();
    },

    discard: async (paths, includeUntracked = false, cwd) => {
      const dir = cwd ?? get().getActiveCwd();
      if (!dir || paths.length === 0) return;
      await scDiscard(dir, paths, includeUntracked);
      await get().refreshGitStatus();
    },

    commit: async (message, cwd) => {
      const dir = cwd ?? get().getActiveCwd();
      if (!dir) throw new Error("no active working copy to commit in");
      const id = await scCommit(dir, message);
      await get().refreshGitStatus();
      return id;
    },

    checkout: async (branch, cwd) => {
      const dir = cwd ?? get().getActiveCwd();
      if (!dir) return;
      await scCheckout(dir, branch);
      // Branch switch invalidates branches list and any cached compare
      set({ gitBranches: null, gitCompare: null });
      await get().refreshGitStatus();
    },

    loadBranches: async (cwd) => {
      const dir = cwd ?? get().getActiveCwd();
      if (!dir) return;
      try {
        set({ gitBranches: await scLocalBranches(dir) });
      } catch {
        // Keep previous branches on failure
      }
    },

    loadHistory: async (limit, cwd) => {
      const dir = cwd ?? get().getActiveCwd();
      if (!dir) return;
      try {
        set({ gitHistory: await scHistory(dir, limit) });
      } catch {
        // Keep previous history on failure
      }
    },

    compareBase: async (baseRef, cwd) => {
      const dir = cwd ?? get().getActiveCwd();
      if (!dir) return;
      try {
        set({ gitCompare: await scBranchCompare(dir, baseRef) });
      } catch {
        set({ gitCompare: null });
      }
    },

    fetch: async (cwd) => {
      const dir = cwd ?? get().getActiveCwd();
      if (!dir) return;
      await scFetch(dir);
      await get().refreshGitStatus();
    },

    pull: async (ffOnly = true, cwd) => {
      const dir = cwd ?? get().getActiveCwd();
      if (!dir) throw new Error("no active working copy to pull");
      const outcome = await scPull(dir, ffOnly);
      await get().refreshGitStatus();
      return outcome;
    },

    ff: async (cwd) => {
      const dir = cwd ?? get().getActiveCwd();
      if (!dir) throw new Error("no active working copy to fast-forward");
      const outcome = await scFastForward(dir);
      await get().refreshGitStatus();
      return outcome;
    },

    push: async (opts, cwd) => {
      const dir = cwd ?? get().getActiveCwd();
      if (!dir) throw new Error("no active working copy to push");
      const outcome = await scPush(dir, opts?.publish ?? false, opts?.forceWithLease ?? false);
      await get().refreshGitStatus();
      return outcome;
    },

    // Notes need a concrete worktree; an explicit session binding wins over the
    // cwd prefix match because nested checkouts can share a parent directory.
    getActiveWorktreeId: () => {
      const state = get();
      const activeTab = getActiveTab(state);
      if (!activeTab) return "";
      let sessionId = "";
      try {
        sessionId = focus(activeTab.layout, activeTab.focusedPath);
      } catch {
        return "";
      }
      const session = state.sessions[sessionId];
      if (!session) return "";
      if (session.worktreeId && state.worktrees.some((w) => w.record.id === session.worktreeId)) {
        return session.worktreeId;
      }
      const cwd = session.cwd?.replace(/[\\/]+$/, "").toLowerCase();
      if (!cwd) return "";
      const match = state.worktrees.find((w) => {
        const base = w.record.path.replace(/[\\/]+$/, "").toLowerCase();
        return cwd === base || cwd.startsWith(`${base}\\`) || cwd.startsWith(`${base}/`);
      });
      return match?.record.id ?? "";
    },

    loadComments: async (worktreeId) => {
      if (!worktreeId) return;
      try {
        const list = await diffCommentsList(worktreeId);
        set((state) => ({ diffComments: { ...state.diffComments, [worktreeId]: list } }));
      } catch {
        // Stopped daemon keeps previous notes visible
      }
    },

    addComment: async (worktreeId, comment) => {
      const added = await diffCommentAdd(comment);
      set((state) => ({
        diffComments: {
          ...state.diffComments,
          [worktreeId]: [...(state.diffComments[worktreeId] ?? []), added],
        },
      }));
      return added;
    },

    updateComment: async (id, body) => {
      const updated = await diffCommentUpdate(id, body);
      set((state) => {
        const buckets = { ...state.diffComments };
        for (const [wt, list] of Object.entries(buckets)) {
          const idx = list.findIndex((c) => c.id === id);
          if (idx !== -1) {
            buckets[wt] = list.map((c, i) => (i === idx ? updated : c));
            break;
          }
        }
        return { diffComments: buckets };
      });
    },

    deleteComment: async (id) => {
      await diffCommentDelete(id);
      set((state) => {
        const buckets: Record<string, DiffComment[]> = {};
        for (const [wt, list] of Object.entries(state.diffComments)) {
          buckets[wt] = list.filter((c) => c.id !== id);
        }
        return { diffComments: buckets };
      });
    },

    markCommentsSent: async (ids) => {
      if (ids.length === 0) return;
      const stamped = await diffCommentsMarkSent(ids);
      const byId = new Map(stamped.map((c) => [c.id, c]));
      set((state) => {
        const buckets: Record<string, DiffComment[]> = {};
        for (const [wt, list] of Object.entries(state.diffComments)) {
          buckets[wt] = list.map((c) => byId.get(c.id) ?? c);
        }
        return { diffComments: buckets };
      });
    },

    setReviewEligibility: (cwd, eligibility) =>
      set((state) => ({
        reviewByCwd: {
          ...state.reviewByCwd,
          [cwd]: { ...(state.reviewByCwd[cwd] ?? { loading: false }), eligibility },
        },
      })),

    setPrStatus: (cwd, prStatus) =>
      set((state) => ({
        reviewByCwd: {
          ...state.reviewByCwd,
          [cwd]: { ...(state.reviewByCwd[cwd] ?? { loading: false }), prStatus },
        },
      })),

    setPrStatusByWorktreeId: (worktreeId, prStatus) =>
      set((state) => ({
        prStatusByWorktreeId: { ...state.prStatusByWorktreeId, [worktreeId]: prStatus },
      })),

    refreshReviewEligibility: async (cwd) => {
      const dir = cwd ?? get().getActiveCwd();
      if (!dir || !requestReviewEligibility) return;
      set((state) => ({
        reviewByCwd: {
          ...state.reviewByCwd,
          [dir]: { ...(state.reviewByCwd[dir] ?? {}), loading: true } as typeof state.reviewByCwd[string],
        },
      }));
      try {
        const eligibility = await requestReviewEligibility(dir);
        set((state) => ({
          reviewByCwd: {
            ...state.reviewByCwd,
            [dir]: { ...(state.reviewByCwd[dir] ?? { loading: false }), eligibility, loading: false },
          },
        }));
      } catch {
        set((state) => ({
          reviewByCwd: {
            ...state.reviewByCwd,
            [dir]: { ...(state.reviewByCwd[dir] ?? {}), loading: false } as typeof state.reviewByCwd[string],
          },
        }));
      }
    },

    createReview: async (cwd, input) => {
      const dir = cwd;
      if (!requestCreateReview) throw new Error("review transport unavailable");
      const created = await requestCreateReview(dir, input);
      // After creation, refresh both eligibility and status for this cwd
      void get().refreshReviewEligibility(dir).catch(() => {});
      void get().refreshReviewStatus(dir).catch(() => {});
      return created;
    },

    refreshReviewStatus: async (cwd) => {
      const dir = cwd ?? get().getActiveCwd();
      if (!dir || !requestReviewStatus) return;
      set((state) => ({
        reviewByCwd: {
          ...state.reviewByCwd,
          [dir]: { ...(state.reviewByCwd[dir] ?? {}), loading: true } as typeof state.reviewByCwd[string],
        },
      }));
      try {
        const prStatus = await requestReviewStatus(dir);
        set((state) => {
          const next: Record<string, PrStatus> = { ...state.prStatusByWorktreeId };
          // Mirror into worktree-id cache for badge lookup
          const match = state.worktrees.find((w) => w.record.path === dir);
          if (match) next[match.record.id] = prStatus;
          return {
            reviewByCwd: {
              ...state.reviewByCwd,
              [dir]: { ...(state.reviewByCwd[dir] ?? { loading: false }), prStatus, loading: false },
            },
            prStatusByWorktreeId: next,
          };
        });
      } catch {
        set((state) => ({
          reviewByCwd: {
            ...state.reviewByCwd,
            [dir]: { ...(state.reviewByCwd[dir] ?? {}), loading: false } as typeof state.reviewByCwd[string],
          },
        }));
      }
    },

    sendToSession: async (sessionId, data) => {
      await ptyWrite(sessionId, data);
    },
  };
}
