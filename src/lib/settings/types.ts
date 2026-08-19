export type DefaultCwdMode = "home" | "last_active" | "custom";
export type StartupBehavior = "restore_previous" | "workspace_launcher" | "fresh_terminal";
export type TabSwitchMode = "sequential" | "mru";
export type BrowserSearchEngine = "duckduckgo" | "google" | "bing";
export type SettingsTabId = "general" | "appearance" | "terminal" | "shortcuts";

export interface GeneralSettings {
  defaultCwdMode: DefaultCwdMode;
  customDefaultCwd: string;
  startupBehavior: StartupBehavior;
  tabSwitchMode: TabSwitchMode;
  confirmCloseTabWithMultiplePanes: boolean;
  confirmQuitWithRunningProcesses: boolean;
  editorWordWrap: boolean;
  editorAutoSaveDelay: number; // 0 = disabled, milliseconds delay otherwise
  browserSearchEngine: BrowserSearchEngine;
  browserHomePage: string;
}

export interface AppSettings {
  general: GeneralSettings;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  general: {
    defaultCwdMode: "home",
    customDefaultCwd: "",
    startupBehavior: "restore_previous",
    tabSwitchMode: "sequential",
    confirmCloseTabWithMultiplePanes: true,
    confirmQuitWithRunningProcesses: true,
    editorWordWrap: true,
    editorAutoSaveDelay: 1000,
    browserSearchEngine: "duckduckgo",
    browserHomePage: "https://duckduckgo.com",
  },
};
