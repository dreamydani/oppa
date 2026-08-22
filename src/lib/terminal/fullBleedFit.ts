// Full-bleed fit planner: picks the letterSpacing/lineHeight pair that makes
// xterm's integer cell grid tile the pane with near-zero leftover on the
// right/bottom edges. Mirrors xterm 6's device-pixel math (WebglRenderer /
// DomRenderer agree): cellW_dev = charW_dev + round(letterSpacing) and
// cellH_dev = floor(charH_dev * lineHeight), so spacing moves the grid in
// whole device px per column and lineHeight in whole device px per row.

export interface FullBleedInput {
  availableWidthCss: number;
  availableHeightCss: number;
  devicePixelRatio: number;
  charWidthDevice: number;
  charHeightDevice: number;
  currentLetterSpacingPx: number;
  currentLineHeight: number;
}

export interface FullBleedPlan {
  letterSpacingPx: number;
  lineHeight: number;
  cols: number;
  rows: number;
  leftoverWidthDevice: number;
  leftoverHeightDevice: number;
}

const SPACING_SEARCH_PX = 2;
const MAX_LINE_HEIGHT_SHIFT = 0.15;
const MIN_LINE_HEIGHT = 1.0;
const MIN_CELL_WIDTH_DEVICE = 4;
const MIN_COLS = 2; // FitAddon minimums
const MIN_ROWS = 1;

interface Tiling {
  count: number;
  leftover: number;
}

function tilingFor(availDevice: number, cellDevice: number, minCount: number): Tiling | null {
  if (cellDevice <= 0 || availDevice <= 0) return null;
  const count = Math.max(minCount, Math.floor(availDevice / cellDevice));
  const used = count * cellDevice;
  // Overdrawing the budget (pane smaller than the minimum grid) is not a fill.
  if (used > availDevice) return null;
  return { count, leftover: availDevice - used };
}

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function planFullBleed(input: FullBleedInput): FullBleedPlan {
  const {
    charWidthDevice,
    charHeightDevice,
    currentLetterSpacingPx,
    currentLineHeight,
  } = input;

  // Degenerate pane metrics: keep the user's settings untouched and report a
  // plain floored grid so callers can still proceed safely.
  if (
    !finitePositive(input.availableWidthCss) ||
    !finitePositive(input.availableHeightCss) ||
    !finitePositive(input.devicePixelRatio) ||
    !finitePositive(charWidthDevice) ||
    !finitePositive(charHeightDevice)
  ) {
    return {
      letterSpacingPx: Math.round(currentLetterSpacingPx) || 0,
      lineHeight: currentLineHeight,
      cols: MIN_COLS,
      rows: MIN_ROWS,
      leftoverWidthDevice: 0,
      leftoverHeightDevice: 0,
    };
  }

  const dpr = input.devicePixelRatio;
  const availWidthDevice = Math.round(input.availableWidthCss * dpr);
  const availHeightDevice = Math.round(input.availableHeightCss * dpr);

  // Width: renderer applies round(letterSpacing), so integer CSS-px values hit
  // exact device-pixel cell widths. Search ±SPACING_SEARCH_PX around zero.
  let bestWidth: { k: number; tiling: Tiling } | null = null;
  for (let k = -SPACING_SEARCH_PX; k <= SPACING_SEARCH_PX; k++) {
    const cellWidth = charWidthDevice + k;
    if (cellWidth < MIN_CELL_WIDTH_DEVICE) continue;
    const tiling = tilingFor(availWidthDevice, cellWidth, MIN_COLS);
    if (!tiling) continue;
    const better =
      !bestWidth ||
      tiling.leftover < bestWidth.tiling.leftover ||
      (tiling.leftover === bestWidth.tiling.leftover && Math.abs(k) < Math.abs(bestWidth.k));
    if (better) bestWidth = { k, tiling };
  }
  if (!bestWidth) {
    bestWidth = { k: 0, tiling: { count: MIN_COLS, leftover: availWidthDevice } };
  }

  // Height: floor(charH * lh) === m exactly when lh = (m + 0.5) / charH, so we
  // can target specific integer row pitches inside the allowed band.
  const pitchBase = Math.floor(charHeightDevice * currentLineHeight);
  const lhMin = Math.max(MIN_LINE_HEIGHT, currentLineHeight - MAX_LINE_HEIGHT_SHIFT);
  const lhMax = currentLineHeight + MAX_LINE_HEIGHT_SHIFT;
  const mStart = Math.max(1, Math.ceil(lhMin * charHeightDevice - 0.5));
  const mEnd = Math.max(mStart, Math.floor(lhMax * charHeightDevice - 0.5));

  let bestHeight: { m: number; lineHeight: number; tiling: Tiling; distance: number } | null = null;
  for (let m = mStart; m <= mEnd; m++) {
    const tiling = tilingFor(availHeightDevice, m, MIN_ROWS);
    if (!tiling) continue;
    const lineHeight = (m + 0.5) / charHeightDevice;
    const distance = Math.abs(m - pitchBase);
    const better =
      !bestHeight ||
      tiling.leftover < bestHeight.tiling.leftover ||
      (tiling.leftover === bestHeight.tiling.leftover &&
        (distance < bestHeight.distance ||
          (distance === bestHeight.distance && m > bestHeight.m)));
    if (better) bestHeight = { m, lineHeight, tiling, distance };
  }
  if (!bestHeight) {
    bestHeight = {
      m: pitchBase,
      lineHeight: currentLineHeight,
      tiling: { count: MIN_ROWS, leftover: Math.max(0, availHeightDevice - MIN_ROWS * pitchBase) },
      distance: 0,
    };
  }

  return {
    letterSpacingPx: bestWidth.k,
    lineHeight: bestHeight.lineHeight,
    cols: bestWidth.tiling.count,
    rows: bestHeight.tiling.count,
    leftoverWidthDevice: bestWidth.tiling.leftover,
    leftoverHeightDevice: bestHeight.tiling.leftover,
  };
}
