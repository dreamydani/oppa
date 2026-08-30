import React, { useState, useMemo } from "react";
import { useTerminalStore } from "../../store/terminalStore";
import type { TabState } from "../../store/slices/paneLayoutSlice";
import { leafIds } from "../../store/slices/layoutQueries";
import { findLeafPath, focus } from "../../lib/pane-manager/layout";
import { sessionDisplayTitle } from "../TerminalPaneHeader";
import { WorktreeActionsMenu } from "./WorktreeActionsMenu";
import { CloseIcon, PlusIcon, SplitSquareIcon } from "../icons/MinimalIcons";
import { ChevronDown, Folder, Pin, Sparkles } from "lucide-react";
import "./workspace-list.css";


// Claude-style compact relative age: 2m, 51m, 1h, 5h, 2d.
function relativeAge(ms: number | undefined): string | null {
  if (!ms || ms <= 0) return null;
  const minutes = Math.floor((Date.now() - ms) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

interface WorkspaceRow {
  sessionId: string;
  title: string;
  worktreeId?: string;
  branch?: string;
  worktreeName?: string;
  worktreeRecord?: import("../../lib/pty/transport").WorktreeRecord;
  exited: boolean;
}

interface WorkspaceCardData {
  tab: TabState;
  isActive: boolean;
  rows: WorkspaceRow[];
}

// Memoized card: an agent-status flip re-renders only its own card, never the
// whole sidebar.
const WorkspaceCard = React.memo(function WorkspaceCard({
  data,
  expanded,
  activeSessionId,
  pinnedSessionIds,
  onToggleExpand,
  onSelect,
  onFocusRow,
  onClose,
  onAddAgent,
  onWorktreeAction,
  onSplitRow,
  onCloseRow,
  onTogglePin,
}: {
  data: WorkspaceCardData;
  expanded: boolean;
  activeSessionId: string | null;
  pinnedSessionIds: ReadonlySet<string>;
  onToggleExpand: (tabId: string) => void;
  onSelect: (tabId: string) => void;
  onFocusRow: (sessionId: string) => void;
  onClose: (tabId: string) => void;
  onAddAgent: () => void;
  onWorktreeAction: () => void;
  onSplitRow: (sessionId: string) => void;
  onCloseRow: (sessionId: string) => void;
  onTogglePin: (sessionId: string) => void;
}) {
  const title = data.tab.isWizard
    ? data.tab.title || "New Workspace"
    : data.tab.title || "Workspace";
  const statusBySessionId = useTerminalStore((s) => s.statusBySessionId);
  const workingBySessionId = useTerminalStore((s) => s.workingBySessionId);
  const unreadBySessionId = useTerminalStore((s) => s.unreadBySessionId);
  const markAgentStatusSeen = useTerminalStore((s) => s.markAgentStatusSeen);

  // Pinned sessions float to the top of their folder; the rest keep order.
  const sortedRows = useMemo(
    () =>
      [...data.rows].sort(
        (a, b) =>
          Number(pinnedSessionIds.has(b.sessionId)) -
          Number(pinnedSessionIds.has(a.sessionId)),
      ),
    [data.rows, pinnedSessionIds],
  );

  if (data.tab.isWizard) {
    return (
      <div className={`ws-card${data.isActive ? " active" : ""}`} data-testid="ws-card-wizard">
        <div
          className="ws-card-header"
          onClick={() => onSelect(data.tab.id)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => e.key === "Enter" && onSelect(data.tab.id)}
        >
          <span className="ws-card-avatar wizard">
            <Sparkles size={13} />
          </span>
          <span className="ws-card-title">{title}</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`ws-card${data.isActive ? " active" : ""}`}
      data-testid={`ws-card-${data.tab.id}`}
    >
      <div
        className="ws-card-header"
        onClick={() => {
          onSelect(data.tab.id);
          onToggleExpand(data.tab.id);
        }}
        role="button"
        tabIndex={0}
        aria-expanded={data.rows.length > 0 ? expanded : undefined}
        onKeyDown={(e) => e.key === "Enter" && onSelect(data.tab.id)}
      >
        <span className="ws-card-avatar">
          <Folder size={13} />
        </span>
        <span className="ws-card-title" title={data.tab.workspaceKey ?? title}>
          {title}
        </span>
        {data.rows.length > 1 && (
          <span
            className={`ws-card-chevron${expanded ? " expanded" : ""}`}
            aria-hidden="true"
          >
            <ChevronDown size={13} />
          </span>
        )}
        <span className="ws-card-header-spacer" />
        <div className="ws-card-actions">
          {data.tab.workspaceKey && (
            <button
              type="button"
              className="ws-card-action-btn ws-card-add"
              title="Add agent to this workspace"
              aria-label={`Add agent to ${title}`}
              onClick={(e) => {
                e.stopPropagation();
                onAddAgent();
              }}
            >
              <PlusIcon size={12} />
            </button>
          )}
          <button
            type="button"
            className="ws-card-action-btn ws-card-close"
            title="Close Workspace"
            aria-label={`Close ${title}`}
            onClick={(e) => {
              e.stopPropagation();
              onClose(data.tab.id);
            }}
          >
            <CloseIcon size={12} />
          </button>
        </div>
      </div>

      {expanded && (
        <div
          className="ws-card-rows"
          role="list"
          // Cascades the rows in on expand (see motion.css [data-motion="stagger"]).
          data-motion="stagger"
          data-state="open"
        >
          {data.rows.length === 0 && (
            <div className="ws-card-empty">No terminals in this workspace.</div>
          )}
          {sortedRows.map((row, rowIndex) => {
            const agentEntry = statusBySessionId[row.sessionId];
            const unread = unreadBySessionId[row.sessionId] ?? false;
            const isWorking = workingBySessionId[row.sessionId] ?? false;
            const isFocusedLeaf = data.isActive && row.sessionId === activeSessionId;
            const age = relativeAge(agentEntry?.state_started_at_ms);
            const isPinned = pinnedSessionIds.has(row.sessionId);
            // State mapping: focused=blue, working=pulsing indigo, done=green,
            // blocked=red, waiting=amber, idle=indigo, exited(stopped)=grey.
            const state = agentEntry
              ? agentEntry.state
              : row.exited
                ? "exited"
                : isWorking
                  ? "working"
                  : "idle";

            return (
              <div
                key={row.sessionId}
                role="listitem"
                className={`ws-row${isFocusedLeaf ? " is-active" : ""}${row.exited ? " exited" : ""}${isPinned ? " pinned" : ""}`}
                // Feeds the [data-motion="stagger"] cascade; motion.css caps it
                // at --stagger-cap so a long list still finishes arriving fast.
                style={{ "--row-index": rowIndex } as React.CSSProperties}
                onClick={() => {
                  markAgentStatusSeen(row.sessionId);
                  onFocusRow(row.sessionId);
                }}
                title={row.worktreeName ? `${row.worktreeName} · ${row.branch}` : row.title}
              >
                {!isPinned && (
                  <span
                    className={`ws-status-circle ${state}${isFocusedLeaf ? " focused" : ""}${unread ? " unread" : ""}`}
                    title={`Status: ${state}`}
                    aria-label={`Status: ${state}`}
                  />
                )}
                <button
                  type="button"
                  className={`ws-row-pin-btn${isPinned ? " is-pinned" : ""}`}
                  title={isPinned ? "Unpin session" : "Pin session to top"}
                  aria-label={isPinned ? `Unpin ${row.title}` : `Pin ${row.title}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onTogglePin(row.sessionId);
                  }}
                >
                  <Pin size={10} />
                </button>
                <span className="ws-row-title">{row.title}</span>
                {age && <span className="ws-row-time">{age}</span>}
                <div className="ws-row-actions">
                  <button
                    type="button"
                    className="ws-row-action-btn"
                    title="Split Pane Vertically"
                    aria-label={`Split ${row.title}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSplitRow(row.sessionId);
                    }}
                  >
                    <SplitSquareIcon size={11} />
                  </button>
                  <button
                    type="button"
                    className="ws-row-action-btn ws-row-close-btn"
                    title="Close Terminal Pane"
                    aria-label={`Close ${row.title}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseRow(row.sessionId);
                    }}
                  >
                    <CloseIcon size={10} />
                  </button>
                </div>
                {row.worktreeRecord && (
                  <WorktreeActionsMenu
                    record={row.worktreeRecord}
                    onActionFinished={onWorktreeAction}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});

export interface WorkspaceListProps {
  filter?: string;
}

export function WorkspaceList({ filter = "" }: WorkspaceListProps): React.ReactElement {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const sessions = useTerminalStore((s) => s.sessions);
  const worktrees = useTerminalStore((s) => s.worktrees);
  const selectTab = useTerminalStore((s) => s.selectTab);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const focusPane = useTerminalStore((s) => s.focusPane);
  const splitPane = useTerminalStore((s) => s.splitPane);
  const closePane = useTerminalStore((s) => s.closePane);
  const createWizardTab = useTerminalStore((s) => s.createWizardTab);
  const openWorktreeCreate = useTerminalStore((s) => s.openWorktreeCreate);

  // Compute active focused leaf session ID in the active tab
  const activeSessionId = useMemo(() => {
    const activeTab = tabs.find((t) => t.id === activeTabId);
    if (!activeTab || activeTab.isWizard) return null;
    try {
      return focus(activeTab.layout, activeTab.focusedPath);
    } catch {
      return null;
    }
  }, [tabs, activeTabId]);

  // Component-local collapse state; default: active expanded, others collapsed.
  const [collapsedOverrides, setCollapsedOverrides] = useState<Record<string, boolean>>({});
  const toggleExpand = (tabId: string) => {
    setCollapsedOverrides((prev) => {
      const isDefaultExpanded = tabId === useTerminalStore.getState().activeTabId;
      const currentlyExpanded = prev[tabId] === undefined ? isDefaultExpanded : !prev[tabId];
      return { ...prev, [tabId]: !currentlyExpanded };
    });
  };

  // Pinned sessions float to the top of their folder (session-scoped).
  const [pinnedSessionIds, setPinnedSessionIds] = useState<ReadonlySet<string>>(new Set());
  const togglePin = (sessionId: string) => {
    setPinnedSessionIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const cards: WorkspaceCardData[] = useMemo(() => {
    const worktreeById = new Map(worktrees.map((w) => [w.record.id, w.record]));
    const query = filter.trim().toLowerCase();

    const result: WorkspaceCardData[] = [];
    for (const tab of tabs) {
      const ids = tab.isWizard ? [] : leafIds(tab.layout);
      const rows: WorkspaceRow[] = [];

      for (const sessionId of ids) {
        const session = sessions[sessionId];
        if (!session) continue;
        const record = session.worktreeId ? worktreeById.get(session.worktreeId) : undefined;
        const exited = session.status === "exited";
        rows.push({
          sessionId,
          title: record?.display_name || sessionDisplayTitle(session),
          worktreeId: session.worktreeId,
          branch: record?.branch,
          worktreeName: record?.name,
          worktreeRecord: record,
          exited,
        });
      }

      const title = tab.isWizard
        ? tab.title || "New Workspace"
        : tab.title || "Workspace";
      const workspaceKey = tab.workspaceKey ?? "";

      if (query) {
        const cardMatches =
          title.toLowerCase().includes(query) ||
          workspaceKey.toLowerCase().includes(query);
        const matchingRows = rows.filter(
          (r) =>
            r.title.toLowerCase().includes(query) ||
            (r.branch?.toLowerCase().includes(query) ?? false),
        );
        if (!cardMatches && matchingRows.length === 0) continue;
        if (!cardMatches) {
          result.push({
            tab,
            isActive: tab.id === activeTabId,
            rows: matchingRows,
          });
          continue;
        }
      }

      result.push({ tab, isActive: tab.id === activeTabId, rows });
    }
    return result;
  }, [tabs, sessions, worktrees, activeTabId, filter]);

  if (tabs.length === 0) {
    return (
      <div className="sidebar-empty-state">
        <span className="sidebar-empty-title">No Workspaces</span>
        <span className="sidebar-empty-desc">
          No project workspaces open.
        </span>
        <button
          type="button"
          className="sidebar-empty-btn"
          onClick={() => createWizardTab()}
        >
          <PlusIcon size={12} /> New Workspace
        </button>
      </div>
    );
  }

  if (cards.length === 0 && filter.trim()) {
    return (
      <div className="sidebar-empty-state">
        <span className="sidebar-empty-title">No Matches</span>
        <span className="sidebar-empty-desc">
          No workspaces matching &quot;{filter}&quot;
        </span>
      </div>
    );
  }

  return (
    <div className="workspace-list" role="list">
      {cards.map((data) => {
        const isDefaultExpanded = data.tab.id === activeTabId;
        const expanded =
          collapsedOverrides[data.tab.id] === undefined
            ? isDefaultExpanded
            : !collapsedOverrides[data.tab.id];
        return (
          <WorkspaceCard
            key={data.tab.id}
            data={data}
            expanded={expanded}
            activeSessionId={activeSessionId}
            pinnedSessionIds={pinnedSessionIds}
            onToggleExpand={toggleExpand}
            onSelect={(tabId) => selectTab(tabId)}
            onFocusRow={(sessionId) => {
              const state = useTerminalStore.getState();
              const tab = state.tabs.find((t) => leafIds(t.layout).includes(sessionId));
              if (!tab) return;
              if (tab.id !== state.activeTabId) selectTab(tab.id);
              const path = findLeafPath(tab.layout, sessionId);
              if (path) focusPane(path);
            }}
            onClose={(tabId) => void closeTab(tabId)}
            onAddAgent={() => {
              // Prefill the repo when the workspace's folder matches one;
              // unresolved folders open the modal unprefilled.
              const key = data.tab.workspaceKey;
              const repo = useTerminalStore
                .getState()
                .repos.find((r) => r.path === key);
              openWorktreeCreate(repo ? { repoPath: repo.path } : undefined);
            }}
            onWorktreeAction={() => {
              void useTerminalStore.getState().loadWorktrees().catch(() => {});
            }}
            onSplitRow={(sessionId) => {
              const state = useTerminalStore.getState();
              const tab = state.tabs.find((t) => leafIds(t.layout).includes(sessionId));
              if (!tab) return;
              if (tab.id !== state.activeTabId) selectTab(tab.id);
              const path = findLeafPath(tab.layout, sessionId);
              if (path) {
                focusPane(path);
                void splitPane("v");
              }
            }}
            onCloseRow={(sessionId) => {
              const state = useTerminalStore.getState();
              const tab = state.tabs.find((t) => leafIds(t.layout).includes(sessionId));
              if (!tab) return;
              const path = findLeafPath(tab.layout, sessionId);
              if (path) {
                if (tab.id !== state.activeTabId) selectTab(tab.id);
                void closePane(path);
              }
            }}
            onTogglePin={togglePin}
          />
        );
      })}
    </div>
  );
}
