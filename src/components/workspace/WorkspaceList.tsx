import React, { useState, useEffect, useMemo } from "react";
import { useTerminalStore } from "../../store/terminalStore";
import type { TabState } from "../../store/slices/paneLayoutSlice";
import { leafIds } from "../../store/slices/layoutQueries";
import { findLeafPath, focus } from "../../lib/pane-manager/layout";
import { sessionDisplayTitle } from "../TerminalPaneHeader";
import { WorktreeActionsMenu, prNumberFromUrl, openWorktreeUrl } from "./WorktreeActionsMenu";
// Viewport-clamped menu math, shared with the Explorer context menu.
import { computeMenuPosition, menuTransformOrigin } from "../right-sidebar/FileContextMenu";
import { AgentWorkingDots } from "./AgentWorkingDots";
import { CloseIcon, PlusIcon, SplitSquareIcon } from "../icons/MinimalIcons";
import { ChevronDown, Pin, Sparkles, TriangleAlert } from "lucide-react";
import "./workspace-list.css";


export type SectionFilter = "all" | "active" | "worktrees" | "attention";

// WHY one home: the rail dots, the attention chip, and the pinned section
// share one predicate so a row never looks urgent in one place and calm in
// another. Done rides on unread (set when it lands unfocused), so a seen
// done row stays quiet.
export function sessionNeedsAttention(sessionId: string): boolean {
  const s = useTerminalStore.getState();
  if (s.workingBySessionId[sessionId] || s.unreadBySessionId[sessionId]) {
    return true;
  }
  const state = s.statusBySessionId[sessionId]?.state;
  return state === "blocked" || state === "waiting";
}

// Deterministic avatar hue from the workspace key (no util file for 5 lines).
function avatarHue(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % 360;
}

function cwdBasename(cwd: string | undefined): string | null {
  if (!cwd) return null;
  return cwd.split(/[/\\]/).filter(Boolean).pop() ?? null;
}

// Row menu size estimates for viewport clamping (6 items); the clamp keeps
// the panel on screen even when the estimate is off by a row.
const ROW_MENU_W = 180;
const ROW_MENU_H = 220;

