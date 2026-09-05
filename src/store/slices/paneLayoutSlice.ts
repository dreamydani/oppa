// Tabs and the binary layout tree: create/close/select, split/move/swap,
// focus movement, maximize, wake-from-sleep, and the layout.json
// save/restore pipeline.

import {
  split,
  remove,
  focus,
  firstLeafPath,
  findLeafPath,
  remapLeafIds,
  swapLeaves,
  moveLeaf,
} from "../../lib/pane-manager/layout";
import type { Layout, Path, DropZone } from "../../lib/pane-manager/layout";
import {
  saveLayout as transportSaveLayout,
  loadLayout as transportLoadLayout,
  saveScrollback,
  loadScrollback,
  deleteScrollback,
  cleanupStaleScrollbacks,
} from "../../lib/layout/transport";
import { ptyWrite } from "../../lib/pty/transport";
import { getSavedWindowState, applyWindowState } from "../../lib/window/transport";
import type { WindowState } from "../../lib/window/transport";
import type { EditorTab, EditorViewMode } from "./codeEditorSlice";
import type { AppMode, DevicePreset } from "./browserPaneSlice";
import type { TerminalState } from "../terminalStore";
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  clearDirtyScrollback,
  isScrollbackDirty,
} from "./terminalSessionsSlice";
import {
  findAdjacentPath,
  generateNextTabId,
  getActiveTab,
  getSyncedTabs,
  leafIds,
} from "./layoutQueries";
import { triggerDebouncedSaveLayout } from "./layoutSaveScheduler";
import { buildMultiBranchGridLayout, createGridLayout } from "../../lib/pane-manager/gridLayout";
import { extractRepoName } from "./worktreeRegistrySlice";

type Set = (
  partial:
    | Partial<TerminalState>
    | ((state: TerminalState) => Partial<TerminalState>),
) => void;

export interface TabState {
  id: string;
  title?: string;
  // Sticky folder/repo binding: set at creation, never re-derived from live
  // cwd (a cd must not hop workspaces). Empty for wizard/legacy tabs.
  workspaceKey?: string;
  layout: Layout;
  focusedPath: Path;
  isWizard?: boolean;
  isSleeping?: boolean;
}

// One in-flight wake per tab so rapid re-selection cannot double-spawn.
const pendingWakeTabs = new Map<string, Promise<void>>();

// Shell settle time before feeding a fresh pane its agent launch command;
// without it the line can land before the shell reads stdin and is lost.
const AGENT_LAUNCH_DELAY_MS = 350;

export interface PaneLayoutSlice {
  tabs: TabState[];
  activeTabId: string;
  layout: Layout;
  focusedPath: Path;
  // True once the persisted layout has been loaded (or failed to load) on
  // startup; the UI stays hidden until then so a restore never races the
  // placeholder auto-spawn in SessionLeaf.
  ready: boolean;
  maximizedSessionId: string | null;
  tabFocusHistory: string[];
  createTab: (cwd?: string, worktreeId?: string, existingId?: string) => Promise<string>;
  closeTab: (tabId?: string) => Promise<void>;
  selectTab: (tabId: string) => void;
  wakeTab: (tabId: string) => Promise<void>;
  renameTab: (tabId: string, title: string) => void;
  setLayout: (layout: Layout) => void;
  setRatio: (path: Path, ratio: number) => void;
  setSplitRatio?: (path: Path, ratio: number) => void;
  splitPane: (dir: "h" | "v", path?: Path) => Promise<void>;
  // Split like splitPane, then title the new pane and launch a command in
  // it (coding-agent picker). The write is delayed: a fresh shell needs a
  // beat before it reads stdin or the launch line is lost.
  splitPaneWithCommand: (
    dir: "h" | "v",
    path: Path | undefined,
    command: string,
    title?: string,
  ) => Promise<void>;
  closePane: (path?: Path) => Promise<void>;
  toggleMaximizePane: (id?: string) => void;
  focusPane: (path: Path) => void;
  moveFocus: (dir: "left" | "right" | "up" | "down") => void;
  swapPanes: (sourceId: string, targetId: string) => void;
  movePane: (sourceId: string, targetId: string, zone: DropZone) => void;
  swapFocusedPane: (dir: "left" | "right" | "up" | "down") => void;
  tileProjectBranches: (repoId: string, worktreeIds?: string[]) => Promise<string>;
  focusBranchPane: (worktreeId: string) => Promise<void>;
  mergeSessionsIntoWorkspace: (
    tabId: string,
    sessionIds: string[],
    opts?: {
      workspaceKey?: string;
      title?: string;
      clearWizard?: boolean;
      worktreeIdsBySession?: Record<string, string>;
    },
  ) => Promise<void>;
  saveLayout: () => Promise<void>;
  loadLayout: () => Promise<void>;
}

