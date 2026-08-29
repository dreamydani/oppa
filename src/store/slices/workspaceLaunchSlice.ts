// Workspace launching: the setup wizard, launcher modal state, recent
// workspaces, saved presets, and the grid-layout launch flows.

import { firstLeafPath } from "../../lib/pane-manager/layout";
import {
  ptyWrite,
} from "../../lib/pty/transport";
import {
  saveRecents,
  loadRecents,
  savePresets,
  loadPresets,
} from "../../lib/workspace/transport";
import type {
  RecentWorkspace,
  WorkspacePreset,
} from "../../lib/workspace/transport";
import { createGridLayout } from "../../lib/pane-manager/gridLayout";
import type { TerminalState } from "../terminalStore";
import { generateNextTabId, getActiveTab, getSyncedTabs } from "./layoutQueries";
import { triggerDebouncedSaveLayout } from "./layoutSaveScheduler";
import type { TabState } from "./paneLayoutSlice";

type Set = (
  partial:
    | Partial<TerminalState>
    | ((state: TerminalState) => Partial<TerminalState>),
) => void;

export interface WorkspaceConfig {
  name?: string;
  cwd?: string;
  terminalCount: number;
  shell?: string;
  commands?: string[];
  agentPersona?: string;
}

export interface WorkspaceLaunchSlice {
  isWorkspaceLauncherOpen: boolean;
  isSetupWizardOpen: boolean;
  wizardStep: 1 | 2 | 3;
  recentWorkspaces: RecentWorkspace[];
  workspacePresets: WorkspacePreset[];
  openWorkspaceLauncher: () => void;
  closeWorkspaceLauncher: () => void;
  toggleWorkspaceLauncher: () => void;
  openSetupWizard: () => void;
  closeSetupWizard: () => void;
  setWizardStep: (step: 1 | 2 | 3) => void;
  loadWizardData: () => Promise<void>;
  addRecentWorkspace: (recent: RecentWorkspace) => Promise<void>;
  saveWorkspacePreset: (preset: WorkspacePreset) => Promise<void>;
  createWizardTab: () => string;
  launchWorkspaceForTab: (tabId: string, config: WorkspaceConfig) => Promise<void>;
  launchCustomWorkspace: (config: WorkspaceConfig) => Promise<string>;
  getActiveCwd: () => string | undefined;
}

function deriveWorkspaceTitle(
  config: WorkspaceConfig,
  tabId: string,
): string {
  let title = config.name?.trim();
  if (!title && config.cwd) {
    const normalized = config.cwd.replace(/[\\/]+$/, "");
    const parts = normalized.split(/[\\/]/);
    title = parts[parts.length - 1] || config.cwd;
  }
  if (!title) {
    title = `Workspace ${tabId.replace("tab-", "")}`;
  }
  return title;
}

export function createWorkspaceLaunchSlice(
  set: Set,
  get: () => TerminalState,
): WorkspaceLaunchSlice {
  return {
    isWorkspaceLauncherOpen: false,
    isSetupWizardOpen: false,
    wizardStep: 1,
    recentWorkspaces: [],
    workspacePresets: [],

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
      // Parallel spawns; array order preserves pane order regardless of resolve order.
      const sessionIds = await Promise.all(
        Array.from({ length: count }, async (_, i) => {
          const id = await get().spawnSession(config.cwd, config.shell);
          const cmd = config.commands?.[i]?.trim();
          if (cmd) void ptyWrite(id, `${cmd}\n`).catch(() => {});
          return id;
        }),
      );

      const layout = createGridLayout(count, sessionIds);
      const title = deriveWorkspaceTitle(config, tabId);
      const targetFocusedPath = firstLeafPath(layout);

      set((state) => {
        const currentTabs = getSyncedTabs(state);
        const tabs = currentTabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                title,
                workspaceKey: config.cwd || t.workspaceKey,
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
      // Parallel spawns; array order preserves pane order regardless of resolve order.
      const sessionIds = await Promise.all(
        Array.from({ length: count }, async (_, i) => {
          const id = await get().spawnSession(config.cwd, config.shell);
          const cmd = config.commands?.[i]?.trim();
          if (cmd) void ptyWrite(id, `${cmd}\n`).catch(() => {});
          return id;
        }),
      );

      const layout = createGridLayout(count, sessionIds);
      const currentTabs = getSyncedTabs(get());
      const tabId = generateNextTabId(currentTabs);
      const title = deriveWorkspaceTitle(config, tabId);

      const newTab: TabState = {
        id: tabId,
        title,
        ...(config.cwd ? { workspaceKey: config.cwd } : {}),
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
  };
}

// focus() is a runtime import kept at the bottom like its sibling slices to
// keep the import block purely types + transport.
import { focus } from "../../lib/pane-manager/layout";
