import { create } from "zustand";
import {
  ptySpawn,
  ptyKill,
  ptyResize,
  ptyAck,
} from "../lib/pty/transport";
import {
  split,
  remove,
  focus,
  firstLeafPath,
  substituteLeafId,
} from "../lib/pane-manager/layout";
import type { Layout, Path } from "../lib/pane-manager/layout";

// Re-exported so existing import sites keep working after the layout types
// moved into `src/lib/pane-manager/layout.ts`.
export type { Layout, Path } from "../lib/pane-manager/layout";

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

// The split node reached by walking `prefix` down from the root.
function nodeAt(tree: Layout, prefix: Path): Layout {
  let node = tree;
  for (const step of prefix) {
    if (node.type === "leaf") return node;
    node = step === 0 ? node.a : node.b;
  }
  return node;
}

interface TerminalState {
  sessions: Record<string, SessionInfo>;
  layout: Layout;
  focusedPath: Path;
  spawnSession: (cwd?: string) => Promise<string>;
  killSession: (id: string) => Promise<void>;
  resizeSession: (id: string, cols: number, rows: number) => void;
  ackSession: (id: string, chars: number) => Promise<void>;
  setSessionStatus: (id: string, status: SessionStatus) => void;
  substituteSessionId: (from: string, to: string) => void;
  setLayout: (layout: Layout) => void;
  setRatio: (path: Path, ratio: number) => void;
  splitPane: (dir: "h" | "v", path?: Path) => Promise<void>;
  closePane: (path?: Path) => Promise<void>;
  focusPane: (path: Path) => void;
  moveFocus: (dir: "left" | "right" | "up" | "down") => void;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  sessions: {},
  layout: { type: "leaf", id: "" },
  focusedPath: [],

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

  // Replace every occurrence of leaf id `from` with `to` in the layout tree.
  // SessionLeaf uses this to bind a resolved spawn id to its placeholder
  // after the layout may have changed (split/close) while the spawn was in
  // flight. A no-op when `from` no longer occurs.
  substituteSessionId: (from, to) => {
    set((state) => {
      const layout = substituteLeafId(state.layout, from, to);
      return layout === state.layout ? state : { layout };
    });
  },

  setLayout: (layout) => set({ layout }),

  // The drag divider in PaneSplit: set the ratio of the split at `path`.
  // The tree is immutable, so walk down rebuilding the spine; a path into a
  // leaf (or past the end of the tree) leaves the tree untouched.
  setRatio: (path, ratio) => {
    const tree = get().layout;
    const clamped = Math.min(1, Math.max(0, ratio));
    const rebuild = (node: Layout, steps: Path): Layout => {
      if (node.type === "leaf") return node;
      if (steps.length === 0) {
        // This split is the target: update its ratio and stop descending.
        return node.ratio === clamped ? node : { ...node, ratio: clamped };
      }
      const [head, ...rest] = steps;
      if (head !== 0 && head !== 1) return node;
      const child = head === 0 ? node.a : node.b;
      const nextChild = rebuild(child, rest);
      if (nextChild === child) return node;
      return {
        type: "split",
        dir: node.dir,
        ratio: node.ratio,
        a: head === 0 ? nextChild : node.a,
        b: head === 1 ? nextChild : node.b,
      };
    };
    set({ layout: rebuild(tree, path) });
  },

  // Split the pane at `path` (defaults to the focused pane): spawn a new
  // session for the fresh leaf, rebuild the tree, and focus the new leaf.
  splitPane: async (dir, path) => {
    const target = path ?? get().focusedPath;
    const id = await get().spawnSession();
    set({
      layout: split(dir, get().layout, target, id),
      focusedPath: [...target, 1],
    });
  },

  // Close the pane at `path` (defaults to the focused pane): kill its session
  // if it has one, prune the leaf from the tree (collapsing empty splits), and
  // focus the leftmost remaining leaf. Closing the last pane resets to a fresh
  // empty leaf.
  closePane: async (path) => {
    const target = path ?? get().focusedPath;
    const tree = get().layout;
    const removedId = focus(tree, target);
    const next = remove(tree, target);
    if (get().sessions[removedId]) {
      await get().killSession(removedId);
    }
    // The removed leaf id is gone from the tree: drop its session too so
    // killed sessions do not accumulate in the store forever.
    const sessions = { ...get().sessions };
    delete sessions[removedId];
    if (next === null) {
      set({ sessions, layout: { type: "leaf", id: "" }, focusedPath: [] });
      return;
    }
    set({ sessions, layout: next, focusedPath: firstLeafPath(next) });
  },

  focusPane: (path) => set({ focusedPath: path }),

  // Move focus to a sibling pane. Interpretation: left/right travel through
  // horizontal ("h") splits, up/down through vertical ("v") splits. Walk the
  // focused path from the deepest ancestor up and use the NEAREST split whose
  // dir matches the movement axis; if the focused leaf is already on the
  // destination side of that split (e.g. pressing right while on the right
  // side), try the next ancestor up. No matching ancestor → no-op. The target
  // lands on the first leaf of the destination child, so the focused path
  // always points at a leaf. This is intentionally simple; it does not handle
  // non-rectangular neighborhoods, which is out of scope for v1.
  moveFocus: (dir) => {
    const tree = get().layout;
    const path = get().focusedPath;
    if (path.length === 0) return; // single root leaf: no sibling
    const target = dir === "left" || dir === "up" ? 0 : 1;
    const axis = dir === "left" || dir === "right" ? "h" : "v";
    for (let i = path.length - 1; i >= 0; i--) {
      const ancestor = nodeAt(tree, path.slice(0, i));
      if (ancestor.type !== "split" || ancestor.dir !== axis) continue;
      if (path[i] === target) continue; // already on the destination side
      const destChild = path[i] === 0 ? ancestor.b : ancestor.a;
      set({
        focusedPath: [...path.slice(0, i), path[i] === 0 ? 1 : 0, ...firstLeafPath(destChild)],
      });
      return;
    }
  },
}));
