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
  rows = 5000,
): string {
  // ~1MB / ~200 chars per row ≈ 5000 rows; serialize only that many rows
  // from the bottom of the scrollback.
  const bounded = serialize({ scrollback: rows });
  return applyCachedScrollbackBudget(bounded);
}

// Scrollback row policy (Orca-parity presets): agent TUIs redraw from their
// own state, so they keep half the history of plain shells at zero visual
// difference while focused.
export const AGENT_SCROLLBACK_ROWS = 5000;
export const SCROLLBACK_ROWS_MIN = 1000;
export const SCROLLBACK_ROWS_MAX = 50000;
export const SCROLLBACK_ROW_PRESETS = [5000, 10000, 25000, 50000] as const;

export function normalizeScrollbackRows(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return XTERM_SCROLLBACK_LINES;
  }
  return Math.min(
    SCROLLBACK_ROWS_MAX,
    Math.max(SCROLLBACK_ROWS_MIN, Math.floor(value)),
  );
}

export function resolveSessionScrollbackRows(isAgent: boolean): number {
  return isAgent ? AGENT_SCROLLBACK_ROWS : XTERM_SCROLLBACK_LINES;
}

// Serialize rows track the live cap: agent panes serialize half.
export function serializeRowsForScrollback(rows: number): number {
  return rows >= XTERM_SCROLLBACK_LINES ? 5000 : 2500;
}

// Pending-output backlog floor: bounds renderer queues while a starved
// display catches up, scaling with scrollback rows so a raised cap keeps
// what the buffer would have retained. A memory bound, not a guarantee.
export const OUTPUT_BACKLOG_MIN_CAP_CHARS = 2 * 1024 * 1024;
const OUTPUT_BACKLOG_CHARS_PER_ROW = 120;

export function outputBacklogCapChars(scrollbackRows: unknown): number {
  const rows = normalizeScrollbackRows(scrollbackRows);
  return Math.max(
    OUTPUT_BACKLOG_MIN_CAP_CHARS,
    rows * OUTPUT_BACKLOG_CHARS_PER_ROW,
  );
}

// xterm's scrollback cap (Terminal option `scrollback`) evicts oldest lines
// silently. This makes truncation visible: once the buffer reaches the cap, a
// one-time marker line is written so the user knows history was dropped.
export const XTERM_SCROLLBACK_LINES = 10000;

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
