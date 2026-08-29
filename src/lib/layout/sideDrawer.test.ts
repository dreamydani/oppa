import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SIDEBAR_OPEN_MS,
  SIDEBAR_CLOSE_MS,
  SLIDE_EASING_OPEN,
  SLIDE_EASING_CLOSE,
  SlideDrawer,
} from "./sideDrawer";
import { isLayoutAnimating, resetLayoutAnimationGateForTests } from "./layoutAnimationGate";

  function makePanel(): {
    el: HTMLElement;
    inner: HTMLElement;
  } {
    const container = document.createElement("div");
    const el = document.createElement("aside");
    const inner = document.createElement("div");
    el.appendChild(inner);
    container.appendChild(el);
    document.body.appendChild(container);
    Object.defineProperty(el, "offsetWidth", { value: 240 });
    return { el, inner };
  }

describe("SlideDrawer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetLayoutAnimationGateForTests();
    window.matchMedia = vi.fn().mockReturnValue({ matches: false }) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    vi.useRealTimers();
    resetLayoutAnimationGateForTests();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  function makeDrawer(el: HTMLElement, inner: HTMLElement, direction: "left" | "right") {
    return new SlideDrawer({
      el,
      innerEl: inner,
      direction,
      openMs: SIDEBAR_OPEN_MS,
      closeMs: SIDEBAR_CLOSE_MS,
      easing: SLIDE_EASING_OPEN,
      easingClose: SLIDE_EASING_CLOSE,
      gapPx: 4,
      parallaxPx: 0,
    });
  }

  it("starts in-flow and takes no action on initial sync(true)", () => {
    const { el } = makePanel();
    const drawer = makeDrawer(el, el.firstElementChild as HTMLElement, "left");
    drawer.sync(true);
    expect(el.style.position).toBe("");
    expect(isLayoutAnimating()).toBe(false);
    drawer.dispose();
  });

  it("close: detaches from flow immediately, slides, hides, and releases the gate", () => {
    const { el, inner } = makePanel();
    const drawer = makeDrawer(el, inner, "left");

    drawer.sync(false);

    // Flow given up synchronously: viewport expands this frame, gate active.
    expect(el.style.position).toBe("absolute");
    expect(isLayoutAnimating()).toBe(true);
    expect(el.style.visibility).not.toBe("hidden");
    expect(el.style.transition).toContain(SLIDE_EASING_CLOSE);

    // Past close duration + fallback: hidden and gate released.
    vi.advanceTimersByTime(SIDEBAR_CLOSE_MS + 100);
    expect(el.style.visibility).toBe("hidden");
    expect(el.style.transform).toBe("");
    expect(inner.style.transform).toBe("");
    expect(isLayoutAnimating()).toBe(false);
    drawer.dispose();
  });

  it("open: floats over full-width viewport, slides in, re-enters flow under cover", () => {
    const { el, inner } = makePanel();
    const drawer = makeDrawer(el, inner, "left");
    drawer.sync(false);
    vi.advanceTimersByTime(SIDEBAR_CLOSE_MS + 100);

    drawer.sync(true);
    expect(el.style.visibility).not.toBe("hidden");
    expect(el.style.position).toBe("absolute"); // still floating mid-slide
    expect(isLayoutAnimating()).toBe(true);

    vi.advanceTimersByTime(SIDEBAR_OPEN_MS + 100);
    // Committed back into flow: viewport narrows now, beneath the static panel.
    expect(el.style.position).toBe("");
    expect(el.style.transform).toBe("");
    expect(el.style.visibility).not.toBe("hidden");
    expect(isLayoutAnimating()).toBe(false);
    drawer.dispose();
  });

  it("interrupts a close mid-flight and lands open in flow", () => {
    const { el } = makePanel();
    const drawer = makeDrawer(el, el.firstElementChild as HTMLElement, "left");
    drawer.sync(false);
    vi.advanceTimersByTime(50); // half-slid out

    drawer.sync(true);
    vi.advanceTimersByTime(SIDEBAR_OPEN_MS + 150);
    expect(el.style.position).toBe("");
    expect(el.style.visibility).not.toBe("hidden");
    expect(isLayoutAnimating()).toBe(false);
    drawer.dispose();
  });

  it("interrupts an open mid-flight by reversing straight back to hidden", () => {
    const { el } = makePanel();
    const drawer = makeDrawer(el, el.firstElementChild as HTMLElement, "left");
    drawer.sync(false);
    vi.advanceTimersByTime(SIDEBAR_CLOSE_MS + 100);
    drawer.sync(true);
    vi.advanceTimersByTime(50); // part-way in

    drawer.sync(false);
    vi.advanceTimersByTime(SIDEBAR_CLOSE_MS + 150);
    expect(el.style.visibility).toBe("hidden");
    expect(el.style.position).toBe("absolute");
    expect(isLayoutAnimating()).toBe(false);
    drawer.dispose();
  });

  it("snaps instantly under prefers-reduced-motion", () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia;
    const { el } = makePanel();
    const drawer = makeDrawer(el, el.firstElementChild as HTMLElement, "left");

    drawer.sync(false);
    expect(el.style.position).toBe("absolute");
    expect(el.style.visibility).toBe("hidden");
    expect(el.style.transitionDuration).toBe("0s");
    expect(isLayoutAnimating()).toBe(false);

    drawer.sync(true);
    expect(el.style.position).toBe("");
    expect(el.style.visibility).not.toBe("hidden");
    drawer.dispose();
  });

  it("snaps when boot suppression is active (launch state flip)", () => {
    const { el } = makePanel();
    const drawer = new SlideDrawer({
      el,
      innerEl: el.firstElementChild as HTMLElement,
      direction: "left",
      openMs: SIDEBAR_OPEN_MS,
      closeMs: SIDEBAR_CLOSE_MS,
      easing: SLIDE_EASING_OPEN,
      easingClose: SLIDE_EASING_CLOSE,
      gapPx: 4,
      parallaxPx: 0,
      suppressMotion: () => true,
    });

    drawer.sync(false);
    expect(el.style.visibility).toBe("hidden");
    expect(isLayoutAnimating()).toBe(false);
    drawer.dispose();
  });

  it("slides the right sidebar toward +x", () => {
    const { el } = makePanel();
    const drawer = makeDrawer(el, el.firstElementChild as HTMLElement, "right");
    drawer.sync(false);

    // Mid-flight the inline target carries the signed distance.
    vi.advanceTimersByTime(10);
    const t = el.style.transform;
    expect(t).not.toBe("");
    drawer.dispose();
  });
});
