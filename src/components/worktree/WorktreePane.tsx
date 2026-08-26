import React, { useState, useEffect, useMemo } from "react";
import { ExternalLink, GitBranch, GitPullRequest, MoreHorizontal } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTerminalStore } from "../../store/terminalStore";
import type { WorktreeRecord, WorktreeStatus, WorktreeListEntry } from "../../lib/pty/transport";
import type { SessionInfo } from "../../store/slices/terminalSessionsSlice";
import { sessionDisplayTitle } from "../TerminalPaneHeader";
import { BLOCKED_COPY } from "../right-sidebar/ReviewComposer";
import { findLeafPath } from "../../lib/pane-manager/layout";
import "./worktree.css";

const NO_LINKED_TERMINALS: SessionInfo[] = [];

// Finish-chain card state: running spinner, PR confirmation, or failure reason.
type FinishCardState =
  | { phase: "running" }
  | { phase: "created"; prUrl: string }
  | { phase: "failed"; reason: string };

function finishFailureReason(reason: string): string {
  // Eligibility failures carry the machine blocked_reason; reuse the review
  // composer's actionable copy so both surfaces read the same.
  return (BLOCKED_COPY as Record<string, string>)[reason] ?? reason;
}

function prNumberFromUrl(url: string): string | null {
  const m = url.match(/\/pull\/(\d+)/);
  return m ? m[1] : null;
}

function prDotClassForState(state?: string): string {
  const s = (state ?? "").toLowerCase();
  if (s === "open") return "dot-open";
  if (s === "merged") return "dot-merged";
  if (s === "closed") return "dot-closed";
  return "dot-unknown";
}

const STATUS_ORDER: WorktreeStatus[] = ["todo", "in-progress", "in-review", "completed"];

const STATUS_LABELS: Record<WorktreeStatus, string> = {
  todo: "Todo",
  "in-progress": "In Progress",
  "in-review": "In Review",
  completed: "Completed",
};

function sortEntries(entries: WorktreeListEntry[]): WorktreeListEntry[] {
  return [...entries].sort((a, b) => {
    if (a.record.retired !== b.record.retired) return a.record.retired ? 1 : -1;
    return (
      a.record.created_at_ms - b.record.created_at_ms || a.record.id.localeCompare(b.record.id)
    );
  });
}

