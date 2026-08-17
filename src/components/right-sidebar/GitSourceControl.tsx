import React, { useEffect, useState, useCallback } from "react";
import { GitBranch } from "lucide-react";
import { useTerminalStore } from "../../store/terminalStore";
import { getGitStatus, GitStatusResult, GitFileStatus } from "../../lib/git/transport";

interface GitSourceControlProps {
  refreshKey?: number;
}

function getBadgeProps(status: string): { label: string; className: string } {
  switch (status.trim()) {
    case "M":
      return { label: "M", className: "git-badge-modified" };
    case "A":
      return { label: "A", className: "git-badge-added" };
    case "D":
      return { label: "D", className: "git-badge-deleted" };
    case "??":
      return { label: "U", className: "git-badge-untracked" };
    case "R":
      return { label: "R", className: "git-badge-modified" };
    default:
      return { label: status.trim() || "?", className: "git-badge-modified" };
  }
}

export function GitSourceControl({ refreshKey = 0 }: GitSourceControlProps): React.ReactElement {
  const cwd = useTerminalStore((s) => s.getActiveCwd());
  const [gitStatus, setGitStatus] = useState<GitStatusResult | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = useCallback(async (dirPath: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await getGitStatus(dirPath);
      setGitStatus(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!cwd) {
      setGitStatus(null);
      return;
    }
    void fetchStatus(cwd);
  }, [cwd, refreshKey, fetchStatus]);

  if (!cwd) {
    return <div className="empty-state">No active directory</div>;
  }

  if (loading && !gitStatus) {
    return <div className="loading-state">Checking git status...</div>;
  }

  if (error) {
    return <div className="empty-state">{error}</div>;
  }

  if (!gitStatus || !gitStatus.is_git) {
    return <div className="empty-state">Not a git repository</div>;
  }

  return (
    <div className="git-source-control">
      <div className="git-branch-header">
        <div className="git-branch-info">
          <GitBranch size={14} />
          <span>{gitStatus.branch || "HEAD"}</span>
        </div>
        {(gitStatus.ahead > 0 || gitStatus.behind > 0) && (
          <div className="git-sync-info">
            <span>↑{gitStatus.ahead}</span>
            <span>↓{gitStatus.behind}</span>
          </div>
        )}
      </div>

      <div className="git-section-title">
        <span>CHANGES</span>
        <span className="git-count-badge">{gitStatus.files.length}</span>
      </div>

      {gitStatus.files.length === 0 ? (
        <div className="empty-state">No changes (working tree clean)</div>
      ) : (
        <div className="git-file-list">
          {gitStatus.files.map((file: GitFileStatus) => {
            const badge = getBadgeProps(file.status);
            return (
              <div key={file.path} className="git-file-item">
                <span className="git-file-path" title={file.path}>
                  {file.path}
                </span>
                <span className={`git-badge ${badge.className}`}>{badge.label}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
