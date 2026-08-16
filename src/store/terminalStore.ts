import { create } from "zustand";
import {
  ptySpawn,
  ptyKill,
  ptyResize,
  ptyAck,
} from "../lib/pty/transport";

// Shape matches Task 7's `layout.ts` exactly (with `ratio`) so the pane
// engine can consume it without a breaking change.
export type Layout =
  | { type: "leaf"; id: string }
  | { type: "split"; dir: "h" | "v"; ratio: number; a: Layout; b: Layout };

export type SessionStatus = "running" | "exited" | "error";

export interface SessionInfo {
  id: string;
  title: string;
  status: SessionStatus;
  cwd?: string;
  cols: number;
  rows: number;
}

export const DEFAULT_COLS = 80;
export const DEFAULT_ROWS = 24;

interface TerminalState {
  sessions: Record<string, SessionInfo>;
  layout: Layout;
  spawnSession: (cwd?: string) => Promise<string>;
  killSession: (id: string) => Promise<void>;
  resizeSession: (id: string, cols: number, rows: number) => void;
  ackSession: (id: string, chars: number) => Promise<void>;
  setSessionStatus: (id: string, status: SessionStatus) => void;
  setLayout: (layout: Layout) => void;
}

export const useTerminalStore = create<TerminalState>((set) => ({
  sessions: {},
  layout: { type: "leaf", id: "" },

  spawnSession: async (cwd) => {
    try {
      const id = await ptySpawn(cwd ? { cwd } : undefined);
      set((state) => ({
        sessions: {
          ...state.sessions,
          [id]: {
            id,
            title: id,
            status: "running",
            cwd,
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
          },
        },
      }));
      return id;
    } catch (error) {
      // Failed spawns surface as an inline pane error in TerminalPane;
      // record a synthetic entry so the pane can render + retry.
      const id = crypto.randomUUID();
      set((state) => ({
        sessions: {
          ...state.sessions,
          [id]: {
            id,
            title: id,
            status: "error",
            cwd,
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
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
    set((state) => {
      const session = state.sessions[id];
      if (!session) return state;
      return {
        sessions: {
          ...state.sessions,
          [id]: { ...session, status: "exited" },
        },
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

  ackSession: async (id, chars) => {
    await ptyAck(id, chars);
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

  setLayout: (layout) => set({ layout }),
}));
