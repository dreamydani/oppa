import React from "react";
import { Files, GitBranch, Puzzle, RefreshCw } from "lucide-react";
import { useTerminalStore } from "../../store/terminalStore";

interface ActivityBarProps {
  onRefresh?: () => void;
}

export function ActivityBar({ onRefresh }: ActivityBarProps): React.ReactElement {
  const rightSidebarTab = useTerminalStore((s) => s.rightSidebarTab);
  const setRightSidebarTab = useTerminalStore((s) => s.setRightSidebarTab);

  return (
    <div className="activity-bar">
      <div className="activity-tabs">
        <button
          type="button"
          className={`activity-tab-btn ${rightSidebarTab === "explorer" ? "active" : ""}`}
          onClick={() => setRightSidebarTab("explorer")}
          title="File Explorer"
          aria-label="File Explorer"
        >
          <Files size={14} />
          <span>Explorer</span>
        </button>
        <button
          type="button"
          className={`activity-tab-btn ${rightSidebarTab === "git" ? "active" : ""}`}
          onClick={() => setRightSidebarTab("git")}
          title="Source Control"
          aria-label="Source Control"
        >
          <GitBranch size={14} />
          <span>Git</span>
        </button>
        <button
          type="button"
          className={`activity-tab-btn ${rightSidebarTab === "extensions" ? "active" : ""}`}
          onClick={() => setRightSidebarTab("extensions")}
          title="Extensions"
          aria-label="Extensions"
        >
          <Puzzle size={14} />
          <span>Extensions</span>
        </button>
      </div>
      <div className="activity-actions">
        <button
          type="button"
          className="activity-action-btn"
          onClick={onRefresh}
          title="Refresh"
          aria-label="Refresh"
        >
          <RefreshCw size={13} />
        </button>
      </div>
    </div>
  );
}
