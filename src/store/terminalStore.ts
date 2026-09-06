// Terminal store composer: assembles the domain slices into one zustand
// store and keeps the public facade stable. Every slice owns one concern:
//   terminalSessionsSlice  live PTY sessions + scrollback registry
//   sessionActivitySlice   per-session working/idle dots
//   paneLayoutSlice        tabs, layout tree, save/restore pipeline
//   workspaceLaunchSlice   wizard, launcher, recents/presets, launch flows
//   appChromeSlice         sidebars, settings view, modals
//   browserPaneSlice       embedded browser mode + URL history + ports
//   codeEditorSlice        editor tabs, autosave, AI-diff review
//   settingsDataSlice      AppSettings document + persistence
//   worktreeRegistrySlice  worktree/repo cards + fleet spawn IPC
//   sourceControlSlice     git panel, diff notes, hosted reviews
//
// Everything below the store is re-exported so existing import sites
// (`../store/terminalStore`) keep working unchanged.

import { create } from "zustand";
import {
  createSessionsSlice,
  markScrollbackDirty,
} from "./slices/terminalSessionsSlice";
import type {
  SessionInfo,
  SessionSlice,
  SessionStatus,
  TerminalSession,
} from "./slices/terminalSessionsSlice";
import { DEFAULT_COLS, DEFAULT_ROWS } from "./slices/terminalSessionsSlice";
import { createSessionActivitySlice } from "./slices/sessionActivitySlice";
import type { SessionActivitySlice } from "./slices/sessionActivitySlice";
import { createAgentStatusSlice, isUnreadWorthyState } from "./slices/agentStatusSlice";
import type { AgentStatusSlice } from "./slices/agentStatusSlice";
import { createPaneLayoutSlice } from "./slices/paneLayoutSlice";
import type { PaneLayoutSlice, TabState } from "./slices/paneLayoutSlice";
import { createWorkspaceLaunchSlice } from "./slices/workspaceLaunchSlice";
import type { WorkspaceConfig, WorkspaceLaunchSlice } from "./slices/workspaceLaunchSlice";
import { createAppChromeSlice } from "./slices/appChromeSlice";
import type { AppChromeSlice } from "./slices/appChromeSlice";
import { createBrowserPaneSlice } from "./slices/browserPaneSlice";
import type {
  AppMode,
  BrowserPaneSlice,
  DevicePreset,
  DetectedPort,
} from "./slices/browserPaneSlice";
import {
  createCodeEditorSlice,
  detectEditorLanguage,
} from "./slices/codeEditorSlice";
import type {
  CodeEditorSlice,
  EditorTab,
  EditorViewMode,
  PendingAiDiff,
  ViewOnlyDiff,
} from "./slices/codeEditorSlice";
import { createSettingsDataSlice } from "./slices/settingsDataSlice";
import type { SettingsDataSlice } from "./slices/settingsDataSlice";
import {
  createWorktreeRegistrySlice,
  extractRepoName,
  selectProjectTree,
} from "./slices/worktreeRegistrySlice";
import type {
  BranchNode,
  FleetSpawnInput,
  ProjectNode,
  WorktreeCreateAgentInput,
  WorktreeCreateInput,
  WorktreeRegistrySlice,
} from "./slices/worktreeRegistrySlice";
import { createSourceControlSlice } from "./slices/sourceControlSlice";
import type { SourceControlSlice } from "./slices/sourceControlSlice";

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
export { generateNextTabId } from "./slices/layoutQueries";
export { selectProjectTree, extractRepoName };

export type { SessionInfo, SessionStatus, TerminalSession };
export { DEFAULT_COLS, DEFAULT_ROWS };
export { markScrollbackDirty, detectEditorLanguage };
export { createAgentStatusSlice } from "./slices/agentStatusSlice";
export type {
  BranchNode,
  ProjectNode,
  TabState,
  WorkspaceConfig,
  WorktreeCreateInput,
  WorktreeCreateAgentInput,
  FleetSpawnInput,
  AppMode,
  DevicePreset,
  DetectedPort,
  EditorTab,
  PendingAiDiff,
  ViewOnlyDiff,
};
export type { EditorViewMode };

export interface TerminalState
  extends SessionSlice,
    SessionActivitySlice,
    AgentStatusSlice,
    PaneLayoutSlice,
    WorkspaceLaunchSlice,
    AppChromeSlice,
    BrowserPaneSlice,
    CodeEditorSlice,
    SettingsDataSlice,
    WorktreeRegistrySlice,
    SourceControlSlice {}

