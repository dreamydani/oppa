import React from "react";
import { useTerminalStore } from "../../store/terminalStore";
import { WorkspaceNav } from "./WorkspaceNav";
import { WorkspaceList } from "./WorkspaceList";
import "./LeftSidebar.css";

const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 420;

export function LeftSidebar(): React.ReactElement | null {
  const leftSidebarOpen = useTerminalStore((s) => s.leftSidebarOpen);
  const leftSidebarWidth = useTerminalStore((s) => s.leftSidebarWidth);
  const setLeftSidebarWidth = useTerminalStore((s) => s.setLeftSidebarWidth);

  if (!leftSidebarOpen) {
    return null;
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
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
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  return (
    <aside className="left-sidebar" style={{ width: leftSidebarWidth }}>
      <WorkspaceNav />
      <WorkspaceList />
      <div
        className="resize-handle-right"
        onMouseDown={handleMouseDown}
        role="separator"
        aria-orientation="vertical"
      />
    </aside>
  );
}
