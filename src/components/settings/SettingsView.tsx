import React from "react";
import { SettingsSidebar } from "./SettingsSidebar";
import { GeneralSettingsPane } from "./GeneralSettingsPane";
import { ShortcutsSettingsPane } from "./ShortcutsSettingsPane";
import { useTerminalStore } from "../../store/terminalStore";
import "./SettingsView.css";

export function SettingsView(): React.ReactElement {
  const activeSettingsTab = useTerminalStore((s) => s.activeSettingsTab);

  return (
    <div className="settings-view" role="main" aria-label="Settings" data-testid="settings-view">
      <SettingsSidebar />
      <div className="settings-content-area" data-testid="settings-content-area">
        {activeSettingsTab === "general" && <GeneralSettingsPane />}
        {activeSettingsTab === "shortcuts" && <ShortcutsSettingsPane />}
        {activeSettingsTab === "appearance" && (
          <div className="settings-pane settings-placeholder-pane">
            <div className="settings-pane-container">
              <div className="settings-pane-header">
                <h2 className="settings-pane-title">Appearance</h2>
                <p className="settings-pane-desc">Themes, fonts, and window styling options.</p>
              </div>
              <div className="settings-placeholder-content">
                <p>Appearance settings coming soon.</p>
              </div>
            </div>
          </div>
        )}
        {activeSettingsTab === "terminal" && (
          <div className="settings-pane settings-placeholder-pane">
            <div className="settings-pane-container">
              <div className="settings-pane-header">
                <h2 className="settings-pane-title">Terminal</h2>
                <p className="settings-pane-desc">Cursor style, scrollback buffers, and shell configurations.</p>
              </div>
              <div className="settings-placeholder-content">
                <p>Terminal settings coming soon.</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
