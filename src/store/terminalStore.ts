import { create } from "zustand";
import {
  ptySpawn,
  ptyKill,
  ptyResize,
  ptyAck,
  ptyWrite,
  saveLayout as transportSaveLayout,
  loadLayout as transportLoadLayout,
  saveScrollback,
  loadScrollback,
  deleteScrollback,
  cleanupStaleScrollbacks,
} from "../lib/pty/transport";
import type { PtySpawnOptions } from "../lib/pty/transport";
import {
  split,
  remove,
  focus,
  firstLeafPath,
  findLeafPath,
  substituteLeafId,
  remapLeafIds,
  swapLeaves,
  moveLeaf,
} from "../lib/pane-manager/layout";
import type { Layout, Path, DropZone } from "../lib/pane-manager/layout";
import { createGridLayout } from "../lib/pane-manager/gridLayout";
import {
  saveRecents,
  loadRecents,
  savePresets,
  loadPresets,
} from "../lib/workspace/transport";
import type {
  RecentWorkspace,
  WorkspacePreset,
} from "../lib/workspace/transport";
import { readFile, writeFile } from "../lib/fs/transport";
import {
  saveSettings as transportSaveSettings,
  loadSettings as transportLoadSettings,
} from "../lib/settings/transport";
import type {
  AppSettings,
  GeneralSettings,
  AppearanceSettings,
  SettingsTabId,
} from "../lib/settings/types";
import { DEFAULT_APP_SETTINGS } from "../lib/settings/types";

// Re-exported so existing import sites keep working after the layout types
// moved into `src/lib/pane-manager/layout.ts`.
export type { Layout, Path, DropZone } from "../lib/pane-manager/layout";
export type { RecentWorkspace, WorkspacePreset } from "../lib/workspace/transport";
export type {
  AppSettings,
  GeneralSettings,
  AppearanceSettings,
  TerminalThemeId,
  TerminalCursorStyle,
  DefaultCwdMode,
  StartupBehavior,
  TabSwitchMode,
  BrowserSearchEngine,
  SettingsTabId,
} from "../lib/settings/types";
export {
  DEFAULT_APP_SETTINGS,
  DEFAULT_APPEARANCE_SETTINGS,
} from "../lib/settings/types";
export {
  getTerminalTheme,
  getAllTerminalThemes,
} from "../lib/theme/terminalThemes";

export interface WorkspaceConfig {
  name?: string;
  cwd?: string;
  terminalCount: number;
  shell?: string;
  commands?: string[];
  agentPersona?: string;
}

export type SessionStatus =
  | "spawning"
  | "loading"
  | "restoring"
  | "running"
  | "exited"
  | "error";


export type AppMode = "terminal" | "browser" | "editor";
export type DevicePreset = "responsive" | "iphone" | "ipad" | "desktop";

export type EditorViewMode = "edit" | "diff" | "markdown-preview" | "markdown-split";

export interface EditorTab {
  path: string;
  name: string;
  content: string;
  originalContent: string;
  isDirty: boolean;
  language: string;
  isMarkdown: boolean;
}

export interface PendingAiDiff {
  path: string;
  original: string;
  modified: string;
  summary?: string;
  isInline?: boolean;
}

export function detectEditorLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "rs":
      return "rust";
    case "py":
    case "pyw":
      return "python";
    case "json":
      return "json";
    case "html":
    case "htm":
      return "html";
    case "css":
      return "css";
    case "scss":
      return "scss";
    case "less":
      return "less";
    case "md":
    case "markdown":
      return "markdown";
    case "toml":
      return "toml";
    case "yaml":
    case "yml":
      return "yaml";
    case "sh":
    case "bash":
    case "zsh":
      return "shell";
    case "go":
      return "go";
    case "c":
    case "h":
      return "c";
    case "cpp":
    case "cc":
    case "cxx":
    case "hpp":
      return "cpp";
    case "sql":
      return "sql";
    case "xml":
    case "svg":
      return "xml";
    case "diff":
    case "patch":
      return "diff";
    default:
      return "plaintext";
  }
}

function getFileName(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

export interface DetectedPort {
  port: number;
  url: string;
  title: string;
  timestamp: number;
}

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
  isRestored?: boolean;
}

export type TerminalSession = SessionInfo;


export interface TabState {
  id: string;
  title?: string;
  layout: Layout;
  focusedPath: Path;
  isWizard?: boolean;
}

// Monotonic counter for synthetic error-session ids. Avoids
// crypto.randomUUID (not available in insecure/non-secure contexts) and stays
// unique within the session without depending on a global UUID source.
let nextErrorId = 0;

