import React, { useEffect, useState } from "react";
import { ExternalLink, GitMerge, GitPullRequest, MoreHorizontal } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTerminalStore } from "../../store/terminalStore";
import type { WorktreeRecord } from "../../lib/worktree/transport";
import { BLOCKED_COPY } from "../right-sidebar/ReviewComposer";
import "./workspace-list.css";

// Finish-chain outcome: running spinner, PR confirmation, or failure reason.
type FinishState =
  | { phase: "running" }
  | { phase: "created"; prUrl: string }
  | { phase: "failed"; reason: string };

function finishFailureReason(reason: string): string {
  // Eligibility failures carry the machine blocked_reason; reuse the review
  // composer's actionable copy so all surfaces read the same.
  return (BLOCKED_COPY as Record<string, string>)[reason] ?? reason;
}

function prNumberFromUrl(url: string): string | null {
  const m = url.match(/\/pull\/(\d+)/);
  return m ? m[1] : null;
}

export interface WorktreeActionsMenuProps {
  record: WorktreeRecord;
  // Called after remove/purge/merge mutate the registry so the parent can
  // refresh derived rows.
  onActionFinished?: () => void;
}

// Row-badge actions menu: Finish / Merge into base / Open PR / Remove / Purge.
// Migrated from the dead WorktreePane so the finish chain stays reachable.
export function WorktreeActionsMenu({
  record,
  onActionFinished,
}: WorktreeActionsMenuProps): React.ReactElement {
  const finishWorktree = useTerminalStore((s) => s.finishWorktree);
  const mergeWorktreeToBase = useTerminalStore((s) => s.mergeWorktreeToBase);
  const removeWorktree = useTerminalStore((s) => s.removeWorktree);
  const purgeWorktree = useTerminalStore((s) => s.purgeWorktree);
  const loadWorktrees = useTerminalStore((s) => s.loadWorktrees);

  const [isOpen, setIsOpen] = useState(false);
  const [finish, setFinish] = useState<FinishState | null>(null);
  const [confirmMode, setConfirmMode] = useState<"remove" | "purge" | "merge" | null>(null);
  const [mergeKind, setMergeKind] = useState<"squash" | "merge">("squash");
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnOutsideClick = (e: MouseEvent) => {
      if (
        !(e.target as HTMLElement).closest(".worktree-card-menu") &&
        !(e.target as HTMLElement).closest(".ws-row-menu-btn")
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [isOpen]);

  const displayName = record.display_name || record.name;

  const runFinish = async () => {
    setIsOpen(false);
    setFinish({ phase: "running" });
    try {
      const outcome = await finishWorktree({ worktreeId: record.id });
      if (outcome.ok) {
        // Re-list so the freshly linked PR badge renders everywhere.
        await loadWorktrees();
        setFinish({ phase: "created", prUrl: outcome.prUrl ?? "" });
        onActionFinished?.();
      } else {
        setFinish({ phase: "failed", reason: outcome.reason });
      }
    } catch (e) {
      setFinish({
        phase: "failed",
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const openConfirm = (mode: "remove" | "purge" | "merge") => {
    setIsOpen(false);
    setActionError(null);
    setMergeKind("squash");
    setConfirmMode(mode);
  };

  const handleConfirm = async (force = false) => {
    if (!confirmMode) return;
    try {
      if (confirmMode === "remove") {
        await removeWorktree(record.id, force);
      } else if (confirmMode === "purge") {
        await purgeWorktree(record.id);
      } else {
        await mergeWorktreeToBase({ worktreeId: record.id, mode: mergeKind });
      }
      setConfirmMode(null);
      onActionFinished?.();
    } catch (e) {
      // Teardown/merge refusal stays visible inside the dialog.
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleOpenPr = (url: string) => {
    openUrl(url).catch(() => {
      window.open(url, "_blank", "noopener,noreferrer");
    });
  };

  return (
    <>
      <button
        type="button"
        className="ws-row-menu-btn"
        title="Branch actions"
        aria-label={`Actions for ${displayName}`}
        aria-expanded={isOpen}
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen((prev) => !prev);
        }}
      >
        <MoreHorizontal size={12} />
      </button>

      {isOpen && (
        <div className="worktree-card-menu" role="menu" data-motion="menu">
          {!record.retired ? (
            <>
              <button
                type="button"
                role="menuitem"
                disabled={finish?.phase === "running"}
                onClick={() => void runFinish()}
              >
                <GitPullRequest size={12} />
                Finish…
              </button>
              {record.linked_pr_url && (
                <button
                  type="button"
                  role="menuitem"
                  title="Open PR"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleOpenPr(record.linked_pr_url!);
                  }}
                >
                  <ExternalLink size={12} />
                  Open PR
                </button>
              )}
              {record.base_ref && (
                <>
                  <div className="worktree-menu-divider" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => openConfirm("merge")}
                  >
                    <GitMerge size={12} />
                    Merge into {record.base_ref}…
                  </button>
                </>
              )}
              <div className="worktree-menu-divider" />
              <button
                type="button"
                role="menuitem"
                className="danger"
                onClick={() => openConfirm("remove")}
              >
                Remove…
              </button>
            </>
          ) : (
            <button
              type="button"
              role="menuitem"
              className="danger"
              onClick={() => openConfirm("purge")}
            >
              Purge…
            </button>
          )}
        </div>
      )}

      {finish && (
        <div className={`ws-finish-row ${finish.phase}`} data-testid="ws-finish-row">
          {finish.phase === "running" && (
            <>
              <span className="ws-finish-spinner" aria-hidden="true" />
              <span className="ws-finish-text">Finishing…</span>
            </>
          )}
          {finish.phase === "created" && (
            <span className="ws-finish-text">
              {prNumberFromUrl(finish.prUrl)
                ? `PR #${prNumberFromUrl(finish.prUrl)} created`
                : "Pull request created"}
            </span>
          )}
          {finish.phase === "failed" && (
            <span className="ws-finish-text" role="alert">
              {finishFailureReason(finish.reason)}
            </span>
          )}
        </div>
      )}

      {confirmMode && (
        <div
          className="wt-modal-backdrop"
          data-motion="scrim"
          data-state="open"
          onClick={(e) => {
            if (e.target === e.currentTarget) setConfirmMode(null);
          }}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="wt-confirm-card"
            data-motion="modal"
            data-state="open"
            role="alertdialog"
            aria-label={
              confirmMode === "purge"
                ? "Purge worktree"
                : confirmMode === "merge"
                  ? "Merge into base"
                  : "Remove worktree"
            }
          >
            <h3 className="wt-confirm-title">
              {confirmMode === "purge"
                ? `Purge “${displayName}”?`
                : confirmMode === "merge"
                  ? `Merge “${displayName}” into ${record.base_ref}?`
                  : `Remove “${displayName}”?`}
            </h3>
            {confirmMode === "merge" ? (
              <>
                <p className="wt-confirm-desc">
                  Runs in the main checkout. It is blocked with a reason if the checkout is dirty,
                  not on {record.base_ref}, or if merging would conflict.
                </p>
                <div className="wt-radio-row" role="radiogroup" aria-label="Merge mode">
                  <label>
                    <input
                      type="radio"
                      name="merge-mode"
                      checked={mergeKind === "squash"}
                      onChange={() => setMergeKind("squash")}
                    />
                    Squash into one commit
                  </label>
                  <label>
                    <input
                      type="radio"
                      name="merge-mode"
                      checked={mergeKind === "merge"}
                      onChange={() => setMergeKind("merge")}
                    />
                    Keep a merge commit
                  </label>
                </div>
              </>
            ) : (
              <p className="wt-confirm-desc">
                {confirmMode === "purge"
                  ? "Drops the tombstone record. The directory is never touched."
                  : `Removes the git worktree at ${record.path}. The branch is preserved unless it is fully merged.`}
              </p>
            )}
            {actionError && <p className="wt-error" role="alert">{actionError}</p>}
            <div className="wt-confirm-actions">
              <button
                type="button"
                className="wt-btn"
                onClick={() => setConfirmMode(null)}
              >
                Cancel
              </button>
              {confirmMode === "remove" && actionError?.includes("live sessions present") ? (
                <button
                  type="button"
                  className="wt-btn danger"
                  onClick={() => void handleConfirm(true)}
                >
                  Force Remove
                </button>
              ) : (
                <button
                  type="button"
                  className={`wt-btn${confirmMode === "remove" || confirmMode === "purge" ? " danger" : ""}`}
                  onClick={() => void handleConfirm(false)}
                >
                  {confirmMode === "purge" ? "Purge" : confirmMode === "merge" ? "Merge" : "Remove"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
