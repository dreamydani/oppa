import React, { useState, useEffect, useMemo } from "react";
import { GitBranch, MoreHorizontal } from "lucide-react";
import { useTerminalStore } from "../../store/terminalStore";
import type { WorktreeRecord, WorktreeStatus, WorktreeListEntry } from "../../lib/pty/transport";
import "./worktree.css";

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
  const setWorktreeStatus = useTerminalStore((s) => s.setWorktreeStatus);
  const renameWorktree = useTerminalStore((s) => s.renameWorktree);
  const removeWorktree = useTerminalStore((s) => s.removeWorktree);
  const purgeWorktree = useTerminalStore((s) => s.purgeWorktree);
  const createTab = useTerminalStore((s) => s.createTab);
  const openWorktreeCreate = useTerminalStore((s) => s.openWorktreeCreate);

  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmTarget, setConfirmTarget] = useState<WorktreeRecord | null>(null);
  const [confirmMode, setConfirmMode] = useState<"remove" | "purge">("remove");
  const [actionError, setActionError] = useState<string | null>(null);

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
