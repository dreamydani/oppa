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
): string {
  // ~1MB / ~200 chars per row ≈ 5000 rows; serialize only that many rows
  // from the bottom of the scrollback.
  const bounded = serialize({ scrollback: 5000 });
  return applyCachedScrollbackBudget(bounded);
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
