export type DefaultCwdMode = "home" | "last_active" | "custom";
export type StartupBehavior = "restore_previous" | "workspace_launcher" | "fresh_terminal";
export type TabSwitchMode = "sequential" | "mru";
export type BrowserSearchEngine = "duckduckgo" | "google" | "bing";
export type SettingsTabId = "general" | "appearance" | "terminal" | "shortcuts";

// `(string & {})` admits extension-contributed ids (e.g. "oppa.theme-pack:nord")
// while keeping literal autocompletion for built-ins.
export type TerminalThemeId =
  | "oppa_dark"
  | "dracula"
  | "tokyo_night"
  | "one_dark"
  | "nord"
  | "catppuccin_mocha"
  | "monokai_pro"
  | "solarized_dark"
  | "ghostty_dark"
  | "github_dark"
  | "minimal_light"
  | (string & {});

export type TerminalCursorStyle = "block" | "bar" | "underline";
export type AppThemeMode = "dark" | "light" | "system";
export type SidebarLaunchMode = "remember_last" | "open" | "collapsed";

export interface AppearanceSettings {
  appTheme: AppThemeMode;
  appFontFamily: string;
  uiZoom: number;
  sidebarOnLaunch: SidebarLaunchMode;
  showStatusBar: boolean;
  showTitlebarLogo: boolean;

  themeName: TerminalThemeId;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: TerminalCursorStyle;
  cursorBlink: boolean;
  dimInactivePanes: boolean;
}

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
  // Relaunch known agent CLIs after a cold boot via their native resume
  autoResumeAgents: boolean;
}

export interface AppSettings {
  general: GeneralSettings;
  appearance: AppearanceSettings;
}

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  appTheme: "dark",
  appFontFamily: "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  uiZoom: 1.0,
  sidebarOnLaunch: "remember_last",
  showStatusBar: true,
  showTitlebarLogo: true,

  themeName: "oppa_dark",
  fontFamily: "'Geist Mono', 'SF Mono', 'JetBrains Mono', Consolas, monospace",
  fontSize: 14,
  lineHeight: 1.2,
  cursorStyle: "block",
  cursorBlink: true,
  dimInactivePanes: true,
};

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
    autoResumeAgents: true,
  },
  appearance: DEFAULT_APPEARANCE_SETTINGS,
};
