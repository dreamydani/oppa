import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { prefersReducedMotion } from "./reducedMotion";
import { useExitPresence } from "./useExitPresence";

describe("prefersReducedMotion", () => {
  const original = window.matchMedia;

  afterEach(() => {
    window.matchMedia = original;
  });

  it("is true when the OS asks for reduced motion", () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
    expect(prefersReducedMotion()).toBe(true);
  });

  it("is false when motion is allowed", () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
    expect(prefersReducedMotion()).toBe(false);
  });

  it("is false when matchMedia is unavailable", () => {
    (window as unknown as { matchMedia?: unknown }).matchMedia = undefined;
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("useExitPresence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Motion allowed by default so the exit path is exercised.
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("mounts immediately and reports open", () => {
    const { result } = renderHook(() => useExitPresence(true, 160));
    expect(result.current.present).toBe(true);
    expect(result.current.state).toBe("open");
  });

  it("stays mounted on a closed initial render — nothing has left yet", () => {
    const { result } = renderHook(() => useExitPresence(false, 160));
    expect(result.current.present).toBe(false);
  });

  it("holds the node in `closed` for exactly exitMs so the animation can play", () => {
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useExitPresence(open, 160),
      { initialProps: { open: true } },
    );

    rerender({ open: false });
    expect(result.current.present).toBe(true);
    expect(result.current.state).toBe("closed");

    act(() => {
      vi.advanceTimersByTime(159);
    });
    expect(result.current.present).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.present).toBe(false);
  });

  it("cancels a pending unmount when reopened mid-exit", () => {
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useExitPresence(open, 160),
      { initialProps: { open: true } },
    );

    rerender({ open: false });
    act(() => {
      vi.advanceTimersByTime(80);
    });
    rerender({ open: true });
    expect(result.current.state).toBe("open");

    // The stale timer from the abandoned close must not unmount us.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.present).toBe(true);
  });

  it("unmounts instantly under reduced motion — no exit is queued", () => {
    (window.matchMedia as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ matches: true });

    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useExitPresence(open, 160),
      { initialProps: { open: true } },
    );

    rerender({ open: false });
    expect(result.current.present).toBe(false);
  });
});
