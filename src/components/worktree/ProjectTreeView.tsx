import React, { useState, useEffect, useMemo } from "react";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Folder,
  GitBranch,
  GitMerge,
  LayoutGrid,
  Layers,
  MoreHorizontal,
  Plus,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTerminalStore, selectProjectTree } from "../../store/terminalStore";
import type { BranchNode, ProjectNode } from "../../store/terminalStore";
import type { MergeModeInput, WorktreeRecord } from "../../lib/pty/transport";
import { findLeafPath } from "../../lib/pane-manager/layout";
import { sessionDisplayTitle } from "../TerminalPaneHeader";
import { AgentStatusPill } from "../agent/AgentStatusPill";
import "./worktree.css";
import "./ProjectTreeView.css";

export interface ProjectTreeViewProps {
  filter?: string;
}

function prNumberFromUrl(url: string): string | null {
  const match = url.match(/\/pull\/(\d+)/);
  return match ? match[1] : null;
}

function prDotClassForState(state?: string): string {
  const s = (state ?? "").toLowerCase();
  if (s === "open") return "dot-open";
  if (s === "merged") return "dot-merged";
  if (s === "closed") return "dot-closed";
  return "dot-unknown";
}

export function ProjectTreeView({ filter = "" }: ProjectTreeViewProps): React.ReactElement {
  const repos = useTerminalStore((s) => s.repos);
  const worktrees = useTerminalStore((s) => s.worktrees);
  const sessions = useTerminalStore((s) => s.sessions);
  const workingBySessionId = useTerminalStore((s) => s.workingBySessionId);
  const statusBySessionId = useTerminalStore((s) => s.statusBySessionId);
  const unreadBySessionId = useTerminalStore((s) => s.unreadBySessionId);

  const projectTree = useMemo(
    () => selectProjectTree({ repos, worktrees, sessions, workingBySessionId }),
    [repos, worktrees, sessions, workingBySessionId],
  );

  const markAgentStatusSeen = useTerminalStore((s) => s.markAgentStatusSeen);

  const openWorktreeCreate = useTerminalStore((s) => s.openWorktreeCreate);
  const openFleetSheet = useTerminalStore((s) => s.openFleetSheet);
  const tileProjectBranches = useTerminalStore((s) => s.tileProjectBranches);
  const focusBranchPane = useTerminalStore((s) => s.focusBranchPane);
  const createTab = useTerminalStore((s) => s.createTab);
  const selectTab = useTerminalStore((s) => s.selectTab);
  const focusPane = useTerminalStore((s) => s.focusPane);
  const tabs = useTerminalStore((s) => s.tabs);
  const removeWorktree = useTerminalStore((s) => s.removeWorktree);
  const purgeWorktree = useTerminalStore((s) => s.purgeWorktree);
  const mergeWorktreeToBase = useTerminalStore((s) => s.mergeWorktreeToBase);
  const reviewByCwd = useTerminalStore((s) => s.reviewByCwd);
  const prStatusByWorktreeId = useTerminalStore((s) => s.prStatusByWorktreeId);

  const [collapsedRepos, setCollapsedRepos] = useState<Record<string, boolean>>({});
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<WorktreeRecord | null>(null);
  const [confirmMode, setConfirmMode] = useState<"remove" | "purge" | "merge">("remove");
  const [mergeKind, setMergeKind] = useState<MergeModeInput>("squash");
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

  const toggleRepoCollapse = (repoId: string) => {
    setCollapsedRepos((prev) => ({ ...prev, [repoId]: !prev[repoId] }));
  };

  const filteredProjects = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return projectTree;

    return projectTree
      .map((project) => {
        const repoMatches =
          project.repoName.toLowerCase().includes(query) ||
          project.repoPath.toLowerCase().includes(query);

        const matchingBranches = project.branches.filter(
          (branch) =>
            branch.name.toLowerCase().includes(query) ||
            branch.branch.toLowerCase().includes(query) ||
            branch.path.toLowerCase().includes(query),
        );

        if (repoMatches) {
          return project;
        }

        if (matchingBranches.length > 0) {
          return {
            ...project,
            branches: matchingBranches,
          };
        }

        return null;
      })
      .filter((p): p is ProjectNode => p !== null);
  }, [projectTree, filter]);

  const handleBranchClick = (branch: BranchNode) => {
    void focusBranchPane(branch.worktreeId);
  };

  const handleOpenLinkedTerminal = (sessionId: string) => {
    markAgentStatusSeen(sessionId);
    const tab = tabs.find((t) => findLeafPath(t.layout, sessionId) !== null);
    if (tab) {
      selectTab(tab.id);
      const path = findLeafPath(tab.layout, sessionId);
      if (path) focusPane(path);
    }
  };

  const handleOpenPr = (url: string) => {
    openUrl(url).catch(() => {
      window.open(url, "_blank", "noopener,noreferrer");
    });
  };

  const openConfirmDialog = (
    branch: BranchNode,
    mode: "remove" | "purge" | "merge",
  ) => {
    setOpenMenuId(null);
    setActionError(null);
    setMergeKind("squash");
    setConfirmMode(mode);

    const record = worktrees.find((w) => w.record.id === branch.worktreeId)?.record ?? {
      id: branch.worktreeId,
      repo_id: "",
      name: branch.name,
      display_name: branch.name,
      branch: branch.branch,
      path: branch.path,
      base_ref: "main",
      parent_worktree_id: null,
      child_worktree_ids: [],
      workspace_status: "in-progress" as const,
      retired: branch.retired,
      created_at_ms: 0,
      linked_pr_url: branch.prUrl,
    };
    setConfirmTarget(record);
  };

  const handleConfirmAction = async (force = false) => {
    if (!confirmTarget) return;
    try {
      if (confirmMode === "remove") {
        await removeWorktree(confirmTarget.id, force);
      } else if (confirmMode === "purge") {
        await purgeWorktree(confirmTarget.id);
      } else {
        await mergeWorktreeToBase({ worktreeId: confirmTarget.id, mode: mergeKind });
      }
      setConfirmTarget(null);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  if (projectTree.length === 0) {
    return (
      <div className="sidebar-empty-state">
        <span className="sidebar-empty-title">No Projects Yet</span>
        <span className="sidebar-empty-desc">
          Create a git worktree to work on features in parallel.
        </span>
        <button
          type="button"
          className="sidebar-empty-btn"
          onClick={openWorktreeCreate}
        >
          <Plus size={12} /> New Worktree
        </button>
      </div>
    );
  }

  if (filteredProjects.length === 0 && filter.trim()) {
    return (
      <div className="sidebar-empty-state">
        <span className="sidebar-empty-title">No Matches</span>
        <span className="sidebar-empty-desc">
          No worktrees matching &quot;{filter}&quot;
        </span>
      </div>
    );
  }

  return (
    <div className="project-tree-view" role="tree" aria-label="Project workspaces tree">
      {filteredProjects.map((project) => {
        const isCollapsed = Boolean(collapsedRepos[project.repoId]);

        return (
          <div key={project.repoId} className="project-node" role="treeitem" aria-expanded={!isCollapsed}>
            {/* Project Group Header */}
            <div
              className="project-node-header"
              onClick={() => toggleRepoCollapse(project.repoId)}
              title={project.repoPath}
            >
              <button
                type="button"
                className="project-chevron"
                aria-label={`Toggle ${project.repoName} project`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleRepoCollapse(project.repoId);
                }}
              >
                {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              </button>

              <Folder size={14} className="project-folder-icon" />

              <span className="project-name">{project.repoName}</span>

              {project.totalLiveSessions > 0 && (
                <span className="project-live-chip">{project.totalLiveSessions} live</span>
              )}

              <div className="project-header-actions">
                <button
                  type="button"
                  className="project-action-btn"
                  title="Tile branches in grid"
                  aria-label="Tile branches in grid"
                  onClick={(e) => {
                    e.stopPropagation();
                    void tileProjectBranches(project.repoId);
                  }}
                >
                  <LayoutGrid size={13} />
                </button>
                <button
                  type="button"
                  className="project-action-btn"
                  title="Spawn Fleet"
                  aria-label={`Spawn Fleet in ${project.repoName}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    openFleetSheet({ repoPath: project.repoPath });
                  }}
                >
                  <Layers size={13} />
                </button>
                <button
                  type="button"
                  className="project-action-btn"
                  title="New Worktree"
                  aria-label={`New Worktree in ${project.repoName}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    openWorktreeCreate();
                  }}
                >
                  <Plus size={13} />
                </button>
              </div>
            </div>

            {/* Nested Branch List */}
            {!isCollapsed && (
              <div className="project-branches-list" role="group">
                {project.branches.map((branch) => {
                  const liveSessionsCount = branch.sessionIds.filter(
                    (sId) => sessions[sId] && sessions[sId].status !== "exited",
                  ).length;
                  const prNum = branch.prUrl ? prNumberFromUrl(branch.prUrl) : null;
                  const cachedPr =
                    prStatusByWorktreeId[branch.worktreeId] ?? reviewByCwd[branch.path]?.prStatus;
                  const prDotClass = prDotClassForState(cachedPr?.state);

                  return (
                    <div
                      key={branch.worktreeId}
                      className={`project-branch-item${branch.retired ? " retired" : ""}`}
                      role="treeitem"
                    >
                      <div
                        className="branch-row-main"
                        onClick={() => handleBranchClick(branch)}
                        title={branch.path}
                      >
                        <GitBranch size={13} className="branch-icon" />

                        <div className="branch-info">
                          <div className="branch-name-row">
                            <span className="branch-name">{branch.name}</span>
                          </div>

                          <div className="branch-meta-row">
                            <span
                              className={`branch-status-chip status-${branch.status}`}
                            >
                              <span
                                className={`branch-status-dot status-${branch.status}`}
                              />
                              {branch.status}
                            </span>

                            {branch.prUrl && (
                              <>
                                <span
                                  className="worktree-pr-badge"
                                  data-testid="pr-badge"
                                  title={branch.prUrl}
                                >
                                  <span className={`pr-badge-dot ${prDotClass}`} data-testid="pr-badge-dot" />
                                  #{prNum ?? "PR"}
                                </span>
                                <button
                                  type="button"
                                  className="worktree-pr-open"
                                  data-testid="pr-open-link"
                                  title="Open PR"
                                  aria-label={`Open PR for ${branch.name}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleOpenPr(branch.prUrl!);
                                  }}
                                >
                                  <ExternalLink size={11} />
                                </button>
                              </>
                            )}

                            {branch.retired && (
                              <span className="branch-retired-chip">retired</span>
                            )}

                            {branch.missingOnDisk && (
                              <span className="branch-missing-chip" title="Directory not found on disk">
                                missing
                              </span>
                            )}

                            {!branch.retired && liveSessionsCount > 0 && (
                              <span className="branch-live-chip">{liveSessionsCount} live</span>
                            )}
                          </div>
                        </div>

                        <button
                          type="button"
                          className="worktree-card-menu-btn"
                          title="Branch actions"
                          aria-label={`Actions for ${branch.name}`}
                          aria-expanded={openMenuId === branch.worktreeId}
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenMenuId(openMenuId === branch.worktreeId ? null : branch.worktreeId);
                          }}
                        >
                          <MoreHorizontal size={13} />
                        </button>
                      </div>

                      {/* Sub-sessions list when multiple sessions exist */}
                      {branch.sessionIds.length > 0 && (
                        <div className="branch-subsessions-list">
                          {branch.sessionIds.map((sId) => {
                            const session = sessions[sId];
                            const isWorking = workingBySessionId[sId] ?? false;
                            const isExited = session?.status === "exited";
                            const title = session ? sessionDisplayTitle(session) : sId;
                            const agentEntry = statusBySessionId[sId];
                            const unread = unreadBySessionId[sId] ?? false;

                            return (
                              <button
                                key={sId}
                                type="button"
                                className={`branch-subsession-row${isExited ? " exited" : ""}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleOpenLinkedTerminal(sId);
                                }}
                                title={`Switch to ${title}`}
                              >
                                {agentEntry ? (
                                  <AgentStatusPill entry={agentEntry} unread={unread} />
                                ) : (
                                  <span
                                    className={`subsession-dot${isWorking ? " working" : ""}`}
                                    aria-hidden="true"
                                  />
                                )}
                                <span className="subsession-title">{title}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}

                      {/* Dropdown Menu */}
                      {openMenuId === branch.worktreeId && (
                        <div className="worktree-card-menu" role="menu">
                          <button
                            type="button"
                            role="menuitem"
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpenMenuId(null);
                              void createTab(branch.path, branch.worktreeId);
                            }}
                          >
                            Open terminal here
                          </button>
                          {!branch.retired ? (
                            <>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openConfirmDialog(branch, "merge");
                                }}
                              >
                                <GitMerge size={12} />
                                Merge into base…
                              </button>
                              <div className="worktree-menu-divider" />
                              <button
                                type="button"
                                role="menuitem"
                                className="danger"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openConfirmDialog(branch, "remove");
                                }}
                              >
                                Remove…
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              role="menuitem"
                              className="danger"
                              onClick={(e) => {
                                e.stopPropagation();
                                openConfirmDialog(branch, "purge");
                              }}
                            >
                              Purge…
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      {/* Confirmation Dialog for Remove / Purge / Merge */}
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
                ? `Purge “${confirmTarget.display_name || confirmTarget.name}”?`
                : confirmMode === "merge"
                  ? `Merge “${confirmTarget.display_name || confirmTarget.name}” into ${confirmTarget.base_ref}?`
                  : `Remove “${confirmTarget.display_name || confirmTarget.name}”?`}
            </h3>
            {confirmMode === "merge" ? (
              <>
                <p className="wt-confirm-desc">
                  Runs in the main checkout. It is blocked with a reason if the checkout is dirty,
                  not on {confirmTarget.base_ref}, or if merging would conflict.
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
                  : `Removes the git worktree at ${confirmTarget.path}. The branch is preserved unless it is fully merged.`}
              </p>
            )}
            {actionError && <p className="wt-error" role="alert">{actionError}</p>}
            <div className="wt-confirm-actions">
              <button
                type="button"
                className="wt-btn"
                onClick={() => setConfirmTarget(null)}
              >
                Cancel
              </button>
              {confirmMode === "remove" && actionError?.includes("live sessions present") ? (
                <button
                  type="button"
                  className="wt-btn danger"
                  onClick={() => void handleConfirmAction(true)}
                >
                  Force Remove
                </button>
              ) : (
                <button
                  type="button"
                  className={`wt-btn${confirmMode === "remove" || confirmMode === "purge" ? " danger" : ""}`}
                  onClick={() => void handleConfirmAction(false)}
                >
                  {confirmMode === "purge" ? "Purge" : confirmMode === "merge" ? "Merge" : "Remove"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