// Cursor-anchored row menu: fixed positioning escapes the scrolling sidebar
// body, so the panel never overlaps rows below or clips at the container edge.
function RowMenu({
  anchor,
  row,
  isPinned,
  onClose,
  onFocus,
  onTogglePin,
  onSplit,
  onCloseRow,
}: {
  anchor: { x: number; y: number };
  row: WorkspaceRow;
  isPinned: boolean;
  onClose: () => void;
  onFocus: () => void;
  onTogglePin: () => void;
  onSplit: () => void;
  onCloseRow: () => void;
}): React.ReactElement {
  const pos = computeMenuPosition({
    clickX: anchor.x,
    clickY: anchor.y,
    menuW: ROW_MENU_W,
    menuH: ROW_MENU_H,
    submenuW: 0,
    submenuH: 0,
    viewportW: window.innerWidth,
    viewportH: window.innerHeight,
  });
  const item = (label: string, action: () => void, danger = false) => (
    <button
      key={label}
      type="button"
      role="menuitem"
      className={danger ? "danger" : undefined}
      onClick={() => {
        onClose();
        action();
      }}
    >
      {label}
    </button>
  );
  return (
    <div
      className="worktree-card-menu ws-row-menu"
      role="menu"
      data-motion="menu"
      style={{
        left: pos.x,
        top: pos.y,
        transformOrigin: menuTransformOrigin(anchor.x, anchor.y, pos),
      }}
    >
      {item("Focus session", onFocus)}
      {item(isPinned ? "Unpin" : "Pin", onTogglePin)}
      {item("Split pane", onSplit)}
      {row.path && item("Copy path", () => {
        void navigator.clipboard?.writeText(row.path!).catch(() => {});
      })}
      <div className="worktree-menu-divider" />
      {item("Close pane", onCloseRow, true)}
    </div>
  );
}

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
  // Second-line context: "cwd-basename · branch" (no per-row git in the
  // store yet — ponytail: ahead/behind lands with per-row git status).
  subtitle?: string;
  // Worktree aliveness, straight from the loaded registry (no extra IPC).
  pill?: string;
  prUrl?: string;
  // Full path for Copy path (worktree path wins, plain cwd otherwise).
  path?: string;
  missingOnDisk?: boolean;
  retired?: boolean;
  worktreeId?: string;
  branch?: string;
  worktreeName?: string;
  worktreeRecord?: import("../../lib/worktree/transport").WorktreeRecord;
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
  menuSessionId,
  menuAnchor,
  onOpenMenu,
  onCloseMenu,
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
  menuSessionId: string | null;
  menuAnchor: { x: number; y: number } | null;
  onOpenMenu: (sessionId: string, x: number, y: number) => void;
  onCloseMenu: () => void;
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
          // Single-row cards stay open: collapsing would hide their only row
          // behind a chevron that doesn't render.
          if (data.rows.length > 1) onToggleExpand(data.tab.id);
        }}
        role="button"
        tabIndex={0}
        aria-expanded={data.rows.length > 0 ? expanded : undefined}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          onSelect(data.tab.id);
          if (data.rows.length > 1) onToggleExpand(data.tab.id);
        }}
      >
        <span
          className="ws-card-avatar"
          aria-hidden="true"
          style={{
            background: `hsl(${avatarHue(data.tab.workspaceKey ?? title)} 30% 28%)`,
          }}
        >
          {(title.trim()[0] ?? "•").toUpperCase()}
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
            const isWorking = workingBySessionId[row.sessionId] ?? false;
            const isFocusedLeaf = data.isActive && row.sessionId === activeSessionId;
            const age = relativeAge(agentEntry?.state_started_at_ms);
            const isPinned = pinnedSessionIds.has(row.sessionId);
            const isUnread = unreadBySessionId[row.sessionId] ?? false;
            // Sidebar states: working (animated dot-grid), done (green),
            // blocked (amber), waiting (hollow). Idle and exited stay silent
            // so quiet rows don't shout.
            const isWorkingState =
              agentEntry?.state === "working" ||
              (!agentEntry && !row.exited && isWorking);
            const isDoneState = agentEntry?.state === "done";
            const prNumber = row.prUrl ? prNumberFromUrl(row.prUrl) : null;

            return (
              <div
                key={row.sessionId}
                role="listitem"
                className={`ws-row${isFocusedLeaf ? " is-active" : ""}${row.exited ? " exited" : ""}${isPinned ? " pinned" : ""}${isUnread ? " is-unread" : ""}${row.retired ? " retired" : ""}${row.missingOnDisk ? " ws-row-missing" : ""}`}
                // Feeds the [data-motion="stagger"] cascade; motion.css caps it
                // at --stagger-cap so a long list still finishes arriving fast.
                style={{ "--row-index": rowIndex } as React.CSSProperties}
                tabIndex={0}
                onClick={() => {
                  markAgentStatusSeen(row.sessionId);
                  onFocusRow(row.sessionId);
                }}
                // Inner buttons keep their own keys: typing in them must not
                // also drive the row (Enter would both click and focus).
                onKeyDown={(e) => {
                  if ((e.target as HTMLElement).closest("button, a, input")) return;
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    markAgentStatusSeen(row.sessionId);
                    onFocusRow(row.sessionId);
                  } else if (e.key === "p") {
                    onTogglePin(row.sessionId);
                  } else if (e.key === "Delete" || e.key === "Backspace") {
                    onCloseRow(row.sessionId);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onOpenMenu(row.sessionId, e.clientX, e.clientY);
                }}
                title={row.worktreeName ? `${row.worktreeName} · ${row.branch}` : row.title}
              >
                {!isPinned && isWorkingState && <AgentWorkingDots />}
                {!isPinned && isDoneState && (
                  <span
                    className="ws-status-circle done"
                    title="Status: done"
                    aria-label="Status: done"
                  />
                )}
                {!isPinned && agentEntry?.state === "blocked" && (
                  <span
                    className="ws-status-circle blocked"
                    title="Status: blocked — needs you"
                    aria-label="Status: blocked"
                  />
                )}
                {!isPinned && agentEntry?.state === "waiting" && (
                  <span
                    className="ws-status-circle waiting"
                    title="Status: waiting"
                    aria-label="Status: waiting"
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
                <span className="ws-row-text">
                  <span className="ws-row-title">{row.title}</span>
                  {row.subtitle && (
                    <span className="ws-row-sub">{row.subtitle}</span>
                  )}
                </span>
                {age && <span className="ws-row-time">{age}</span>}
                {(row.pill || row.prUrl || row.missingOnDisk) && (
                  <span className="ws-row-badges">
                    {row.missingOnDisk && (
                      <span
                        className="ws-row-missing-mark"
                        title="Worktree missing on disk"
                      >
                        <TriangleAlert size={11} aria-hidden="true" />
                      </span>
                    )}
                    {row.pill && <span className="ws-row-pill">{row.pill}</span>}
                    {row.prUrl && (
                      <a
                        href={row.prUrl}
                        className="ws-row-pr"
                        title="Open PR"
                        aria-label={prNumber ? `Open PR #${prNumber}` : "Open PR"}
                        onClick={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          if (row.prUrl) openWorktreeUrl(row.prUrl);
                        }}
                      >
                        {prNumber ? `#${prNumber}` : "PR"}
                      </a>
                    )}
                  </span>
                )}
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
                {menuSessionId === row.sessionId && menuAnchor && (
                  <RowMenu
                    anchor={menuAnchor}
                    row={row}
                    isPinned={isPinned}
                    onClose={onCloseMenu}
                    onFocus={() => {
                      markAgentStatusSeen(row.sessionId);
                      onFocusRow(row.sessionId);
                    }}
                    onTogglePin={() => onTogglePin(row.sessionId)}
                    onSplit={() => onSplitRow(row.sessionId)}
                    onCloseRow={() => onCloseRow(row.sessionId)}
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
  sectionFilter?: SectionFilter;
}

export function WorkspaceList({
  filter = "",
  sectionFilter = "all",
}: WorkspaceListProps): React.ReactElement {
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
  const markAgentStatusSeen = useTerminalStore((s) => s.markAgentStatusSeen);

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
  // Overrides store COLLAPSED (render reads expanded = !override), so the
  // new value is the pre-toggle expanded — storing its negation no-ops.
  const [collapsedOverrides, setCollapsedOverrides] = useState<Record<string, boolean>>({});
  const toggleExpand = (tabId: string) => {
    setCollapsedOverrides((prev) => {
      const isDefaultExpanded = tabId === useTerminalStore.getState().activeTabId;
      const currentlyExpanded = prev[tabId] === undefined ? isDefaultExpanded : !prev[tabId];
      return { ...prev, [tabId]: currentlyExpanded };
    });
  };

  // Pinned sessions float to the top of their folder (session-scoped).
  const [pinnedSessionIds, setPinnedSessionIds] = useState<ReadonlySet<string>>(new Set());
  // Row context menu (right-click): one open at a time, cursor-anchored.
  const [menu, setMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const closeOnOutsideClick = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".ws-row-menu")) {
        setMenu(null);
      }
    };
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    // Fixed panels don't follow their anchor: any scroll or resize closes.
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menu]);
  const togglePin = (sessionId: string) => {
    setPinnedSessionIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  const cards: WorkspaceCardData[] = useMemo(() => {
    const worktreeById = new Map(worktrees.map((w) => [w.record.id, w]));
    const query = filter.trim().toLowerCase();

    const result: WorkspaceCardData[] = [];
    for (const tab of tabs) {
      const ids = tab.isWizard ? [] : leafIds(tab.layout);
      const rows: WorkspaceRow[] = [];
      const cardTitle = tab.isWizard
        ? tab.title || "New Workspace"
        : tab.title || "Workspace";

      for (const sessionId of ids) {
        const session = sessions[sessionId];
        if (!session) continue;
        const entry = session.worktreeId ? worktreeById.get(session.worktreeId) : undefined;
        const record = entry?.record;
        const exited = session.status === "exited";
        const rowTitle = record?.display_name || sessionDisplayTitle(session);
        // Subtitle shows only new info: parts echoing the row or card title
        // (typical when the title already is the cwd basename) are dropped.
        const subtitle =
          [cwdBasename(session.cwd), record?.branch]
            .filter((p): p is string => !!p && p !== rowTitle && p !== cardTitle)
            .join(" · ") || undefined;
        rows.push({
          sessionId,
          title: rowTitle,
          subtitle,
          pill:
            record && !record.retired
              ? record.base_ref
                ? `${record.workspace_status} → ${record.base_ref}`
                : record.workspace_status
              : undefined,
          prUrl: record?.linked_pr_url ?? undefined,
          path: record?.path ?? session.cwd,
          missingOnDisk: entry?.missing_on_disk ?? false,
          retired: record?.retired ?? false,
          worktreeId: session.worktreeId,
          branch: record?.branch,
          worktreeName: record?.name,
          worktreeRecord: record,
          exited,
        });
      }

      const title = cardTitle;
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

  // Section filter narrows the searched cards; emptied cards drop out.
  // Computed before the empty state so a chip that hides everything reads
  // as "No Matches" instead of a blank list.
  const visibleCards = cards.flatMap((data) => {
    if (sectionFilter === "active" && !data.isActive) return [];
    if (sectionFilter === "worktrees" || sectionFilter === "attention") {
      const rows = data.rows.filter((r) =>
        sectionFilter === "worktrees"
          ? r.worktreeRecord !== undefined
          : sessionNeedsAttention(r.sessionId),
      );
      if (rows.length === 0) return [];
      return [{ ...data, rows }];
    }
    return [data];
  });

  if (visibleCards.length === 0 && (filter.trim() || sectionFilter !== "all")) {
    // Chip-specific empty states read as progress, not failure.
    if (sectionFilter === "attention" && !filter.trim()) {
      return (
        <div className="sidebar-empty-state">
          <span className="sidebar-empty-title">All caught up</span>
          <span className="sidebar-empty-desc">
            Nothing needs you right now.
          </span>
        </div>
      );
    }
    if (sectionFilter === "worktrees" && !filter.trim()) {
      return (
        <div className="sidebar-empty-state">
          <span className="sidebar-empty-title">No worktrees</span>
          <span className="sidebar-empty-desc">
            Isolate a task in its own branch checkout.
          </span>
          <button
            type="button"
            className="sidebar-empty-btn"
            onClick={() => openWorktreeCreate()}
          >
            <PlusIcon size={12} /> New Worktree
          </button>
        </div>
      );
    }
    return (
      <div className="sidebar-empty-state">
        <span className="sidebar-empty-title">No Matches</span>
        <span className="sidebar-empty-desc">
          {filter.trim()
            ? <>No workspaces matching &quot;{filter}&quot;</>
            : "No workspaces in this view"}
        </span>
      </div>
    );
  }

  const activeCards = visibleCards.filter((c) => c.isActive);
  const recentCards = visibleCards.filter((c) => !c.isActive);
  // Pins stay visible even when their card is collapsed.
  const pinnedRows = visibleCards.flatMap((c) =>
    c.rows.filter((r) => pinnedSessionIds.has(r.sessionId)),
  );

  const focusRowBySession = (sessionId: string) => {
    const state = useTerminalStore.getState();
    const tab = state.tabs.find((t) => leafIds(t.layout).includes(sessionId));
    if (!tab) return;
    if (tab.id !== state.activeTabId) selectTab(tab.id);
    const path = findLeafPath(tab.layout, sessionId);
    if (path) focusPane(path);
  };

  const renderCard = (data: WorkspaceCardData) => {
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
        onFocusRow={focusRowBySession}
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
            menuSessionId={menu?.sessionId ?? null}
            menuAnchor={menu ? { x: menu.x, y: menu.y } : null}
            onOpenMenu={(sessionId, x, y) => setMenu({ sessionId, x, y })}
            onCloseMenu={() => setMenu(null)}
          />
        );
      };

  const renderSection = (
    title: string,
    count: number,
    className: string,
    children: React.ReactNode,
  ) => (
    <section className={`ws-section ${className}`}>
      <div className="ws-section-header" aria-hidden="true">
        <span className="ws-section-title">{title}</span>
        <span className="ws-section-count">{count}</span>
      </div>
      {children}
    </section>
  );

  return (
    <div className="workspace-list" role="list">
      {pinnedRows.length > 0 &&
        renderSection(
          "Pinned",
          pinnedRows.length,
          "ws-section-pinned",
          pinnedRows.map((row) => (
            <button
              key={row.sessionId}
              type="button"
              className="ws-row ws-pinned-row"
              onClick={() => {
                markAgentStatusSeen(row.sessionId);
                focusRowBySession(row.sessionId);
              }}
              title={row.title}
            >
              <Pin size={10} className="ws-pinned-row-icon" aria-hidden="true" />
              <span className="ws-row-text">
                <span className="ws-row-title">{row.title}</span>
                {row.subtitle && (
                  <span className="ws-row-sub">{row.subtitle}</span>
                )}
              </span>
            </button>
          )),
        )}
      {activeCards.length > 0 &&
        renderSection("Active", activeCards.length, "", activeCards.map(renderCard))}
      {recentCards.length > 0 &&
        renderSection("Recents", recentCards.length, "", recentCards.map(renderCard))}
    </div>
  );
}
