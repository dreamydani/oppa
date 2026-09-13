import React, { useCallback, useEffect, useMemo, useState } from "react";
import { MemoryStick, X } from "lucide-react";
import { useTerminalStore } from "../../store/terminalStore";
import { findLeafPath } from "../../lib/pane-manager/layout";
import { getSystemMemorySnapshot } from "../../lib/system/transport";
import type { SessionMemory } from "../../lib/system/transport";
import { ptyKill } from "../../lib/pty/transport";

// Orca formatters (ResourceUsageStatusSegment.tsx:93-113): KB round, MB 1-dec, GB 2-dec.
function formatMemory(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatCpu(percent: number): string {
  return `${percent.toFixed(1)}%`;
}

type SortOption = "memory" | "cpu" | "name";

function sortSessions(rows: SessionMemory[], sort: SortOption): SessionMemory[] {
  const copy = [...rows];
  if (sort === "name") {
    copy.sort((a, b) => a.session_id.localeCompare(b.session_id));
    return copy;
  }
  if (sort === "cpu") {
    copy.sort((a, b) => (b.cpu ?? -1) - (a.cpu ?? -1));
    return copy;
  }
  copy.sort((a, b) => (b.memory ?? -1) - (a.memory ?? -1));
  return copy;
}

export function MemorySegment(): React.ReactElement {
  const sessions = useTerminalStore((s) => s.sessions);
  const tabs = useTerminalStore((s) => s.tabs);
  const selectTab = useTerminalStore((s) => s.selectTab);
  const [snapshot, setSnapshot] = useState<Awaited<
    ReturnType<typeof getSystemMemorySnapshot>
  >>(null);
  const [open, setOpen] = useState(false);
  const [sort, setSort] = useState<SortOption>("memory");

  const fetchSnapshot = useCallback(async () => {
    const snap = await getSystemMemorySnapshot();
    setSnapshot(snap);
  }, []);

  // Seed once so the closed chip has a value without opening.
  useEffect(() => {
    let mounted = true;
    void getSystemMemorySnapshot()
      .then((snap) => {
        if (mounted) setSnapshot(snap);
      })
      .catch(() => {
        if (mounted) setSnapshot(null);
      });
    return () => {
      mounted = false;
    };
  }, []);

  // Orca open-gating: 2s poll only while the popover is open.
  useEffect(() => {
    if (!open) return;
    void fetchSnapshot();
    const timer = setInterval(() => {
      void fetchSnapshot();
    }, 2000);
    return () => clearInterval(timer);
  }, [open, fetchSnapshot]);

  const rows = useMemo(
    () => sortSessions(snapshot?.sessions ?? [], sort),
    [snapshot, sort],
  );

  const chipLabel = snapshot ? formatMemory(snapshot.total_memory) : "—";
  const sessionCount = snapshot ? snapshot.sessions.length : 0;
  const hostPercent =
    snapshot != null ? `${Math.round(snapshot.host.percent)}%` : "—";

  const jumpToSession = (sessionId: string) => {
    const tab = tabs.find((t) => findLeafPath(t.layout, sessionId) !== null);
    if (tab) selectTab(tab.id);
  };

  const killSession = (sessionId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    // WHY no confirm v1: footer kill mirrors pty_kill; agent-owned confirm lands with the worktree grouping.
    void ptyKill(sessionId).catch(() => {});
  };

  return (
    <div className="memory-segment-wrap">
      <button
        type="button"
        className="status-bar-item memory-segment"
        data-testid="memory-segment"
        title={
          snapshot
            ? `Resource Manager — ${chipLabel} — ${sessionCount} sessions`
            : "Resource Manager — unavailable"
        }
        onClick={() => setOpen((v) => !v)}
      >
        <MemoryStick size={13} />
        {snapshot ? (
          <span className="tabular-nums">
            {chipLabel} · {sessionCount}
          </span>
        ) : (
          <span>—</span>
        )}
      </button>

      {open && (
        <div
          className="memory-popover"
          data-testid="memory-popover"
          role="dialog"
          aria-label="Resource Manager"
        >
          <div className="memory-popover-header">
            <span className="memory-popover-title">Resource Manager</span>
            {snapshot && (
              <span className="memory-popover-summary tabular-nums">
                {formatCpu(snapshot.total_cpu)} · {chipLabel} Σ RSS
              </span>
            )}
          </div>

          {snapshot ? (
            <>
              <div className="memory-popover-host tabular-nums">
                <span>
                  {formatMemory(snapshot.host.used)} /{" "}
                  {formatMemory(snapshot.host.total)}
                </span>
                <span>{hostPercent}</span>
              </div>
              <div className="memory-host-bar" aria-hidden="true">
                <div
                  className="memory-host-bar-fill"
                  style={{ width: `${Math.min(100, snapshot.host.percent)}%` }}
                />
              </div>

              <div className="memory-sort-row" role="group" aria-label="Sort sessions">
                {(["memory", "cpu", "name"] as SortOption[]).map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={`memory-sort-btn${sort === option ? " active" : ""}`}
                    aria-pressed={sort === option}
                    onClick={() => setSort(option)}
                  >
                    {option === "memory" ? "Mem" : option === "cpu" ? "CPU" : "Name"}
                  </button>
                ))}
              </div>

              <div className="memory-popover-body">
                <div className="memory-app-row tabular-nums">
                  <span>Oppa app</span>
                  <span>{snapshot.app.cpu != null ? formatCpu(snapshot.app.cpu) : "—"}</span>
                  <span>
                    {snapshot.app.memory != null ? formatMemory(snapshot.app.memory) : "—"}
                  </span>
                </div>
                {rows.map((row) => (
                  <button
                    key={row.session_id}
                    type="button"
                    className="memory-session-row"
                    title={sessions[row.session_id]?.title ?? row.session_id}
                    onClick={() => jumpToSession(row.session_id)}
                  >
                    <span className="memory-session-name">
                      {sessions[row.session_id]?.title ?? row.session_id}
                    </span>
                    <span className="tabular-nums">
                      {row.cpu != null ? formatCpu(row.cpu) : "—"}
                    </span>
                    <span className="tabular-nums">
                      {row.memory != null ? formatMemory(row.memory) : "—"}
                    </span>
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={`Kill ${row.session_id}`}
                      data-testid={`memory-kill-${row.session_id}`}
                      className="memory-kill"
                      onClick={(event) => killSession(row.session_id, event)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          killSession(row.session_id, event as unknown as React.MouseEvent);
                        }
                      }}
                    >
                      <X size={12} />
                    </span>
                  </button>
                ))}
                {rows.length === 0 && (
                  <div className="memory-empty">No terminal sessions yet.</div>
                )}
              </div>
            </>
          ) : (
            <div className="memory-empty">Snapshots unavailable.</div>
          )}
        </div>
      )}
    </div>
  );
}
