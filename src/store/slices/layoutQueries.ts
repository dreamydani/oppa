// Pure queries over the combined terminal state. Used by several slices;
// keeping them here prevents copy-paste drift between siblings.

import type { Layout, Path } from "../../lib/pane-manager/layout";
import { firstLeafPath } from "../../lib/pane-manager/layout";
import type { TabState } from "./paneLayoutSlice";
import type { TerminalState } from "../terminalStore";

export function isNonEmptyLayout(layout?: Layout): boolean {
  if (!layout) return false;
  if (layout.type === "split") return true;
  return layout.id !== "";
}

export function getSyncedTabs(state: TerminalState): TabState[] {
  if (state.tabs && state.tabs.length > 0) {
    return state.tabs;
  }
  if (isNonEmptyLayout(state.layout)) {
    return [
      {
        id: state.activeTabId || "tab-1",
        layout: state.layout,
        focusedPath: state.focusedPath ?? [],
      },
    ];
  }
  return [];
}

export function getActiveTab(state: TerminalState): TabState | undefined {
  const tabs = getSyncedTabs(state);
  const activeId = state.activeTabId;
  return tabs.find((t) => t.id === activeId) ?? tabs[0];
}

// The split node reached by walking `prefix` down from the root.
export function nodeAt(tree: Layout, prefix: Path): Layout {
  let node = tree;
  for (const step of prefix) {
    if (node.type === "leaf") return node;
    node = step === 0 ? node.a : node.b;
  }
  return node;
}

// Find path of the adjacent sibling leaf in direction dir.
export function findAdjacentPath(
  tree: Layout,
  path: Path,
  dir: "left" | "right" | "up" | "down",
): Path | null {
  if (path.length === 0) return null;
  const target = dir === "left" || dir === "up" ? 0 : 1;
  const axis = dir === "left" || dir === "right" ? "h" : "v";
  for (let i = path.length - 1; i >= 0; i--) {
    const ancestor = nodeAt(tree, path.slice(0, i));
    if (ancestor.type !== "split" || ancestor.dir !== axis) continue;
    if (path[i] === target) continue;
    const destChild = path[i] === 0 ? ancestor.b : ancestor.a;
    return [
      ...path.slice(0, i),
      path[i] === 0 ? 1 : 0,
      ...firstLeafPath(destChild),
    ];
  }
  return null;
}

// Leaf ids in depth-first (a before b) order — the deterministic spawn order
// a persisted-layout restore uses.
export function leafIds(tree: Layout): string[] {
  if (tree.type === "leaf") return [tree.id];
  return [...leafIds(tree.a), ...leafIds(tree.b)];
}

export function generateNextTabId(existingTabs: TabState[]): string {
  const existingIds = new Set(existingTabs.map((t) => t.id));
  let maxId = 0;
  for (const t of existingTabs) {
    const match = /^tab-(\d+)$/.exec(t.id);
    if (match) {
      const num = parseInt(match[1], 10);
      if (!isNaN(num) && num > maxId) {
        maxId = num;
      }
    }
  }
  let candidate = maxId + 1;
  while (existingIds.has(`tab-${candidate}`)) {
    candidate++;
  }
  return `tab-${candidate}`;
}
