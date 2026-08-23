import React, { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, GitBranch, Minus, Plus, RefreshCw, Undo2 } from "lucide-react";
import { useTerminalStore, setGitChangedListening } from "../../store/terminalStore";
import type { GitArea, StatusEntry } from "../../lib/pty/transport";
import { DiffNotesShelf } from "./DiffNotesShelf";

interface GitSourceControlProps {
  refreshKey?: number;
}

type StatusLine = { kind: "info" | "error"; text: string };

const SECTION_ORDER: GitArea[] = ["conflict", "staged", "unstaged", "untracked"];
const SECTION_LABELS: Record<GitArea, string> = {
  conflict: "Conflicts",
  staged: "Staged",
  unstaged: "Unstaged",
  untracked: "Untracked",
};

function splitPath(path: string): { dir: string; base: string } {
  const normalized = path.replace(/[\\/]+$/, "");
  const idx = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (idx === -1) return { dir: "", base: normalized };
  return { dir: normalized.slice(0, idx + 1), base: normalized.slice(idx + 1) };
}

function letterClass(letter: string): string {
  switch (letter) {
    case "A":
      return "git-badge-added";
    case "D":
      return "git-badge-deleted";
    default:
      return "git-badge-modified";
  }
}

function badgesFor(entry: StatusEntry): { label: string; className: string }[] {
  if (entry.area === "untracked") {
    return [{ label: "U", className: "git-badge-untracked" }];
  }
  if (entry.area === "conflict") {
    return [
      {
        label: entry.worktree_status.trim() || entry.index_status.trim() || "C",
        className: "git-badge-conflict",
      },
    ];
  }
  const badges: { label: string; className: string }[] = [];
  const indexLetter = entry.index_status.trim();
  const worktreeLetter = entry.worktree_status.trim();
  if (indexLetter) badges.push({ label: indexLetter, className: letterClass(indexLetter) });
  if (worktreeLetter) badges.push({ label: worktreeLetter, className: letterClass(worktreeLetter) });
  return badges.length > 0 ? badges : [{ label: "?", className: "git-badge-modified" }];
}

function FileRow({ entry }: { entry: StatusEntry }): React.ReactElement {
  const stage = useTerminalStore((s) => s.stage);
  const unstage = useTerminalStore((s) => s.unstage);
  const discard = useTerminalStore((s) => s.discard);
  const openGitDiff = useTerminalStore((s) => s.openGitDiff);

  const isConflict = entry.area === "conflict";
  const { dir, base } = splitPath(entry.path);
  const oldBase = entry.old_path ? splitPath(entry.old_path).base : null;

  return (
    <div
      className={`git-file-item${isConflict ? " git-file-conflict" : ""}`}
      title={isConflict ? "Resolve conflicts before staging" : undefined}
      onClick={() => void openGitDiff(entry.path, entry.area)}
    >
      <span className="git-file-badges">
        {badgesFor(entry).map((badge, i) => (
          <span key={i} className={`git-badge ${badge.className}`}>
            {badge.label}
          </span>
        ))}
      </span>
      <span className="git-file-path" title={entry.old_path ? `${entry.old_path} → ${entry.path}` : entry.path}>
        {dir && <span className="git-file-dirname">{dir}</span>}
        {oldBase && <span className="git-file-oldname">{oldBase} </span>}
        {oldBase && <span className="git-file-rename-arrow">→ </span>}
        <span className="git-file-basename">{base}</span>
      </span>
      <span className="git-file-actions" onClick={(e) => e.stopPropagation()}>
        {entry.area === "staged" && (
          <>
            <button
              type="button"
              className="git-action-btn"
              title="Unstage"
              onClick={() => void unstage([entry.path]).catch(() => {})}
            >
              <Minus size={12} />
            </button>
            <button
              type="button"
              className="git-action-btn"
              title="Discard"
              onClick={() => void discard([entry.path], false).catch(() => {})}
            >
              <Undo2 size={12} />
            </button>
          </>
        )}
        {(entry.area === "unstaged" || entry.area === "untracked") && (
          <button
            type="button"
            className="git-action-btn"
            title="Stage"
            onClick={() => void stage([entry.path]).catch(() => {})}
          >
            <Plus size={12} />
          </button>
        )}
      </span>
    </div>
  );
}

