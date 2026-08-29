// Slide-drawer engine for the left/right sidebars: replaces width/margin
// layout animation with compositor-only transform slides. The panel leaves
// flex flow the moment a close starts (viewport takes full width once) and
// re-enters flow only when fully open (the narrowing refit lands beneath the
// opaque panel). All inline styles — React never renders these keys, so they
// survive re-renders. Pair every sync() with begin/end of the layout gate so
// terminal fits commit exactly once per toggle.

import {
  beginLayoutAnimation,
  endLayoutAnimation,
} from "./layoutAnimationGate";
import { prefersReducedMotion } from "../motion/reducedMotion";

export const SIDEBAR_OPEN_MS = 460; // mirror --dur-panel-open
export const SIDEBAR_CLOSE_MS = 360; // mirror --dur-panel-close
export const SLIDE_EASING_OPEN = "cubic-bezier(0.22, 1, 0.36, 1)"; // mirror --ease-slide-open
export const SLIDE_EASING_CLOSE = "cubic-bezier(0.55, 0, 0.85, 0.25)"; // mirror --ease-slide-close

const ANIM_FALLBACK_MS = 100;

export interface SlideDrawerOptions {
  el: HTMLElement;
  innerEl?: HTMLElement | null;
  direction: "left" | "right";
  openMs: number;
  closeMs: number;
  easing: string;
  easingClose?: string;
  gapPx: number;
  parallaxPx: number;
  suppressMotion?: () => boolean;
}

type Phase = "in-flow" | "hidden" | "to-open" | "to-closed";

// Current translateX in px from the computed matrix (interruption start).
function currentTranslateX(el: HTMLElement): number {
  const transform = getComputedStyle(el).transform;
  if (!transform || transform === "none") return 0;
  const m = transform.match(/matrix\(([^)]+)\)/);
  if (!m) return 0;
  const parts = m[1].split(",").map((v) => parseFloat(v));
  return Number.isFinite(parts[4]) ? parts[4] : 0;
}

export class SlideDrawer {
  private readonly el: HTMLElement;
  private readonly innerEl: HTMLElement | null;
  private readonly direction: "left" | "right";
  private readonly openMs: number;
  private readonly closeMs: number;
  private readonly easing: string;
  private readonly easingClose: string;
  private readonly gapPx: number;
  private readonly parallaxPx: number;
  private readonly suppressMotion?: () => boolean;

