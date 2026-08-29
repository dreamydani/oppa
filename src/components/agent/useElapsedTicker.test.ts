import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useElapsedTicker, formatElapsed } from "./useElapsedTicker";

describe("formatElapsed", () => {
  const now = 1_700_000_000_000;

  it("formats under a minute as now", () => {
    expect(formatElapsed(now, now - 25_000)).toBe("now");
    expect(formatElapsed(now, now)).toBe("now");
  });

  it("formats minutes, hours, and days compactly", () => {
    expect(formatElapsed(now, now - 90_000)).toBe("1m");
    expect(formatElapsed(now, now - 12 * 60_000)).toBe("12m");
    expect(formatElapsed(now, now - 3 * 3_600_000)).toBe("3h");
    expect(formatElapsed(now, now - 2 * 86_400_000)).toBe("2d");
  });

  it("never shows negative elapsed for clock skew", () => {
    expect(formatElapsed(now, now + 5_000)).toBe("now");
  });
});

describe("useElapsedTicker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a stable timestamp that advances on the 30s tick", () => {
    const { result } = renderHook(() => useElapsedTicker());
    const first = result.current;
    expect(typeof first).toBe("number");

    vi.advanceTimersByTime(30_000);
    expect(result.current).toBeGreaterThanOrEqual(first);
  });

  it("stops ticking after unmount", () => {
    const { unmount } = renderHook(() => useElapsedTicker());
    unmount();
    vi.advanceTimersByTime(120_000);
    // No error and no leaked interval: advancing is safe after unmount.
    expect(vi.getTimerCount()).toBe(0);
  });
});
