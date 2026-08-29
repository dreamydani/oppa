import React, { useState, useMemo } from "react";
import { useTerminalStore } from "../../store/terminalStore";
import type { TabState } from "../../store/slices/paneLayoutSlice";
import { leafIds } from "../../store/slices/layoutQueries";
import { findLeafPath } from "../../lib/pane-manager/layout";
import type { AgentStatusEntry } from "../../lib/pty/transport";
import { AgentStatusPill } from "../agent/AgentStatusPill";
import { sessionDisplayTitle } from "../TerminalPaneHeader";
import { WorktreeActionsMenu } from "./WorktreeActionsMenu";
import { CloseIcon, PlusIcon } from "../icons/MinimalIcons";
import { ChevronDown, ChevronRight, Folder, GitBranch, Sparkles, TerminalSquare } from "lucide-react";
import "./workspace-list.css";

// Worst-state-first ordering for the aggregate severity chip.
const SEVERITY_ORDER = ["blocked", "waiting", "working", "done"] as const;
type Severity = (typeof SEVERITY_ORDER)[number];

function aggregateSeverity(
  entries: AgentStatusEntry[],
): { label: string; state: Severity } | null {
  const counts = new Map<Severity, number>();
  for (const entry of entries) {
    const state = entry.state as Severity;
    if (!SEVERITY_ORDER.includes(state)) continue;
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  for (const state of SEVERITY_ORDER) {
    const count = counts.get(state);
    if (count) return { label: `${count} ${state}`, state };
  }
  return null;
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
  severity: { label: string; state: Severity } | null;
  liveCount: number;
  unread: boolean;
}

// Memoized card: an agent-status flip re-renders only its own card, never the
// whole sidebar.
const WorkspaceCard = React.memo(function WorkspaceCard({
  data,
  expanded,
  onToggleExpand,
  onSelect,
  onFocusRow,
  onClose,
  onAddAgent,
  onWorktreeAction,
}: {
  data: WorkspaceCardData;
  expanded: boolean;
  onToggleExpand: (tabId: string) => void;
  onSelect: (tabId: string) => void;
  onFocusRow: (sessionId: string) => void;
  onClose: (tabId: string) => void;
  onAddAgent: () => void;
  onWorktreeAction: () => void;
}) {
  const title = data.tab.isWizard
    ? data.tab.title || "New Workspace"
    : data.tab.title || "Workspace";
  const statusBySessionId = useTerminalStore((s) => s.statusBySessionId);
  const workingBySessionId = useTerminalStore((s) => s.workingBySessionId);
  const unreadBySessionId = useTerminalStore((s) => s.unreadBySessionId);
  const markAgentStatusSeen = useTerminalStore((s) => s.markAgentStatusSeen);

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
            <Sparkles size={14} />
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
        onKeyDown={(e) => e.key === "Enter" && onSelect(data.tab.id)}
      >
        <button
          type="button"
          className="ws-card-chevron"
          aria-label={expanded ? `Collapse ${title}` : `Expand ${title}`}
          aria-expanded={expanded}
          onClick={(e) => {
            e.stopPropagation();
            onToggleExpand(data.tab.id);
          }}
        >
          {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        <span className="ws-card-avatar">
          <Folder size={13} />
        </span>
        <span className="ws-card-title" title={data.tab.workspaceKey ?? title}>
          {title}
        </span>
        {data.severity && (
          <span className={`ws-severity-chip ws-severity-${data.severity.state}`}>
            {data.severity.label}
          </span>
        )}
        {data.liveCount > 0 && !data.severity && (
          <span className="ws-live-chip">{data.liveCount} live</span>
        )}
        <span className="ws-card-header-spacer" />
        {data.tab.workspaceKey && (
          <button
            type="button"
            className="ws-card-add"
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
          className="ws-card-close"
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

      {expanded && (
        <div className="ws-card-rows" role="list">
          {data.rows.length === 0 && (
            <div className="ws-card-empty">No terminals in this workspace.</div>
          )}
          {data.rows.map((row) => {
            const agentEntry = statusBySessionId[row.sessionId];
            const unread = unreadBySessionId[row.sessionId] ?? false;
            const isWorking = workingBySessionId[row.sessionId] ?? false;
            return (
              <div
                key={row.sessionId}
                role="listitem"
                className={`ws-row${row.exited ? " exited" : ""}${isWorking && !agentEntry ? " working" : ""}`}
                onClick={() => {
                  markAgentStatusSeen(row.sessionId);
                  onFocusRow(row.sessionId);
                }}
                title={row.worktreeName ? `${row.worktreeName} · ${row.branch}` : row.title}
              >
                <span className="ws-row-icon">
                  {row.worktreeId ? <GitBranch size={12} /> : <TerminalSquare size={12} />}
                </span>
                <span className="ws-row-title">{row.title}</span>
                {row.worktreeId && (
                  <span className="ws-row-branch" title={`Branch ${row.branch}`}>
                    {row.branch}
                  </span>
                )}
                <span className="ws-row-status">
                  {agentEntry ? (
                    <AgentStatusPill entry={agentEntry} unread={unread} />
                  ) : isWorking ? (
                    <span className="ws-row-dot working" aria-hidden="true" />
                  ) : null}
                </span>
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
  const statusBySessionId = useTerminalStore((s) => s.statusBySessionId);
  const unreadBySessionId = useTerminalStore((s) => s.unreadBySessionId);
  const selectTab = useTerminalStore((s) => s.selectTab);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const focusPane = useTerminalStore((s) => s.focusPane);
  const createWizardTab = useTerminalStore((s) => s.createWizardTab);
  const openWorktreeCreate = useTerminalStore((s) => s.openWorktreeCreate);

  // Component-local collapse state; default: active expanded, others collapsed.
  const [collapsedOverrides, setCollapsedOverrides] = useState<Record<string, boolean>>({});
  const toggleExpand = (tabId: string) => {
    setCollapsedOverrides((prev) => {
      const isDefaultExpanded = tabId === useTerminalStore.getState().activeTabId;
      const currentlyExpanded = prev[tabId] === undefined ? isDefaultExpanded : !prev[tabId];
      return { ...prev, [tabId]: !currentlyExpanded };
    });
  };

  const cards: WorkspaceCardData[] = useMemo(() => {
    const worktreeById = new Map(worktrees.map((w) => [w.record.id, w.record]));
    const query = filter.trim().toLowerCase();

    const result: WorkspaceCardData[] = [];
    for (const tab of tabs) {
      const ids = tab.isWizard ? [] : leafIds(tab.layout);
      const rows: WorkspaceRow[] = [];
      const statusEntries: AgentStatusEntry[] = [];
      let liveCount = 0;
      let unread = false;

      for (const sessionId of ids) {
        const session = sessions[sessionId];
        if (!session) continue;
        const record = session.worktreeId ? worktreeById.get(session.worktreeId) : undefined;
        const exited = session.status === "exited";
        if (!exited) liveCount += 1;
        if (statusBySessionId[sessionId]) statusEntries.push(statusBySessionId[sessionId]);
        if (unreadBySessionId[sessionId]) unread = true;
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

      const severity = aggregateSeverity(statusEntries);
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
            severity,
            liveCount,
            unread,
          });
          continue;
        }
      }

      result.push({ tab, isActive: tab.id === activeTabId, rows, severity, liveCount, unread });
    }
    return result;
  }, [tabs, sessions, worktrees, statusBySessionId, unreadBySessionId, activeTabId, filter]);

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
          />
        );
      })}
    </div>
  );
}
