// Working/idle flags per session id feeding the header terminal-dropdown
// dots. Hydrated from the attach result inside spawnSession; kept live by
// the session-working event pump installed once in terminalStore.

export interface SessionActivitySlice {
  workingBySessionId: Record<string, boolean>;
}

export function createSessionActivitySlice(): SessionActivitySlice {
  return { workingBySessionId: {} };
}
