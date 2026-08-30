import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  beginResizeStream,
  updateResizeStream,
  endResizeStream,
  isResizeStreamActive,
  resetResizeStreamOverlayForTests,
  resizeOverlayFor,
} from "./resizeStreamOverlay";

interface FakeRect {
  width: number;
  height: number;
}

function makeEl(initial?: FakeRect) {
  const el = {
    style: {} as Record<string, string>,
    getBoundingClientRect: vi.fn(
      () =>
        ({
          width: initial?.width ?? 0,
          height: initial?.height ?? 0,
          left: 0,
          top: 0,
          right: initial?.width ?? 0,
          bottom: initial?.height ?? 0,
          toJSON: () => ({}),
        }) as DOMRect,
    ),
  };
  return el as unknown as HTMLElement;
}

describe("resizeStreamOverlay", () => {
  beforeEach(() => {
    resetResizeStreamOverlayForTests();
  });
  afterEach(() => {
    resetResizeStreamOverlayForTests();
  });

  it("pins the element rect at begin and reports active", () => {
    const el = makeEl({ width: 400, height: 300 });
    beginResizeStream("p1", el);
    expect(isResizeStreamActive("p1")).toBe(true);
  });

  it("applies a non-uniform stretch to fill the new box", () => {
    const el = makeEl({ width: 400, height: 300 });
    beginResizeStream("p1", el);

    // Pane grew to 800x600: freeze+stretch scales the old frame to fill.
    updateResizeStream("p1", { width: 800, height: 600 });
    expect(el.style.transform).toContain("scale(2");
    expect(el.style.transformOrigin).toBe("top left");
  });

  it("no-ops update for an unknown pane", () => {
    updateResizeStream("ghost", { width: 100, height: 100 });
    expect(isResizeStreamActive("ghost")).toBe(false);
  });

  it("end clears the transform and removes the element from the registry", () => {
    const el = makeEl({ width: 400, height: 300 });
    beginResizeStream("p1", el);
    updateResizeStream("p1", { width: 800, height: 600 });
    endResizeStream("p1");
    expect(el.style.transform).toBe("");
    expect(isResizeStreamActive("p1")).toBe(false);
    expect(resizeOverlayFor("p1")).toBeUndefined();
  });

  it("end is idempotent for unknown panes", () => {
    expect(() => endResizeStream("ghost")).not.toThrow();
  });
});
