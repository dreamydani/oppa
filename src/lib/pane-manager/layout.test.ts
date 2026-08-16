import { describe, it, expect } from "vitest";
import {
  split,
  remove,
  focus,
  substituteLeafId,
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
      expect(substituteLeafId(tree, "x", "y")).toBe(tree); // no placeholder: untouched
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
      expect(substituteLeafId(next!, "z", "w")).toBe(next); // no placeholder: untouched
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

  describe("substituteLeafId", () => {
    it("replaces the id of a root placeholder leaf", () => {
      expect(substituteLeafId(leaf("old"), "old", "new")).toEqual(leaf("new"));
    });

    it("substitutes the placeholder id wherever it occurs in a nested tree", () => {
      const tree = splitTree(
        "h",
        splitTree("v", leaf("old"), leaf("a")),
        splitTree("v", leaf("b"), leaf("old")),
      );
      expect(substituteLeafId(tree, "old", "new")).toEqual(
        splitTree(
          "h",
          splitTree("v", leaf("new"), leaf("a")),
          splitTree("v", leaf("b"), leaf("new")),
        ),
      );
    });

    it("returns the same tree when the placeholder id is absent", () => {
      const tree = splitTree("h", leaf("a"), leaf("b"));
      expect(substituteLeafId(tree, "nope", "new")).toBe(tree);
    });

    it("substitutes a placeholder that was wrapped as a child by a split", () => {
      // splitPane wraps the placeholder as `a` of a new split while its
      // spawn is still in flight; the resolved session id must replace it
      // at depth, not just at the root.
      const tree = splitTree(
        "h",
        leaf("placeholder"),
        splitTree("v", leaf("b"), leaf("c")),
      );
      const next = substituteLeafId(tree, "placeholder", "s1");
      expect(next).toEqual(
        splitTree("h", leaf("s1"), splitTree("v", leaf("b"), leaf("c"))),
      );
      expect(JSON.stringify(next)).not.toContain("placeholder");
    });

    it("keeps every non-matching leaf untouched", () => {
      const tree = splitTree("h", leaf("a"), leaf("b"));
      expect(substituteLeafId(tree, "a", "a1")).toEqual(
        splitTree("h", leaf("a1"), leaf("b")),
      );
    });
  });
});
