import { describe, it, expect } from "vitest";
import {
  computeMenuPosition,
  CONTEXT_MENU_MARGIN,
  MenuBoundsInput,
} from "./FileContextMenu";

const base: MenuBoundsInput = {
  clickX: 300,
  clickY: 200,
  menuW: 210,
  menuH: 120,
  submenuW: 170,
  submenuH: 100,
  viewportW: 1200,
  viewportH: 800,
};

describe("computeMenuPosition", () => {
  it("opens at the click point with right submenu when there is room", () => {
    const pos = computeMenuPosition(base);
    expect(pos.x).toBe(300);
    expect(pos.y).toBe(200);
    expect(pos.submenuSide).toBe("right");
    expect(pos.submenuOffsetY).toBe(0);
  });

  it("shifts the menu left so it stays inside the right viewport edge", () => {
    const pos = computeMenuPosition({ ...base, clickX: 1150 });
    expect(pos.x).toBe(1200 - 210 - CONTEXT_MENU_MARGIN);
    expect(pos.y).toBe(200);
  });

  it("flips the submenu to the left when it would overflow the right edge", () => {
    const pos = computeMenuPosition({ ...base, clickX: 1000 });
    const menuRight = pos.x + 210;
    expect(menuRight + 2 + 170 + CONTEXT_MENU_MARGIN).toBeGreaterThan(1200);
    expect(pos.submenuSide).toBe("left");
  });

  it("keeps the submenu on the right when the flipped side would not fit either", () => {
    // Menu pinned at the far left: a left-side submenu would clip the left edge
    const pos = computeMenuPosition({ ...base, clickX: 0 });
    expect(pos.submenuSide).toBe("right");
  });

  it("flips the menu up when it would overflow the bottom edge", () => {
    const pos = computeMenuPosition({ ...base, clickY: 760 });
    expect(pos.y).toBe(800 - 120 - CONTEXT_MENU_MARGIN);
    expect(pos.x).toBe(300);
  });

  it("clamps an oversized menu inside the viewport", () => {
    const pos = computeMenuPosition({ ...base, menuW: 1300, menuH: 900, clickX: 600, clickY: 700 });
    expect(pos.x).toBe(0);
    expect(pos.y).toBe(0);
  });

  it("shifts the submenu up when it would overflow the bottom edge", () => {
    // Menu bottom sits at 672; a 200px submenu would overflow past 800
    const pos = computeMenuPosition({ ...base, clickY: 672 - 120 + 120, submenuH: 200 });
    const menuBottom = pos.y + 120;
    expect(menuBottom + 200 + CONTEXT_MENU_MARGIN).toBeGreaterThan(800);
    expect(pos.submenuOffsetY).toBeLessThan(0);
  });

  it("never shifts the submenu above the viewport top", () => {
    const pos = computeMenuPosition({ ...base, clickY: 0, submenuH: 900 });
    expect(pos.y + pos.submenuOffsetY).toBeGreaterThanOrEqual(0);
  });
});
