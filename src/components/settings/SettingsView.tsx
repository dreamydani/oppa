import React from "react";
import { SettingsSidebar } from "./SettingsSidebar";
import { GeneralSettingsPane } from "./GeneralSettingsPane";
import { ShortcutsSettingsPane } from "./ShortcutsSettingsPane";
import { AppearanceSettingsPane } from "./AppearanceSettingsPane";
import { useTerminalStore } from "../../store/terminalStore";
import "./SettingsView.css";

export function SettingsView(): React.ReactElement {
  const activeSettingsTab = useTerminalStore((s) => s.activeSettingsTab);

  return (
    <div className="settings-view" role="main" aria-label="Settings" data-testid="settings-view">
      <SettingsSidebar />
      <div
        className="settings-content-area"
        data-testid="settings-content-area"
        // Keyed on the tab so switching unmounts and remounts the subtree —
        // without a new node there is no mount for the entrance to play on.
        key={activeSettingsTab}
        data-motion="view"
        data-state="open"
      >
        {activeSettingsTab === "general" && <GeneralSettingsPane />}
        {activeSettingsTab === "appearance" && <AppearanceSettingsPane />}
        {activeSettingsTab === "shortcuts" && <ShortcutsSettingsPane />}
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