export function WorktreePane({ filter = "" }: { filter?: string }): React.ReactElement {
  const worktrees = useTerminalStore((s) => s.worktrees);
  const liveSessions = useTerminalStore((s) => s.worktreeLiveSessions);
  const reviewByCwd = useTerminalStore((s) => s.reviewByCwd);
  const prStatusByWorktreeId = useTerminalStore((s) => s.prStatusByWorktreeId);
  const setWorktreeStatus = useTerminalStore((s) => s.setWorktreeStatus);
  const finishWorktree = useTerminalStore((s) => s.finishWorktree);
  const loadWorktrees = useTerminalStore((s) => s.loadWorktrees);
  const renameWorktree = useTerminalStore((s) => s.renameWorktree);
  const removeWorktree = useTerminalStore((s) => s.removeWorktree);
  const purgeWorktree = useTerminalStore((s) => s.purgeWorktree);
  const createTab = useTerminalStore((s) => s.createTab);
  const openWorktreeCreate = useTerminalStore((s) => s.openWorktreeCreate);
  const sessions = useTerminalStore((s) => s.sessions);
  const workingBySessionId = useTerminalStore((s) => s.workingBySessionId);
  const tabs = useTerminalStore((s) => s.tabs);
  const selectTab = useTerminalStore((s) => s.selectTab);

  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmTarget, setConfirmTarget] = useState<WorktreeRecord | null>(null);
  const [confirmMode, setConfirmMode] = useState<"remove" | "purge">("remove");
  const [actionError, setActionError] = useState<string | null>(null);
  const [finishByCardId, setFinishByCardId] = useState<Record<string, FinishCardState>>({});

  useEffect(() => {
    if (!openMenuId) return;
    const closeOnOutsideClick = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".worktree-card-menu")) {
        setOpenMenuId(null);
      }
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [openMenuId]);

  useEffect(() => {
    if (!renamingId) return;
    // Menu must close before the inline input takes over the card title row.
    setOpenMenuId(null);
  }, [renamingId]);

  const sorted = useMemo(() => {
    const query = filter.toLowerCase().trim();
    const visible = query
      ? worktrees.filter(({ record }) =>
          (record.display_name || record.name).toLowerCase().includes(query) ||
          record.branch.toLowerCase().includes(query),
        )
      : worktrees;
    return sortEntries(visible);
  }, [worktrees, filter]);

  // Live bound sessions per worktree id — one join pass, recomputed only when
  // the sessions map identity changes (idle sessions never trigger it).
  const linkedByWorktreeId = useMemo(() => {
    const byWorktree = new Map<string, SessionInfo[]>();
    for (const session of Object.values(sessions)) {
      if (!session.worktreeId || session.status === "exited") continue;
      const list = byWorktree.get(session.worktreeId);
      if (list) list.push(session);
      else byWorktree.set(session.worktreeId, [session]);
    }
    return byWorktree;
  }, [sessions]);

  const openLinkedTerminal = (sessionId: string) => {
    const tab = tabs.find((t) => findLeafPath(t.layout, sessionId) !== null);
    if (tab) selectTab(tab.id);
  };

  const startRename = (record: WorktreeRecord) => {
    setRenamingId(record.id);
    setRenameValue(record.display_name ?? record.name);
  };

  const saveRename = async () => {
    const id = renamingId;
    setRenamingId(null);
    if (!id || !renameValue.trim()) return;
    try {
      await renameWorktree(id, renameValue.trim());
    } catch (e) {
      console.error("worktree rename failed:", e);
    }
  };

  const handleSetStatus = async (id: string, status: WorktreeStatus) => {
    setOpenMenuId(null);
    try {
      await setWorktreeStatus(id, status);
    } catch (e) {
      console.error("worktree status change failed:", e);
    }
  };

  const runFinish = async (record: WorktreeRecord) => {
    setOpenMenuId(null);
    setFinishByCardId((prev) => ({ ...prev, [record.id]: { phase: "running" } }));
    try {
      const outcome = await finishWorktree({ worktreeId: record.id });
      if (outcome.ok) {
        // Re-list so the freshly linked PR badge renders on the card.
        await loadWorktrees();
        setFinishByCardId((prev) => ({
          ...prev,
          [record.id]: { phase: "created", prUrl: outcome.prUrl ?? "" },
        }));
      } else {
        setFinishByCardId((prev) => ({
          ...prev,
          [record.id]: { phase: "failed", reason: outcome.reason },
        }));
      }
    } catch (e) {
      setFinishByCardId((prev) => ({
        ...prev,
        [record.id]: {
          phase: "failed",
          reason: e instanceof Error ? e.message : String(e),
        },
      }));
    }
  };

  const openConfirm = (record: WorktreeRecord, mode: "remove" | "purge") => {
    setOpenMenuId(null);
    setActionError(null);
    setConfirmMode(mode);
    setConfirmTarget(record);
  };

  const handleConfirm = async () => {
    if (!confirmTarget) return;
    try {
      if (confirmMode === "remove") {
        await removeWorktree(confirmTarget.id);
      } else {
        await purgeWorktree(confirmTarget.id);
      }
      setConfirmTarget(null);
    } catch (e) {
      // Teardown refusal stays visible inside the dialog.
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleOpenTerminal = (record: WorktreeRecord) => {
    setOpenMenuId(null);
    void createTab(record.path, record.id).catch((e) =>
      console.error("worktree terminal spawn failed:", e),
    );
  };

  const handleOpenPr = (url: string) => {
    openUrl(url).catch(() => {
      window.open(url, "_blank", "noopener,noreferrer");
    });
  };

  return (
    <div className="worktree-pane">
      <div className="tab-list" role="list">
        {sorted.length === 0 ? (
          <div className="sidebar-empty-state">
            {filter.trim() ? (
              <>
                <span className="sidebar-empty-title">No Matches</span>
                <span className="sidebar-empty-desc">
                  No worktrees matching &quot;{filter}&quot;
                </span>
              </>
            ) : (
              <>
                <span className="sidebar-empty-title">No Workspaces Yet</span>
                <span className="sidebar-empty-desc">
                  Create a git worktree to work on features in parallel.
                </span>
                <button
                  type="button"
                  className="sidebar-empty-btn"
                  onClick={openWorktreeCreate}
                >
                  New Worktree
                </button>
              </>
            )}
          </div>
        ) : (
          sorted.map(({ record, missing_on_disk }) => {
            const live = liveSessions[record.id] ?? 0;
            const isEditing = renamingId === record.id;
            const linked = linkedByWorktreeId.get(record.id) ?? NO_LINKED_TERMINALS;
            const finish = finishByCardId[record.id];

            return (
              <div
                key={record.id}
                role="listitem"
                className={`worktree-card${record.retired ? " retired" : ""}${
                  missing_on_disk ? " missing" : ""
                }`}
                title={record.path}
              >
                <div className="tab-card-avatar worktree-card-avatar">
                  <GitBranch size={14} />
                </div>

                <div className="worktree-card-content">
                  <div className="worktree-card-row-top">
                    {isEditing ? (
                      <input
                        type="text"
                        className="tab-rename-input"
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => void saveRename()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void saveRename();
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            setRenamingId(null);
                          }
                        }}
                        aria-label={`Rename ${record.name}`}
                      />
                    ) : (
                      <span className="worktree-card-title">
                        {record.display_name || record.name}
                      </span>
                    )}
                  </div>
                  <div className="worktree-card-meta">
                    <span className="worktree-chip branch">{record.branch}</span>
                    {record.linked_pr_url && (() => {
                      const num = prNumberFromUrl(record.linked_pr_url!);
                      const cached = prStatusByWorktreeId[record.id] ?? reviewByCwd[record.path]?.prStatus;
                      const dotCls = prDotClassForState(cached?.state);
                      return (
                        <>
                          <span className="worktree-pr-badge" data-testid="pr-badge" title={record.linked_pr_url!}>
                            <span className={`pr-badge-dot ${dotCls}`} data-testid="pr-badge-dot" />
                            #{num ?? "PR"}
                          </span>
                          <button
                            type="button"
                            className="worktree-pr-open"
                            data-testid="pr-open-link"
                            title="Open PR"
                            aria-label={`Open PR for ${record.display_name || record.name}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleOpenPr(record.linked_pr_url!);
                            }}
                          >
                            <ExternalLink size={12} />
                          </button>
                        </>
                      );
                    })()}
                    {!record.retired && (
                      <span
                        className={`worktree-status-chip status-${record.workspace_status}`}
                      >
                        <span className="status-dot" />
                        {STATUS_LABELS[record.workspace_status]}
                      </span>
                    )}
                    {record.retired && (
                      <span className="worktree-retired-chip">retired</span>
                    )}
                    {missing_on_disk && (
                      <span
                        className="worktree-missing-chip"
                        title="Directory not found on disk"
                      >
                        missing on disk
                      </span>
                    )}
                    {!record.retired && live > 0 && (
                      <span className="worktree-live-chip">{live} live</span>
                    )}
                  </div>
                  {finish && (
                    <div
                      className={`worktree-finish-row ${finish.phase}`}
                      data-testid="finish-row"
                    >
                      {finish.phase === "running" && (
                        <>
                          <span className="worktree-finish-spinner" aria-hidden="true" />
                          <span className="worktree-finish-text">Finishing…</span>
                        </>
                      )}
                      {finish.phase === "created" && (
                        <span className="worktree-finish-text">
                          {prNumberFromUrl(finish.prUrl)
                            ? `PR #${prNumberFromUrl(finish.prUrl)} created`
                            : "Pull request created"}
                        </span>
                      )}
                      {finish.phase === "failed" && (
                        <span className="worktree-finish-text" role="alert">
                          {finishFailureReason(finish.reason)}
                        </span>
                      )}
                    </div>
                  )}
                  {linked.length > 0 && (
                    <div className="worktree-terminals">
                      <div className="worktree-terminals-label">
                        {linked.length} terminal{linked.length === 1 ? "" : "s"}
                      </div>
                      <div className="worktree-terminals-list">
                        {linked.map((session) => {
                          const isWorking = workingBySessionId[session.id] ?? false;
                          return (
                            <button
                              key={session.id}
                              type="button"
                              className="worktree-terminal-row"
                              title={`Switch to ${sessionDisplayTitle(session)}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                openLinkedTerminal(session.id);
                              }}
                            >
                              <span
                                className={`worktree-terminal-dot${isWorking ? " working" : ""}`}
                                aria-hidden="true"
                              />
                              <span className="worktree-terminal-title">
                                {sessionDisplayTitle(session)}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                <button
                  type="button"
                  className="worktree-card-menu-btn"
                  title="Worktree actions"
                  aria-label={`Actions for ${record.display_name || record.name}`}
                  aria-expanded={openMenuId === record.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenMenuId(openMenuId === record.id ? null : record.id);
                  }}
                >
                  <MoreHorizontal size={14} />
                </button>

                {openMenuId === record.id && (
                  <div className="worktree-card-menu" role="menu">
                    {!record.retired ? (
                      <>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={finish?.phase === "running"}
                          onClick={() => void runFinish(record)}
                        >
                          <GitPullRequest size={12} />
                          Finish…
                        </button>
                        <div className="worktree-menu-divider" />
                        <div className="worktree-menu-section-label">Set status</div>
                        {STATUS_ORDER.map((status) => (
                          <button
                            key={status}
                            type="button"
                            role="menuitem"
                            className={
                              status === record.workspace_status ? "active" : ""
                            }
                            onClick={() => void handleSetStatus(record.id, status)}
                          >
                            <span className={`status-dot dot-${status}`} />
                            {STATUS_LABELS[status]}
                          </button>
                        ))}
                        <div className="worktree-menu-divider" />
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => startRename(record)}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => handleOpenTerminal(record)}
                        >
                          Open terminal here
                        </button>
                        <div className="worktree-menu-divider" />
                        <button
                          type="button"
                          role="menuitem"
                          className="danger"
                          onClick={() => openConfirm(record, "remove")}
                        >
                          Remove…
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        role="menuitem"
                        className="danger"
                        onClick={() => openConfirm(record, "purge")}
                      >
                        Purge…
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {confirmTarget && (
        <div
          className="wt-modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) setConfirmTarget(null);
          }}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="wt-confirm-card"
            role="alertdialog"
            aria-label={confirmMode === "purge" ? "Purge worktree" : "Remove worktree"}
          >
            <h3 className="wt-confirm-title">
              {confirmMode === "purge"
                ? `Purge “${confirmTarget.display_name || confirmTarget.name}”?`
                : `Remove “${confirmTarget.display_name || confirmTarget.name}”?`}
            </h3>
            <p className="wt-confirm-desc">
              {confirmMode === "purge"
                ? "Drops the tombstone record. The directory is never touched."
                : `Removes the git worktree at ${confirmTarget.path}. The branch is preserved unless it is fully merged.`}
            </p>
            {actionError && <p className="wt-error" role="alert">{actionError}</p>}
            <div className="wt-confirm-actions">
              <button
                type="button"
                className="wt-btn"
                onClick={() => setConfirmTarget(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="wt-btn danger"
                onClick={() => void handleConfirm()}
              >
                {confirmMode === "purge" ? "Purge" : "Remove"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
