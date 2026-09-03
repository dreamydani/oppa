// Live PTY session records: spawn/kill/resize/ack plus the scrollback
// serializer registry used by layout persistence and warm restore.

import {
  ptySpawn,
  ptyKill,
  ptyResize,
  ptyAck,
  ptyWrite,
} from "../../lib/pty/transport";
import type { PtySpawnOptions } from "../../lib/pty/transport";
import { substituteLeafId } from "../../lib/pane-manager/layout";
import { applyCachedScrollbackBudget } from "../../lib/terminal/scrollbackBudget";
import type { TerminalState } from "../terminalStore";
import { getSyncedTabs } from "./layoutQueries";
import { triggerDebouncedSaveLayout } from "./layoutSaveScheduler";

type Set = (
  partial:
    | Partial<TerminalState>
    | ((state: TerminalState) => Partial<TerminalState>),
) => void;

export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;

// Monotonic counter for synthetic error-session ids. Avoids
// crypto.randomUUID (not available in insecure/non-secure contexts) and stays
// unique within the session without depending on a global UUID source.
let nextErrorId = 0;

// Sessions whose terminal output changed since the last layout save.
// Module-level (not state) so marking costs a Set.add per data chunk with
// zero re-renders; saveLayout serializes only these buffers.
const dirtyScrollbackIds = new Set<string>();

export function markScrollbackDirty(id: string): void {
  if (id) dirtyScrollbackIds.add(id);
}

export function isScrollbackDirty(id: string): boolean {
  return dirtyScrollbackIds.has(id);
}

export function clearDirtyScrollback(id: string): void {
  dirtyScrollbackIds.delete(id);
}

export type SessionStatus =
  | "sleeping"
  | "spawning"
  | "loading"
  | "restoring"
  | "running"
  | "exited"
  | "error";

export interface SessionInfo {
  id: string;
  title: string;
  status: SessionStatus;
  cwd?: string;
  // Worktree the session was spawned for, when created through a worktree tab.
  worktreeId?: string;
  // Message from the failed spawn; set only on error sessions so the pane can
  // render the real reason instead of a hardcoded string.
  error?: string;
  cols: number;
  rows: number;
  isRestored?: boolean;
  // How the cold-restored session's work was brought back, when it was
  resumeKind?: "agent-resume" | "command-relaunch";
}

export type TerminalSession = SessionInfo;

export interface SessionSlice {
  sessions: Record<string, SessionInfo>;
  serializers: Record<string, () => string>;
  cachedScrollbacks: Record<string, string>;
  restoredScrollbacks: Record<string, string>;
  registerSerializer: (id: string, fn: () => string) => void;
  unregisterSerializer: (id: string) => void;
  cacheScrollback: (id: string, buffer: string) => void;
  setRestoredScrollback: (id: string, data: string) => void;
  clearRestoredScrollback: (id: string) => void;
  spawnSession: (
    cwd?: string,
    shell?: string,
    existingId?: string,
    geometry?: { cols?: number; rows?: number },
    worktreeId?: string,
  ) => Promise<string>;
  killSession: (id: string) => Promise<void>;
  resizeSession: (id: string, cols: number, rows: number) => void;
  ackSession: (id: string, bytes: number) => Promise<void>;
  setSessionStatus: (id: string, status: SessionStatus) => void;
  dismissSessionRestoredBanner: (sessionId: string) => void;
  updateSessionCwd: (id: string, cwd: string) => void;
  renameSession: (id: string, title: string) => void;
  substituteSessionId: (from: string, to: string) => void;
  sendPromptToSession: (sessionId: string, prompt: string) => Promise<void>;
  interruptSession: (sessionId: string) => Promise<void>;
}

