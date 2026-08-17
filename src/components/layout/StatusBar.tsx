import React, { useEffect, useState } from "react";
import { GitBranch, Folder, Terminal } from "lucide-react";
import { useTerminalStore } from "../../store/terminalStore";
import { focus } from "../../lib/pane-manager/layout";
import { getGitStatus, GitStatusResult } from "../../lib/git/transport";
import "./StatusBar.css";

export function StatusBar(): React.ReactElement {
  const cwd = useTerminalStore((s) => s.getActiveCwd());
  const sessions = useTerminalStore((s) => s.sessions);
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const detectedPorts = useTerminalStore((s) => s.detectedPorts);
  const setAppMode = useTerminalStore((s) => s.setAppMode);
  const navigateBrowser = useTerminalStore((s) => s.navigateBrowser);

  const [gitStatus, setGitStatus] = useState<GitStatusResult | null>(null);

  useEffect(() => {
    let isMounted = true;
    if (!cwd) {
      setGitStatus(null);
      return;
    }

    void getGitStatus(cwd)
      .then((res) => {
        if (isMounted) {
          setGitStatus(res);
        }
      })
      .catch(() => {
        if (isMounted) {
          setGitStatus(null);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [cwd]);

  // Derive active session info
  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];
  let activeSessionId = "";
  if (activeTab) {
    try {
      activeSessionId = focus(activeTab.layout, activeTab.focusedPath || []);
    } catch {
      // Layout traversal fallback
    }
  }
  const activeSession = activeSessionId ? sessions[activeSessionId] : undefined;
  const cols = activeSession?.cols ?? 80;
  const rows = activeSession?.rows ?? 24;
  const sessionStatus = activeSession?.status || "ready";

  const getCwdDisplay = () => {
    if (!cwd) return "No directory";
    const parts = cwd.split(/[/\\]/).filter(Boolean);
    return parts[parts.length - 1] || cwd;
  };

  return (
    <footer className="status-bar">
      <div className="status-bar-section status-bar-section-left">
        <div className={`status-bar-item ${gitStatus?.is_git ? "git-item" : ""}`}>
          <GitBranch size={13} />
          {gitStatus?.is_git ? (
            <>
              <span className="status-bar-git-branch">{gitStatus.branch || "HEAD"}</span>
              {(gitStatus.ahead > 0 || gitStatus.behind > 0) && (
                <span className="status-bar-git-sync">
                  {gitStatus.ahead > 0 && `↑${gitStatus.ahead}`}
                  {gitStatus.behind > 0 && ` ↓${gitStatus.behind}`}
                </span>
              )}
            </>
          ) : (
            <span>no git</span>
          )}
        </div>

        <div className="status-bar-item" title={cwd || "No active directory"}>
          <Folder size={13} />
          <span className="status-bar-cwd">{getCwdDisplay()}</span>
        </div>

        {detectedPorts.map((port) => (
          <button
            key={port.port}
            type="button"
            className="status-bar-item localhost-badge"
            title={`Open ${port.url} in Browser`}
            onClick={() => {
              navigateBrowser(port.url);
              setAppMode("browser");
            }}
          >
            <span className="localhost-bolt">⚡</span>
            <span>{`localhost:${port.port}`}</span>
          </button>
        ))}
      </div>

      <div className="status-bar-section status-bar-section-right">
        <div className="status-bar-item" title="Terminal Dimensions">
          <Terminal size={13} />
          <span>{`${cols}x${rows}`}</span>
        </div>

        <div className="status-bar-item" title={`Status: ${sessionStatus}`}>
          <span className={`status-indicator-dot ${sessionStatus}`} />
          <span>{sessionStatus === "running" ? "Ready" : sessionStatus}</span>
        </div>
      </div>
    </footer>
  );
}
