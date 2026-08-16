import { describe, it, expect } from "vitest";
import {
  split,
  remove,
  focus,
  leafCount,
  firstLeaf,
  firstLeafPath,
} from "./layout";
import type { Layout } from "./layout";

function leaf(id: string): Layout {
  return { type: "leaf", id };
}

function splitTree(
  dir: "h" | "v",
  a: Layout,
  b: Layout,
  ratio = 0.5,
): Layout {
  return { type: "split", dir, ratio, a, b };
}

describe("layout", () => {
  describe("split", () => {
    it("wraps a single-leaf root in a split with the new leaf", () => {
      const tree = leaf("a");
      const next = split("h", tree, [], "b");
      expect(next).toEqual(splitTree("h", leaf("a"), leaf("b")));
      expect(next).not.toBe(tree); // pure: returns a new tree, original untouched
    });

    it("inserts a sibling leaf inside a nested split", () => {
      const tree = splitTree("h", leaf("a"), leaf("b"));
      const next = split("v", tree, [0], "c");
      expect(next).toEqual(
        splitTree("h", splitTree("v", leaf("a"), leaf("c")), leaf("b")),
      );
      expect(focus(next, [0, 1])).toBe("c");
    });

    it("keeps the original tree untouched (pure function)", () => {
      const tree = splitTree("h", leaf("a"), leaf("b"));
      const original = JSON.stringify(tree);
      split("v", tree, [0], "c");
      expect(JSON.stringify(tree)).toBe(original);
      expect(leafCount(tree)).toBe(2);
    });

    it("no-ops when the path descends into a leaf", () => {
      const tree = leaf("a");
      expect(split("h", tree, [0], "b")).toBe(tree);
    });
  });

  describe("remove", () => {
    it("removes a leaf and collapses a split left with one child", () => {
      const tree = splitTree("h", leaf("a"), leaf("b"));
      expect(remove(tree, [0])).toEqual(leaf("b"));
      expect(remove(tree, [1])).toEqual(leaf("a"));
    });

    it("prunes a nested leaf and keeps the outer split", () => {
      const tree = splitTree(
        "h",
        splitTree("v", leaf("a"), leaf("b")),
        leaf("c"),
      );
      const next = remove(tree, [0, 0]);
      expect(next).toEqual(splitTree("h", leaf("b"), leaf("c")));
      expect(leafCount(next!)).toBe(2);
    });

    it("collapses the inner split when the last of its leaves is removed", () => {
      const tree = splitTree(
        "h",
        splitTree("v", leaf("a"), leaf("b")),
        leaf("c"),
      );
      const next = remove(tree, [1]);
      expect(next).toEqual(splitTree("v", leaf("a"), leaf("b")));
    });

    it("returns null when the only leaf is removed", () => {
      expect(remove(leaf("a"), [])).toBeNull();
    });

    it("no-ops when the path cannot reach a leaf", () => {
      const tree = leaf("a");
      expect(remove(tree, [0])).toBe(tree);
    });
  });

  describe("focus", () => {
    it("returns the id of the leaf at a path", () => {
      const tree = splitTree(
        "h",
        splitTree("v", leaf("a"), leaf("b")),
        leaf("c"),
      );
      expect(focus(tree, [0, 0])).toBe("a");
      expect(focus(tree, [0, 1])).toBe("b");
      expect(focus(tree, [1])).toBe("c");
    });

    it("returns the root leaf id for an empty path", () => {
      expect(focus(leaf("a"), [])).toBe("a");
    });
  });

  describe("helpers", () => {
    it("leafCount counts every leaf", () => {
      const tree = splitTree(
        "h",
        splitTree("v", leaf("a"), leaf("b")),
        leaf("c"),
      );
      expect(leafCount(tree)).toBe(3);
      expect(leafCount(leaf("a"))).toBe(1);
    });

    it("firstLeaf returns the depth-first leftmost leaf and its path", () => {
      const tree = splitTree(
        "h",
        splitTree("v", leaf("a"), leaf("b")),
        leaf("c"),
      );
      expect(firstLeaf(tree)).toBe("a");
      expect(firstLeafPath(tree)).toEqual([0, 0]);
      expect(firstLeaf(leaf("z"))).toBe("z");
      expect(firstLeafPath(leaf("z"))).toEqual([]);
    });
  });
});
