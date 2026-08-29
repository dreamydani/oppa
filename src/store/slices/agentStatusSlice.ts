// Hook-classified rich agent status per session id (Orca four-state contract).
// Hydrated from the attach result inside spawnSession; kept live by the
// agent-status event pump installed once in terminalStore. This replaces the
// binary working/idle dot as the source of truth for agent state, with the
// optimistic/fallback dot retained in sessionActivitySlice.

import type { AgentStatusEntry } from "../../lib/pty/transport";
import type { TerminalState } from "../terminalStore";

type SliceSet = (
  partial:
    | Partial<TerminalState>
    | ((state: TerminalState) => Partial<TerminalState>),
) => void;

export interface AgentStatusSlice {
  statusBySessionId: Record<string, AgentStatusEntry>;
  // Unread flag per session, set when a done/waiting/blocked entry lands while
  // that pane is not focused; cleared once the user views the pane.
  unreadBySessionId: Record<string, boolean>;
  markAgentStatusSeen: (sessionId: string) => void;
}

export function createAgentStatusSlice(set: SliceSet): AgentStatusSlice {
  return {
    statusBySessionId: {},
    unreadBySessionId: {},
    markAgentStatusSeen: (sessionId) =>
      set((state) => {
        if (!state.unreadBySessionId[sessionId]) return {};
        const unreadBySessionId = { ...state.unreadBySessionId };
        delete unreadBySessionId[sessionId];
        return { unreadBySessionId };
      }),
  };
}

/** True when a state is "attention-worthy" and surfaces a pill unread dot. */
export function isUnreadWorthyState(
  entry: AgentStatusEntry,
  focused: boolean,
): boolean {
  if (focused) return false;
  return entry.state === "done" || entry.state === "blocked" || entry.state === "waiting";
}