// Hook-classified rich agent status per session id (Orca four-state contract).
// Hydrated from the attach result inside spawnSession; kept live by the
// agent-status event pump installed once in terminalStore. This replaces the
// binary working/idle dot as the source of truth for agent state, with the
// optimistic/fallback dot retained in sessionActivitySlice.

import type { AgentStatusEntry } from "../../lib/pty/transport";

export interface AgentStatusSlice {
  statusBySessionId: Record<string, AgentStatusEntry>;
}

export function createAgentStatusSlice(): AgentStatusSlice {
  return { statusBySessionId: {} };
}