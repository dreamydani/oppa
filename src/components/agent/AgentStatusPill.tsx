import React from "react";
import type { AgentStatusEntry } from "../../lib/pty/transport";
import { formatElapsed, useElapsedTicker } from "./useElapsedTicker";
import "./AgentStatusPill.css";

interface AgentStatusPillProps {
  entry?: AgentStatusEntry;
  unread?: boolean;
}

/** Human-readable tip for the current state, so a bare pill is never cryptic. */
function pillTip(entry: AgentStatusEntry): string | undefined {
  switch (entry.state) {
    case "blocked":
      return entry.interactive_prompt
        ? `Blocked: ${entry.interactive_prompt}`
        : "Blocked on permission";
    case "waiting":
      return entry.interactive_prompt
        ? `Waiting: ${entry.interactive_prompt}`
        : "Waiting for input";
    case "working":
      return entry.tool_name ? `Working — ${entry.tool_name}` : "Working";
    case "done":
      return entry.interrupted ? "Interrupted" : "Done";
  }
}

// Rich hook-classified status pill. Renders nothing when no hook row exists:
// surfaces keep their legacy dot as the fallback for hookless shells.
export function AgentStatusPill({
  entry,
  unread,
}: AgentStatusPillProps): React.ReactElement | null {
  const now = useElapsedTicker();
  if (!entry) return null;
  const tip = pillTip(entry);
  return (
    <span
      className={`agent-status-pill agent-status-${entry.state}${
        entry.interrupted ? " agent-status-interrupted" : ""
      }`}
      data-state={entry.state}
      title={tip ?? undefined}
      aria-label={tip ?? entry.state}
      role="status"
    >
      {entry.state === "working" && (
        <span className="agent-status-spinner" aria-hidden="true" />
      )}
      <span className="agent-status-elapsed" aria-hidden="true">
        {formatElapsed(now, entry.state_started_at_ms)}
      </span>
      {unread && <span className="agent-status-unread-dot" aria-hidden="true" />}
    </span>
  );
}