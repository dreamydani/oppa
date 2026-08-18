// Pure layout-tree operations for split panes. These functions never mutate
// the input tree; each returns a new tree (or null when the tree becomes
// empty). The store is the only consumer, so the shape here must match the
// `Layout` type used in `terminalStore.ts`.

export type Layout =
  | { type: "leaf"; id: string }
  | { type: "split"; dir: "h" | "v"; ratio: number; a: Layout; b: Layout };

// A path of child indices from the root of the tree. The root leaf has path
// `[]`; a leaf inside the left (a) child of the root split has path `[0]`, and
// so on: `[0, 0]` is a inside `a`, `[1, 1]` is b inside `b`.
export type Path = number[];

// Insert a new leaf as a sibling at `path`, splitting the parent in `dir`.
export function split(
  dir: "h" | "v",
  tree: Layout,
  path: Path,
  newId: string,
): Layout {
  if (path.length === 0) {
    // Splitting the root: wrap it in a split with the new leaf.
    return {
      type: "split",
      dir,
      ratio: 0.5,
      a: tree,
      b: { type: "leaf", id: newId },
    };
  }
  const [head, ...rest] = path;
  if (tree.type === "leaf") return tree; // can't descend into a leaf
  const [a, b] = tree.type === "split" ? [tree.a, tree.b] : [tree, tree];
  const left = head === 0 ? split(dir, a, rest, newId) : a;
  const right = head === 1 ? split(dir, b, rest, newId) : b;
  return { type: "split", dir: tree.dir, ratio: tree.ratio, a: left, b: right };
}

// Remove the leaf at `path`; if a split is left with one child, collapse it.
export function remove(tree: Layout, path: Path): Layout | null {
  if (path.length === 0) return null;
  const [head, ...rest] = path;
  if (tree.type === "leaf") return tree;
  const a = head === 0 ? remove(tree.a, rest) : tree.a;
  const b = head === 1 ? remove(tree.b, rest) : tree.b;
  if (a === null && b === null) return null;
  if (a === null) return b;
  if (b === null) return a;
  return { type: "split", dir: tree.dir, ratio: tree.ratio, a, b };
}

// The id of the leaf at `path`.
export function focus(tree: Layout, path: Path): string {
  if (tree.type === "leaf") return tree.id;
  const [head, ...rest] = path;
  const child = head === 0 ? tree.a : tree.b;
  return focus(child, rest);
}

// Replace every leaf with id `from` by a leaf with id `to`. Used to bind a
// resolved spawn id to its placeholder leaf. Pure: returns the SAME tree
// reference when `from` does not occur anywhere, so callers can treat
// "placeholder still present" as a cheap identity check.
export function substituteLeafId(
  tree: Layout,
  from: string,
  to: string,
): Layout {
  if (tree.type === "leaf") {
    return tree.id === from ? { type: "leaf", id: to } : tree;
  }
  const a = substituteLeafId(tree.a, from, to);
  const b = substituteLeafId(tree.b, from, to);
  if (a === tree.a && b === tree.b) return tree;
  return { type: "split", dir: tree.dir, ratio: tree.ratio, a, b };
}

// Replace every leaf id through `map` (saved id -> fresh session id after a
// persisted-layout restore). Ids absent from the map pass through untouched.
// Pure: returns the SAME tree reference when nothing changes.
export function remapLeafIds(
  tree: Layout,
  map: Record<string, string>,
): Layout {
  if (tree.type === "leaf") {
    const to = map[tree.id];
    return to === undefined ? tree : { type: "leaf", id: to };
  }
  const a = remapLeafIds(tree.a, map);
  const b = remapLeafIds(tree.b, map);
  if (a === tree.a && b === tree.b) return tree;
  return { type: "split", dir: tree.dir, ratio: tree.ratio, a, b };
}

// Path of the depth-first leftmost leaf (the root leaf has path `[]`).
export function firstLeafPath(tree: Layout): Path {
  if (tree.type === "leaf") return [];
  return [0, ...firstLeafPath(tree.a)];
}

export type DropZone = "top" | "bottom" | "left" | "right";

// Check if a leaf with `id` exists in the tree.
function hasLeaf(tree: Layout, id: string): boolean {
  if (tree.type === "leaf") return tree.id === id;
  return hasLeaf(tree.a, id) || hasLeaf(tree.b, id);
}

// Remove the leaf with `id` and collapse single-child splits.
function removeLeaf(tree: Layout, id: string): Layout | null {
  if (tree.type === "leaf") {
    return tree.id === id ? null : tree;
  }
  const a = removeLeaf(tree.a, id);
  const b = removeLeaf(tree.b, id);
  if (a === null && b === null) return null;
  if (a === null) return b;
  if (b === null) return a;
  if (a === tree.a && b === tree.b) return tree;
  return { type: "split", dir: tree.dir, ratio: tree.ratio, a, b };
}

// Insert `sourceId` relative to `targetId` according to `zone`.
function insertAtLeaf(
  tree: Layout,
  targetId: string,
  sourceId: string,
  zone: DropZone,
): Layout {
  if (tree.type === "leaf") {
    if (tree.id !== targetId) return tree;
    const sourceNode: Layout = { type: "leaf", id: sourceId };
    const dir = zone === "left" || zone === "right" ? "h" : "v";
    const [a, b] =
      zone === "left" || zone === "top"
        ? [sourceNode, tree]
        : [tree, sourceNode];
    return { type: "split", dir, ratio: 0.5, a, b };
  }
  const a = insertAtLeaf(tree.a, targetId, sourceId, zone);
  const b = insertAtLeaf(tree.b, targetId, sourceId, zone);
  if (a === tree.a && b === tree.b) return tree;
  return { type: "split", dir: tree.dir, ratio: tree.ratio, a, b };
}

// Recursively swap the positions of two leaf nodes.
export function swapLeaves(tree: Layout, idA: string, idB: string): Layout {
  if (idA === idB) return tree;
  if (!hasLeaf(tree, idA) || !hasLeaf(tree, idB)) return tree;

  function doSwap(node: Layout): Layout {
    if (node.type === "leaf") {
      if (node.id === idA) return { type: "leaf", id: idB };
      if (node.id === idB) return { type: "leaf", id: idA };
      return node;
    }
    const a = doSwap(node.a);
    const b = doSwap(node.b);
    if (a === node.a && b === node.b) return node;
    return { type: "split", dir: node.dir, ratio: node.ratio, a, b };
  }

  return doSwap(tree);
}

// Detach source leaf and attach it relative to target leaf in specified zone.
export function moveLeaf(
  tree: Layout,
  sourceId: string,
  targetId: string,
  zone: DropZone,
): Layout {
  if (sourceId === targetId) return tree;
  if (!hasLeaf(tree, sourceId) || !hasLeaf(tree, targetId)) return tree;

  const pruned = removeLeaf(tree, sourceId);
  if (!pruned) return tree;

  return insertAtLeaf(pruned, targetId, sourceId, zone);
}

