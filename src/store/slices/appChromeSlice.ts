// Window chrome state: sidebar visibility/widths, settings view, and the
// worktree-create modal. Pure UI toggles; each change schedules a layout save
// so the chrome survives restarts.

import type { TerminalState } from "../terminalStore";
import { triggerDebouncedSaveLayout } from "./layoutSaveScheduler";

type Set = (
  partial:
    | Partial<TerminalState>
    | ((state: TerminalState) => Partial<TerminalState>),
) => void;

export interface WorktreeCreatePrefill {
  repoPath?: string;
}

export interface AppChromeSlice {
  leftSidebarOpen: boolean;
  leftSidebarWidth: number;
  rightSidebarOpen: boolean;
  rightSidebarWidth: number;
  rightSidebarTab: "explorer" | "git" | "extensions";
  isWorktreeCreateOpen: boolean;
  worktreeCreatePrefill: WorktreeCreatePrefill | null;
  isSettingsOpen: boolean;
  activeSettingsTab: import("../../lib/settings/types").SettingsTabId;
  toggleLeftSidebar: () => void;
  setLeftSidebarWidth: (width: number) => void;
  toggleRightSidebar: () => void;
  setRightSidebarWidth: (width: number) => void;
  setRightSidebarTab: (tab: "explorer" | "git" | "extensions") => void;
  openWorktreeCreate: (prefill?: WorktreeCreatePrefill) => void;
  closeWorktreeCreate: () => void;
  openSettings: (tab?: import("../../lib/settings/types").SettingsTabId) => void;
  closeSettings: () => void;
}

export function createAppChromeSlice(
  set: Set,
  get: () => TerminalState,
): AppChromeSlice {
  return {
    leftSidebarOpen: true,
    leftSidebarWidth: 240,
    rightSidebarOpen: false,
    rightSidebarWidth: 280,
    rightSidebarTab: "explorer",
    isWorktreeCreateOpen: false,
    worktreeCreatePrefill: null,
    isSettingsOpen: false,
    activeSettingsTab: "general",

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

    openWorktreeCreate: (prefill) =>
      set({ isWorktreeCreateOpen: true, worktreeCreatePrefill: prefill ?? null }),
    closeWorktreeCreate: () =>
      set({ isWorktreeCreateOpen: false, worktreeCreatePrefill: null }),

    openSettings: (tab) =>
      set({ isSettingsOpen: true, activeSettingsTab: tab || "general" }),

    closeSettings: () => set({ isSettingsOpen: false }),
  };
}
