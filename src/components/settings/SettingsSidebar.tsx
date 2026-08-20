import React from "react";
import { ArrowLeft, Settings, Palette, Terminal, Keyboard } from "lucide-react";
import { useTerminalStore } from "../../store/terminalStore";
import type { SettingsTabId } from "../../lib/settings/types";
import "./SettingsSidebar.css";

interface SettingsCategory {
  id: SettingsTabId;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  disabled?: boolean;
  badge?: string;
}

const CATEGORIES: SettingsCategory[] = [
  {
    id: "general",
    label: "General",
    icon: Settings,
  },
  {
    id: "appearance",
    label: "Appearance",
    icon: Palette,
  },
  {
    id: "terminal",
    label: "Terminal",
    icon: Terminal,
    disabled: true,
    badge: "Coming Soon",
  },
  {
    id: "shortcuts",
    label: "Shortcuts",
    icon: Keyboard,
  },
];

export function SettingsSidebar(): React.ReactElement {
  const activeSettingsTab = useTerminalStore((s) => s.activeSettingsTab);
  const openSettings = useTerminalStore((s) => s.openSettings);
  const closeSettings = useTerminalStore((s) => s.closeSettings);

  return (
    <aside className="settings-sidebar" aria-label="Settings navigation">
      <div className="settings-sidebar-header">
        <button
          type="button"
          className="settings-back-btn"
          onClick={() => closeSettings()}
          title="Back to terminal (Esc)"
          aria-label="Back"
        >
          <ArrowLeft size={16} className="settings-back-icon" />
          <span className="settings-back-label">Back</span>
          <kbd className="settings-back-kbd">Esc</kbd>
        </button>
      </div>

      <nav className="settings-nav-list" role="navigation" aria-label="Settings categories">
        {CATEGORIES.map((cat) => {
          const isActive = activeSettingsTab === cat.id;
          return (
            <button
              key={cat.id}
              type="button"
              className={`settings-nav-item ${isActive ? "active" : ""} ${cat.disabled ? "disabled" : ""}`}
              disabled={cat.disabled}
              onClick={() => !cat.disabled && openSettings(cat.id)}
              aria-current={isActive ? "page" : undefined}
            >
              <span className="settings-nav-icon">
                <cat.icon size={16} />
              </span>
              <span className="settings-nav-label">{cat.label}</span>
              {cat.badge && <span className="settings-nav-badge">{cat.badge}</span>}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