  private phase: Phase = "in-flow";
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: SlideDrawerOptions) {
    this.el = opts.el;
    this.innerEl = opts.innerEl ?? null;
    this.direction = opts.direction;
    this.openMs = opts.openMs;
    this.closeMs = opts.closeMs;
    this.easing = opts.easing;
    this.easingClose = opts.easingClose ?? opts.easing;
    this.gapPx = opts.gapPx;
    this.parallaxPx = opts.parallaxPx;
    this.suppressMotion = opts.suppressMotion;
  }

  dispose(): void {
    this.cancelFallback();
    // Leave the DOM as React rendered it.
    this.clearMotionStyles();
    this.setFloating(false);
    this.phase = "in-flow";
  }

  sync(open: boolean): void {
    if (open) this.playOpen();
    else this.playClose();
  }

  private offscreenTransform(): string {
    const sign = this.direction === "left" ? -1 : 1;
    return `translateX(calc(${sign * 100}% + ${sign * this.gapPx}px))`;
  }

  private setFloating(floating: boolean): void {
    if (floating) {
      this.el.style.position = "absolute";
      if (this.direction === "left") {
        this.el.style.left = `${this.gapPx}px`;
        this.el.style.right = "auto";
      } else {
        this.el.style.right = `${this.gapPx}px`;
        this.el.style.left = "auto";
      }
      this.el.style.top = `${this.gapPx}px`;
      this.el.style.bottom = `${this.gapPx}px`;
      this.el.style.margin = "0";
      this.el.style.zIndex = "40";
    } else {
      this.el.style.position = "";
      this.el.style.left = "";
      this.el.style.right = "";
      this.el.style.top = "";
      this.el.style.bottom = "";
      this.el.style.margin = "";
      this.el.style.zIndex = "";
    }
  }

  private clearMotionStyles(): void {
    this.el.style.transform = "";
    this.el.style.opacity = "";
    this.el.style.transition = "";
    this.el.style.willChange = "";
    this.el.style.visibility = "";
    if (this.innerEl) {
      this.innerEl.style.transform = "";
      this.innerEl.style.transition = "";
      this.innerEl.style.willChange = "";
    }
  }

  // Pin the inner subtree to the panel's compositor layer for the slide, so
  // children never repaint on the main thread and lag behind the panel.
  private pinInnerLayer(): void {
    if (!this.innerEl) return;
    this.innerEl.style.willChange = "transform";
    this.innerEl.style.transform = "translateZ(0)";
  }

  private cancelFallback(): void {
    if (this.fallbackTimer !== null) {
      clearTimeout(this.fallbackTimer);
      this.fallbackTimer = null;
    }
  }

  private motionSuppressed(): boolean {
    return this.suppressMotion?.() === true || prefersReducedMotion();
  }

  private snapClosed(): void {
    this.cancelFallback();
    this.setFloating(true);
    this.el.style.transitionDuration = "0s";
    this.el.style.visibility = "hidden";
    this.phase = "hidden";
    endLayoutAnimation(this.gateKind());
  }

  private snapOpen(): void {
    this.cancelFallback();
    this.setFloating(false);
    this.el.style.transitionDuration = "0s";
    this.el.style.visibility = "";
    this.clearMotionStyles();
    this.phase = "in-flow";
    endLayoutAnimation(this.gateKind());
  }

  private gateKind(): "sidebar-left" | "sidebar-right" {
    return this.direction === "left" ? "sidebar-left" : "sidebar-right";
  }

  private playClose(): void {
    this.cancelFallback();
    beginLayoutAnimation(this.gateKind(), this.closeMs);

    if (this.motionSuppressed()) {
      this.snapClosed();
      return;
    }

    const startX =
      this.phase === "hidden"
        ? this.direction === "left"
          ? -1
          : 1
        : currentTranslateX(this.el);

    // Leaving flow expands the viewport THIS frame; the gate keeps terminal
    // fits deferred until the slide completes.
    this.setFloating(true);
    this.el.style.visibility = "";

    this.el.style.willChange = "transform";
    this.pinInnerLayer();
    this.el.style.transition = "none";
    this.el.style.opacity = "1";
    this.el.style.transform =
      startX === 0 ? "" : `translateX(${startX}px)`;
    if (this.innerEl) {
      this.innerEl.style.transition = "none";
      this.innerEl.style.transform = "translateZ(0)";
    }
    // Commit the start frame before releasing toward the off-screen pose.
    void this.el.offsetWidth;

    const duration = this.closeMs;
    this.el.style.transition = `transform ${duration}ms ${this.easingClose}, opacity ${duration}ms ease`;
    this.el.style.transform = this.offscreenTransform();
    this.el.style.opacity = "0";
    if (this.innerEl) {
      const sign = this.direction === "left" ? -1 : 1;
      this.innerEl.style.transition = `transform ${duration}ms ${this.easingClose}`;
      this.innerEl.style.transform = `translateX(${sign * this.parallaxPx}px) translateZ(0)`;
    }
    this.phase = "to-closed";

    this.armCompletion(duration, () => {
      this.el.style.transitionDuration = "0s";
      this.clearMotionStyles();
      this.el.style.visibility = "hidden";
      this.phase = "hidden";
      endLayoutAnimation(this.gateKind());
    });
  }

  private playOpen(): void {
    this.cancelFallback();
    beginLayoutAnimation(this.gateKind(), this.openMs);

    if (this.motionSuppressed()) {
      this.snapOpen();
      return;
    }

    if (this.phase === "in-flow") {
      // Already committed (e.g. initial state drift): nothing to animate.
      endLayoutAnimation(this.gateKind());
      return;
    }

    this.el.style.visibility = "";
    this.el.style.willChange = "transform";
    this.pinInnerLayer();

    let start: string;
    if (this.phase === "hidden") {
      start = this.offscreenTransform();
    } else {
      // Interrupting a close mid-flight: resume from the visual position.
      const x = currentTranslateX(this.el);
      start = x === 0 ? "" : `translateX(${x}px)`;
    }

    this.el.style.transition = "none";
    this.el.style.opacity = "1";
    this.el.style.transform = start;
    if (this.innerEl && this.phase === "hidden") {
      const sign = this.direction === "left" ? -1 : 1;
      this.innerEl.style.transition = "none";
      this.innerEl.style.transform = `translateX(${sign * this.parallaxPx}px) translateZ(0)`;
    }
    void this.el.offsetWidth;

    const duration = this.openMs;
    this.el.style.transition = `transform ${duration}ms ${this.easing}`;
    this.el.style.transform = "";
    if (this.innerEl) {
      this.innerEl.style.transition = `transform ${duration}ms ${this.easing}`;
      this.innerEl.style.transform = "translateZ(0)";
    }
    this.phase = "to-open";

    this.armCompletion(duration, () => {
      // Re-enter flow NOW: the viewport narrows and the refit lands beneath
      // the opaque static panel.
      this.clearMotionStyles();
      this.setFloating(false);
      this.phase = "in-flow";
      endLayoutAnimation(this.gateKind());
    });
  }

  // transitionend plus a timer fallback (transitions never fire in tests,
  // hidden tabs, or reduced-motion edge cases).
  private armCompletion(durationMs: number, done: () => void): void {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      this.cancelFallback();
      this.el.removeEventListener("transitionend", onEnd);
      done();
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.propertyName === "transform") finish();
    };
    this.el.addEventListener("transitionend", onEnd);
    this.fallbackTimer = setTimeout(finish, durationMs + ANIM_FALLBACK_MS);
  }
}
