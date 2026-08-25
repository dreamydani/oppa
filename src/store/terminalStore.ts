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
  ptyList,
  worktreeCreate,
  worktreeCreateAgent,
  worktreeList,
  worktreeSet,
  worktreeRemove,
  worktreePurge,
  worktreePs,
  repoAdd,
  repoList,
  onWorktreeChanged,
  onTitleChanged,
  onFocusRequested,
  onGitChanged,
  onPrChanged,
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
  scFileDiff,
  diffCommentsList,
  diffCommentAdd,
  diffCommentUpdate,
  diffCommentDelete,
  diffCommentsMarkSent,
  requestReviewEligibility,
  requestCreateReview,
  requestReviewStatus,
} from "../lib/pty/transport";
import type {
  PtySpawnOptions,
  WorktreeListEntry,
  WorktreeRecord,
  WorktreeAgentHandoff,
  RepoRecord,
  WorktreeStatus,
  SourceControlStatus,
  LocalBranches,
  HistoryResult,
  BranchCompare,
  PullOutcome,
  PushOutcome,
  GitArea,
  DiffComment,
  NewDiffComment,
  Eligibility,
  CreatedReview,
  PrStatus,
} from "../lib/pty/transport";
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
import {
  getSavedWindowState,
  applyWindowState,
} from "../lib/window/transport";
import type { WindowState } from "../lib/window/transport";

