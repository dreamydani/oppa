import React, { useState, useMemo } from "react";
import { Search, X } from "lucide-react";
import "./ShortcutsSettingsPane.css";

export interface ShortcutItem {
  id: string;
  name: string;
  description?: string;
  combos: string[][];
}

export interface ShortcutCategory {
  id: string;
  title: string;
  shortcuts: ShortcutItem[];
}

export const SHORTCUT_CATEGORIES: ShortcutCategory[] = [
  {
    id: "tabs-workspaces",
    title: "Workspaces",
    shortcuts: [
      {
        id: "new-tab",
        name: "New Terminal Workspace",
        description: "Open a new single-terminal workspace",
        combos: [["Cmd/Ctrl", "T"]],
      },
      {
        id: "close-tab",
        name: "Close Workspace / Pane",
        description: "Close active workspace or split pane",
        combos: [["Cmd/Ctrl", "W"]],
      },
      {
        id: "cycle-next-tab",
        name: "Cycle Next Workspace",
        description: "Switch to the next workspace",
        combos: [["Ctrl", "Tab"]],
      },
      {
        id: "cycle-prev-tab",
        name: "Cycle Previous Workspace",
        description: "Switch to the previous workspace",
        combos: [["Ctrl", "Shift", "Tab"]],
      },
      {
        id: "direct-tab-jump",
        name: "Direct Workspace Jump",
        description: "Jump directly to workspace 1 through 9",
        combos: [["Alt/Cmd", "1..9"]],
      },
      {
        id: "workspace-launcher",
        name: "Workspace Setup Wizard",
        description: "Open the workspace setup wizard (terminal or parallel agents)",
        combos: [["Cmd/Ctrl", "N"]],
      },
    ],
  },
  {
    id: "split-panes",
    title: "Split Panes",
    shortcuts: [
      {
        id: "split-horizontal",
        name: "Split Horizontal",
        description: "Split current pane horizontally",
        combos: [["Cmd/Ctrl", "Shift", "D"]],
      },
      {
        id: "split-vertical",
        name: "Split Vertical",
        description: "Split current pane vertically",
        combos: [["Cmd/Ctrl", "Shift", "E"]],
      },
      {
        id: "move-focus-pane",
        name: "Move Focus to Pane",
        description: "Focus adjacent directional pane",
        combos: [["Cmd/Ctrl", "Arrows"]],
      },
      {
        id: "swap-focused-pane",
        name: "Swap Focused Pane",
        description: "Swap position with adjacent pane",
        combos: [["Alt", "Shift", "Arrows"]],
      },
    ],
  },
  {
    id: "sidebars-modes",
    title: "Sidebars & App Modes",
    shortcuts: [
      {
        id: "toggle-left-sidebar",
        name: "Toggle Left Sidebar",
        description: "Show or hide the navigation sidebar",
        combos: [["Cmd/Ctrl", "B"]],
      },
      {
        id: "toggle-right-sidebar",
        name: "Toggle Right Sidebar",
        description: "Show or hide the utility sidebar",
        combos: [["Cmd/Ctrl", "Shift", "B"]],
      },
      {
        id: "browser-mode",
        name: "Browser Mode",
        description: "Switch pane viewport to web browser",
        combos: [["Cmd/Ctrl", "1"]],
      },
      {
        id: "terminal-mode",
        name: "Terminal Mode",
        description: "Switch pane viewport to terminal shell",
        combos: [["Cmd/Ctrl", "2"]],
      },
      {
        id: "editor-mode",
        name: "Editor Mode",
        description: "Switch pane viewport to code editor",
        combos: [["Cmd/Ctrl", "3"]],
      },
    ],
  },
  {
    id: "settings-help",
    title: "Settings & Help",
    shortcuts: [
      {
        id: "open-settings",
        name: "Open Settings",
        description: "Open application preferences",
        combos: [["Cmd/Ctrl", ","]],
      },
      {
        id: "keyboard-shortcuts",
        name: "Keyboard Shortcuts",
        description: "Show keyboard shortcuts reference sheet",
        combos: [["F1"], ["Cmd/Ctrl", "/"]],
      },
      {
        id: "close-modal-back",
        name: "Close Modal / Back",
        description: "Close modal, settings, or search overlay",
        combos: [["Esc"]],
      },
      {
        id: "terminal-find",
        name: "Terminal Find",
        description: "Search in active terminal buffer",
        combos: [["Cmd/Ctrl", "F"]],
      },
    ],
  },
];