export function createSessionsSlice(
  set: Set,
  get: () => TerminalState,
): SessionSlice {
  return {
    sessions: {},
    serializers: {},
    cachedScrollbacks: {},
    restoredScrollbacks: {},

    registerSerializer: (id, fn) =>
      set((state) => ({
        serializers: { ...state.serializers, [id]: fn },
      })),

    unregisterSerializer: (id) =>
      set((state) => {
        const serializers = { ...state.serializers };
        delete serializers[id];
        return { serializers };
      }),

    cacheScrollback: (id, buffer) => {
      markScrollbackDirty(id);
      set((state) => ({
        cachedScrollbacks: {
          ...state.cachedScrollbacks,
          [id]: applyCachedScrollbackBudget(buffer),
        },
      }));
    },

    setRestoredScrollback: (id, data) =>
      set((state) => ({
        restoredScrollbacks: { ...state.restoredScrollbacks, [id]: data },
      })),

    clearRestoredScrollback: (id) =>
      set((state) => {
        const restoredScrollbacks = { ...state.restoredScrollbacks };
        delete restoredScrollbacks[id];
        return { restoredScrollbacks };
      }),

    spawnSession: async (cwd, shell, existingId, geometry, worktreeId) => {
      try {
        const targetCwd = cwd ?? (existingId ? undefined : get().resolveDefaultCwd());
        const opts: PtySpawnOptions = {};
        if (existingId) opts.id = existingId;
        if (targetCwd) opts.cwd = targetCwd;
        if (shell) opts.shell = shell;
        if (geometry?.cols !== undefined) opts.cols = geometry.cols;
        if (geometry?.rows !== undefined) opts.rows = geometry.rows;
        if (worktreeId) opts.worktreeId = worktreeId;
        // Rust defaults to resume-on; only ever send the explicit opt-out
        const autoResume = get().settings.general.autoResumeAgents;
        if (autoResume === false) opts.resumeAgents = false;
        const res = await ptySpawn(Object.keys(opts).length > 0 ? opts : undefined);
        const id = typeof res === "string" ? res : res.id;
        const isNew = typeof res === "string" ? true : res.is_new;
        const isWarm = typeof res === "string" ? !isNew : (res.is_warm ?? !isNew);
        const snapshot = typeof res === "string" ? null : res.snapshot;
        const coldScrollback = typeof res === "string" ? null : res.cold_scrollback;
        const resumeKind = typeof res === "string" ? undefined : res.resume?.kind;
        const cols = (typeof res !== "string" && res.cols) || geometry?.cols || DEFAULT_COLS;
        const rows = (typeof res !== "string" && res.rows) || geometry?.rows || DEFAULT_ROWS;
        const resolvedCwd = (typeof res !== "string" && res.cwd) || targetCwd;
        // Attach result carries the daemon's current working/idle so dots are
        // correct immediately on warm reattach.
        const working = typeof res !== "string" ? (res.working ?? false) : false;
        // Last hook-classified rich status rides the attach result so pills show
        // truth instantly (e.g. a finished or blocked agent on cold reattach).
        const agentStatus =
          typeof res !== "string" ? (res.agent_status ?? undefined) : undefined;

        const isColdRestored = (!isWarm || isNew) && Boolean(coldScrollback);

        if (!isNew && snapshot) {
          set((state) => ({
            restoredScrollbacks: {
              ...state.restoredScrollbacks,
              [id]: snapshot,
            },
          }));
        } else if (isColdRestored && coldScrollback) {
          set((state) => ({
            restoredScrollbacks: {
              ...state.restoredScrollbacks,
              [id]: coldScrollback,
            },
          }));
        }

        set((state) => {
          const existingSession = state.sessions[id];
          return {
            sessions: {
              ...state.sessions,
              [id]: {
                id,
                title: existingSession?.title || id,
                status: "running",
                cwd: resolvedCwd || existingSession?.cwd,
                cols,
                rows,
                ...(isColdRestored || existingSession?.isRestored ? { isRestored: true } : {}),
                ...(resumeKind ? { resumeKind } : {}),
                ...(worktreeId || existingSession?.worktreeId
                  ? { worktreeId: worktreeId ?? existingSession?.worktreeId }
                  : {}),
              },
            },
            workingBySessionId: { ...state.workingBySessionId, [id]: working },
            ...(agentStatus
              ? { statusBySessionId: { ...state.statusBySessionId, [id]: agentStatus } }
              : {}),
          };
        });
        return id;
      } catch (error) {
        // Failed spawns surface as an inline pane error in TerminalPane;
        // record a synthetic entry so the pane can render + retry.
        const id = `error-${++nextErrorId}`;
        set((state) => ({
          sessions: {
            ...state.sessions,
            [id]: {
              id,
              title: id,
              status: "error",
              error: error instanceof Error ? error.message : String(error),
              cwd: cwd ?? (existingId ? undefined : get().resolveDefaultCwd()),
              cols: geometry?.cols ?? DEFAULT_COLS,
              rows: geometry?.rows ?? DEFAULT_ROWS,
            },
          },
        }));
        return id;
      }
    },

    killSession: async (id) => {
      try {
        await ptyKill(id);
      } catch {
        // Session may already be dead (exit raced the kill) — mark it anyway.
      }
      clearDirtyScrollback(id);
      set((state) => {
        const session = state.sessions[id];
        if (!session) return state;
        // A killed session's cached scrollback must not stay resident — the
        // closeTab/closePane paths prune it, but a bare kill left it behind.
        const cachedScrollbacks = { ...state.cachedScrollbacks };
        delete cachedScrollbacks[id];
        return {
          sessions: {
            ...state.sessions,
            [id]: { ...session, status: "exited" },
          },
          cachedScrollbacks,
        };
      });
    },

    resizeSession: (id, cols, rows) => {
      set((state) => {
        const session = state.sessions[id];
        if (!session) return state;
        return {
          sessions: {
            ...state.sessions,
            [id]: { ...session, cols, rows },
          },
        };
      });
      // Best-effort resize: a stale resize on a dead session must not reject.
      ptyResize(id, cols, rows).catch(() => {});
    },

    ackSession: async (id, bytes) => {
      await ptyAck(id, bytes);
    },

    setSessionStatus: (id, status) => {
      set((state) => {
        const session = state.sessions[id];
        if (!session) return state;
        return {
          sessions: {
            ...state.sessions,
            [id]: { ...session, status },
          },
        };
      });
    },

    dismissSessionRestoredBanner: (sessionId) => {
      set((state) => {
        const session = state.sessions[sessionId];
        if (!session) return state;
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: { ...session, isRestored: false },
          },
        };
      });
    },

    updateSessionCwd: (id, cwd) => {
      let updated = false;
      set((state) => {
        const session = state.sessions[id];
        if (!session) return state;
        if (session.cwd === cwd) return state;
        updated = true;
        return {
          sessions: {
            ...state.sessions,
            [id]: { ...session, cwd },
          },
        };
      });
      if (updated) {
        triggerDebouncedSaveLayout(get);
      }
    },

    renameSession: (id, title) => {
      let updated = false;
      set((state) => {
        const session = state.sessions[id];
        if (!session) return state;
        if (session.title === title) return state;
        updated = true;
        return {
          sessions: {
            ...state.sessions,
            [id]: { ...session, title },
          },
        };
      });
      if (updated) {
        triggerDebouncedSaveLayout(get);
      }
    },

    // Replace every occurrence of leaf id `from` with `to` in the layout trees across all tabs.
    substituteSessionId: (from, to) => {
      set((state) => {
        let changed = false;
        const syncedTabs = getSyncedTabs(state);
        const tabs = syncedTabs.map((tab) => {
          const nextLayout = substituteLeafId(tab.layout, from, to);
          if (nextLayout !== tab.layout) {
            changed = true;
            return { ...tab, layout: nextLayout };
          }
          return tab;
        });
        const topLayout = substituteLeafId(state.layout, from, to);
        if (!changed && topLayout === state.layout) return state;
        const activeTab = tabs.find((t) => t.id === state.activeTabId) || tabs[0];
        return {
          tabs,
          layout: activeTab ? activeTab.layout : topLayout,
        };
      });
    },

    // Send-target prompting (Orca parity): paste-style delivery reuses the
    // initial-command write path — text first, then a submit keystroke.
    sendPromptToSession: async (sessionId, prompt) => {
      const session = get().sessions[sessionId];
      if (!session || session.status === "exited" || session.status === "error") {
        throw new Error(`session ${sessionId} is not live; targeting refused`);
      }
      await ptyWrite(sessionId, prompt);
      await ptyWrite(sessionId, "\r");
    },

    // Single Ctrl+C, exactly what a user would type into the pane.
    interruptSession: async (sessionId) => {
      const session = get().sessions[sessionId];
      if (!session || session.status === "exited" || session.status === "error") {
        throw new Error(`session ${sessionId} is not live; interrupt refused`);
      }
      await ptyWrite(sessionId, "\x03");
    },
  };
}