// Re-exported so existing import sites keep working after the layout types
// moved into `src/lib/pane-manager/layout.ts`.
export type { Layout, Path, DropZone } from "../lib/pane-manager/layout";
export type { RecentWorkspace, WorkspacePreset } from "../lib/workspace/transport";
export type {
  AppSettings,
  GeneralSettings,
  AppearanceSettings,
  AppThemeMode,
  SidebarLaunchMode,
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
  | "sleeping"
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

export interface ViewOnlyDiff {
  path: string;
  original: string;
  modified: string;
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


export interface TabState {
  id: string;
  title?: string;
  layout: Layout;
  focusedPath: Path;
  isWizard?: boolean;
  isSleeping?: boolean;
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
  spawnSession: (
    cwd?: string,
    shell?: string,
    existingId?: string,
    geometry?: { cols?: number; rows?: number },
    worktreeId?: string,
  ) => Promise<string>;
  killSession: (id: string) => Promise<void>;
  resizeSession: (id: string, cols: number, rows: number) => void;
  ackSession: (id: string, chars: number) => Promise<void>;
  setSessionStatus: (id: string, status: SessionStatus) => void;
  dismissSessionRestoredBanner: (sessionId: string) => void;
  updateSessionCwd: (id: string, cwd: string) => void;

  renameSession: (id: string, title: string) => void;
  substituteSessionId: (from: string, to: string) => void;
  createTab: (cwd?: string, worktreeId?: string, existingId?: string) => Promise<string>;
  closeTab: (tabId?: string) => Promise<void>;
  selectTab: (tabId: string) => void;
  wakeTab: (tabId: string) => Promise<void>;
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
  rightSidebarTab: "explorer" | "git" | "extensions";
  toggleLeftSidebar: () => void;
  setLeftSidebarWidth: (width: number) => void;
  toggleRightSidebar: () => void;
  setRightSidebarWidth: (width: number) => void;
  setRightSidebarTab: (tab: "explorer" | "git" | "extensions") => void;
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
  viewOnlyDiff: ViewOnlyDiff | null;
  openDiffView: (path: string, original: string, modified: string) => void;
  clearViewOnlyDiff: () => void;
  openGitDiff: (path: string, area: GitArea) => Promise<void>;
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
  worktrees: WorktreeListEntry[];
  worktreeLiveSessions: Record<string, number>;
  repos: RepoRecord[];
  leftSidebarView: "tabs" | "worktrees";
  isWorktreeCreateOpen: boolean;
  loadWorktrees: () => Promise<void>;
  loadRepos: () => Promise<void>;
  addRepo: (path: string) => Promise<RepoRecord>;
  createWorktree: (input: WorktreeCreateInput) => Promise<WorktreeRecord | null>;
  createWorktreeWithAgent: (input: WorktreeCreateAgentInput) => Promise<WorktreeAgentHandoff>;
  setWorktreeStatus: (id: string, status: WorktreeStatus) => Promise<void>;
  renameWorktree: (id: string, displayName: string) => Promise<void>;
  removeWorktree: (id: string, force?: boolean, deleteBranch?: boolean) => Promise<void>;
  purgeWorktree: (id: string) => Promise<void>;
  setLeftSidebarView: (view: "tabs" | "worktrees") => void;
  openWorktreeCreate: () => void;
  closeWorktreeCreate: () => void;

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
let layoutSaveTimer: ReturnType<typeof setTimeout> | null = null;
const pendingWakeTabs = new Map<string, Promise<void>>();

// Sessions whose terminal output changed since the last layout save.
// Module-level (not state) so marking costs a Set.add per data chunk with
// zero re-renders; saveLayout serializes only these buffers.
const dirtyScrollbackIds = new Set<string>();

export function markScrollbackDirty(id: string): void {
  if (id) dirtyScrollbackIds.add(id);
}

function discardDirtyScrollback(id: string): void {
  dirtyScrollbackIds.delete(id);
}

function triggerDebouncedSaveLayout(get: () => TerminalState, delayMs = 2000) {
  if (layoutSaveTimer) clearTimeout(layoutSaveTimer);
  layoutSaveTimer = setTimeout(() => {
    layoutSaveTimer = null;
    void get().saveLayout().catch(() => {});
  }, delayMs);
}

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
  viewOnlyDiff: null,
  settings: DEFAULT_APP_SETTINGS,
  isSettingsOpen: false,
  activeSettingsTab: "general",
  tabFocusHistory: [],
  worktrees: [],
  worktreeLiveSessions: {},
  repos: [],
  leftSidebarView: "tabs",
  isWorktreeCreateOpen: false,
  reviewByCwd: {},
  prStatusByWorktreeId: {},

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
      cachedScrollbacks: { ...state.cachedScrollbacks, [id]: buffer },
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
    discardDirtyScrollback(id);
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

  createTab: async (cwd, worktreeId, existingId) => {
    const resolvedCwd = cwd ?? get().resolveDefaultCwd();
    const sessionId = await get().spawnSession(resolvedCwd, undefined, existingId, undefined, worktreeId);
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
          discardDirtyScrollback(sId);
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
          const newId = await get().spawnSession(savedSession?.cwd, undefined, oldId, geometry);
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
      discardDirtyScrollback(removedId);
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
      version: 2,
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
    // Serialize only buffers with new output since the last write — a tab
    // switch or rename must not stringify every live terminal.
    const scrollbackPromises: Promise<void>[] = [];
    for (const s of Object.values(sessions)) {
      if (!dirtyScrollbackIds.has(s.id)) continue;
      // Clear per-id before awaiting: output landing mid-save re-marks it
      // for the next pass instead of being lost.
      discardDirtyScrollback(s.id);
      const buffer = serializers[s.id]?.() || cachedScrollbacks[s.id];
      if (buffer) {
        scrollbackPromises.push(saveScrollback(s.id, buffer).catch(() => {}));
      }
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
        sessions?: SessionInfo[];
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
        if (parsed.tabs.length === 0) {
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
          if (tab.id === activeTabId) {
            const remappedLayout = remapLeafIds(tab.layout, remap);
            return {
              id: tab.id,
              ...(tab.title !== undefined ? { title: tab.title } : {}),
              layout: remappedLayout,
              focusedPath: tab.focusedPath ?? firstLeafPath(remappedLayout),
              isSleeping: false,
            };
          }
          return {
            id: tab.id,
            ...(tab.title !== undefined ? { title: tab.title } : {}),
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


  toggleLeftSidebar: () => {
    set((state) => ({ leftSidebarOpen: !state.leftSidebarOpen }));
    triggerDebouncedSaveLayout(get);
  },

  setLeftSidebarWidth: (width) => {
    set({ leftSidebarWidth: width });
    triggerDebouncedSaveLayout(get);
  },

  toggleRightSidebar: () => {
    set((state) => ({ rightSidebarOpen: !state.rightSidebarOpen }));
    triggerDebouncedSaveLayout(get);
  },

  setRightSidebarWidth: (width) => {
    set({ rightSidebarWidth: width });
    triggerDebouncedSaveLayout(get);
  },

  setRightSidebarTab: (tab) => {
    set({ rightSidebarTab: tab });
    triggerDebouncedSaveLayout(get);
  },

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
    triggerDebouncedSaveLayout(get);
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

    triggerDebouncedSaveLayout(get);
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

    triggerDebouncedSaveLayout(get);
    return tabId;
  },

  setAppMode: (mode) => {
    set({ activeAppMode: mode });
    triggerDebouncedSaveLayout(get);
  },

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
        viewOnlyDiff: null,
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
      viewOnlyDiff: null,
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
      // Review-only diffs never mix with the AI accept/reject flow
      viewOnlyDiff: null,
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

  openDiffView: (path: string, original: string, modified: string) => {
    set({
      viewOnlyDiff: { path, original, modified },
      pendingAiDiff: null,
      activeAppMode: "editor",
    });
  },

  clearViewOnlyDiff: () =>
    set((s) => ({
      viewOnlyDiff: null,
      editorViewMode: s.pendingAiDiff ? s.editorViewMode : "edit",
    })),

  openGitDiff: async (path: string, area: GitArea) => {
    const dir = get().getActiveCwd();
    if (!dir) return;
    // Untracked has no HEAD version, so compare worktree against empty base
    const staged = area === "staged";
    const compareAgainstHead = area === "untracked";
    const diff = await scFileDiff(dir, path, staged, compareAgainstHead);
    const modified =
      diff.kind === "binary"
        ? "<binary file>"
        : diff.truncated
          ? "<diff too large — truncated>"
          : diff.modified_content;
    get().openDiffView(path, diff.original_content, modified);
  },

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

  setLeftSidebarView: (view) => {
    set({ leftSidebarView: view });
  },

  openWorktreeCreate: () => set({ isWorktreeCreateOpen: true }),
  closeWorktreeCreate: () => set({ isWorktreeCreateOpen: false }),

  gitStatus: null,
  gitBranches: null,
  gitHistory: null,
  gitCompare: null,
  diffComments: {},

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
}));

// Daemon-side mutations from any client must refresh the cards; debounced so a
// burst of events triggers one reload.
let worktreeReloadTimer: ReturnType<typeof setTimeout> | null = null;
void onWorktreeChanged(() => {
  if (worktreeReloadTimer) clearTimeout(worktreeReloadTimer);
  worktreeReloadTimer = setTimeout(() => {
    worktreeReloadTimer = null;
    void useTerminalStore.getState().loadWorktrees().catch(() => {});
  }, 300);
});

void onTitleChanged(({ id, title }) => {
  const state = useTerminalStore.getState();
  if (!state.sessions[id]) return;
  state.renameSession(id, title);
  const tab = state.tabs.find((t) => leafIds(t.layout).includes(id));
  if (tab) state.renameTab(tab.id, title);
});

void onFocusRequested(({ id }) => {
  const state = useTerminalStore.getState();
  const tab = state.tabs.find((t) => findLeafPath(t.layout, id) !== null);
  if (!tab) return;
  state.selectTab(tab.id);
  const path = tab.focusedPath ? findLeafPath(tab.layout, id) : null;
  if (path) state.focusPane(path);
});

// Daemon-side git mutations (any client, incl. CLI) refresh the panel; task 7
// toggles listening when the panel is closed to skip the work entirely.
let gitChangedListening = true;
export function setGitChangedListening(on: boolean) {
  gitChangedListening = on;
}
let gitReloadTimer: ReturnType<typeof setTimeout> | null = null;
void onGitChanged(() => {
  if (gitReloadTimer) clearTimeout(gitReloadTimer);
  gitReloadTimer = setTimeout(() => {
    gitReloadTimer = null;
    if (!gitChangedListening) return;
    const cwd = useTerminalStore.getState().getActiveCwd();
    if (cwd) void useTerminalStore.getState().refreshGitStatus(cwd).catch(() => {});
  }, 300);
});

let prChangedTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPrWorktreeId: string | null = null;
if (onPrChanged) {
  void onPrChanged((payload) => {
    // Remember targeted worktree for registry-level badge refresh
    if (payload?.worktree_id) pendingPrWorktreeId = payload.worktree_id;
    if (prChangedTimer) clearTimeout(prChangedTimer);
    prChangedTimer = setTimeout(() => {
      prChangedTimer = null;
      const state = useTerminalStore.getState();
      // Targeted worktree refresh for badge cache
      if (pendingPrWorktreeId) {
        const targetId = pendingPrWorktreeId;
        pendingPrWorktreeId = null;
        const entry = state.worktrees.find((w) => w.record.id === targetId);
        if (entry) void state.refreshReviewStatus(entry.record.path).catch(() => {});
      }
      const cwd = state.getActiveCwd();
      if (cwd) void state.refreshReviewStatus(cwd).catch(() => {});
    }, 300);
  });
}