export function ShortcutsSettingsPane(): React.ReactElement {
  const [searchQuery, setSearchQuery] = useState("");

  const filteredCategories = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return SHORTCUT_CATEGORIES;

    return SHORTCUT_CATEGORIES.map((category) => {
      const categoryMatches = category.title.toLowerCase().includes(query);
      const filteredShortcuts = category.shortcuts.filter((shortcut) => {
        if (categoryMatches) return true;
        if (shortcut.name.toLowerCase().includes(query)) return true;
        if (shortcut.description?.toLowerCase().includes(query)) return true;
        const keyMatch = shortcut.combos.some((combo) =>
          combo.some((key) => key.toLowerCase().includes(query))
        );
        if (keyMatch) return true;
        const joinedComboMatch = shortcut.combos.some(
          (combo) =>
            combo.join(" ").toLowerCase().includes(query) ||
            combo.join("+").toLowerCase().includes(query) ||
            combo.join(" + ").toLowerCase().includes(query)
        );
        return joinedComboMatch;
      });

      return {
        ...category,
        shortcuts: filteredShortcuts,
      };
    }).filter((cat) => cat.shortcuts.length > 0);
  }, [searchQuery]);

  const totalShortcuts = useMemo(
    () => filteredCategories.reduce((acc, cat) => acc + cat.shortcuts.length, 0),
    [filteredCategories]
  );

  return (
    <div className="settings-pane shortcuts-settings-pane" role="region" aria-label="Keyboard Shortcuts">
      <div className="settings-pane-container">
        <div className="settings-pane-header">
          <div className="shortcuts-header-top">
            <div>
              <h2 className="settings-pane-title">Keyboard Shortcuts</h2>
              <p className="settings-pane-desc">
                Quick reference of all navigation, terminal, layout, and mode keybindings.
              </p>
            </div>
          </div>

        <div className="shortcuts-search-wrapper">
          <Search size={15} className="shortcuts-search-icon" aria-hidden="true" />
          <input
            type="text"
            className="shortcuts-search-input"
            placeholder="Search shortcuts..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="Search shortcuts"
          />
          {searchQuery && (
            <button
              type="button"
              className="shortcuts-search-clear"
              onClick={() => setSearchQuery("")}
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="settings-pane-content">
        {totalShortcuts === 0 ? (
          <div className="shortcuts-empty-state">
            <p className="shortcuts-empty-title">No shortcuts found</p>
            <p className="shortcuts-empty-desc">
              No keyboard shortcuts match &ldquo;{searchQuery}&rdquo;
            </p>
          </div>
        ) : (
          filteredCategories.map((category) => (
            <section
              key={category.id}
              className="settings-card shortcuts-category-card"
              aria-labelledby={`heading-${category.id}`}
            >
              <h3 id={`heading-${category.id}`} className="settings-card-title">
                {category.title}
              </h3>

              <div className="shortcuts-list">
                {category.shortcuts.map((shortcut) => (
                  <div key={shortcut.id} className="shortcut-row">
                    <div className="shortcut-info">
                      <span className="shortcut-name">{shortcut.name}</span>
                      {shortcut.description && (
                        <span className="shortcut-desc">{shortcut.description}</span>
                      )}
                    </div>
                    <div className="shortcut-keys">
                      {shortcut.combos.map((combo, cIdx) => (
                        <React.Fragment key={cIdx}>
                          {cIdx > 0 && <span className="shortcut-keys-or">or</span>}
                          <span className="shortcut-key-combo">
                            {combo.map((k, kIdx) => (
                              <React.Fragment key={kIdx}>
                                {kIdx > 0 && <span className="shortcut-key-plus">+</span>}
                                <kbd className="shortcut-kbd">{k}</kbd>
                              </React.Fragment>
                            ))}
                          </span>
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))
        )}
      </div>
      </div>
    </div>
  );
}
