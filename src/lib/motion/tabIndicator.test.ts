import { describe, it, expect } from "vitest";
import { computeIndicatorTransform, type IndicatorMeasure } from "./tabIndicator";

const box = (left: number, width: number): IndicatorMeasure => ({ left, width });

describe("computeIndicatorTransform", () => {
  it("covers the first tab exactly when they are equal width", () => {
    const t = computeIndicatorTransform(box(0, 100), box(0, 100));
    expect(t).toEqual({ translateX: 0, scaleX: 1 });
  });

  it("translates to the active tab and scales to its width", () => {
    // Indicator spans the strip (120px); the active tab starts at 40 and is 60 wide.
    const t = computeIndicatorTransform(box(0, 120), box(40, 60))!;
    expect(t.translateX).toBe(40);
    expect(t.scaleX).toBeCloseTo(0.5);
  });

  it("offsets by the container origin so nested containers still align", () => {
    const strip = box(500, 120);
    const tab = box(540, 60);
    const t = computeIndicatorTransform(strip, tab)!;
    expect(t.translateX).toBe(40);
    expect(t.scaleX).toBeCloseTo(0.5);
  });

  it("returns null for a zero-width strip — an unmeasured node must not move the pill", () => {
    expect(computeIndicatorTransform(box(0, 0), box(0, 60))).toBeNull();
  });

  it("returns null on negative or non-finite input (happy-dom reports 0x0)", () => {
    expect(computeIndicatorTransform(box(0, NaN), box(0, 60))).toBeNull();
    expect(computeIndicatorTransform(box(0, -10), box(0, 60))).toBeNull();
  });

  it("never produces a non-finite scale", () => {
    const t = computeIndicatorTransform(box(0, 3), box(0, 900));
    expect(Number.isFinite(t!.scaleX)).toBe(true);
  });
});
