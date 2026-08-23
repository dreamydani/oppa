import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  computeFlipTransform,
  prefersReducedMotion,
  playFlip,
} from "./maximizeZoom";

const rect = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
});

describe("computeFlipTransform", () => {
  it("returns identity when rects match", () => {
    const flip = computeFlipTransform(rect(10, 20, 300, 200), rect(10, 20, 300, 200));
    expect(flip).not.toBeNull();
    expect(flip!.transformOrigin).toBe("top left");
    expect(flip!.transform).toBe("translate(0px, 0px) scale(1, 1)");
  });

  it("maps a small slot onto a fullscreen target (maximize invert)", () => {
    // Pane sat at (100, 50) 200x100; fullscreen is (0, 0) 800x400.
    const flip = computeFlipTransform(
      rect(100, 50, 200, 100),
      rect(0, 0, 800, 400),
    );
    expect(flip!.transform).toBe("translate(100px, 50px) scale(0.25, 0.25)");
  });

  it("handles restore direction (fullscreen back into slot)", () => {
    const flip = computeFlipTransform(
      rect(0, 0, 800, 400),
      rect(100, 50, 200, 100),
    );
    expect(flip!.transform).toBe("translate(-100px, -50px) scale(4, 4)");
  });

  it("returns null when the previous rect has zero area", () => {
    expect(
      computeFlipTransform(rect(0, 0, 0, 100), rect(0, 0, 800, 400)),
    ).toBeNull();
  });

  it("returns null when the next rect has zero area", () => {
    expect(
      computeFlipTransform(rect(0, 0, 200, 100), rect(0, 0, 800, 0)),
    ).toBeNull();
  });
});

describe("prefersReducedMotion", () => {
  const originalMatchMedia = window.matchMedia;

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    vi.restoreAllMocks();
  });

  it("is true when the OS asks for reduced motion", () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
    expect(prefersReducedMotion()).toBe(true);
  });

  it("is false when motion is allowed", () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
    expect(prefersReducedMotion()).toBe(false);
  });

  it("is false when matchMedia is unavailable (old webviews / happy-dom)", () => {
    (window as unknown as { matchMedia?: unknown }).matchMedia = undefined;
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("playFlip", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeEl(): HTMLDivElement {
    const el = document.createElement("div");
    document.body.appendChild(el);
    return el;
  }

  it("ends with an identity transform, a live transition, and no leftover inline styles after the fallback timer", () => {
    const el = makeEl();
    const flip = computeFlipTransform(rect(0, 0, 100, 50), rect(0, 0, 400, 200))!;
    playFlip(el, flip, 220, "cubic-bezier(0.22, 1, 0.36, 1)");

    // Play phase: inverted start already released, transition armed.
    expect(el.style.transform).toBe("");
    expect(el.style.transition).toContain("220ms");

    // Past duration (220) plus the internal cleanup fallback (500).
    vi.advanceTimersByTime(900);

    expect(el.style.transform).toBe("");
    expect(el.style.transition).toBe("");
    expect(el.style.willChange).toBe("");
    el.remove();
  });

  it("cancel() stops the flight and clears inline styles synchronously", () => {
    const el = makeEl();
    const flip = computeFlipTransform(rect(0, 0, 100, 50), rect(0, 0, 400, 200))!;
    const cancel = playFlip(el, flip, 220, "ease");
    cancel();

    expect(el.style.transform).toBe("");
    expect(el.style.transition).toBe("");

    vi.advanceTimersByTime(900);
    expect(el.style.willChange).toBe("");
    el.remove();
  });
});
