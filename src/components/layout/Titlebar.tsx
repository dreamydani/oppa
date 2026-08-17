import React from "react";
import { PanelLeft, PanelRight, Folder } from "lucide-react";
import { useTerminalStore } from "../../store/terminalStore";
import "./Titlebar.css";

export function Titlebar(): React.ReactElement {
  const leftSidebarOpen = useTerminalStore((s) => s.leftSidebarOpen);
  const rightSidebarOpen = useTerminalStore((s) => s.rightSidebarOpen);
  const toggleLeftSidebar = useTerminalStore((s) => s.toggleLeftSidebar);
  const toggleRightSidebar = useTerminalStore((s) => s.toggleRightSidebar);
  const cwd = useTerminalStore((s) => s.getActiveCwd());

  const getBreadcrumbLabel = () => {
    if (!cwd) return "oppa";
    const parts = cwd.split(/[/\\]/).filter(Boolean);
    return parts[parts.length - 1] || cwd;
  };

  const breadcrumb = getBreadcrumbLabel();

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-section titlebar-section-left">
        <button
          type="button"
          className={`titlebar-btn ${leftSidebarOpen ? "active" : ""}`}
          title="Toggle Left Sidebar"
          aria-label="Toggle Left Sidebar"
          data-tauri-drag-region="false"
          onClick={toggleLeftSidebar}
        >
          <PanelLeft size={16} />
        </button>
      </div>

      <div className="titlebar-section titlebar-section-center" data-tauri-drag-region>
        <span className="titlebar-app-name">OPPA</span>
        <span className="titlebar-separator">/</span>
        <div
          className="titlebar-breadcrumb"
          data-testid="titlebar-breadcrumb"
          title={cwd || "oppa"}
        >
          <Folder size={14} />
          <span>{breadcrumb}</span>
        </div>
      </div>

      <div className="titlebar-section titlebar-section-right">
        <button
          type="button"
          className={`titlebar-btn ${rightSidebarOpen ? "active" : ""}`}
          title="Toggle Right Sidebar"
          aria-label="Toggle Right Sidebar"
          data-tauri-drag-region="false"
          onClick={toggleRightSidebar}
        >
          <PanelRight size={16} />
        </button>
      </div>
    </header>
  );
}
