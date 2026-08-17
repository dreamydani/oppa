import React, { useState, useRef, useEffect } from "react";
import { Plus, X, Folder, TerminalSquare } from "lucide-react";
import { useTerminalStore } from "../../store/terminalStore";
import { focus } from "../../lib/pane-manager/layout";

export function WorkspaceList(): React.ReactElement {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const sessions = useTerminalStore((s) => s.sessions);
  const selectTab = useTerminalStore((s) => s.selectTab);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const renameTab = useTerminalStore((s) => s.renameTab);
  const openWorkspaceLauncher = useTerminalStore((s) => s.openWorkspaceLauncher);

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

  const getTabDetails = (tab: (typeof tabs)[0]) => {
    let title = tab.title;
    let cwd: string | undefined;
    try {
      const leafId = focus(tab.layout, tab.focusedPath || []);
      const session = sessions[leafId];
      if (session) {
        cwd = session.cwd;
        if (!title && session.cwd) {
          const parts = session.cwd.split(/[/\\]/).filter(Boolean);
          title = parts[parts.length - 1] || session.title || "terminal";
        } else if (!title && session.title && session.title !== session.id) {
          title = session.title;
        }
      }
    } catch {
      // Safe fallback on unexpected layout tree
    }
    return {
      title: title || "terminal",
      cwd,
    };
  };

  return (
    <div className="workspace-content">
      <div className="workspace-header">
        <span>WORKSPACES</span>
        <div className="workspace-header-actions">
          <button
            type="button"
            className="workspace-icon-btn"
            title="New Workspace"
            aria-label="New Workspace"
            onClick={() => openWorkspaceLauncher()}
          >
            <Plus size={14} />
          </button>
        </div>
      </div>

      <div className="workspace-list" role="list">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const { title, cwd } = getTabDetails(tab);
          const isEditing = editingTabId === tab.id;

          return (
            <div
              key={tab.id}
              role="listitem"
              className={`workspace-card ${isActive ? "active" : ""}`}
              onClick={() => !isEditing && selectTab(tab.id)}
              onDoubleClick={() => handleStartRename(tab.id, tab.title || title)}
            >
              <div className="workspace-card-main">
                <div className="workspace-card-icon">
                  {cwd ? <Folder size={14} /> : <TerminalSquare size={14} />}
                </div>

                <div className="workspace-card-info">
                  {isEditing ? (
                    <input
                      ref={editInputRef}
                      type="text"
                      className="workspace-rename-input"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      onBlur={() => handleSaveRename(tab.id)}
                      onKeyDown={(e) => handleKeyDown(e, tab.id)}
                      aria-label="Rename workspace"
                    />
                  ) : (
                    <>
                      <span className="workspace-card-title" title={title}>
                        {title}
                      </span>
                      {cwd && (
                        <span className="workspace-card-cwd" title={cwd}>
                          {cwd}
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>

              <button
                type="button"
                className="workspace-card-close"
                title="Close Workspace"
                aria-label="Close workspace"
                onClick={(e) => {
                  e.stopPropagation();
                  void closeTab(tab.id);
                }}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
