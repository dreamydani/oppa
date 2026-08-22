import { describe, it, expect } from "vitest";
import { planFullBleed } from "./fullBleedFit";

// Numbers mirror xterm 6's device-pixel math (WebglRenderer._updateDimensions):
// cellW_dev = charW_dev + round(letterSpacing); cellH_dev = floor(charH_dev * lineHeight).
describe("planFullBleed", () => {
  it("picks letter spacing that tiles the width exactly at dpr 1", () => {
    // cellW candidates {6,7,8,9,10}: leftovers {2,1,6,5,6} -> k=-1 wins
    const plan = planFullBleed({
      availableWidthCss: 806,
      availableHeightCss: 600,
      devicePixelRatio: 1,
      charWidthDevice: 8,
      charHeightDevice: 16,
      currentLetterSpacingPx: 0,
      currentLineHeight: 1.2,
    });
    expect(plan.letterSpacingPx).toBe(-1);
    expect(plan.cols).toBe(115);
    expect(plan.leftoverWidthDevice).toBe(1);
  });

  it("keeps zero letter spacing when the grid already tiles perfectly", () => {
    const plan = planFullBleed({
      availableWidthCss: 800,
      availableHeightCss: 600,
      devicePixelRatio: 1,
      charWidthDevice: 8,
      charHeightDevice: 16,
      currentLetterSpacingPx: 0,
      currentLineHeight: 1.2,
    });
    expect(plan.letterSpacingPx).toBe(0);
    expect(plan.cols).toBe(100);
    expect(plan.leftoverWidthDevice).toBe(0);
  });

  it("breaks horizontal ties toward the smallest spacing shift", () => {
    // cellW {6,7,8,9,10} -> leftovers {5,6,5,5,7}: three-way tie -> |k| smallest = 0
    const plan = planFullBleed({
      availableWidthCss: 797,
      availableHeightCss: 600,
      devicePixelRatio: 1,
      charWidthDevice: 8,
      charHeightDevice: 16,
      currentLetterSpacingPx: 0,
      currentLineHeight: 1.2,
    });
    expect(plan.letterSpacingPx).toBe(0);
  });

  it("finds a row pitch that tiles the height exactly while honoring the lineHeight band", () => {
    // m candidates 17..21 (lh band [1.05,1.35] around 1.2): leftovers {5,6,11,0,12}
    const plan = planFullBleed({
      availableWidthCss: 800,
      availableHeightCss: 600,
      devicePixelRatio: 1,
      charWidthDevice: 8,
      charHeightDevice: 16,
      currentLetterSpacingPx: 0,
      currentLineHeight: 1.2,
    });
    expect(plan.lineHeight).toBeCloseTo(20.5 / 16, 10);
    expect(plan.rows).toBe(30);
    expect(plan.leftoverHeightDevice).toBe(0);
  });

  it("never drops lineHeight below 1.0 even when squeezing would tile better", () => {
    // lh band [max(1, 0.85)=1.0, 1.15] restricts m to {16,17}; m=16 tiles exactly.
    const plan = planFullBleed({
      availableWidthCss: 800,
      availableHeightCss: 608,
      devicePixelRatio: 1,
      charWidthDevice: 8,
      charHeightDevice: 16,
      currentLetterSpacingPx: 0,
      currentLineHeight: 1.0,
    });
    expect(plan.lineHeight).toBeCloseTo(16.5 / 16, 10);
    expect(plan.lineHeight).toBeGreaterThanOrEqual(1.0);
    expect(plan.rows).toBe(38);
    expect(plan.leftoverHeightDevice).toBe(0);
  });

  it("works on fractional device pixel ratios", () => {
    // Width: round(763*1.25)=954 dev px, charW 9 -> 106*9=954 exact.
    // Height: round(520*1.25)=650 dev px, charH 20 -> m=25 tiles exactly;
    // m=26 also leaves 0 but sits further from the configured pitch (24).
    const plan = planFullBleed({
      availableWidthCss: 763,
      availableHeightCss: 520,
      devicePixelRatio: 1.25,
      charWidthDevice: 9,
      charHeightDevice: 20,
      currentLetterSpacingPx: 0,
      currentLineHeight: 1.2,
    });
    expect(plan.letterSpacingPx).toBe(0);
    expect(plan.cols).toBe(106);
    expect(plan.lineHeight).toBeCloseTo(25.5 / 20, 10);
    expect(plan.rows).toBe(26);
    expect(plan.leftoverHeightDevice).toBe(0);
  });

  it("echoes the current settings when inputs are degenerate", () => {
    for (const bad of [
      { availableWidthCss: Number.NaN },
      { availableHeightCss: 0 },
      { devicePixelRatio: 0 },
      { charWidthDevice: -3 },
      { charHeightDevice: Number.NaN },
    ]) {
      const plan = planFullBleed({
        availableWidthCss: 800,
        availableHeightCss: 600,
        devicePixelRatio: 1,
        charWidthDevice: 8,
        charHeightDevice: 16,
        currentLetterSpacingPx: 0,
        currentLineHeight: 1.2,
        ...bad,
      });
      expect(plan.letterSpacingPx).toBe(0);
      expect(plan.lineHeight).toBe(1.2);
    }
  });

  it("keeps grid counts above the FitAddon minimums on tiny panes", () => {
    const plan = planFullBleed({
      availableWidthCss: 15,
      availableHeightCss: 14,
      devicePixelRatio: 1,
      charWidthDevice: 8,
      charHeightDevice: 16,
      currentLetterSpacingPx: 0,
      currentLineHeight: 1.2,
    });
    expect(plan.cols).toBeGreaterThanOrEqual(2);
    expect(plan.rows).toBeGreaterThanOrEqual(1);
  });
});