export function createPaneLayoutSlice(
  set: Set,
  get: () => TerminalState,
): PaneLayoutSlice {
  return {
    tabs: [],
    activeTabId: "",
    layout: { type: "leaf", id: "" },
    focusedPath: [],
    ready: false,
    maximizedSessionId: null,
    tabFocusHistory: [],

    createTab: async (cwd, worktreeId, existingId) => {
      const resolvedCwd = cwd ?? get().resolveDefaultCwd();
      const sessionId = await get().spawnSession(resolvedCwd, undefined, existingId, undefined, worktreeId);
      // The new tab takes focus immediately: any pending attention flag is seen.
      get().markAgentStatusSeen(sessionId);
      const currentTabs = getSyncedTabs(get());
      const tabId = generateNextTabId(currentTabs);
      const newTab: TabState = {
        id: tabId,
        ...(resolvedCwd ? { workspaceKey: resolvedCwd } : {}),
        layout: { type: "leaf", id: sessionId },
        focusedPath: [],
      };
      set((state) => {
        const current = getSyncedTabs(state);
        const tabs = [...current, newTab];
        return {
          tabs,
          activeTabId: tabId,
          layout: newTab.layout,
          focusedPath: newTab.focusedPath,
          tabFocusHistory: [tabId, ...state.tabFocusHistory.filter((id) => id !== tabId)],
        };
      });
      triggerDebouncedSaveLayout(get);
      return tabId;
    },

    closeTab: async (tabId) => {
      const state = get();
      const targetId = tabId ?? state.activeTabId;
      const currentTabs = getSyncedTabs(state);
      const targetTab = currentTabs.find((t) => t.id === targetId);
      if (!targetTab) return;

      let sessions = get().sessions;
      let cachedScrollbacks = get().cachedScrollbacks;

      if (!targetTab.isWizard) {
        const sessionIds = leafIds(targetTab.layout);
        for (const sId of sessionIds) {
          if (sId) {
            const session = get().sessions[sId];
            if (session && session.status !== "sleeping") {
              await get().killSession(sId);
            }
            void deleteScrollback(sId).catch(() => {});
            clearDirtyScrollback(sId);
          }
        }

        sessions = { ...get().sessions };
        cachedScrollbacks = { ...get().cachedScrollbacks };
        for (const sId of sessionIds) {
          if (sId) {
            delete sessions[sId];
            delete cachedScrollbacks[sId];
          }
        }
      }

      const remainingTabs = currentTabs.filter((t) => t.id !== targetId);
      const nextTabFocusHistory = state.tabFocusHistory.filter((id) => id !== targetId);

      if (remainingTabs.length === 0) {
        set({
          sessions,
          cachedScrollbacks,
          tabs: [],
          activeTabId: "",
          layout: { type: "leaf", id: "" },
          focusedPath: [],
          tabFocusHistory: nextTabFocusHistory,
        });
      } else {
        if (targetId === state.activeTabId) {
          const targetIdx = currentTabs.findIndex((t) => t.id === targetId);
          const nextIdx = Math.min(Math.max(0, targetIdx), remainingTabs.length - 1);
          const nextActiveTab = remainingTabs[nextIdx];
          set({
            sessions,
            cachedScrollbacks,
            tabs: remainingTabs,
            activeTabId: nextActiveTab.id,
            layout: nextActiveTab.layout,
            focusedPath: nextActiveTab.focusedPath,
            tabFocusHistory: [
              nextActiveTab.id,
              ...nextTabFocusHistory.filter((id) => id !== nextActiveTab.id),
            ],
          });
        } else {
          const activeTab = remainingTabs.find((t) => t.id === state.activeTabId) || remainingTabs[0];
          set({
            sessions,
            cachedScrollbacks,
            tabs: remainingTabs,
            layout: activeTab ? activeTab.layout : { type: "leaf", id: "" },
            focusedPath: activeTab ? activeTab.focusedPath : [],
            tabFocusHistory: nextTabFocusHistory,
          });
        }
      }
      triggerDebouncedSaveLayout(get);
    },

    selectTab: (tabId) => {
      const state = get();
      const currentTabs = getSyncedTabs(state);
      const tab = currentTabs.find((t) => t.id === tabId);
      if (!tab) return;

      const wasSleeping = Boolean(tab.isSleeping);
      const updatedTabs = wasSleeping
        ? currentTabs.map((t) => (t.id === tabId ? { ...t, isSleeping: false } : t))
        : currentTabs;

      set({
        tabs: updatedTabs,
        activeTabId: tab.id,
        layout: tab.layout,
        focusedPath: tab.focusedPath,
        tabFocusHistory: [tab.id, ...state.tabFocusHistory.filter((id) => id !== tab.id)],
      });

      if (wasSleeping) {
        void get().wakeTab(tabId);
      }
      triggerDebouncedSaveLayout(get);
    },

    wakeTab: async (tabId: string) => {
      const existing = pendingWakeTabs.get(tabId);
      if (existing) return existing;

      const wakePromise = (async () => {
        const state = get();
        const tab = state.tabs.find((t) => t.id === tabId);
        if (!tab || tab.isWizard) return;

        const ids = leafIds(tab.layout).filter(Boolean);
        const sleepingIds = ids.filter((id) => state.sessions[id]?.status === "sleeping");
        if (sleepingIds.length === 0) return;

        // Transition sleeping sessions to restoring state immediately for UI feedback
        set((s) => {
          const updated = { ...s.sessions };
          for (const id of sleepingIds) {
            if (updated[id]) {
              updated[id] = { ...updated[id], status: "restoring" };
            }
          }
          return { sessions: updated };
        });

        const remap: Record<string, string> = {};

        await Promise.all(
          sleepingIds.map(async (oldId) => {
            const savedSession = get().sessions[oldId];
            const geometry =
              savedSession && (savedSession.cols !== undefined || savedSession.rows !== undefined)
                ? { cols: savedSession.cols, rows: savedSession.rows }
                : undefined;
            const newId = await get().spawnSession(savedSession?.cwd, undefined, oldId, geometry, savedSession?.worktreeId);
            remap[oldId] = newId;

            if (oldId !== newId) {
              set((s) => {
                const sessions = { ...s.sessions };
                delete sessions[oldId];
                return { sessions };
              });
            }

            if (savedSession?.title && savedSession.title !== newId) {
              get().renameSession(newId, savedSession.title);
            }

            const prev = await loadScrollback(oldId);
            if (prev) {
              if (!get().restoredScrollbacks[newId]) {
                get().setRestoredScrollback(newId, prev);
                set((s) => {
                  const sess = s.sessions[newId];
                  if (!sess) return s;
                  return {
                    sessions: {
                      ...s.sessions,
                      [newId]: { ...sess, isRestored: true },
                    },
                  };
                });
              }
              await saveScrollback(newId, prev);
              if (oldId !== newId) {
                await deleteScrollback(oldId);
              }
            }
          }),
        );

        // Remap layout leaf IDs if any session IDs changed upon spawn
        set((s) => {
          const currentTabs = getSyncedTabs(s);
          const remappedTabs = currentTabs.map((t) => {
            if (t.id !== tabId) return t;
            const remappedLayout = remapLeafIds(t.layout, remap);
            return {
              ...t,
              isSleeping: false,
              layout: remappedLayout,
            };
          });
          const updatedActiveTab = remappedTabs.find((t) => t.id === s.activeTabId);
          return {
            tabs: remappedTabs,
            ...(updatedActiveTab ? { layout: updatedActiveTab.layout } : {}),
          };
        });

        triggerDebouncedSaveLayout(get);
      })();

      pendingWakeTabs.set(tabId, wakePromise);
      try {
        await wakePromise;
      } finally {
        pendingWakeTabs.delete(tabId);
      }
    },

    renameTab: (tabId, title) => {
      set((state) => {
        const currentTabs = getSyncedTabs(state);
        const tabs = currentTabs.map((t) => (t.id === tabId ? { ...t, title } : t));
        return { tabs };
      });
      triggerDebouncedSaveLayout(get);
    },

    setLayout: (layout) =>
      set((state) => {
        const activeId = state.activeTabId || "tab-1";
        const tabs = getSyncedTabs(state).map((t) => (t.id === activeId ? { ...t, layout } : t));
        return { tabs, layout };
      }),

    // The drag divider in PaneSplit: set the ratio of the split at `path`.
    setRatio: (path, ratio) => {
      const state = get();
      const activeTab = getActiveTab(state);
      const tree = activeTab ? activeTab.layout : state.layout;
      const clamped = Math.min(1, Math.max(0, ratio));
      const rebuild = (node: Layout, steps: Path): Layout => {
        if (node.type === "leaf") return node;
        if (steps.length === 0) {
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
      if (activeTab) {
        const activeId = state.activeTabId || activeTab.id;
        const tabs = getSyncedTabs(state).map((t) =>
          t.id === activeId ? { ...t, layout: next } : t,
        );
        set({ tabs, layout: next });
      } else {
        set({ layout: next });
      }
      // NOTE: no saveLayout() here — SplitDivider calls it once on drag end
    },

    setSplitRatio: (path, ratio) => {
      get().setRatio(path, ratio);
    },

    // Split the pane at `path` in the active tab (defaults to active tab focused pane).
    splitPane: async (dir, path) => {
      const state = get();
      const activeTab = getActiveTab(state);
      const tree = activeTab ? activeTab.layout : state.layout;
      const target = path ?? (activeTab ? activeTab.focusedPath : state.focusedPath);
      const focusedId = focus(tree, target);
      const focusedSession = get().sessions[focusedId];
      const currentCwd = focusedSession?.cwd;
      const id = await get().spawnSession(currentCwd);
      const nextLayout = split(dir, tree, target, id);
      const nextFocusedPath = [...target, 1];
      if (activeTab) {
        const activeId = state.activeTabId || activeTab.id;
        const tabs = getSyncedTabs(state).map((t) =>
          t.id === activeId ? { ...t, layout: nextLayout, focusedPath: nextFocusedPath } : t,
        );
        set({
          tabs,
          layout: nextLayout,
          focusedPath: nextFocusedPath,
        });
      } else {
        set({
          layout: nextLayout,
          focusedPath: nextFocusedPath,
        });
      }
      triggerDebouncedSaveLayout(get);
    },

    // Agent-launch split: same cwd inheritance + focus contract as splitPane,
    // then title the pane and feed the shell its start command on a timer.
    // Fire-and-forget write: a dead session must not reject the split.
    splitPaneWithCommand: async (dir, path, command, title) => {
      const state = get();
      const activeTab = getActiveTab(state);
      const tree = activeTab ? activeTab.layout : state.layout;
      const target = path ?? (activeTab ? activeTab.focusedPath : state.focusedPath);
      const focusedId = focus(tree, target);
      const focusedSession = get().sessions[focusedId];
      const currentCwd = focusedSession?.cwd;
      const id = await get().spawnSession(currentCwd);
      const nextLayout = split(dir, tree, target, id);
      const nextFocusedPath = [...target, 1];
      if (activeTab) {
        const activeId = state.activeTabId || activeTab.id;
        const tabs = getSyncedTabs(state).map((t) =>
          t.id === activeId ? { ...t, layout: nextLayout, focusedPath: nextFocusedPath } : t,
        );
        set({
          tabs,
          layout: nextLayout,
          focusedPath: nextFocusedPath,
        });
      } else {
        set({
          layout: nextLayout,
          focusedPath: nextFocusedPath,
        });
      }
      if (title) get().renameSession(id, title);
      const launchLine = command.trim();
      if (launchLine) {
        window.setTimeout(() => {
          void ptyWrite(id, `${launchLine}\n`).catch(() => {});
        }, AGENT_LAUNCH_DELAY_MS);
      }
      triggerDebouncedSaveLayout(get);
    },

    // Close the pane at `path` in the active tab (defaults to active tab focused pane).
    closePane: async (path) => {
      const state = get();
      const activeTab = getActiveTab(state);
      const tree = activeTab ? activeTab.layout : state.layout;
      const target = path ?? (activeTab ? activeTab.focusedPath : state.focusedPath);
      const removedId = focus(tree, target);
      const next = remove(tree, target);
      if (next === null) {
        if (activeTab) {
          await get().closeTab(activeTab.id);
        } else {
          set({
            layout: { type: "leaf", id: "" },
            focusedPath: [],
          });
        }
        return;
      }
      const session = get().sessions[removedId];
      if (session && session.status !== "sleeping") {
        await get().killSession(removedId);
      }
      if (removedId) {
        void deleteScrollback(removedId).catch(() => {});
        clearDirtyScrollback(removedId);
      }
      const sessions = { ...get().sessions };
      delete sessions[removedId];
      const cachedScrollbacks = { ...get().cachedScrollbacks };
      delete cachedScrollbacks[removedId];
      const nextLayout: Layout = next;
      const nextFocusedPath: Path = firstLeafPath(next);
      if (activeTab) {
        const activeId = state.activeTabId || activeTab.id;
        const tabs = getSyncedTabs(state).map((t) =>
          t.id === activeId ? { ...t, layout: nextLayout, focusedPath: nextFocusedPath } : t,
        );
        set({
          sessions,
          cachedScrollbacks,
          tabs,
          layout: nextLayout,
          focusedPath: nextFocusedPath,
        });
      } else {
        set({
          sessions,
          cachedScrollbacks,
          layout: nextLayout,
          focusedPath: nextFocusedPath,
        });
      }
      triggerDebouncedSaveLayout(get);
    },

    toggleMaximizePane: (id) => {
      const current = get().maximizedSessionId;
      if (id !== undefined) {
        set({ maximizedSessionId: current === id ? null : id });
        triggerDebouncedSaveLayout(get);
        return;
      }
      if (current !== null) {
        set({ maximizedSessionId: null });
        triggerDebouncedSaveLayout(get);
        return;
      }
      const state = get();
      const activeTab = getActiveTab(state);
      if (!activeTab) return;
      const focusedId = focus(activeTab.layout, activeTab.focusedPath);
      if (focusedId) {
        set({ maximizedSessionId: focusedId });
        triggerDebouncedSaveLayout(get);
      }
    },

    focusPane: (path) =>
      set((state) => {
        const activeId = state.activeTabId || "tab-1";
        const tabs = getSyncedTabs(state).map((t) =>
          t.id === activeId ? { ...t, focusedPath: path } : t,
        );
        return { tabs, focusedPath: path };
      }),

    // Move focus to a sibling pane in the active tab.
    moveFocus: (dir) => {
      const state = get();
      const activeTab = getActiveTab(state);
      if (!activeTab) return;
      const tree = activeTab.layout;
      const path = activeTab.focusedPath;
      const newFocusedPath = findAdjacentPath(tree, path, dir);
      if (!newFocusedPath) return;

      const activeId = state.activeTabId || activeTab.id;
      const tabs = getSyncedTabs(state).map((t) =>
        t.id === activeId ? { ...t, focusedPath: newFocusedPath } : t,
      );
      set({
        tabs,
        focusedPath: newFocusedPath,
      });
    },

    // Swap positions of two panes and update focused path to track the focused session.
    swapPanes: (sourceId, targetId) => {
      if (!sourceId || !targetId || sourceId === targetId) return;
      const state = get();
      const activeTab = getActiveTab(state);
      const tree = activeTab ? activeTab.layout : state.layout;
      const nextLayout = swapLeaves(tree, sourceId, targetId);
      if (nextLayout === tree) return;

      const currentFocusedPath = activeTab ? activeTab.focusedPath : state.focusedPath;
      let focusedSessionId: string | null = null;
      try {
        focusedSessionId = focus(tree, currentFocusedPath);
      } catch {
        focusedSessionId = null;
      }

      let nextFocusedPath = currentFocusedPath;
      if (focusedSessionId) {
        const found = findLeafPath(nextLayout, focusedSessionId);
        if (found !== null) {
          nextFocusedPath = found;
        }
      }

      if (activeTab) {
        const activeId = state.activeTabId || activeTab.id;
        const tabs = getSyncedTabs(state).map((t) =>
          t.id === activeId
            ? { ...t, layout: nextLayout, focusedPath: nextFocusedPath }
            : t,
        );
        set({
          tabs,
          layout: nextLayout,
          focusedPath: nextFocusedPath,
        });
      } else {
        set({
          layout: nextLayout,
          focusedPath: nextFocusedPath,
        });
      }
      triggerDebouncedSaveLayout(get);
    },

    // Move source pane relative to target pane and focus the source pane.
    movePane: (sourceId, targetId, zone) => {
      if (!sourceId || !targetId || sourceId === targetId) return;
      const state = get();
      const activeTab = getActiveTab(state);
      const tree = activeTab ? activeTab.layout : state.layout;
      const nextLayout = moveLeaf(tree, sourceId, targetId, zone);
      if (nextLayout === tree) return;

      const nextFocusedPath =
        findLeafPath(nextLayout, sourceId) ?? firstLeafPath(nextLayout);

      if (activeTab) {
        const activeId = state.activeTabId || activeTab.id;
        const tabs = getSyncedTabs(state).map((t) =>
          t.id === activeId
            ? { ...t, layout: nextLayout, focusedPath: nextFocusedPath }
            : t,
        );
        set({
          tabs,
          layout: nextLayout,
          focusedPath: nextFocusedPath,
        });
      } else {
        set({
          layout: nextLayout,
          focusedPath: nextFocusedPath,
        });
      }
      triggerDebouncedSaveLayout(get);
    },

    // Swap the currently focused pane with its adjacent sibling in direction dir.
    swapFocusedPane: (dir) => {
      const state = get();
      const activeTab = getActiveTab(state);
      const tree = activeTab ? activeTab.layout : state.layout;
      const path = activeTab ? activeTab.focusedPath : state.focusedPath;
      let sourceId: string;
      try {
        sourceId = focus(tree, path);
      } catch {
        return;
      }
      if (!sourceId) return;
      const targetPath = findAdjacentPath(tree, path, dir);
      if (!targetPath) return;
      let targetId: string;
      try {
        targetId = focus(tree, targetPath);
      } catch {
        return;
      }
      if (!targetId || targetId === sourceId) return;
      get().swapPanes(sourceId, targetId);
    },

    tileProjectBranches: async (repoId, worktreeIds) => {
      const state = get();
      const allWorktrees = state.worktrees ?? [];
      const targetWorktrees = allWorktrees.filter((w) => {
        const matchRepo =
          w.record.repo_id === repoId ||
          (!w.record.repo_id && repoId === "orphaned") ||
          (!repoId && !w.record.repo_id);
        const matchId = worktreeIds ? worktreeIds.includes(w.record.id) : true;
        return matchRepo && matchId && !w.record.retired;
      });

      const sessionIds: string[] = [];

      for (const wt of targetWorktrees) {
        // Reuse live session if one already exists for this worktree
        const currentSessions = get().sessions;
        const liveSession = Object.values(currentSessions).find(
          (s) => s.worktreeId === wt.record.id && s.status !== "exited",
        );

        if (liveSession) {
          sessionIds.push(liveSession.id);
        } else {
          // Spawn a session for this worktree
          const spawnedId = await get().spawnSession(
            wt.record.path,
            undefined,
            undefined,
            undefined,
            wt.record.id,
          );
          sessionIds.push(spawnedId);
        }
      }

      // If no matching worktrees found, check if a repo exists to spawn a base session
      if (sessionIds.length === 0) {
        const repo = state.repos.find((r) => r.repo_id === repoId);
        if (repo) {
          const spawnedId = await get().spawnSession(repo.path);
          sessionIds.push(spawnedId);
        }
      }

      const gridLayout = buildMultiBranchGridLayout(sessionIds);
      const repo = get().repos.find((r) => r.repo_id === repoId);
      const repoName = extractRepoName(
        repo?.path ?? targetWorktrees[0]?.record.path ?? "",
        repoId,
      );
      const title = `${repoName} (Grid)`;

      const currentTabs = getSyncedTabs(get());
      let tabId = "";
      let updatedTabs: TabState[] = [];

      if (
        currentTabs.length === 1 &&
        currentTabs[0].layout.type === "leaf" &&
        !currentTabs[0].layout.id
      ) {
        tabId = currentTabs[0].id;
        updatedTabs = [
          {
            id: tabId,
            title,
            layout: gridLayout,
            focusedPath: firstLeafPath(gridLayout),
          },
        ];
      } else {
        tabId = generateNextTabId(currentTabs);
        const newTab: TabState = {
          id: tabId,
          title,
          layout: gridLayout,
          focusedPath: firstLeafPath(gridLayout),
        };
        updatedTabs = [...currentTabs, newTab];
      }

      set((s) => ({
        tabs: updatedTabs,
        activeTabId: tabId,
        layout: gridLayout,
        focusedPath: firstLeafPath(gridLayout),
        tabFocusHistory: [tabId, ...s.tabFocusHistory.filter((id) => id !== tabId)],
      }));

      triggerDebouncedSaveLayout(get);
      return tabId;
    },

    focusBranchPane: async (worktreeId) => {
      const state = get();
      const currentTabs = getSyncedTabs(state);
      let foundTab: TabState | null = null;
      let foundSessionId: string | null = null;

      for (const tab of currentTabs) {
        if (tab.isWizard) continue;
        const ids = leafIds(tab.layout);
        const matchedLiveId = ids.find(
          (id) =>
            state.sessions[id]?.worktreeId === worktreeId &&
            state.sessions[id]?.status !== "exited",
        );
        const matchedAnyId = ids.find(
          (id) => state.sessions[id]?.worktreeId === worktreeId,
        );
        const chosenId = matchedLiveId ?? matchedAnyId;
        if (chosenId) {
          foundTab = tab;
          foundSessionId = chosenId;
          break;
        }
      }

      if (foundTab && foundSessionId) {
        const path =
          findLeafPath(foundTab.layout, foundSessionId) ?? firstLeafPath(foundTab.layout);
        get().selectTab(foundTab.id);
        get().focusPane(path);
        // Bringing the branch forward is an implicit read of its agent truth.
        get().markAgentStatusSeen(foundSessionId);
      } else {
        const wtEntry = state.worktrees.find((w) => w.record.id === worktreeId);
        const targetPath = wtEntry?.record.path;
        await get().createTab(targetPath, worktreeId);
      }
    },

    // Attach daemon-held sessions (fleet slots, reopened worktrees) into an
    // existing tab and re-tile its grid. Snapshot-then-set: leaf ids captured
    // before the async attaches, one layout write after — a user split racing
    // the merge lands in the rebuilt grid, never a torn tree.
    mergeSessionsIntoWorkspace: async (tabId, sessionIds, opts) => {
      const state = get();
      const tab = getSyncedTabs(state).find((t) => t.id === tabId);
      if (!tab || sessionIds.length === 0) return;

      const isPlaceholder = tab.layout.type === "leaf" && !tab.layout.id;
      // Existing leaves minus the throwaway placeholder; DFS order preserved.
      const existingLeaves = isPlaceholder ? [] : leafIds(tab.layout);
      const incoming = sessionIds.filter((id) => id && !existingLeaves.includes(id));
      if (incoming.length === 0 && !opts?.clearWizard) return;

      const attached: string[] = [];
      // Attach in parallel — order comes from the array, not the resolve order.
      await Promise.all(
        incoming.map(async (sessionId) => {
          const worktreeId = opts?.worktreeIdsBySession?.[sessionId];
          const id = await get().spawnSession(
            undefined,
            undefined,
            sessionId,
            undefined,
            worktreeId,
          );
          if (id) attached.push(id);
        }),
      );

      set((s) => {
        const currentTabs = getSyncedTabs(s);
        const current = currentTabs.find((t) => t.id === tabId);
        if (!current) return {};
        // Re-read leaves at write time: mid-merge splits must survive.
        const liveLeaves =
          current.layout.type === "leaf" && !current.layout.id
            ? []
            : leafIds(current.layout);
        const merged = [...liveLeaves, ...attached];
        // ponytail: equal-ratio grid on membership change; ratio-preserving
        // reflow if users demand their manual tuning survives merges.
        const layout = createGridLayout(merged.length, merged);
        const focusedPath = firstLeafPath(layout);
        const updated = currentTabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                layout,
                focusedPath,
                ...(opts?.clearWizard ? { isWizard: false } : {}),
                ...(opts?.workspaceKey ? { workspaceKey: opts.workspaceKey } : {}),
                ...(opts?.title ? { title: opts.title } : {}),
              }
            : t,
        );
        const isActive = s.activeTabId === tabId;
        return {
          tabs: updated,
          ...(isActive ? { layout, focusedPath } : {}),
        };
      });
      triggerDebouncedSaveLayout(get);
    },

    // Persist the current multi-tab layout, session state, UI view state, and active scrollbacks.
    saveLayout: async () => {
      if (!get().ready) return;
      const {
        activeTabId,
        sessions,
        serializers,
        cachedScrollbacks,
        leftSidebarOpen,
        leftSidebarWidth,
        rightSidebarOpen,
        rightSidebarWidth,
        rightSidebarTab,
        activeAppMode,
        maximizedSessionId,
        editorTabs,
        activeEditorPath,
        editorViewMode,
        browserUrl,
        devicePreset,
      } = get();
      const currentTabs = getSyncedTabs(get());
      const windowState = await getSavedWindowState();
      const snapshot = {
        version: 3,
        ...(windowState ? { window: windowState } : {}),
        ui: {
          leftSidebarOpen,
          leftSidebarWidth,
          rightSidebarOpen,
          rightSidebarWidth,
          rightSidebarTab,
          activeAppMode,
          maximizedSessionId,
          editorTabs,
          activeEditorPath,
          editorViewMode,
          browserUrl,
          devicePreset,
        },
        tabs: currentTabs.map((t) => ({
          id: t.id,
          ...(t.title !== undefined ? { title: t.title } : {}),
          ...(t.workspaceKey !== undefined ? { workspaceKey: t.workspaceKey } : {}),
          ...(t.isWizard !== undefined ? { isWizard: t.isWizard } : {}),
          layout: t.layout,
          focusedPath: t.focusedPath,
        })),
        activeTabId: activeTabId || currentTabs[0]?.id || "tab-1",
        sessions: Object.values(sessions).map((s) => ({
          id: s.id,
          title: s.title,
          status: s.status,
          cwd: s.cwd,
          cols: s.cols,
          rows: s.rows,
          ...(s.worktreeId ? { worktreeId: s.worktreeId } : {}),
        })),
      };
      await transportSaveLayout(JSON.stringify(snapshot));
      // Serialize only buffers with new output since the last write — a tab
      // switch or rename must not stringify every live terminal. Each
      // serialize is bounded (~1MB via scrollbackBudget) and we yield between
      // sessions so a burst of dirty buffers never blocks the UI thread in
      // one synchronous block.
      const scrollbackPromises: Promise<void>[] = [];
      for (const s of Object.values(sessions)) {
        if (!isScrollbackDirty(s.id)) continue;
        // Clear per-id before awaiting: output landing mid-save re-marks it
        // via markScrollbackDirty for the next pass instead of being lost.
        clearDirtyScrollback(s.id);
        const buffer = serializers[s.id]?.() || cachedScrollbacks[s.id];
        if (buffer) {
          scrollbackPromises.push(saveScrollback(s.id, buffer).catch(() => {}));
        }
        // Yield to the event loop between serializations.
        await Promise.resolve();
      }
      if (scrollbackPromises.length > 0) {
        await Promise.all(scrollbackPromises);
      }
      await cleanupStaleScrollbacks(Object.keys(sessions)).catch(() => {});
    },

    // Restore a saved multi-tab (or legacy single-tab) layout.
    loadLayout: async () => {
      const [, saved] = await Promise.all([
        get().loadSettingsData().catch(() => {}),
        transportLoadLayout().catch(() => null),
        get().loadWizardData().catch(() => {}),
      ]);
      if (!saved) {
        set({ ready: true });
        return;
      }
      try {
        const parsed = JSON.parse(saved) as {
          version?: number;
          window?: WindowState;
          ui?: {
            leftSidebarOpen?: boolean;
            leftSidebarWidth?: number;
            rightSidebarOpen?: boolean;
            rightSidebarWidth?: number;
            rightSidebarTab?: "explorer" | "git" | "extensions";
            activeAppMode?: AppMode;
            maximizedSessionId?: string | null;
            editorTabs?: EditorTab[];
            activeEditorPath?: string | null;
            editorViewMode?: EditorViewMode;
            browserUrl?: string;
            devicePreset?: DevicePreset;
          };
          tabs?: TabState[];
          activeTabId?: string;
          layout?: Layout;
          sessions?: import("./terminalSessionsSlice").SessionInfo[];
        };

        if (parsed.ui) {
          set((state) => ({
            leftSidebarOpen: parsed.ui!.leftSidebarOpen ?? state.leftSidebarOpen,
            leftSidebarWidth: parsed.ui!.leftSidebarWidth ?? state.leftSidebarWidth,
            rightSidebarOpen: parsed.ui!.rightSidebarOpen ?? state.rightSidebarOpen,
            rightSidebarWidth: parsed.ui!.rightSidebarWidth ?? state.rightSidebarWidth,
            rightSidebarTab: parsed.ui!.rightSidebarTab ?? state.rightSidebarTab,
            activeAppMode: parsed.ui!.activeAppMode ?? state.activeAppMode,
            maximizedSessionId:
              parsed.ui!.maximizedSessionId !== undefined
                ? parsed.ui!.maximizedSessionId
                : state.maximizedSessionId,
            editorTabs: parsed.ui!.editorTabs ?? state.editorTabs,
            activeEditorPath:
              parsed.ui!.activeEditorPath !== undefined
                ? parsed.ui!.activeEditorPath
                : state.activeEditorPath,
            editorViewMode: parsed.ui!.editorViewMode ?? state.editorViewMode,
            browserUrl: parsed.ui!.browserUrl ?? state.browserUrl,
            devicePreset: parsed.ui!.devicePreset ?? state.devicePreset,
          }));
        }

        if (parsed.window) {
          void applyWindowState(parsed.window);
        }
        const byId = new Map((parsed.sessions ?? []).map((s) => [s.id, s]));
        const remap: Record<string, string> = {};

        if (Array.isArray(parsed.tabs)) {
          // v3 migration: derive a sticky folder binding for v2 tabs that
          // lack one — the first session's cwd is the best proxy for where
          // the workspace lived. Wizard tabs keep an empty key.
          const restoredTabsInput: TabState[] = parsed.tabs.map((t) =>
            t.workspaceKey === undefined && !t.isWizard
              ? {
                  ...t,
                  workspaceKey:
                    byId.get(leafIds(t.layout).find((id) => id) ?? "")?.cwd ?? undefined,
                }
              : t,
          );
          if (restoredTabsInput.length === 0) {
            set({
              tabs: [],
              activeTabId: "",
              layout: { type: "leaf", id: "" },
              focusedPath: [],
              ready: true,
            });
            return;
          }

          const activeTabId =
            parsed.activeTabId && parsed.tabs.some((t) => t.id === parsed.activeTabId)
              ? parsed.activeTabId
              : parsed.tabs[0].id;
          const activeTab = parsed.tabs.find((t) => t.id === activeTabId) ?? parsed.tabs[0];

          const activeOldIds = new Set<string>();
          if (activeTab && !activeTab.isWizard) {
            for (const oldId of leafIds(activeTab.layout)) {
              if (oldId) activeOldIds.add(oldId);
            }
          }

          const dormantOldIds = new Set<string>();
          for (const tab of parsed.tabs) {
            if (tab.id === activeTabId || tab.isWizard) continue;
            for (const oldId of leafIds(tab.layout)) {
              if (oldId && !activeOldIds.has(oldId)) {
                dormantOldIds.add(oldId);
              }
            }
          }

          // Seed state.sessions: restoring for active, sleeping for dormant.
          set((state) => {
            const updatedSessions = { ...state.sessions };
            if (Array.isArray(parsed.sessions)) {
              for (const s of parsed.sessions) {
                if (s.id) {
                  const isRestoring = activeOldIds.has(s.id);
                  updatedSessions[s.id] = {
                    id: s.id,
                    title: s.title || s.id,
                    status: isRestoring ? "restoring" : "sleeping",
                    cwd: s.cwd,
                    cols: s.cols || DEFAULT_COLS,
                    rows: s.rows || DEFAULT_ROWS,
                    ...(s.isRestored ? { isRestored: true } : {}),
                    ...(s.worktreeId ? { worktreeId: s.worktreeId } : {}),
                  };
                }
              }
            }
            for (const oldId of dormantOldIds) {
              if (!updatedSessions[oldId]) {
                const saved = byId.get(oldId);
                updatedSessions[oldId] = {
                  id: oldId,
                  title: saved?.title || oldId,
                  status: "sleeping",
                  cwd: saved?.cwd,
                  cols: saved?.cols || DEFAULT_COLS,
                  rows: saved?.rows || DEFAULT_ROWS,
                  ...(saved?.isRestored ? { isRestored: true } : {}),
                  ...(saved?.worktreeId ? { worktreeId: saved.worktreeId } : {}),
                };
              }
            }
            for (const oldId of activeOldIds) {
              if (!updatedSessions[oldId]) {
                const saved = byId.get(oldId);
                updatedSessions[oldId] = {
                  id: oldId,
                  title: saved?.title || oldId,
                  status: "restoring",
                  cwd: saved?.cwd,
                  cols: saved?.cols || DEFAULT_COLS,
                  rows: saved?.rows || DEFAULT_ROWS,
                  ...(saved?.isRestored ? { isRestored: true } : {}),
                  ...(saved?.worktreeId ? { worktreeId: saved.worktreeId } : {}),
                };
              }
            }
            return { sessions: updatedSessions };
          });

          // Restore active sessions in parallel
          await Promise.all(
            Array.from(activeOldIds).map(async (oldId) => {
              const savedSession = byId.get(oldId);
              const geometry =
                savedSession && (savedSession.cols !== undefined || savedSession.rows !== undefined)
                  ? { cols: savedSession.cols, rows: savedSession.rows }
                  : undefined;
              const newId = await get().spawnSession(
                savedSession?.cwd,
                undefined,
                oldId,
                geometry,
                savedSession?.worktreeId,
              );
              remap[oldId] = newId;
              if (oldId !== newId) {
                set((state) => {
                  const sessions = { ...state.sessions };
                  delete sessions[oldId];
                  return { sessions };
                });
              }

              if (savedSession?.title && savedSession.title !== newId) {
                get().renameSession(newId, savedSession.title);
              }

              const prev = await loadScrollback(oldId);
              if (prev) {
                if (!get().restoredScrollbacks[newId]) {
                  get().setRestoredScrollback(newId, prev);
                  set((state) => {
                    const sess = state.sessions[newId];
                    if (!sess) return state;
                    return {
                      sessions: {
                        ...state.sessions,
                        [newId]: { ...sess, isRestored: true },
                      },
                    };
                  });
                }
                await saveScrollback(newId, prev);
                if (oldId !== newId) {
                  await deleteScrollback(oldId);
                }
              }
            }),
          );

          const restoredTabs: TabState[] = restoredTabsInput.map((tab) => {
            if (tab.isWizard) {
              return {
                id: tab.id,
                ...(tab.title !== undefined ? { title: tab.title } : {}),
                isWizard: true,
                layout: { type: "leaf", id: "" },
                focusedPath: [],
              };
            }
            const key = tab.workspaceKey;
            if (tab.id === activeTabId) {
              const remappedLayout = remapLeafIds(tab.layout, remap);
              return {
                id: tab.id,
                ...(tab.title !== undefined ? { title: tab.title } : {}),
                ...(key !== undefined ? { workspaceKey: key } : {}),
                layout: remappedLayout,
                focusedPath: tab.focusedPath ?? firstLeafPath(remappedLayout),
                isSleeping: false,
              };
            }
            return {
              id: tab.id,
              ...(tab.title !== undefined ? { title: tab.title } : {}),
              ...(key !== undefined ? { workspaceKey: key } : {}),
              layout: tab.layout,
              focusedPath: tab.focusedPath ?? firstLeafPath(tab.layout),
              isSleeping: true,
            };
          });

          const activeRestoredTab = restoredTabs.find((t) => t.id === activeTabId) ?? restoredTabs[0];

          set({
            tabs: restoredTabs,
            activeTabId,
            layout: activeRestoredTab ? activeRestoredTab.layout : { type: "leaf", id: "" },
            focusedPath: activeRestoredTab ? activeRestoredTab.focusedPath : [],
          });
        } else if (parsed.layout) {
          const uniqueOldIds = new Set<string>();
          for (const oldId of leafIds(parsed.layout)) {
            if (oldId) uniqueOldIds.add(oldId);
          }

          set((state) => {
            const updatedSessions = { ...state.sessions };
            if (Array.isArray(parsed.sessions)) {
              for (const s of parsed.sessions) {
                if (s.id) {
                  updatedSessions[s.id] = {
                    id: s.id,
                    title: s.title || s.id,
                    status: "restoring",
                    cwd: s.cwd,
                    cols: s.cols || DEFAULT_COLS,
                    rows: s.rows || DEFAULT_ROWS,
                    ...(s.isRestored ? { isRestored: true } : {}),
                    ...(s.worktreeId ? { worktreeId: s.worktreeId } : {}),
                  };
                }
              }
            }
            for (const oldId of uniqueOldIds) {
              if (!updatedSessions[oldId]) {
                const saved = byId.get(oldId);
                updatedSessions[oldId] = {
                  id: oldId,
                  title: saved?.title || oldId,
                  status: "restoring",
                  cwd: saved?.cwd,
                  cols: saved?.cols || DEFAULT_COLS,
                  rows: saved?.rows || DEFAULT_ROWS,
                  ...(saved?.isRestored ? { isRestored: true } : {}),
                  ...(saved?.worktreeId ? { worktreeId: saved.worktreeId } : {}),
                };
              }
            }
            return { sessions: updatedSessions };
          });

          await Promise.all(
            Array.from(uniqueOldIds).map(async (oldId) => {
              const savedSession = byId.get(oldId);
              const geometry =
                savedSession && (savedSession.cols !== undefined || savedSession.rows !== undefined)
                  ? { cols: savedSession.cols, rows: savedSession.rows }
                  : undefined;
              const newId = await get().spawnSession(
                savedSession?.cwd,
                undefined,
                oldId,
                geometry,
                savedSession?.worktreeId,
              );
              remap[oldId] = newId;
              if (oldId !== newId) {
                set((state) => {
                  const sessions = { ...state.sessions };
                  delete sessions[oldId];
                  return { sessions };
                });
              }

              if (savedSession?.title && savedSession.title !== newId) {
                get().renameSession(newId, savedSession.title);
              }

              const prev = await loadScrollback(oldId);
              if (prev) {
                if (!get().restoredScrollbacks[newId]) {
                  get().setRestoredScrollback(newId, prev);
                  set((state) => {
                    const sess = state.sessions[newId];
                    if (!sess) return state;
                    return {
                      sessions: {
                        ...state.sessions,
                        [newId]: { ...sess, isRestored: true },
                      },
                    };
                  });
                }
                await saveScrollback(newId, prev);
                if (oldId !== newId) {
                  await deleteScrollback(oldId);
                }
              }
            }),
          );

          const remappedLayout = remapLeafIds(parsed.layout, remap);
          const defaultTab: TabState = {
            id: "tab-1",
            layout: remappedLayout,
            focusedPath: firstLeafPath(remappedLayout),
            isSleeping: false,
          };
          set({
            tabs: [defaultTab],
            activeTabId: defaultTab.id,
            layout: remappedLayout,
            focusedPath: defaultTab.focusedPath,
          });
        }
      } finally {
        set({ ready: true });
      }
    },
  };
}