type SliceSet = (
  partial:
    | Partial<TerminalState>
    | ((state: TerminalState) => Partial<TerminalState>),
) => void;

export const useTerminalStore = create<TerminalState>()((set, get) => ({
  ...createSessionsSlice(set as SliceSet, get),
  ...createSessionActivitySlice(),
  ...createAgentStatusSlice(set as SliceSet),
  ...createPaneLayoutSlice(set as SliceSet, get),
  ...createWorkspaceLaunchSlice(set as SliceSet, get),
  ...createAppChromeSlice(set as SliceSet, get),
  ...createBrowserPaneSlice(set as SliceSet, get),
  ...createCodeEditorSlice(set as SliceSet, get),
  ...createSettingsDataSlice(set as SliceSet, get),
  ...createWorktreeRegistrySlice(set as SliceSet, get),
  ...createSourceControlSlice(set as SliceSet, get),
}));

// ---- Global daemon-event subscriptions (module-level, installed once) ----

import {
  onTitleChanged,
  onFocusRequested,
  onSessionWorking,
  onAgentStatus,
} from "../lib/pty/transport";
import { onWorktreeChanged } from "../lib/worktree/transport";
import { onGitChanged, onPrChanged } from "../lib/git/transport";
import type { PrChangedPayload } from "../lib/git/transport";
import { findLeafPath, focus as focusLeaf } from "../lib/pane-manager/layout";
import { leafIds } from "./slices/layoutQueries";

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

void onTitleChanged(({ id, title, pinned }) => {
  const state = useTerminalStore.getState();
  if (!state.sessions[id]) return;
  // Pre-field backends only emitted manual renames, which pin.
  const isPinned = pinned ?? true;
  // A local manual pin wins over daemon auto titles (e.g. renamed here while
  // the daemon hasn't learned it yet); manual events always apply.
  if (!isPinned && state.sessions[id].titlePinned) return;
  state.renameSession(id, title);
  state.setTitlePinned(id, isPinned);
  const tab = state.tabs.find((t) => leafIds(t.layout).includes(id));
  // WHY tab guard: two auto-updating panes must not thrash one shared tab
  // title; manual renames always follow, auto only the focused pane.
  if (tab && (isPinned || focusLeaf(tab.layout, tab.focusedPath) === id)) {
    state.renameTab(tab.id, title);
  }
});

void onFocusRequested(({ id }) => {
  const state = useTerminalStore.getState();
  const tab = state.tabs.find((t) => findLeafPath(t.layout, id) !== null);
  if (!tab) return;
  state.selectTab(tab.id);
  const path = tab.focusedPath ? findLeafPath(tab.layout, id) : null;
  if (path) state.focusPane(path);
});

// Edge-triggered working/idle flips hydrate the switcher dots.
void onSessionWorking(({ sessionId, working }) => {
  // Events are edge-triggered; skip no-op flips so idle sessions stay quiet.
  if (useTerminalStore.getState().workingBySessionId[sessionId] === working) return;
  useTerminalStore.setState((state) => ({
    workingBySessionId: { ...state.workingBySessionId, [sessionId]: working },
  }));
});

// Hook-classified rich status entries are edge-triggered like SessionWorking;
// the whole entry rides in so panes/pills never infer agent state themselves.
void onAgentStatus(({ paneKey, entry }) => {
  if (!paneKey) return;
  const state = useTerminalStore.getState();
  if (state.statusBySessionId[paneKey]?.updated_at_ms === entry.updated_at_ms) return;
  // A done/blocked/waiting entry landing on a non-focused pane marks it unread
  // so pills can draw the attention dot until the user brings the pane forward.
  const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
  const focusedId = activeTab ? focusLeaf(activeTab.layout, activeTab.focusedPath) : null;
  const focused = paneKey === focusedId || paneKey === state.maximizedSessionId;
  const unread = isUnreadWorthyState(entry, focused)
    ? { ...state.unreadBySessionId, [paneKey]: true }
    : state.unreadBySessionId;
  useTerminalStore.setState((prev) => ({
    statusBySessionId: { ...prev.statusBySessionId, [paneKey]: entry },
    ...(prev.unreadBySessionId[paneKey] !== unread[paneKey]
      ? { unreadBySessionId: unread }
      : {}),
  }));
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
  void onPrChanged((payload: PrChangedPayload) => {
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