export function generateNextTabId(existingTabs: TabState[]): string {
  const existingIds = new Set(existingTabs.map((t) => t.id));
  let maxId = 0;
  for (const t of existingTabs) {
    const match = /^tab-(\d+)$/.exec(t.id);
    if (match) {
      const num = parseInt(match[1], 10);
      if (!isNaN(num) && num > maxId) {
        maxId = num;
      }
    }
  }
  let candidate = maxId + 1;
  while (existingIds.has(`tab-${candidate}`)) {
    candidate++;
  }
  return `tab-${candidate}`;
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

// Find path of the adjacent sibling leaf in direction dir.
function findAdjacentPath(
  tree: Layout,
  path: Path,
  dir: "left" | "right" | "up" | "down",
): Path | null {
  if (path.length === 0) return null;
  const target = dir === "left" || dir === "up" ? 0 : 1;
  const axis = dir === "left" || dir === "right" ? "h" : "v";
  for (let i = path.length - 1; i >= 0; i--) {
    const ancestor = nodeAt(tree, path.slice(0, i));
    if (ancestor.type !== "split" || ancestor.dir !== axis) continue;
    if (path[i] === target) continue;
    const destChild = path[i] === 0 ? ancestor.b : ancestor.a;
    return [
      ...path.slice(0, i),
      path[i] === 0 ? 1 : 0,
      ...firstLeafPath(destChild),
    ];
  }
  return null;
}

// Leaf ids in depth-first (a before b) order — the deterministic spawn order
// a persisted-layout restore uses.
function leafIds(tree: Layout): string[] {
  if (tree.type === "leaf") return [tree.id];
  return [...leafIds(tree.a), ...leafIds(tree.b)];
}

export interface TerminalState {
  sessions: Record<string, SessionInfo>;
  tabs: TabState[];
  activeTabId: string;
  layout: Layout;
  focusedPath: Path;
  serializers: Record<string, () => string>;
  cachedScrollbacks: Record<string, string>;
  restoredScrollbacks: Record<string, string>;
  // True once the persisted layout has been loaded (or failed to load) on
  // startup; the UI stays hidden until then so a restore never races the
  // placeholder auto-spawn in SessionLeaf.
  ready: boolean;
  activeAppMode: AppMode;
  browserUrl: string;
  browserHistory: string[];
  historyIndex: number;
  devicePreset: DevicePreset;
  detectedPorts: DetectedPort[];
  registerSerializer: (id: string, fn: () => string) => void;
  unregisterSerializer: (id: string) => void;
  cacheScrollback: (id: string, buffer: string) => void;
  setRestoredScrollback: (id: string, data: string) => void;
  clearRestoredScrollback: (id: string) => void;
  spawnSession: (cwd?: string, shell?: string, existingId?: string) => Promise<string>;
  killSession: (id: string) => Promise<void>;
  resizeSession: (id: string, cols: number, rows: number) => void;
  ackSession: (id: string, chars: number) => Promise<void>;
  setSessionStatus: (id: string, status: SessionStatus) => void;
  dismissSessionRestoredBanner: (sessionId: string) => void;
  updateSessionCwd: (id: string, cwd: string) => void;

  renameSession: (id: string, title: string) => void;
  substituteSessionId: (from: string, to: string) => void;
  createTab: (cwd?: string) => Promise<string>;
  closeTab: (tabId?: string) => Promise<void>;
  selectTab: (tabId: string) => void;
  renameTab: (tabId: string, title: string) => void;
  setLayout: (layout: Layout) => void;
  setRatio: (path: Path, ratio: number) => void;
  setSplitRatio?: (path: Path, ratio: number) => void;
  splitPane: (dir: "h" | "v", path?: Path) => Promise<void>;
  closePane: (path?: Path) => Promise<void>;
  maximizedSessionId: string | null;
  toggleMaximizePane: (id?: string) => void;
  focusPane: (path: Path) => void;
  moveFocus: (dir: "left" | "right" | "up" | "down") => void;
  swapPanes: (sourceId: string, targetId: string) => void;
  movePane: (sourceId: string, targetId: string, zone: DropZone) => void;
  swapFocusedPane: (dir: "left" | "right" | "up" | "down") => void;
  saveLayout: () => Promise<void>;
  loadLayout: () => Promise<void>;
  leftSidebarOpen: boolean;
  leftSidebarWidth: number;
  rightSidebarOpen: boolean;
  rightSidebarWidth: number;
  rightSidebarTab: "explorer" | "git";
  toggleLeftSidebar: () => void;
  setLeftSidebarWidth: (width: number) => void;
  toggleRightSidebar: () => void;
  setRightSidebarWidth: (width: number) => void;
  setRightSidebarTab: (tab: "explorer" | "git") => void;
  getActiveCwd: () => string | undefined;
  isWorkspaceLauncherOpen: boolean;
  openWorkspaceLauncher: () => void;
  closeWorkspaceLauncher: () => void;
  toggleWorkspaceLauncher: () => void;
  isSetupWizardOpen: boolean;
  wizardStep: 1 | 2 | 3;
  recentWorkspaces: RecentWorkspace[];
  workspacePresets: WorkspacePreset[];
  openSetupWizard: () => void;
  closeSetupWizard: () => void;
  setWizardStep: (step: 1 | 2 | 3) => void;
  loadWizardData: () => Promise<void>;
  createWizardTab: () => string;
  launchWorkspaceForTab: (tabId: string, config: WorkspaceConfig) => Promise<void>;
  launchCustomWorkspace: (config: WorkspaceConfig) => Promise<string>;
  addRecentWorkspace: (recent: RecentWorkspace) => Promise<void>;
  saveWorkspacePreset: (preset: WorkspacePreset) => Promise<void>;
  setAppMode: (mode: AppMode) => void;
  navigateBrowser: (url: string) => void;
  browserGoBack: () => void;
  browserGoForward: () => void;
  browserReload: () => void;
  setDevicePreset: (preset: DevicePreset) => void;
  addDetectedPort: (portInfo: { port: number; url: string; title?: string; timestamp?: number }) => void;
  clearDetectedPorts: () => void;
  scanOutputForPorts: (text: string) => void;
  editorTabs: EditorTab[];
  activeEditorPath: string | null;
  editorViewMode: EditorViewMode;
  pendingAiDiff: PendingAiDiff | null;
  openFileInEditor: (path: string, content?: string) => Promise<void>;
  closeEditorTab: (path: string) => void;
  setActiveEditorTab: (path: string) => void;
  updateEditorContent: (path: string, content: string) => void;
  saveActiveFile: () => Promise<void>;
  stageAiDiff: (path: string, original: string, modified: string, summary?: string) => void;
  acceptAiDiff: () => Promise<void>;
  rejectAiDiff: () => void;
  setEditorViewMode: (mode: EditorViewMode) => void;
  settings: AppSettings;
  isSettingsOpen: boolean;
  activeSettingsTab: SettingsTabId;
  tabFocusHistory: string[];
  openSettings: (tab?: SettingsTabId) => void;
  closeSettings: () => void;
  updateSettings: (
    partial:
      | Partial<AppSettings>
      | { general?: Partial<GeneralSettings>; appearance?: Partial<AppearanceSettings> },
  ) => void;
  updateAppearanceSettings: (partial: Partial<AppearanceSettings>) => void;
  resolveDefaultCwd: () => string | undefined;
  loadSettingsData: () => Promise<void>;
}

function isNonEmptyLayout(layout?: Layout): boolean {
  if (!layout) return false;
  if (layout.type === "split") return true;
  return layout.id !== "";
}

function getSyncedTabs(state: TerminalState): TabState[] {
  if (state.tabs && state.tabs.length > 0) {
    return state.tabs;
  }
  if (isNonEmptyLayout(state.layout)) {
    return [
      {
        id: state.activeTabId || "tab-1",
        layout: state.layout,
        focusedPath: state.focusedPath ?? [],
      },
    ];
  }
  return [];
}

function getActiveTab(state: TerminalState): TabState | undefined {
  const tabs = getSyncedTabs(state);
  const activeId = state.activeTabId;
  return tabs.find((t) => t.id === activeId) ?? tabs[0];
}

let settingsSaveTimer: ReturnType<typeof setTimeout> | null = null;
let editorAutoSaveTimer: ReturnType<typeof setTimeout> | null = null;

export const useTerminalStore = create<TerminalState>((set, get) => ({
  sessions: {},
  tabs: [],
  activeTabId: "",
  layout: { type: "leaf", id: "" },
  focusedPath: [],
  serializers: {},
  cachedScrollbacks: {},
  restoredScrollbacks: {},
  ready: false,
  leftSidebarOpen: true,
  leftSidebarWidth: 240,
  rightSidebarOpen: false,
  rightSidebarWidth: 280,
  rightSidebarTab: "explorer",
  isWorkspaceLauncherOpen: false,
  maximizedSessionId: null,
  isSetupWizardOpen: false,
  wizardStep: 1,
  recentWorkspaces: [],
  workspacePresets: [],
  activeAppMode: "terminal",
  browserUrl: "",
  browserHistory: [],
  historyIndex: -1,
  devicePreset: "responsive",
  detectedPorts: [],
  editorTabs: [],
  activeEditorPath: null,
  editorViewMode: "edit",
  pendingAiDiff: null,
  settings: DEFAULT_APP_SETTINGS,
  isSettingsOpen: false,
  activeSettingsTab: "general",
  tabFocusHistory: [],

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

  cacheScrollback: (id, buffer) =>
    set((state) => ({
      cachedScrollbacks: { ...state.cachedScrollbacks, [id]: buffer },
    })),

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

  spawnSession: async (cwd, shell, existingId) => {
    try {
      const targetCwd = cwd ?? (existingId ? undefined : get().resolveDefaultCwd());
      const opts: PtySpawnOptions = {};
      if (existingId) opts.id = existingId;
      if (targetCwd) opts.cwd = targetCwd;
      if (shell) opts.shell = shell;
      const res = await ptySpawn(Object.keys(opts).length > 0 ? opts : undefined);
      const id = typeof res === "string" ? res : res.id;
      const isNew = typeof res === "string" ? true : res.is_new;
      const isWarm = typeof res === "string" ? !isNew : (res.is_warm ?? !isNew);
      const snapshot = typeof res === "string" ? null : res.snapshot;
      const coldScrollback = typeof res === "string" ? null : res.cold_scrollback;
      const cols = (typeof res !== "string" && res.cols) || DEFAULT_COLS;
      const rows = (typeof res !== "string" && res.rows) || DEFAULT_ROWS;
      const resolvedCwd = (typeof res !== "string" && res.cwd) || targetCwd;

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
            },
          },
        };
      });
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
            cwd: cwd ?? (existingId ? undefined : get().resolveDefaultCwd()),
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
      void get().saveLayout().catch(() => {});
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
      void get().saveLayout().catch(() => {});
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

  createTab: async (cwd) => {
    const resolvedCwd = cwd ?? get().resolveDefaultCwd();
    const sessionId = await get().spawnSession(resolvedCwd);
    const currentTabs = getSyncedTabs(get());
    const tabId = generateNextTabId(currentTabs);
    const newTab: TabState = {
      id: tabId,
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
    void get().saveLayout().catch(() => {});
    return tabId;
  },

  closeTab: async (tabId) => {
    const state = get();
    const targetId = tabId ?? state.activeTabId;
    const currentTabs = getSyncedTabs(state);
    const targetTab = currentTabs.find((t) => t.id === targetId);
    if (!targetTab) return;

    const sessionIds = leafIds(targetTab.layout);
    for (const sId of sessionIds) {
      if (sId) {
        if (get().sessions[sId]) {
          await get().killSession(sId);
        }
        void deleteScrollback(sId).catch(() => {});
      }
    }

    const sessions = { ...get().sessions };
    const cachedScrollbacks = { ...get().cachedScrollbacks };
    for (const sId of sessionIds) {
      if (sId) {
        delete sessions[sId];
        delete cachedScrollbacks[sId];
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
    void get().saveLayout().catch(() => {});
  },

  selectTab: (tabId) => {
    const state = get();
    const currentTabs = getSyncedTabs(state);
    const tab = currentTabs.find((t) => t.id === tabId);
    if (!tab) return;
    set({
      tabs: currentTabs,
      activeTabId: tab.id,
      layout: tab.layout,
      focusedPath: tab.focusedPath,
      tabFocusHistory: [tab.id, ...state.tabFocusHistory.filter((id) => id !== tab.id)],
    });
    void get().saveLayout().catch(() => {});
  },

  renameTab: (tabId, title) => {
    set((state) => {
      const currentTabs = getSyncedTabs(state);
      const tabs = currentTabs.map((t) => (t.id === tabId ? { ...t, title } : t));
      return { tabs };
    });
    void get().saveLayout().catch(() => {});
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
    void get().saveLayout().catch(() => {});
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
    if (get().sessions[removedId]) {
      await get().killSession(removedId);
    }
    if (removedId) {
      void deleteScrollback(removedId).catch(() => {});
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
    void get().saveLayout().catch(() => {});
  },

  toggleMaximizePane: (id) => {
    const current = get().maximizedSessionId;
    if (id !== undefined) {
      set({ maximizedSessionId: current === id ? null : id });
      return;
    }
    if (current !== null) {
      set({ maximizedSessionId: null });
      return;
    }
    const state = get();
    const activeTab = getActiveTab(state);
    if (!activeTab) return;
    const focusedId = focus(activeTab.layout, activeTab.focusedPath);
    if (focusedId) {
      set({ maximizedSessionId: focusedId });
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
    void get().saveLayout().catch(() => {});
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
    void get().saveLayout().catch(() => {});
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

  // Persist the current multi-tab layout, session state, and active scrollbacks.
  saveLayout: async () => {
    if (!get().ready) return;
    const { activeTabId, sessions, serializers, cachedScrollbacks } = get();
    const currentTabs = getSyncedTabs(get());
    const snapshot = {
      tabs: currentTabs.map((t) => ({
        id: t.id,
        ...(t.title !== undefined ? { title: t.title } : {}),
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
      })),
    };
    await transportSaveLayout(JSON.stringify(snapshot));
    for (const s of Object.values(sessions)) {
      const buffer = serializers[s.id]?.() || cachedScrollbacks[s.id];
      if (buffer) {
        await saveScrollback(s.id, buffer);
      }
    }
    await cleanupStaleScrollbacks(Object.keys(sessions));
  },

  // Restore a saved multi-tab (or legacy single-tab) layout.
  loadLayout: async () => {
    await get().loadSettingsData().catch(() => {});
    try {
      const saved = await transportLoadLayout();
      if (!saved) return;
      const parsed = JSON.parse(saved) as {
        tabs?: TabState[];
        activeTabId?: string;
        layout?: Layout;
        sessions?: SessionInfo[];
      };
      const byId = new Map((parsed.sessions ?? []).map((s) => [s.id, s]));
      const remap: Record<string, string> = {};

      // Seed sessions with restoring status so the UI knows restore is in flight.
      if (Array.isArray(parsed.sessions) && parsed.sessions.length > 0) {
        set((state) => {
          const updatedSessions = { ...state.sessions };
          for (const s of parsed.sessions!) {
            if (s.id) {
              updatedSessions[s.id] = {
                id: s.id,
                title: s.title || s.id,
                status: "restoring",
                cwd: s.cwd,
                cols: s.cols || DEFAULT_COLS,
                rows: s.rows || DEFAULT_ROWS,
                ...(s.isRestored ? { isRestored: true } : {}),
              };
            }
          }
          return { sessions: updatedSessions };
        });
      }

      if (Array.isArray(parsed.tabs)) {
        if (parsed.tabs.length === 0) {
          set({
            tabs: [],
            activeTabId: "",
            layout: { type: "leaf", id: "" },
            focusedPath: [],
          });
          return;
        }
        for (const tab of parsed.tabs) {
          if (tab.isWizard) continue;
          for (const oldId of leafIds(tab.layout)) {
            if (oldId === "" || remap[oldId]) continue;
            const savedSession = byId.get(oldId);
            const newId = await get().spawnSession(
              savedSession?.cwd,
              undefined,
              oldId,
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
          }
        }

        const restoredTabs: TabState[] = parsed.tabs.map((tab) => {
          if (tab.isWizard) {
            return {
              id: tab.id,
              ...(tab.title !== undefined ? { title: tab.title } : {}),
              isWizard: true,
              layout: { type: "leaf", id: "" },
              focusedPath: [],
            };
          }
          const remappedLayout = remapLeafIds(tab.layout, remap);
          return {
            id: tab.id,
            ...(tab.title !== undefined ? { title: tab.title } : {}),
            layout: remappedLayout,
            focusedPath: tab.focusedPath ?? firstLeafPath(remappedLayout),
          };
        });

        const activeTabId =
          parsed.activeTabId && restoredTabs.some((t) => t.id === parsed.activeTabId)
            ? parsed.activeTabId
            : restoredTabs[0].id;
        const activeTab = restoredTabs.find((t) => t.id === activeTabId) ?? restoredTabs[0];

        set({
          tabs: restoredTabs,
          activeTabId,
          layout: activeTab ? activeTab.layout : { type: "leaf", id: "" },
          focusedPath: activeTab ? activeTab.focusedPath : [],
        });
      } else if (parsed.layout) {
        for (const oldId of leafIds(parsed.layout)) {
          if (oldId === "") continue;
          const savedSession = byId.get(oldId);
          const newId = await get().spawnSession(
            savedSession?.cwd,
            undefined,
            oldId,
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
        }
        const remappedLayout = remapLeafIds(parsed.layout, remap);
        const defaultTab: TabState = {
          id: "tab-1",
          layout: remappedLayout,
          focusedPath: firstLeafPath(remappedLayout),
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


  toggleLeftSidebar: () =>
    set((state) => ({ leftSidebarOpen: !state.leftSidebarOpen })),

  setLeftSidebarWidth: (width) =>
    set({ leftSidebarWidth: width }),

  toggleRightSidebar: () =>
    set((state) => ({ rightSidebarOpen: !state.rightSidebarOpen })),

  setRightSidebarWidth: (width) =>
    set({ rightSidebarWidth: width }),

  setRightSidebarTab: (tab) =>
    set({ rightSidebarTab: tab }),

  getActiveCwd: () => {
    const state = get();
    const activeTab = getActiveTab(state);
    if (!activeTab) return undefined;
    try {
      const leafId = focus(activeTab.layout, activeTab.focusedPath);
      return state.sessions[leafId]?.cwd;
    } catch {
      return undefined;
    }
  },

  openWorkspaceLauncher: () => set({ isWorkspaceLauncherOpen: true }),
  closeWorkspaceLauncher: () => set({ isWorkspaceLauncherOpen: false }),
  toggleWorkspaceLauncher: () =>
    set((s) => ({ isWorkspaceLauncherOpen: !s.isWorkspaceLauncherOpen })),

  openSetupWizard: () => set({ isSetupWizardOpen: true, wizardStep: 1 }),
  closeSetupWizard: () => set({ isSetupWizardOpen: false }),
  setWizardStep: (step) => set({ wizardStep: step }),

  loadWizardData: async () => {
    try {
      const [recents, presets] = await Promise.all([
        loadRecents().catch(() => []),
        loadPresets().catch(() => []),
      ]);
      set({
        recentWorkspaces: Array.isArray(recents) ? recents : [],
        workspacePresets: Array.isArray(presets) ? presets : [],
      });
    } catch {
      // Keep defaults on failure
    }
  },

  addRecentWorkspace: async (recent) => {
    const current = get().recentWorkspaces;
    const filtered = current.filter((r) =>
      recent.path ? r.path !== recent.path : r.name !== recent.name,
    );
    const updated = [recent, ...filtered].slice(0, 20);
    set({ recentWorkspaces: updated });
    try {
      await saveRecents(updated);
    } catch {
      // Best-effort persistence
    }
  },

  saveWorkspacePreset: async (preset) => {
    const current = get().workspacePresets;
    const filtered = current.filter((p) => p.id !== preset.id);
    const updated = [...filtered, preset];
    set({ workspacePresets: updated });
    try {
      await savePresets(updated);
    } catch {
      // Best-effort persistence
    }
  },

  createWizardTab: () => {
    const currentTabs = getSyncedTabs(get());
    const tabId = generateNextTabId(currentTabs);
    const newTab: TabState = {
      id: tabId,
      title: "New Workspace",
      isWizard: true,
      layout: { type: "leaf", id: "" },
      focusedPath: [],
    };
    set((state) => {
      const current = getSyncedTabs(state);
      const tabs = [...current, newTab];
      return {
        tabs,
        activeTabId: tabId,
        wizardStep: 1,
        layout: newTab.layout,
        focusedPath: newTab.focusedPath,
        tabFocusHistory: [tabId, ...state.tabFocusHistory.filter((id) => id !== tabId)],
      };
    });
    void get().saveLayout().catch(() => {});
    return tabId;
  },

  launchWorkspaceForTab: async (tabId, config) => {
    const count = Math.max(1, config.terminalCount || 1);
    const sessionIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = await get().spawnSession(config.cwd, config.shell);
      sessionIds.push(id);
      if (config.commands && config.commands[i] && config.commands[i].trim()) {
        const cmd = config.commands[i].trim();
        void ptyWrite(id, `${cmd}\n`).catch(() => {});
      }
    }

    const layout = createGridLayout(count, sessionIds);

    let title = config.name?.trim();
    if (!title && config.cwd) {
      const normalized = config.cwd.replace(/[\\/]+$/, "");
      const parts = normalized.split(/[\\/]/);
      title = parts[parts.length - 1] || config.cwd;
    }
    if (!title) {
      title = `Workspace ${tabId.replace("tab-", "")}`;
    }

    const targetFocusedPath = firstLeafPath(layout);

    set((state) => {
      const currentTabs = getSyncedTabs(state);
      const tabs = currentTabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              title,
              isWizard: false,
              layout,
              focusedPath: targetFocusedPath,
            }
          : t,
      );
      const isActive = state.activeTabId === tabId;
      return {
        tabs,
        ...(isActive ? { layout, focusedPath: targetFocusedPath } : {}),
      };
    });

    const recentEntry: RecentWorkspace = {
      name: title,
      path: config.cwd || "",
      terminal_count: count,
      last_opened: Date.now(),
    };
    await get().addRecentWorkspace(recentEntry);

    void get().saveLayout().catch(() => {});
  },

  launchCustomWorkspace: async (config) => {
    const count = Math.max(1, config.terminalCount || 1);
    const sessionIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = await get().spawnSession(config.cwd, config.shell);
      sessionIds.push(id);
      if (config.commands && config.commands[i] && config.commands[i].trim()) {
        const cmd = config.commands[i].trim();
        void ptyWrite(id, `${cmd}\n`).catch(() => {});
      }
    }

    const layout = createGridLayout(count, sessionIds);
    const currentTabs = getSyncedTabs(get());
    const tabId = generateNextTabId(currentTabs);

    let title = config.name?.trim();
    if (!title && config.cwd) {
      const normalized = config.cwd.replace(/[\\/]+$/, "");
      const parts = normalized.split(/[\\/]/);
      title = parts[parts.length - 1] || config.cwd;
    }
    if (!title) {
      title = `Workspace ${tabId.replace("tab-", "")}`;
    }

    const newTab: TabState = {
      id: tabId,
      title,
      layout,
      focusedPath: firstLeafPath(layout),
    };

    set((state) => {
      const current = getSyncedTabs(state);
      const tabs = [...current, newTab];
      return {
        tabs,
        activeTabId: tabId,
        layout: newTab.layout,
        focusedPath: newTab.focusedPath,
        isSetupWizardOpen: false,
        tabFocusHistory: [tabId, ...state.tabFocusHistory.filter((id) => id !== tabId)],
      };
    });

    const recentEntry: RecentWorkspace = {
      name: title,
      path: config.cwd || "",
      terminal_count: count,
      last_opened: Date.now(),
    };
    await get().addRecentWorkspace(recentEntry);

    void get().saveLayout().catch(() => {});
    return tabId;
  },

  setAppMode: (mode) => set({ activeAppMode: mode }),

  navigateBrowser: (url) => {
    const trimmed = url.trim();
    if (!trimmed) {
      set({ browserUrl: "", browserHistory: [], historyIndex: -1 });
      return;
    }
    set((state) => {
      const currentHistory = state.browserHistory.slice(0, state.historyIndex + 1);
      const newHistory = [...currentHistory, trimmed];
      return {
        browserUrl: trimmed,
        browserHistory: newHistory,
        historyIndex: newHistory.length - 1,
      };
    });
  },

  browserGoBack: () => {
    set((state) => {
      if (state.historyIndex <= 0) return state;
      const nextIndex = state.historyIndex - 1;
      return {
        historyIndex: nextIndex,
        browserUrl: state.browserHistory[nextIndex] ?? state.browserUrl,
      };
    });
  },

  browserGoForward: () => {
    set((state) => {
      if (state.historyIndex >= state.browserHistory.length - 1) return state;
      const nextIndex = state.historyIndex + 1;
      return {
        historyIndex: nextIndex,
        browserUrl: state.browserHistory[nextIndex] ?? state.browserUrl,
      };
    });
  },

  browserReload: () => {
    const { browserUrl } = get();
    if (browserUrl) {
      set({ browserUrl });
    }
  },

  setDevicePreset: (preset) => set({ devicePreset: preset }),

  addDetectedPort: (portInfo) => {
    set((state) => {
      const title = portInfo.title ?? `Port ${portInfo.port}`;
      const timestamp = portInfo.timestamp ?? Date.now();
      const entry: DetectedPort = {
        port: portInfo.port,
        url: portInfo.url,
        title,
        timestamp,
      };
      const existingIndex = state.detectedPorts.findIndex((p) => p.port === portInfo.port);
      if (existingIndex >= 0) {
        const updated = [...state.detectedPorts];
        updated[existingIndex] = entry;
        return { detectedPorts: updated };
      }
      return { detectedPorts: [...state.detectedPorts, entry] };
    });
  },

  clearDetectedPorts: () => set({ detectedPorts: [] }),

  scanOutputForPorts: (text: string) => {
    const portRegex = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):([0-9]{2,5})/gi;
    let match: RegExpExecArray | null;
    while ((match = portRegex.exec(text)) !== null) {
      const port = parseInt(match[1], 10);
      if (port > 0 && port <= 65535) {
        const url = `http://localhost:${port}`;
        get().addDetectedPort({ port, url, title: `Localhost :${port}`, timestamp: Date.now() });
      }
    }
  },

  openFileInEditor: async (path: string, content?: string) => {
    const state = get();
    const existing = state.editorTabs.find((t) => t.path === path);
    if (existing) {
      set({
        activeEditorPath: path,
        editorViewMode: existing.isMarkdown ? "markdown-split" : "edit",
      });
      return;
    }

    let fileContent = content;
    if (fileContent === undefined) {
      fileContent = await readFile(path);
    }

    const isMarkdown = path.endsWith(".md") || path.endsWith(".markdown");
    const newTab: EditorTab = {
      path,
      name: getFileName(path),
      content: fileContent,
      originalContent: fileContent,
      isDirty: false,
      language: detectEditorLanguage(path),
      isMarkdown,
    };

    set((s) => ({
      editorTabs: [...s.editorTabs, newTab],
      activeEditorPath: path,
      editorViewMode: isMarkdown ? "markdown-split" : "edit",
    }));
  },

  closeEditorTab: (path: string) => {
    set((state) => {
      const idx = state.editorTabs.findIndex((t) => t.path === path);
      if (idx === -1) return state;

      const remaining = state.editorTabs.filter((t) => t.path !== path);
      let activePath = state.activeEditorPath;

      if (activePath === path) {
        if (remaining.length === 0) {
          activePath = null;
        } else {
          const nextIdx = Math.min(Math.max(0, idx), remaining.length - 1);
          activePath = remaining[nextIdx].path;
        }
      }

      return {
        editorTabs: remaining,
        activeEditorPath: activePath,
      };
    });
  },

  setActiveEditorTab: (path: string) => set({ activeEditorPath: path }),

  updateEditorContent: (path: string, content: string) => {
    set((state) => ({
      editorTabs: state.editorTabs.map((t) =>
        t.path === path
          ? {
              ...t,
              content,
              isDirty: content !== t.originalContent,
            }
          : t,
      ),
    }));

    const delay = get().settings.general.editorAutoSaveDelay;
    if (delay > 0) {
      if (editorAutoSaveTimer) {
        clearTimeout(editorAutoSaveTimer);
      }
      editorAutoSaveTimer = setTimeout(() => {
        void get().saveActiveFile();
      }, delay);
    }
  },

  saveActiveFile: async () => {
    const { activeEditorPath, editorTabs } = get();
    if (!activeEditorPath) return;
    const activeTab = editorTabs.find((t) => t.path === activeEditorPath);
    if (!activeTab) return;

    await writeFile(activeTab.path, activeTab.content);
    set((state) => ({
      editorTabs: state.editorTabs.map((t) =>
        t.path === activeEditorPath
          ? {
              ...t,
              isDirty: false,
              originalContent: t.content,
            }
          : t,
      ),
    }));
  },

  stageAiDiff: (path: string, original: string, modified: string, summary?: string) => {
    const state = get();
    const existing = state.editorTabs.find((t) => t.path === path);
    const isMarkdown = path.endsWith(".md") || path.endsWith(".markdown");

    let tabs = state.editorTabs;
    if (!existing) {
      const newTab: EditorTab = {
        path,
        name: getFileName(path),
        content: original,
        originalContent: original,
        isDirty: false,
        language: detectEditorLanguage(path),
        isMarkdown,
      };
      tabs = [...tabs, newTab];
    }

    set({
      editorTabs: tabs,
      activeEditorPath: path,
      pendingAiDiff: { path, original, modified, summary },
      editorViewMode: "diff",
    });
  },

  acceptAiDiff: async () => {
    const { pendingAiDiff } = get();
    if (!pendingAiDiff) return;

    const { path, modified } = pendingAiDiff;
    await writeFile(path, modified);

    set((state) => ({
      pendingAiDiff: null,
      editorViewMode: "edit",
      editorTabs: state.editorTabs.map((t) =>
        t.path === path
          ? {
              ...t,
              content: modified,
              originalContent: modified,
              isDirty: false,
            }
          : t,
      ),
    }));
  },

  rejectAiDiff: () => {
    set({
      pendingAiDiff: null,
      editorViewMode: "edit",
    });
  },

  setEditorViewMode: (mode: EditorViewMode) => set({ editorViewMode: mode }),

  openSettings: (tab?: SettingsTabId) =>
    set({ isSettingsOpen: true, activeSettingsTab: tab || "general" }),

  closeSettings: () => set({ isSettingsOpen: false }),

  updateSettings: (partial) => {
    const current = get().settings;
    const updated: AppSettings = {
      ...current,
      ...partial,
      general: {
        ...current.general,
        ...(partial.general || {}),
      },
      appearance: {
        ...current.appearance,
        ...(partial.appearance || {}),
      },
    };
    set({ settings: updated });
    if (settingsSaveTimer) {
      clearTimeout(settingsSaveTimer);
    }
    settingsSaveTimer = setTimeout(() => {
      void transportSaveSettings(get().settings).catch(() => {});
    }, 100);
  },

  updateAppearanceSettings: (partial) => {
    const current = get().settings;
    const updated: AppSettings = {
      ...current,
      appearance: {
        ...current.appearance,
        ...partial,
      },
    };
    set({ settings: updated });
    if (settingsSaveTimer) {
      clearTimeout(settingsSaveTimer);
    }
    settingsSaveTimer = setTimeout(() => {
      void transportSaveSettings(get().settings).catch(() => {});
    }, 100);
  },

  resolveDefaultCwd: () => {
    const { settings } = get();
    const { defaultCwdMode, customDefaultCwd } = settings.general;
    if (defaultCwdMode === "last_active") {
      return get().getActiveCwd() || undefined;
    }
    if (defaultCwdMode === "custom") {
      return customDefaultCwd.trim() || undefined;
    }
    return undefined;
  },

  loadSettingsData: async () => {
    try {
      const loaded = await transportLoadSettings();
      if (loaded) {
        set({ settings: loaded });
      }
    } catch {
      // Keep default settings on error
    }
  },
}));