export function GitSourceControl({ refreshKey = 0 }: GitSourceControlProps): React.ReactElement {
  const cwd = useTerminalStore((s) => s.getActiveCwd());
  const gitStatus = useTerminalStore((s) => s.gitStatus);
  const gitBranches = useTerminalStore((s) => s.gitBranches);
  const gitHistory = useTerminalStore((s) => s.gitHistory);
  const refreshGitStatus = useTerminalStore((s) => s.refreshGitStatus);
  const loadBranches = useTerminalStore((s) => s.loadBranches);
  const loadHistory = useTerminalStore((s) => s.loadHistory);
  const stageAction = useTerminalStore((s) => s.stage);
  const unstageAction = useTerminalStore((s) => s.unstage);
  const checkout = useTerminalStore((s) => s.checkout);
  const commitAction = useTerminalStore((s) => s.commit);
  const fetchAction = useTerminalStore((s) => s.fetch);
  const pullAction = useTerminalStore((s) => s.pull);
  const ffAction = useTerminalStore((s) => s.ff);
  const pushAction = useTerminalStore((s) => s.push);

  const [loadedOnce, setLoadedOnce] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [statusLine, setStatusLine] = useState<StatusLine | null>(null);
  const [hasConflictWarning, setHasConflictWarning] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<GitArea, boolean>>({
    conflict: false,
    staged: false,
    unstaged: false,
    untracked: false,
  });
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    setGitChangedListening(true);
    return () => setGitChangedListening(false);
  }, []);

  useEffect(() => {
    if (!cwd) return;
    setLoadedOnce(false);
    void refreshGitStatus(cwd).finally(() => setLoadedOnce(true));
    void loadBranches(cwd);
  }, [cwd, refreshKey, refreshGitStatus, loadBranches]);

  const groups: Record<GitArea, StatusEntry[]> = {
    conflict: [],
    staged: [],
    unstaged: [],
    untracked: [],
  };
  for (const entry of gitStatus?.entries ?? []) {
    groups[entry.area].push(entry);
  }

  const branchName = gitStatus?.branch || gitBranches?.current || "";
  const hasUpstream = gitStatus?.upstream.has_upstream ?? false;

  const runSynced = async (name: string, fn: () => Promise<void>) => {
    setSyncing(name);
    setStatusLine(null);
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("conflict:")) {
        // Merge left the worktree dirty — surface it and reload conflict entries
        setHasConflictWarning(true);
        void refreshGitStatus().catch(() => {});
      } else {
        setStatusLine({ kind: "error", text: message });
      }
    } finally {
      setSyncing(null);
    }
  };

  const showInfo = (text: string) => setStatusLine({ kind: "info", text });

  const handleCheckout = (nextBranch: string) => {
    if (!nextBranch || nextBranch === branchName) return;
    if (!window.confirm(`Checkout branch "${nextBranch}"?`)) return;
    void runSynced("checkout", async () => {
      await checkout(nextBranch);
      await loadBranches();
      showInfo(`switched to ${nextBranch}`);
    });
  };

  const handleFetch = () =>
    void runSynced("fetch", async () => {
      await fetchAction();
      setHasConflictWarning(false);
      showInfo("fetch complete");
    });

  const handlePull = () =>
    void runSynced("pull", async () => {
      const outcome = await pullAction(true);
      setHasConflictWarning(false);
      showInfo(
        outcome.status === "up-to-date"
          ? "already up to date"
          : `${outcome.status === "merged" ? "merged" : "fast-forwarded"} to ${outcome.new_head ?? ""}`.trim(),
      );
    });

  const handleFF = () =>
    void runSynced("ff", async () => {
      const outcome = await ffAction();
      setHasConflictWarning(false);
      showInfo(outcome.status === "up-to-date" ? "already up to date" : `fast-forwarded to ${outcome.new_head ?? ""}`);
    });

  const handlePush = () => {
    const publish = !hasUpstream;
    if (publish && !window.confirm(`Publish branch "${branchName}" to origin?`)) return;
    void runSynced("push", async () => {
      const outcome = await pushAction({ publish });
      setHasConflictWarning(false);
      showInfo(`pushed to ${outcome.pushed_to}`);
    });
  };

  const handleCommit = () =>
    void runSynced("commit", async () => {
      const sha = await commitAction(commitMessage);
      setCommitMessage("");
      showInfo(`committed ${sha}`);
    });

  const canCommit = commitMessage.trim().length > 0 && groups.staged.length > 0;

  const toggleSection = (area: GitArea) =>
    setCollapsed((prev) => ({ ...prev, [area]: !prev[area] }));

  const toggleHistory = () => {
    const opening = !historyOpen;
    setHistoryOpen(opening);
    if (opening && !gitHistory) void loadHistory(30);
  };

  if (!cwd) {
    return <div className="empty-state">No active directory</div>;
  }

  if (!gitStatus) {
    return (
      <div className="empty-state">
        {loadedOnce ? "Not a git repository" : "Checking git status..."}
      </div>
    );
  }

  return (
    <div className="git-source-control">
      <div className="git-branch-header">
        <div className="git-branch-info">
          <GitBranch size={14} />
          <select
            className="git-branch-select"
            aria-label="Switch branch"
            value={branchName}
            onChange={(e) => handleCheckout(e.target.value)}
          >
            {(gitBranches?.branches.length ? gitBranches.branches : [branchName]).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        {hasUpstream && (
          <div className="git-sync-info">
            <span>↑{gitStatus.upstream.ahead} ↓{gitStatus.upstream.behind}</span>
          </div>
        )}
        <button
          type="button"
          className="git-refresh-btn"
          title="Refresh"
          onClick={() => {
            void refreshGitStatus(cwd);
            void loadBranches(cwd);
          }}
        >
          <RefreshCw size={13} />
        </button>
      </div>

      <div className="git-sync-row">
        <button type="button" className="git-sync-btn" disabled={syncing !== null} onClick={handleFetch}>
          Fetch
        </button>
        <button type="button" className="git-sync-btn" disabled={syncing !== null} onClick={handlePull}>
          Pull
        </button>
        <button type="button" className="git-sync-btn" disabled={syncing !== null} onClick={handleFF}>
          FF
        </button>
        <button
          type="button"
          className="git-sync-btn git-sync-primary"
          disabled={syncing !== null}
          onClick={handlePush}
        >
          {hasUpstream ? "Push" : "Publish"}
        </button>
      </div>

      {hasConflictWarning && (
        <div className="git-warning-banner" role="alert">
          merge conflicts — resolve in editor then commit
        </div>
      )}

      {statusLine && (
        <div className={`git-status-line ${statusLine.kind === "error" ? "error" : "info"}`}>
          {statusLine.text}
        </div>
      )}

      {gitStatus.did_hit_limit && (
        <div className="git-status-line info">status truncated at 2000 entries</div>
      )}

      {SECTION_ORDER.map((area) => {
        const entries = groups[area];
        if (entries.length === 0) return null;
        return (
          <section key={area} className={`git-section git-section-${area}`}>
            <button
              type="button"
              className="git-section-header"
              onClick={() => toggleSection(area)}
            >
              {collapsed[area] ? (
                <ChevronRight size={13} className="git-section-chevron" />
              ) : (
                <ChevronDown size={13} className="git-section-chevron" />
              )}
              <span className="git-section-label">{SECTION_LABELS[area]}</span>
              <span className="git-count-badge">{entries.length}</span>
            </button>

            {!collapsed[area] && (
              <>
                {area !== "conflict" && (
                  <div className="git-section-bulk">
                    {(area === "unstaged" || area === "untracked") && (
                      <button
                        type="button"
                        className="git-bulk-btn"
                        onClick={() => {
                          void stageAction(entries.map((e) => e.path)).catch(() => {});
                        }}
                      >
                        + Stage all
                      </button>
                    )}
                    {area === "staged" && (
                      <button
                        type="button"
                        className="git-bulk-btn"
                        onClick={() => {
                          void unstageAction(entries.map((e) => e.path)).catch(() => {});
                        }}
                      >
                        − Unstage all
                      </button>
                    )}
                    <BulkDiscardButton area={area} entries={entries} />
                  </div>
                )}

                <div className="git-file-list">
                  {entries.map((entry) => (
                    <FileRow key={`${entry.path}:${entry.old_path ?? ""}`} entry={entry} />
                  ))}
                </div>

                {area === "staged" && (
                  <div className="git-commit-box">
                    <textarea
                      className="git-commit-message"
                      placeholder="Commit message…"
                      rows={3}
                      value={commitMessage}
                      onChange={(e) => setCommitMessage(e.target.value)}
                    />
                    <div className="git-commit-actions">
                      <button type="button" className="git-commit-ai-btn" disabled>
                        AI message — next task
                      </button>
                      <button
                        type="button"
                        className="git-commit-btn"
                        disabled={!canCommit || syncing !== null}
                        onClick={handleCommit}
                      >
                        Commit
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </section>
        );
      })}

      {gitStatus.entries.length === 0 && (
        <div className="empty-state">Working tree clean</div>
      )}

      <div className="git-history">
        <button type="button" className="git-history-toggle" onClick={toggleHistory}>
          History {historyOpen ? "▾" : "▸"}
        </button>
        {historyOpen && (
          <div className="git-history-list">
            {(gitHistory?.items ?? []).map((item) => (
              <div key={item.id} className="git-history-item">
                <span className="git-history-sha">{item.id.slice(0, 7)}</span>
                <span className="git-history-subject" title={item.subject}>
                  {item.subject}
                </span>
                <span className="git-history-stats">
                  +{item.stats.insertions} −{item.stats.deletions} files:{item.stats.files}
                </span>
              </div>
            ))}
            {gitHistory && gitHistory.items.length === 0 && (
              <div className="git-history-empty">No commits yet</div>
            )}
          </div>
        )}
      </div>

      <DiffNotesShelf />
    </div>
  );
}

function BulkDiscardButton({
  area,
  entries,
}: {
  area: GitArea;
  entries: StatusEntry[];
}): React.ReactElement {
  const discard = useTerminalStore((s) => s.discard);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(timer);
  }, [confirming]);

  const includeUntracked = area === "untracked";
  const handleClick = () => {
    if (includeUntracked && !confirming) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    void discard(
      entries.map((e) => e.path),
      includeUntracked,
    ).catch(() => {});
  };

  return (
    <button
      type="button"
      className={`git-bulk-btn${confirming ? " armed" : ""}`}
      title={includeUntracked && !confirming ? undefined : includeUntracked ? "Click again to confirm" : undefined}
      onClick={handleClick}
    >
      Discard all
    </button>
  );
}
