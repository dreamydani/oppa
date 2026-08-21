import React from "react";
import { useTerminalStore } from "../../store/terminalStore";
import type {
  DefaultCwdMode,
  StartupBehavior,
  TabSwitchMode,
  BrowserSearchEngine,
} from "../../lib/settings/types";
import "./GeneralSettingsPane.css";

export function GeneralSettingsPane(): React.ReactElement {
  const general = useTerminalStore((s) => s.settings.general);
  const updateSettings = useTerminalStore((s) => s.updateSettings);

  const setCwdMode = (mode: DefaultCwdMode) => {
    updateSettings({ general: { defaultCwdMode: mode } });
  };

  const setCustomCwd = (val: string) => {
    updateSettings({ general: { customDefaultCwd: val } });
  };

  const setStartupBehavior = (behavior: StartupBehavior) => {
    updateSettings({ general: { startupBehavior: behavior } });
  };

  const setTabSwitchMode = (mode: TabSwitchMode) => {
    updateSettings({ general: { tabSwitchMode: mode } });
  };

  const toggleConfirmCloseTab = () => {
    updateSettings({
      general: { confirmCloseTabWithMultiplePanes: !general.confirmCloseTabWithMultiplePanes },
    });
  };

  const toggleConfirmQuit = () => {
    updateSettings({
      general: { confirmQuitWithRunningProcesses: !general.confirmQuitWithRunningProcesses },
    });
  };

  const toggleAutoResumeAgents = () => {
    updateSettings({ general: { autoResumeAgents: !general.autoResumeAgents } });
  };

  const toggleWordWrap = () => {
    updateSettings({ general: { editorWordWrap: !general.editorWordWrap } });
  };

  const setAutoSaveDelay = (delay: number) => {
    updateSettings({ general: { editorAutoSaveDelay: delay } });
  };

  const setSearchEngine = (engine: BrowserSearchEngine) => {
    updateSettings({ general: { browserSearchEngine: engine } });
  };

  const setHomePage = (url: string) => {
    updateSettings({ general: { browserHomePage: url } });
  };

  return (
    <div className="settings-pane" role="region" aria-label="General Settings">
      <div className="settings-pane-container">
        <div className="settings-pane-header">
          <h2 className="settings-pane-title">General</h2>
          <p className="settings-pane-desc">
            Workspace behavior, navigation, and defaults.
          </p>
        </div>

        <div className="settings-pane-content">
        {/* Workspace & Startup */}
        <section className="settings-card" aria-labelledby="heading-workspace-startup">
          <h3 id="heading-workspace-startup" className="settings-card-title">
            Workspace &amp; Startup
          </h3>

          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Default Working Directory</span>
              <span className="settings-row-desc">
                Choose the initial directory when opening new tabs and terminals.
              </span>
            </div>
            <div className="settings-row-control">
              <div className="settings-segmented-group" role="group" aria-label="Default Working Directory">
                <button
                  type="button"
                  className={`settings-segmented-btn ${general.defaultCwdMode === "home" ? "active" : ""}`}
                  onClick={() => setCwdMode("home")}
                >
                  Home (~)
                </button>
                <button
                  type="button"
                  className={`settings-segmented-btn ${general.defaultCwdMode === "last_active" ? "active" : ""}`}
                  onClick={() => setCwdMode("last_active")}
                >
                  Last Active
                </button>
                <button
                  type="button"
                  className={`settings-segmented-btn ${general.defaultCwdMode === "custom" ? "active" : ""}`}
                  onClick={() => setCwdMode("custom")}
                >
                  Custom Path
                </button>
              </div>
            </div>
          </div>

          {general.defaultCwdMode === "custom" && (
            <div className="settings-sub-row">
              <label htmlFor="custom-cwd-input" className="settings-sub-label">
                Custom Path:
              </label>
              <input
                id="custom-cwd-input"
                type="text"
                className="settings-input"
                placeholder="/path/to/projects"
                value={general.customDefaultCwd}
                onChange={(e) => setCustomCwd(e.target.value)}
                aria-label="Custom Path"
              />
            </div>
          )}

          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Startup Behavior</span>
              <span className="settings-row-desc">
                Determine what OPPA opens on initial application launch.
              </span>
            </div>
            <div className="settings-row-control">
              <div className="settings-segmented-group" role="group" aria-label="Startup Behavior">
                <button
                  type="button"
                  className={`settings-segmented-btn ${general.startupBehavior === "restore_previous" ? "active" : ""}`}
                  onClick={() => setStartupBehavior("restore_previous")}
                >
                  Restore Session
                </button>
                <button
                  type="button"
                  className={`settings-segmented-btn ${general.startupBehavior === "workspace_launcher" ? "active" : ""}`}
                  onClick={() => setStartupBehavior("workspace_launcher")}
                >
                  Workspace Launcher
                </button>
                <button
                  type="button"
                  className={`settings-segmented-btn ${general.startupBehavior === "fresh_terminal" ? "active" : ""}`}
                  onClick={() => setStartupBehavior("fresh_terminal")}
                >
                  Fresh Terminal
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* Navigation & Confirmations */}
        <section className="settings-card" aria-labelledby="heading-navigation">
          <h3 id="heading-navigation" className="settings-card-title">
            Navigation &amp; Confirmations
          </h3>

          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Tab Switching Mode (Ctrl+Tab)</span>
              <span className="settings-row-desc">
                Choose whether Ctrl+Tab cycles tabs sequentially by index or switches between most recently active tabs.
              </span>
            </div>
            <div className="settings-row-control">
              <div className="settings-segmented-group" role="group" aria-label="Tab Switching Mode">
                <button
                  type="button"
                  className={`settings-segmented-btn ${general.tabSwitchMode === "sequential" ? "active" : ""}`}
                  onClick={() => setTabSwitchMode("sequential")}
                >
                  Sequential (1→2→3)
                </button>
                <button
                  type="button"
                  className={`settings-segmented-btn ${general.tabSwitchMode === "mru" ? "active" : ""}`}
                  onClick={() => setTabSwitchMode("mru")}
                >
                  MRU (Recent First)
                </button>
              </div>
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Confirm before closing multi-pane tabs</span>
              <span className="settings-row-desc">
                Prompt for confirmation when closing a tab containing multiple split panes.
              </span>
            </div>
            <div className="settings-row-control">
              <button
                type="button"
                role="switch"
                aria-checked={general.confirmCloseTabWithMultiplePanes}
                aria-label="Confirm before closing multi-pane tabs"
                className={`settings-switch ${general.confirmCloseTabWithMultiplePanes ? "checked" : ""}`}
                onClick={toggleConfirmCloseTab}
              >
                <span className="settings-switch-thumb" />
              </button>
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Confirm quit with running processes</span>
              <span className="settings-row-desc">
                Prompt for confirmation before quitting when active processes are still running in terminals.
              </span>
            </div>
            <div className="settings-row-control">
              <button
                type="button"
                role="switch"
                aria-checked={general.confirmQuitWithRunningProcesses}
                aria-label="Confirm quit with running processes"
                className={`settings-switch ${general.confirmQuitWithRunningProcesses ? "checked" : ""}`}
                onClick={toggleConfirmQuit}
              >
                <span className="settings-switch-thumb" />
              </button>
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Resume agents after cold boot</span>
              <span className="settings-row-desc">
                After a shutdown or reboot, relaunch agent CLIs (Claude Code, Codex, Gemini, Aider,
                Antigravity) that were running, using their native resume.
              </span>
            </div>
            <div className="settings-row-control">
              <button
                type="button"
                role="switch"
                aria-checked={general.autoResumeAgents}
                aria-label="Resume agents after cold boot"
                className={`settings-switch ${general.autoResumeAgents ? "checked" : ""}`}
                onClick={toggleAutoResumeAgents}
              >
                <span className="settings-switch-thumb" />
              </button>
            </div>
          </div>
        </section>

        {/* Code Editor */}
        <section className="settings-card" aria-labelledby="heading-editor">
          <h3 id="heading-editor" className="settings-card-title">
            Code Editor
          </h3>

          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Editor Word Wrap</span>
              <span className="settings-row-desc">
                Toggle line wrapping in the code editor viewport.
              </span>
            </div>
            <div className="settings-row-control">
              <button
                type="button"
                role="switch"
                aria-checked={general.editorWordWrap}
                aria-label="Editor Word Wrap"
                className={`settings-switch ${general.editorWordWrap ? "checked" : ""}`}
                onClick={toggleWordWrap}
              >
                <span className="settings-switch-thumb" />
              </button>
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Auto-Save Delay</span>
              <span className="settings-row-desc">
                Automatically save modified editor files after a period of inactivity.
              </span>
            </div>
            <div className="settings-row-control">
              <select
                aria-label="Auto-Save Delay"
                className="settings-select"
                value={general.editorAutoSaveDelay}
                onChange={(e) => setAutoSaveDelay(Number(e.target.value))}
              >
                <option value="0">Off (0)</option>
                <option value="1000">1000 ms (1s)</option>
                <option value="3000">3000 ms (3s)</option>
                <option value="5000">5000 ms (5s)</option>
              </select>
            </div>
          </div>
        </section>

        {/* Web Browser */}
        <section className="settings-card" aria-labelledby="heading-browser">
          <h3 id="heading-browser" className="settings-card-title">
            Web Browser
          </h3>

          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Default Search Engine</span>
              <span className="settings-row-desc">
                Search provider used when typing non-URL queries into the browser omnibox.
              </span>
            </div>
            <div className="settings-row-control">
              <select
                aria-label="Default Search Engine"
                className="settings-select"
                value={general.browserSearchEngine}
                onChange={(e) => setSearchEngine(e.target.value as BrowserSearchEngine)}
              >
                <option value="duckduckgo">DuckDuckGo</option>
                <option value="google">Google</option>
                <option value="bing">Bing</option>
              </select>
            </div>
          </div>

          <div className="settings-row">
            <div className="settings-row-info">
              <span className="settings-row-label">Home Page URL</span>
              <span className="settings-row-desc">
                Initial web page loaded when opening a new browser tab or viewport.
              </span>
            </div>
            <div className="settings-row-control">
              <input
                type="text"
                aria-label="Home Page URL"
                className="settings-input"
                placeholder="https://duckduckgo.com"
                value={general.browserHomePage}
                onChange={(e) => setHomePage(e.target.value)}
              />
            </div>
          </div>
        </section>
      </div>
      </div>
    </div>
  );
}
