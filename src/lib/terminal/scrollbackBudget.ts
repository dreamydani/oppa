// Scrollback memory budgets. The biggest predictable-memory lever for many
// panes is bounding how much history each one retains; when a buffer exceeds
// its budget it is truncated to the newest content with a visible marker so
// the user knows history was dropped, never silently.

export const SCROLLBACK_TRUNCATION_MARKER = "[scrollback truncated]";

// Hard per-session cap for cached scrollback strings (~1MB).
export const CACHED_SCROLLBACK_MAX_BYTES = 1024 * 1024;

// Truncates to the tail of the buffer plus a marker, keeping the newest
// content. Budget is in UTF-16 code units (the string's .length) which is a
// conservative stand-in for bytes for the marker math here.
export function truncateScrollbackWithMarker(
  buffer: string,
  budget: number,
): string {
  if (buffer.length <= budget) return buffer;
  const marker = SCROLLBACK_TRUNCATION_MARKER;
  const headRoom = Math.max(0, budget - marker.length);
  return buffer.slice(Math.max(0, buffer.length - headRoom)) + marker;
}

export function applyCachedScrollbackBudget(buffer: string): string {
  return truncateScrollbackWithMarker(buffer, CACHED_SCROLLBACK_MAX_BYTES);
}

// Bounded xterm serialize: cap the row count so the synchronous serialize
// builds a bounded string, then apply the byte budget as belt-and-suspenders.
export interface ScrollbackSerializer {
  (options?: { scrollback?: number }): string;
}

export function serializeScrollbackBounded(
  serialize: ScrollbackSerializer,
  rows = 2500,
): string {
  // ~1MB / ~200 chars per row ≈ 5000 rows max; focused panes serialize 2500,
  // agent/background panes half. Only that many rows from the bottom.
  const bounded = serialize({ scrollback: rows });
  return applyCachedScrollbackBudget(bounded);
}

// Scrollback row policy (tiered): focused panes keep full history; agent TUIs
// redraw from their own state, so they keep half at zero visual difference.
// Background panes keep less — the user only scrolls the focused one.
export const AGENT_SCROLLBACK_ROWS = 2500;

export function resolveSessionScrollbackRows(isAgent: boolean): number {
  return isAgent ? AGENT_SCROLLBACK_ROWS : XTERM_SCROLLBACK_LINES;
}

// Background mounted panes: enough for a quick glance-back, not deep archaeology.
export const BACKGROUND_SCROLLBACK_LINES = 2000;
export const BACKGROUND_AGENT_SCROLLBACK_LINES = 1000;

export function resolveBackgroundScrollbackRows(isAgent: boolean): number {
  return isAgent ? BACKGROUND_AGENT_SCROLLBACK_LINES : BACKGROUND_SCROLLBACK_LINES;
}

// Serialize rows track the live cap: agent panes serialize half.
export function serializeRowsForScrollback(rows: number): number {
  return rows >= XTERM_SCROLLBACK_LINES ? 2500 : 1250;
}

// xterm's scrollback cap (Terminal option `scrollback`) evicts oldest lines
// silently. This makes truncation visible: once the buffer reaches the cap, a
// one-time marker line is written so the user knows history was dropped.
export const XTERM_SCROLLBACK_LINES = 5000;

export interface ScrollbackSink {
  bufferLength: number;
  write(data: string): void;
}

export function maybeWriteTruncationMarker(
  sink: ScrollbackSink,
  cap: number = XTERM_SCROLLBACK_LINES,
  alreadyMarked: boolean,
): boolean {
  if (alreadyMarked) return true;
  const length = sink.bufferLength;
  // Non-finite (mock/undefined) means we can't tell yet — don't mark.
  if (!Number.isFinite(length) || length < cap) return false;
  sink.write(SCROLLBACK_TRUNCATION_MARKER + "\r\n");
  return true;
}
