import React, { useState, useRef, useEffect, useMemo } from "react";
import { useTerminalStore } from "../store/terminalStore";
import { focus } from "../lib/pane-manager/layout";
import {
  SearchIcon,
  PlusIcon,
  TerminalIcon,
  CloseIcon,
} from "./icons/MinimalIcons";

const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 420;

export function LeftSidebar(): React.ReactElement | null {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const sessions = useTerminalStore((s) => s.sessions);
  const selectTab = useTerminalStore((s) => s.selectTab);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const renameTab = useTerminalStore((s) => s.renameTab);
  const openWorkspaceLauncher = useTerminalStore((s) => s.openWorkspaceLauncher);
  const leftSidebarWidth = useTerminalStore((s) => s.leftSidebarWidth);
  const setLeftSidebarWidth = useTerminalStore((s) => s.setLeftSidebarWidth);

  const [searchQuery, setSearchQuery] = useState("");
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

  const handleRenameKeyDown = (e: React.KeyboardEvent, tabId: string) => {
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

  // Shorten CWD for display (e.g. D:\oppa\oppa -> ~/oppa)
  const shortenCwd = (cwd: string): string => {
    const parts = cwd.split(/[/\\]/).filter(Boolean);
    if (parts.length <= 2) return `~/${parts.join("/")}`;
    return `~/${parts.slice(-2).join("/")}`;
  };

  const filteredTabs = useMemo(() => {
    if (!searchQuery.trim()) return tabs;
    const q = searchQuery.toLowerCase().trim();
    return tabs.filter((tab) => {
      const { title, cwd } = getTabDetails(tab);
      const matchTitle = title.toLowerCase().includes(q);
      const matchCwd = cwd ? cwd.toLowerCase().includes(q) : false;
      return matchTitle || matchCwd;
    });
  }, [tabs, searchQuery, sessions]);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = leftSidebarWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      const nextWidth = Math.max(
        MIN_SIDEBAR_WIDTH,
        Math.min(MAX_SIDEBAR_WIDTH, startWidth + delta)
      );
      setLeftSidebarWidth(nextWidth);
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  return (
    <aside className="left-sidebar" style={{ width: leftSidebarWidth }}>
      <div className="left-sidebar-top">
        <div className="sidebar-search-strip">
          <div className="sidebar-search-box">
            <SearchIcon size={14} className="sidebar-search-icon" />
            <input
              type="text"
              placeholder="Search tabs..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label="Search tabs"
              className="sidebar-search-input"
            />
          </div>
          <button
            type="button"
            className="sidebar-icon-btn"
            title="New Tab"
            aria-label="New Tab"
            onClick={() => openWorkspaceLauncher()}
          >
            <PlusIcon size={14} />
          </button>
        </div>
      </div>

      <div className="left-sidebar-body">
        <div className="tab-list" role="list">
          {filteredTabs.map((tab) => {
            const isActive = tab.id === activeTabId;
            const { title, cwd } = getTabDetails(tab);
            const isEditing = editingTabId === tab.id;

            return (
              <div
                key={tab.id}
                role="listitem"
                className={`tab-card ${isActive ? "active" : ""}`}
                onClick={() => !isEditing && selectTab(tab.id)}
                onDoubleClick={() =>
                  handleStartRename(tab.id, tab.title || title)
                }
              >
                {/* Workspace avatar badge */}
                <div className="tab-card-avatar">
                  <TerminalIcon size={14} />
                </div>

                <div className="tab-card-content">
                  <div className="tab-card-row-top">
                    <span className="tab-card-app-icon">
                      <TerminalIcon size={12} />
                    </span>
                    {isEditing ? (
                      <input
                        ref={editInputRef}
                        type="text"
                        className="tab-rename-input"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        onBlur={() => handleSaveRename(tab.id)}
                        onKeyDown={(e) => handleRenameKeyDown(e, tab.id)}
                        aria-label="Rename tab"
                      />
                    ) : (
                      <span className="tab-card-title" title={title}>
                        {title}
                      </span>
                    )}
                  </div>
                  {cwd && (
                    <span className="tab-card-cwd" title={cwd}>
                      {shortenCwd(cwd)}
                    </span>
                  )}
                </div>

                <button
                  type="button"
                  className="tab-card-close"
                  title="Close Tab"
                  aria-label="Close Tab"
                  onClick={(e) => {
                    e.stopPropagation();
                    void closeTab(tab.id);
                  }}
                >
                  <CloseIcon size={12} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div
        className="resize-handle-right"
        onMouseDown={handleMouseDown}
        role="separator"
        aria-orientation="vertical"
      />
    </aside>
  );
}

