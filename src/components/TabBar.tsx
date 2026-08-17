import React, { useState, useRef, useEffect } from "react";
import { Plus, X, Sparkles } from "lucide-react";
import { useTerminalStore } from "../store/terminalStore";
import { focus } from "../lib/pane-manager/layout";

export function TabBar(): React.ReactElement {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const sessions = useTerminalStore((s) => s.sessions);
  const selectTab = useTerminalStore((s) => s.selectTab);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const renameTab = useTerminalStore((s) => s.renameTab);
  const createWizardTab = useTerminalStore((s) => s.createWizardTab);

  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingTabId) {
      editInputRef.current?.focus();
      editInputRef.current?.select();
    }
  }, [editingTabId]);

  const handleStartRename = (tabId: string, currentTitle: string) => {
    setEditingTabId(tabId);
    setEditTitle(currentTitle);
  };

  const handleSaveRename = (tabId: string) => {
    if (editTitle.trim()) {
      renameTab(tabId, editTitle.trim());
    }
    setEditingTabId(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent, tabId: string) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSaveRename(tabId);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setEditingTabId(null);
    }
  };

  const getTabLabel = (tab: (typeof tabs)[0]) => {
    if (tab.title) return tab.title;
    if (tab.isWizard) return "New Workspace";
    try {
      const leafId = focus(tab.layout, tab.focusedPath || []);
      const session = sessions[leafId];
      if (session?.cwd) {
        const parts = session.cwd.split(/[/\\]/).filter(Boolean);
        return parts[parts.length - 1] || session.title || "terminal";
      }
      if (session?.title && session.title !== session.id) {
        return session.title;
      }
    } catch {
      // Safe fallback on unexpected layout tree
    }
    return "terminal";
  };

  return (
    <div className="tab-bar" role="tablist" aria-label="Terminal Tabs">
      <div className="tab-list">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const label = getTabLabel(tab);
          const isEditing = editingTabId === tab.id;

          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              className={`tab-item ${isActive ? "active" : ""}`}
              onClick={() => !isEditing && selectTab(tab.id)}
              onDoubleClick={() => handleStartRename(tab.id, tab.title || label)}
            >
              {isEditing ? (
                <input
                  ref={editInputRef}
                  type="text"
                  className="tab-rename-input"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onBlur={() => handleSaveRename(tab.id)}
                  onKeyDown={(e) => handleKeyDown(e, tab.id)}
                  aria-label="Rename tab"
                />
              ) : (
                <span className="tab-title" title={label}>
                  {tab.isWizard && (
                    <Sparkles
                      size={12}
                      className="tab-wizard-icon inline-block mr-1 text-amber-400"
                    />
                  )}
                  {label}
                </span>
              )}
              {tabs.length > 1 && (
                <button
                  type="button"
                  className="tab-close-btn"
                  title="Close Tab (Ctrl+W)"
                  aria-label="Close tab"
                  onClick={(e) => {
                    e.stopPropagation();
                    void closeTab(tab.id);
                  }}
                >
                  <X size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="tab-add-btn"
        title="New Tab (Ctrl+T)"
        aria-label="New Tab"
        onClick={() => createWizardTab()}
      >
        <Plus size={14} />
      </button>
    </div>
  );
}
