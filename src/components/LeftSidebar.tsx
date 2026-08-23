import React, { useState, useRef, useEffect, useMemo } from "react";
import { Sparkles, GitBranch } from "lucide-react";
import { useTerminalStore } from "../store/terminalStore";
import { focus } from "../lib/pane-manager/layout";
import { WorktreePane } from "./worktree/WorktreePane";
import {
  SearchIcon,
  PlusIcon,
  TerminalIcon,
  CloseIcon,
  SettingsIcon,
  HelpIcon,
} from "./icons/MinimalIcons";
import "./LeftSidebar.css";

const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 420;

export function LeftSidebar(): React.ReactElement {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const sessions = useTerminalStore((s) => s.sessions);
  const selectTab = useTerminalStore((s) => s.selectTab);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const renameTab = useTerminalStore((s) => s.renameTab);
  const createWizardTab = useTerminalStore((s) => s.createWizardTab);
  const leftSidebarWidth = useTerminalStore((s) => s.leftSidebarWidth);
  const setLeftSidebarWidth = useTerminalStore((s) => s.setLeftSidebarWidth);
  const leftSidebarOpen = useTerminalStore((s) => s.leftSidebarOpen);
  const openSettings = useTerminalStore((s) => s.openSettings);
  const leftSidebarView = useTerminalStore((s) => s.leftSidebarView);
  const setLeftSidebarView = useTerminalStore((s) => s.setLeftSidebarView);
  const openWorktreeCreate = useTerminalStore((s) => s.openWorktreeCreate);

  const [searchQuery, setSearchQuery] = useState("");
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  // Disables width transitions while drag-resizing so the panel tracks the
  // cursor 1:1 instead of easing behind it.
  const [isResizing, setIsResizing] = useState(false);
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
    if (tab.isWizard) {
      return {
        title: tab.title || "New Workspace",
        cwd: undefined,
      };
    }
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
    setIsResizing(true);
    const sidebarEl = (e.currentTarget as HTMLElement).closest(".left-sidebar");
    const sidebarLeft = sidebarEl?.getBoundingClientRect().left ?? 0;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const nextWidth = Math.max(
        MIN_SIDEBAR_WIDTH,
        Math.min(MAX_SIDEBAR_WIDTH, moveEvent.clientX - sidebarLeft),
      );
      setLeftSidebarWidth(nextWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  return (
    <aside
      className={`left-sidebar${leftSidebarOpen ? "" : " closed"}${isResizing ? " is-resizing" : ""}`}
      style={{ "--sidebar-w": `${leftSidebarWidth}px` } as React.CSSProperties}
    >
      <div className="sidebar-slide-inner">
        <div className="left-sidebar-top">
        <div className="sidebar-search-strip">
          <div className="sidebar-search-box">
            <SearchIcon size={14} className="sidebar-search-icon" />
            <input
              type="text"
              placeholder={leftSidebarView === "worktrees" ? "Search worktrees..." : "Search tabs..."}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              aria-label={
                leftSidebarView === "worktrees" ? "Search worktrees" : "Search tabs"
              }
              className="sidebar-search-input"
            />
          </div>
          {leftSidebarView === "worktrees" ? (
            <button
              type="button"
              className="sidebar-icon-btn"
              title="New Worktree"
              aria-label="New Worktree"
              onClick={openWorktreeCreate}
            >
              <PlusIcon size={14} />
            </button>
          ) : (
            <button
              type="button"
              className="sidebar-icon-btn"
              title="New Tab"
              aria-label="New Tab"
              onClick={() => createWizardTab()}
            >
              <PlusIcon size={14} />
            </button>
          )}
        </div>
        <div className="sidebar-view-toggle" role="tablist" aria-label="Sidebar view">
          <button
            type="button"
            role="tab"
            aria-selected={leftSidebarView === "tabs"}
            className={`sidebar-view-btn ${leftSidebarView === "tabs" ? "active" : ""}`}
            onClick={() => setLeftSidebarView("tabs")}
          >
            <TerminalIcon size={12} /> Sessions
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={leftSidebarView === "worktrees"}
            className={`sidebar-view-btn ${leftSidebarView === "worktrees" ? "active" : ""}`}
            onClick={() => setLeftSidebarView("worktrees")}
          >
            <GitBranch size={12} /> Worktrees
          </button>
        </div>
      </div>

      <div className="left-sidebar-body">
        {leftSidebarView === "worktrees" ? (
          <WorktreePane filter={searchQuery} />
        ) : (
          <div className="tab-list" role="list">
          {tabs.length === 0 ? (
            <div className="sidebar-empty-state">
              <span className="sidebar-empty-title">No Workspaces</span>
              <span className="sidebar-empty-desc">
                No project workspaces open.
              </span>
              <button
                type="button"
                className="sidebar-empty-btn"
                onClick={() => createWizardTab()}
              >
                <PlusIcon size={12} /> New Workspace
              </button>
            </div>
          ) : filteredTabs.length === 0 ? (
            <div className="sidebar-empty-state">
              <span className="sidebar-empty-title">No Matches</span>
              <span className="sidebar-empty-desc">
                No workspaces matching &quot;{searchQuery}&quot;
              </span>
            </div>
          ) : (
            filteredTabs.map((tab) => {
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
                  {tab.isWizard ? (
                    <Sparkles size={14} />
                  ) : (
                    <TerminalIcon size={14} />
                  )}
                </div>

                <div className="tab-card-content">
                  <div className="tab-card-row-top">
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
          })
        )}
        </div>
        )}
      </div>

      <div className="left-sidebar-footer">
        <button
          type="button"
          className="sidebar-footer-btn"
          title="Settings (Ctrl+, / Cmd+,)"
          aria-label="Settings"
          onClick={() => openSettings("general")}
        >
          <SettingsIcon size={14} />
        </button>
        <button
          type="button"
          className="sidebar-footer-btn"
          title="Keyboard Shortcuts (F1 / Ctrl+/)"
          aria-label="Keyboard Shortcuts"
          onClick={() => openSettings("shortcuts")}
        >
          <HelpIcon size={14} />
        </button>
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

