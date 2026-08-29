import React, { useState, useRef, useEffect } from "react";
import { useTerminalStore } from "../store/terminalStore";
import {
  SIDEBAR_CLOSE_MS,
  SIDEBAR_OPEN_MS,
  SLIDE_EASING,
  SlideDrawer,
} from "../lib/layout/sideDrawer";
import { createRafCoalescer } from "../lib/layout/rafThrottle";
import { WorkspaceList } from "./workspace/WorkspaceList";
import {
  SearchIcon,
  PlusIcon,
  SettingsIcon,
  HelpIcon,
} from "./icons/MinimalIcons";
import "./LeftSidebar.css";

const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 420;

export function LeftSidebar(): React.ReactElement {
  const leftSidebarWidth = useTerminalStore((s) => s.leftSidebarWidth);
  const setLeftSidebarWidth = useTerminalStore((s) => s.setLeftSidebarWidth);
  const leftSidebarOpen = useTerminalStore((s) => s.leftSidebarOpen);
  const openSettings = useTerminalStore((s) => s.openSettings);
  const createWizardTab = useTerminalStore((s) => s.createWizardTab);

  const [searchQuery, setSearchQuery] = useState("");
  // Disables width transitions while drag-resizing so the panel tracks the
  // cursor 1:1 instead of easing behind it.
  const [isResizing, setIsResizing] = useState(false);
  const asideRef = useRef<HTMLElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);

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
      easing: SLIDE_EASING,
      gapPx: 4,
      parallaxPx: 44,
      // The sidebarOnLaunch flip must apply silently before boot settles.
      suppressMotion: () =>
        !document.querySelector(".app-container.app-booted"),
    });
    drawer.sync(leftSidebarOpen);
    return () => drawer.dispose();
  }, [leftSidebarOpen]);

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
      className={`left-sidebar${isResizing ? " is-resizing" : ""}`}
      style={{ "--sidebar-w": `${leftSidebarWidth}px` } as React.CSSProperties}
    >
      <div ref={innerRef} className="sidebar-slide-inner">
        <div className="left-sidebar-top">
          <div className="sidebar-search-strip">
            <div className="sidebar-search-box">
              <SearchIcon size={14} className="sidebar-search-icon" />
              <input
                type="text"
                placeholder="Search workspaces..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                aria-label="Search workspaces"
                className="sidebar-search-input"
              />
            </div>
            <button
              type="button"
              className="sidebar-icon-btn"
              title="New Workspace"
              aria-label="New Workspace"
              onClick={() => createWizardTab()}
            >
              <PlusIcon size={14} />
            </button>
          </div>
        </div>

        <div className="left-sidebar-body">
          <WorkspaceList filter={searchQuery} />
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
