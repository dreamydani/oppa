import { create } from "zustand";
import {
  ptySpawn,
  ptyKill,
  ptyResize,
  ptyAck,
  saveLayout as transportSaveLayout,
  loadLayout as transportLoadLayout,
} from "../lib/pty/transport";
import {
  split,
  remove,
  focus,
  firstLeafPath,
  substituteLeafId,
  remapLeafIds,
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
  // Message from the failed spawn; set only on error sessions so the pane can
  // render the real reason instead of a hardcoded string.
  error?: string;
  cols: number;
  rows: number;
}

// Monotonic counter for synthetic error-session ids. Avoids crypto.randomUUID
// (not available in insecure/non-secure contexts) and stays unique within the
// session without depending on a global UUID source.
let nextErrorId = 0;

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

// Leaf ids in depth-first (a before b) order — the deterministic spawn order
// a persisted-layout restore uses.
function leafIds(tree: Layout): string[] {
  if (tree.type === "leaf") return [tree.id];
  return [...leafIds(tree.a), ...leafIds(tree.b)];
}

interface TerminalState {
  sessions: Record<string, SessionInfo>;
  layout: Layout;
  focusedPath: Path;
  // True once the persisted layout has been loaded (or failed to load) on
  // startup; the UI stays hidden until then so a restore never races the
  // placeholder auto-spawn in SessionLeaf.
  ready: boolean;
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
  saveLayout: () => Promise<void>;
  loadLayout: () => Promise<void>;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  sessions: {},
  layout: { type: "leaf", id: "" },
  focusedPath: [],
  ready: false,

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
      // record a synthetic entry so the pane can render + retry. The id comes
      // from a monotonic local counter (not crypto.randomUUID) so it works in
      // non-secure contexts, and the real error message is stored on the
      // session so the pane can show why the spawn failed.
      const id = `error-${++nextErrorId}`;
      set((state) => ({
        sessions: {
          ...state.sessions,
          [id]: {
            id,
            title: id,
            status: "error",
            error: error instanceof Error ? error.message : String(error),
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
    const next = rebuild(tree, path);
    if (next === tree) return;
    set({ layout: next });
    void get().saveLayout().catch(() => {});
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
    // Persist immediately so a crash/close never loses the arrangement.
    void get().saveLayout().catch(() => {});
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
    } else {
      set({ sessions, layout: next, focusedPath: firstLeafPath(next) });
    }
    // Persist immediately so the arrangement is never stale on close.
    void get().saveLayout().catch(() => {});
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

  // Persist the current pane layout + session state (NOT scrollback) so the
  // next launch can restore the same arrangement of fresh shells. Serialized
  // sessions carry only the metadata needed to re-spawn: id, title, status,
  // cwd, cols, rows.
  saveLayout: async () => {
    // Guard: a beforeunload during the startup restore must not overwrite the
    // last good save with a near-empty snapshot. Once loadLayout has settled
    // (ready=true), every save reflects a fully restored layout.
    if (!get().ready) return;
    const { layout, sessions } = get();
    const snapshot = {
      layout,
      sessions: Object.values(sessions).map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        cwd: s.cwd,
        cols: s.cols,
        rows: s.rows,
      })),
    };
    await transportSaveLayout(JSON.stringify(snapshot));
  },

  // Restore a saved layout by re-spawning a FRESH shell for every saved leaf
  // (scrollback is deliberately not persisted — a restored session is a new
  // shell in the same pane layout + cwd) and rebuilding the tree with the new
  // ids. Saved ids from a previous run are stale, so every saved leaf is
  // spawned in depth-first order and its id remapped to the fresh session id;
  // a leaf whose spawn fails keeps an inline error session. The store is
  // marked ready in all outcomes so the UI can render even when restore fails.
  loadLayout: async () => {
    try {
      const saved = await transportLoadLayout();
      if (!saved) return;
      const parsed = JSON.parse(saved) as {
        layout: Layout;
        sessions: SessionInfo[];
      };
      const byId = new Map(parsed.sessions.map((s) => [s.id, s]));
      const remap: Record<string, string> = {};
      for (const oldId of leafIds(parsed.layout)) {
        if (oldId === "") continue; // empty fresh-start leaf: nothing to spawn
        remap[oldId] = await get().spawnSession(byId.get(oldId)?.cwd);
      }
      set({ layout: remapLeafIds(parsed.layout, remap) });
    } finally {
      set({ ready: true });
    }
  },
}));
