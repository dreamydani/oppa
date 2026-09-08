import React, { useState, useRef, useEffect, useMemo } from "react";
import { useTerminalStore } from "../store/terminalStore";
import { leafIds } from "../store/slices/layoutQueries";
import {
  SIDEBAR_CLOSE_MS,
  SIDEBAR_OPEN_MS,
  SLIDE_EASING_CLOSE,
  SLIDE_EASING_OPEN,
  SlideDrawer,
} from "../lib/layout/sideDrawer";
import { createRafCoalescer } from "../lib/layout/rafThrottle";
import { WorkspaceList, sessionNeedsAttention } from "./workspace/WorkspaceList";
import type { SectionFilter } from "./workspace/WorkspaceList";
import {
  SearchIcon,
  PlusIcon,
  SettingsIcon,
  HelpIcon,
  CloseIcon,
} from "./icons/MinimalIcons";
import "./LeftSidebar.css";

const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 420;
// Fixed icon-rail width: avatars only, no resize (matches opencode's old rail).
const RAIL_WIDTH = 56;

const isMacPlatform =
  typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.platform);

// Icon rail: one avatar per workspace, attention dot when a tab's session is
// working, unread, blocked, or waiting. Click selects; full actions live in
// the open sidebar.
function RailStrip(): React.ReactElement {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const selectTab = useTerminalStore((s) => s.selectTab);

  return (
    <div className="sidebar-rail" role="list" aria-label="Workspaces">
      {tabs.map((tab) => {
        const title = tab.isWizard
          ? tab.title || "New Workspace"
          : tab.title || "Workspace";
        const needsAttention =
          !tab.isWizard &&
          leafIds(tab.layout).some((id) => sessionNeedsAttention(id));
        return (
          <button
            key={tab.id}
            type="button"
            className={`sidebar-rail-item${tab.id === activeTabId ? " is-active" : ""}`}
            title={title}
            aria-label={`Open ${title}`}
            aria-current={tab.id === activeTabId ? "true" : undefined}
            onClick={() => selectTab(tab.id)}
          >
            <span className="sidebar-rail-avatar" aria-hidden="true">
              {(title.trim()[0] ?? "•").toUpperCase()}
            </span>
            {needsAttention && (
              <span className="sidebar-rail-dot" aria-hidden="true" />
            )}
          </button>
        );
      })}
    </div>
  );
}

