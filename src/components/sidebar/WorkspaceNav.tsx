import React from "react";
import { Terminal, Settings } from "lucide-react";

export function WorkspaceNav(): React.ReactElement {
  return (
    <nav className="workspace-nav" aria-label="Workspaces Activity Bar">
      <div className="workspace-nav-group">
        <button
          type="button"
          className="workspace-nav-btn active"
          title="Terminal Workspaces"
          aria-label="Terminal Workspaces"
        >
          <Terminal size={18} />
        </button>
      </div>
      <div className="workspace-nav-group">
        <button
          type="button"
          className="workspace-nav-btn"
          title="Settings"
          aria-label="Settings"
        >
          <Settings size={18} />
        </button>
      </div>
    </nav>
  );
}
