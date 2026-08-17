import { describe, it, expect } from "vitest";
import { createGridLayout } from "./gridLayout";
import type { Layout } from "./layout";

// Helper to extract leaf IDs in depth-first traversal order
function extractLeafIds(tree: Layout): string[] {
  if (tree.type === "leaf") return [tree.id];
  return [...extractLeafIds(tree.a), ...extractLeafIds(tree.b)];
}

describe("createGridLayout", () => {
  it("returns an empty leaf when count is 0 or negative", () => {
    expect(createGridLayout(0, [])).toEqual({ type: "leaf", id: "" });
    expect(createGridLayout(-1, [])).toEqual({ type: "leaf", id: "" });
  });

  it("returns a single leaf for count = 1", () => {
    const layout = createGridLayout(1, ["session-1"]);
    expect(layout).toEqual({
      type: "leaf",
      id: "session-1",
    });
  });

  it("returns a horizontal split for count = 2", () => {
    const layout = createGridLayout(2, ["session-1", "session-2"]);
    expect(layout).toEqual({
      type: "split",
      dir: "h",
      ratio: 0.5,
      a: { type: "leaf", id: "session-1" },
      b: { type: "leaf", id: "session-2" },
    });
  });

  it("returns a 2x2 quadrant (vertical split of two horizontal splits) for count = 4", () => {
    const layout = createGridLayout(4, ["s1", "s2", "s3", "s4"]);
    expect(layout).toEqual({
      type: "split",
      dir: "v",
      ratio: 0.5,
      a: {
        type: "split",
        dir: "h",
        ratio: 0.5,
        a: { type: "leaf", id: "s1" },
        b: { type: "leaf", id: "s2" },
      },
      b: {
        type: "split",
        dir: "h",
        ratio: 0.5,
        a: { type: "leaf", id: "s3" },
        b: { type: "leaf", id: "s4" },
      },
    });
    expect(extractLeafIds(layout)).toEqual(["s1", "s2", "s3", "s4"]);
  });

  it("returns a 2x3 grid for count = 6 with balanced leaf ordering", () => {
    const ids = ["s1", "s2", "s3", "s4", "s5", "s6"];
    const layout = createGridLayout(6, ids);
    expect(layout.type).toBe("split");
    if (layout.type === "split") {
      expect(layout.dir).toBe("v");
      expect(layout.ratio).toBe(0.5);
    }
    expect(extractLeafIds(layout)).toEqual(ids);
  });

  it("returns a 2x4 grid for count = 8", () => {
    const ids = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"];
    const layout = createGridLayout(8, ids);
    expect(layout.type).toBe("split");
    if (layout.type === "split") {
      expect(layout.dir).toBe("v");
      expect(layout.ratio).toBe(0.5);
    }
    expect(extractLeafIds(layout)).toEqual(ids);
  });

  it("returns a 2x5 grid for count = 10", () => {
    const ids = Array.from({ length: 10 }, (_, i) => `s${i + 1}`);
    const layout = createGridLayout(10, ids);
    expect(layout.type).toBe("split");
    if (layout.type === "split") {
      expect(layout.dir).toBe("v");
      expect(layout.ratio).toBe(0.5);
    }
    expect(extractLeafIds(layout)).toEqual(ids);
  });

  it("returns a 3x4 grid for count = 12", () => {
    const ids = Array.from({ length: 12 }, (_, i) => `s${i + 1}`);
    const layout = createGridLayout(12, ids);
    expect(layout.type).toBe("split");
    if (layout.type === "split") {
      expect(layout.dir).toBe("v");
    }
    expect(extractLeafIds(layout)).toEqual(ids);
  });

  it("pads missing session IDs with empty strings", () => {
    const layout = createGridLayout(4, ["s1", "s2"]);
    expect(extractLeafIds(layout)).toEqual(["s1", "s2", "", ""]);
  });
});