export function LeftSidebar(): React.ReactElement {
  const leftSidebarWidth = useTerminalStore((s) => s.leftSidebarWidth);
  const setLeftSidebarWidth = useTerminalStore((s) => s.setLeftSidebarWidth);
  const leftSidebarMode = useTerminalStore((s) => s.leftSidebarMode);
  const openSettings = useTerminalStore((s) => s.openSettings);
  const createWizardTab = useTerminalStore((s) => s.createWizardTab);
  const sessions = useTerminalStore((s) => s.sessions);
  const isRail = leftSidebarMode === "rail";

  const [searchQuery, setSearchQuery] = useState("");
  // Chip filter narrows sections; the search box stays the text authority.
  const [sectionFilter, setSectionFilter] = useState<SectionFilter>("all");
  // Disables width transitions while drag-resizing so the panel tracks the
  // cursor 1:1 instead of easing behind it.
  const [isResizing, setIsResizing] = useState(false);
  const asideRef = useRef<HTMLElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Global Ctrl+K / Cmd+K search focus binding
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = isMacPlatform ? e.metaKey : e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  // Compute live session count for footer status indicator
  const liveCount = useMemo(() => {
    return Object.values(sessions).filter((s) => s.status !== "exited").length;
  }, [sessions]);

  // Compositor drawer: transform-only open/close (see sideDrawer.ts). Inline
  // motion styles are invisible to React's style diffing, so they survive
  // re-renders; unmount/remount re-syncs from the store.
  useEffect(() => {
    const el = asideRef.current;
    if (!el) return;
    const drawer = new SlideDrawer({
      el,
      innerEl: innerRef.current,
      direction: "left",
      openMs: SIDEBAR_OPEN_MS,
      closeMs: SIDEBAR_CLOSE_MS,
      easing: SLIDE_EASING_OPEN,
      easingClose: SLIDE_EASING_CLOSE,
      gapPx: 4,
      parallaxPx: 0,
      // The sidebarOnLaunch flip must apply silently before boot settles.
      suppressMotion: () =>
        !document.querySelector(".app-container.app-booted"),
    });
    drawer.sync(leftSidebarMode !== "hidden");
    return () => drawer.dispose();
  }, [leftSidebarMode]);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    const sidebarEl = (e.currentTarget as HTMLElement).closest(".left-sidebar");
    const sidebarLeft = sidebarEl?.getBoundingClientRect().left ?? 0;
    // One width commit per frame; the drag end flushes the final value.
    const widthCoalescer = createRafCoalescer<number>((width) => setLeftSidebarWidth(width));

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const nextWidth = Math.max(
        MIN_SIDEBAR_WIDTH,
        Math.min(MAX_SIDEBAR_WIDTH, moveEvent.clientX - sidebarLeft),
      );
      widthCoalescer.push(nextWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      widthCoalescer.flushNow();
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  return (

    <aside
      ref={asideRef}
      className={`left-sidebar${isResizing ? " is-resizing" : ""}${isRail ? " is-rail" : ""}`}
      style={{ "--sidebar-w": `${isRail ? RAIL_WIDTH : leftSidebarWidth}px` } as React.CSSProperties}
    >
      {isRail ? (
        <RailStrip />
      ) : (
      <div ref={innerRef} className="sidebar-slide-inner">
        <div className="left-sidebar-top">
          <div className="sidebar-search-strip">
            <div className="sidebar-search-box">
              <SearchIcon size={14} className="sidebar-search-icon" />
              <input
                ref={searchInputRef}
                type="text"
                placeholder="Search workspaces..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                aria-label="Search workspaces"
                className="sidebar-search-input"
              />
              {!searchQuery && (
                <span className="sidebar-search-hint" aria-hidden="true">
                  {isMacPlatform ? "⌘K" : "Ctrl+K"}
                </span>
              )}
              {searchQuery && (
                <button
                  type="button"
                  className="sidebar-search-clear-btn"
                  onClick={() => {
                    setSearchQuery("");
                    searchInputRef.current?.focus();
                  }}
                  aria-label="Clear search"
                  title="Clear search"
                >
                  <CloseIcon size={10} />
                </button>
              )}
            </div>
            <button
              type="button"
              className="sidebar-icon-btn sidebar-new-workspace-btn"
              title="New Workspace"
              aria-label="New Workspace"
              onClick={() => createWizardTab()}
            >
              <PlusIcon size={14} />
            </button>
          </div>
          <div className="sidebar-filter-chips" role="group" aria-label="Filter workspaces">
            {(
              [
                ["all", "All"],
                ["active", "Active"],
                ["worktrees", "Worktrees"],
                ["attention", "Attention"],
              ] as [SectionFilter, string][]
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`sidebar-filter-chip${sectionFilter === value ? " is-active" : ""}`}
                aria-pressed={sectionFilter === value}
                onClick={() => setSectionFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>


        <div className="left-sidebar-body">
          <WorkspaceList filter={searchQuery} sectionFilter={sectionFilter} />
        </div>

        <div className="left-sidebar-footer">
          <div className="sidebar-footer-status" title="OPPA Daemon Connected">
            <span className="sidebar-status-dot" aria-hidden="true" />
            <span className="sidebar-status-text">
              {liveCount > 0 ? `${liveCount} live` : "Daemon"}
            </span>
          </div>
          <div className="sidebar-footer-actions">
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
      </div>
      )}

      {!isRail && (
      <div
        className="resize-handle-right"
        onMouseDown={handleMouseDown}
        role="separator"
        aria-orientation="vertical"
      />
      )}
    </aside>
  );
}

