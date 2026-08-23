import React, { useState } from "react";
import { useTerminalStore } from "../../store/terminalStore";
import { ActivityBar } from "./ActivityBar";
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

  const handleRefresh = () => {
    setRefreshKey((prev) => prev + 1);
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    const startX = e.clientX;
    const startWidth = rightSidebarWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const delta = startX - moveEvent.clientX;
      const nextWidth = Math.max(
        MIN_SIDEBAR_WIDTH,
        Math.min(MAX_SIDEBAR_WIDTH, startWidth + delta),
      );
      setRightSidebarWidth(nextWidth);
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
      className={`right-sidebar${rightSidebarOpen ? "" : " closed"}${isResizing ? " is-resizing" : ""}`}
      style={{ "--sidebar-w": `${rightSidebarWidth}px` } as React.CSSProperties}
    >
      <div className="sidebar-slide-inner">
        <div className="right-sidebar-inner-row">
          <ActivityBar onRefresh={handleRefresh} />
          <div className="right-sidebar-content">
            {rightSidebarTab === "explorer" ? (
              <FileExplorer refreshKey={refreshKey} />
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
