import { describe, expect, it, vi } from "vitest";
import {
  truncateScrollbackWithMarker,
  maybeWriteTruncationMarker,
  XTERM_SCROLLBACK_LINES,
} from "./scrollbackBudget";

describe("truncateScrollbackWithMarker", () => {
  it("returns the buffer unchanged when under the budget", () => {
    const s = "x".repeat(100);
    expect(truncateScrollbackWithMarker(s, 1000)).toBe(s);
  });

  it("truncates over-budget buffers and appends a visible marker", () => {
    const s = "x".repeat(5000);
    const result = truncateScrollbackWithMarker(s, 1000);
    expect(result.length).toBeLessThanOrEqual(1000);
    expect(result.endsWith("[scrollback truncated]")).toBe(true);
  });

  it("keeps the newest content (tail) when truncating", () => {
    const s = "head-content\n" + "tail-content\n".repeat(200);
    const result = truncateScrollbackWithMarker(s, 200);
    expect(result).toContain("tail-content");
    expect(result).not.toContain("head-content");
  });

  it("marker alone fits when the budget is tiny", () => {
    const s = "x".repeat(100);
    const result = truncateScrollbackWithMarker(s, 5);
    expect(result.endsWith("[scrollback truncated]")).toBe(true);
  });
});

describe("maybeWriteTruncationMarker", () => {
  it("writes the marker once when the buffer reaches the cap", () => {
    const sink = { bufferLength: XTERM_SCROLLBACK_LINES, write: vi.fn() };
    const marked = maybeWriteTruncationMarker(sink, XTERM_SCROLLBACK_LINES, false);
    expect(marked).toBe(true);
    expect(sink.write).toHaveBeenCalledWith("[scrollback truncated]\r\n");
  });

  it("does not write below the cap", () => {
    const sink = { bufferLength: XTERM_SCROLLBACK_LINES - 1, write: vi.fn() };
    const marked = maybeWriteTruncationMarker(sink, XTERM_SCROLLBACK_LINES, false);
    expect(marked).toBe(false);
    expect(sink.write).not.toHaveBeenCalled();
  });

  it("is a no-op once already marked", () => {
    const sink = { bufferLength: XTERM_SCROLLBACK_LINES, write: vi.fn() };
    const marked = maybeWriteTruncationMarker(sink, XTERM_SCROLLBACK_LINES, true);
    expect(marked).toBe(true);
    expect(sink.write).not.toHaveBeenCalled();
  });
});
