// A travelling pill that slides between tabs instead of the active background
// recolouring in place. It communicates that the tabs share one axis and the
// active state is a single value moving along it — a colour swap does not.
//
// The pill is one element sized to the strip, positioned with
// `translateX + scaleX`. Width is deliberately not animated: it is a layout
// property, and animating it relayouts the whole tab strip every frame
// (tokens.test.ts now rejects that outright). Because the pill is a stadium,
// the horizontal scale only stretches the straight run between the ends, so
// the rounded caps stay round.

import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";

export interface IndicatorMeasure {
  left: number;
  width: number;
}

export interface IndicatorTransform {
  translateX: number;
  scaleX: number;
}

const MIN_SCALE = 0.02;

/**
 * Position the strip-sized pill over `tab`.
 *
 * `strip` must be the strip's CONTENT box: an indicator declared `inset: 0` on
 * a padded container is positioned from the padding edge, so measuring the
 * border box leaves the pill offset by the container's padding. See
 * contentBoxOf() for how that is derived.
 * Returns null when the strip has no width yet, so a caller can leave the pill
 * hidden rather than collapsing it onto the origin.
 */
export function computeIndicatorTransform(
  strip: IndicatorMeasure,
  tab: IndicatorMeasure,
): IndicatorTransform | null {
  if (
    !Number.isFinite(strip.width) ||
    !Number.isFinite(tab.width) ||
    !Number.isFinite(strip.left) ||
    !Number.isFinite(tab.left) ||
    strip.width <= 0
  ) {
    return null;
  }
  const scaleX = Math.max(MIN_SCALE, tab.width / strip.width);
  return { translateX: tab.left - strip.left, scaleX };
}

/**
 * Content-box left edge and width of `el`, undoing any padding so a pill
 * positioned with `inset: <padding>` lines up with the tabs it measures against.
 */
export function contentBoxOf(el: HTMLElement): IndicatorMeasure {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const padLeft = parseFloat(style.paddingLeft) || 0;
  const padRight = parseFloat(style.paddingRight) || 0;
  return {
    left: rect.left + padLeft,
    width: rect.width - padLeft - padRight,
  };
}

export interface TabIndicator {
  /** Attach to the strip that contains the tabs. */
  stripRef: (node: HTMLElement | null) => void;
  /** CSS for the absolutely-positioned pill; undefined until measured. */
  style?: CSSProperties;
  /** Call after layout may have changed (tab labels, fonts, window resize). */
  refresh: () => void;
}

/**
 * @param activeKey identity of the active tab; the pill animates on change.
 * @param selector  CSS selector for a tab within the strip. The strip's own
 *                  pill is excluded by construction (it is not focusable).
 */
export function useTabIndicator(
  activeKey: unknown,
  selector: string,
): TabIndicator {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [transform, setTransform] = useState<IndicatorTransform | null>(null);

  const measure = useCallback(() => {
    if (!node) return;
    const active = node.querySelector<HTMLElement>(`${selector}[data-active="true"]`);
    if (!active) {
      setTransform(null);
      return;
    }
    const next = computeIndicatorTransform(contentBoxOf(node), {
      left: active.getBoundingClientRect().left,
      width: active.offsetWidth,
    });
    // Skip the state write when nothing moved: resize observers fire on every
    // pixel and re-rendering a static pill is pure waste.
    setTransform((prev) =>
      prev && next && prev.translateX === next.translateX && prev.scaleX === next.scaleX
        ? prev
        : next,
    );
  }, [node, selector]);

  useEffect(() => {
    if (!node) return;
    measure();
    // Text and window changes both move the tabs; a ResizeObserver on the strip
    // covers the cases that matter without observing every tab individually.
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, measure]);

  // Re-measure when the active tab changes. Separate from the effect above so
  // switching tabs does not tear down and rebuild the observer.
  useEffect(() => {
    measure();
  }, [activeKey, measure]);

  return {
    stripRef: setNode,
    refresh: measure,
    style: transform
      ? {
          transform: `translate3d(${transform.translateX}px, 0, 0) scaleX(${transform.scaleX})`,
        }
      : { opacity: 0 },
  };
}
