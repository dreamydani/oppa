import React, { useState, useRef, useEffect } from "react";
import { useTerminalStore } from "../../store/terminalStore";
import {
  SIDEBAR_CLOSE_MS,
  SIDEBAR_OPEN_MS,
  SLIDE_EASING_CLOSE,
  SLIDE_EASING_OPEN,
  SlideDrawer,
} from "../../lib/layout/sideDrawer";
import { createRafCoalescer } from "../../lib/layout/rafThrottle";
import { ActivityBar } from "./ActivityBar";
import { ExtensionsPanel } from "./ExtensionsPanel";
import { FileExplorer } from "./FileExplorer";
import { GitSourceControl } from "./GitSourceControl";
import "./RightSidebar.css";

const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 480;

export function RightSidebar(): React.ReactElement {
  const rightSidebarOpen = useTerminalStore((s) => s.rightSidebarOpen);
  const rightSidebarWidth = useTerminalStore((s) => s.rightSidebarWidth);
  const rightSidebarTab = useTerminalStore((s) => s.rightSidebarTab);
  const setRightSidebarWidth = useTerminalStore((s) => s.setRightSidebarWidth);
  // Disables width transitions while drag-resizing so the panel tracks the
  // cursor 1:1 instead of easing behind it.
  const [isResizing, setIsResizing] = useState(false);
  const [refreshKey, setRefreshKey] = useState<number>(0);
  const asideRef = useRef<HTMLElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);

  // Compositor drawer mirroring LeftSidebar (see sideDrawer.ts).
  useEffect(() => {
    const el = asideRef.current;
    if (!el) return;
    const drawer = new SlideDrawer({
      el,
      innerEl: innerRef.current,
      direction: "right",
      openMs: SIDEBAR_OPEN_MS,
      closeMs: SIDEBAR_CLOSE_MS,
      easing: SLIDE_EASING_OPEN,
      easingClose: SLIDE_EASING_CLOSE,
      gapPx: 4,
      parallaxPx: 0,
      suppressMotion: () =>
        !document.querySelector(".app-container.app-booted"),
    });
    drawer.sync(rightSidebarOpen);
    return () => drawer.dispose();
  }, [rightSidebarOpen]);

  const handleRefresh = () => {
    setRefreshKey((prev) => prev + 1);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    const startX = e.clientX;
    const startWidth = rightSidebarWidth;
    // One width commit per frame; the drag end flushes the final value.
    const widthCoalescer = createRafCoalescer<number>((width) => setRightSidebarWidth(width));

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const delta = startX - moveEvent.clientX;
      const nextWidth = Math.max(
        MIN_SIDEBAR_WIDTH,
        Math.min(MAX_SIDEBAR_WIDTH, startWidth + delta),
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
      className={`right-sidebar${isResizing ? " is-resizing" : ""}`}
      style={{ "--sidebar-w": `${rightSidebarWidth}px` } as React.CSSProperties}
    >
      <div ref={innerRef} className="sidebar-slide-inner">
        <div className="right-sidebar-inner-row">
          <ActivityBar onRefresh={handleRefresh} />
          <div className="right-sidebar-content">
            {rightSidebarTab === "explorer" ? (
              <FileExplorer refreshKey={refreshKey} />
            ) : rightSidebarTab === "extensions" ? (
              <ExtensionsPanel />
            ) : (
              <GitSourceControl refreshKey={refreshKey} />
            )}
          </div>
        </div>
      </div>
      <div
        className="resize-handle-left"
        onMouseDown={handleMouseDown}
        role="separator"
        aria-orientation="vertical"
      />
    </aside>
  );
}
