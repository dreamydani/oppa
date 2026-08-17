import type { Layout } from "./layout";

// Splits a flat list of layout nodes into a balanced binary tree along `dir`.
function build1D(nodes: Layout[], dir: "h" | "v"): Layout {
  if (nodes.length === 0) {
    return { type: "leaf", id: "" };
  }
  if (nodes.length === 1) {
    return nodes[0];
  }
  if (nodes.length === 2) {
    return {
      type: "split",
      dir,
      ratio: 0.5,
      a: nodes[0],
      b: nodes[1],
    };
  }

  const mid = Math.floor(nodes.length / 2);
  const leftNodes = nodes.slice(0, mid);
  const rightNodes = nodes.slice(mid);
  const ratio = leftNodes.length / nodes.length;

  return {
    type: "split",
    dir,
    ratio,
    a: build1D(leftNodes, dir),
    b: build1D(rightNodes, dir),
  };
}

// Generates a balanced 2D recursive binary split tree for the given session count.
export function createGridLayout(count: number, sessionIds: string[]): Layout {
  if (count <= 0) {
    return { type: "leaf", id: "" };
  }
  const ids = Array.from({ length: count }, (_, i) => sessionIds[i] ?? "");
  if (count === 1) {
    return { type: "leaf", id: ids[0] };
  }

  // Pick balanced row count based on pane count and wide aspect ratio.
  let rows = 1;
  if (count <= 3) {
    rows = 1;
  } else if (count <= 10) {
    rows = 2;
  } else if (count <= 18) {
    rows = 3;
  } else {
    rows = Math.round(Math.sqrt(count * (9 / 16))) || 1;
  }

  // Partition sessions across rows and build 1D row trees.
  const rowLayouts: Layout[] = [];
  const baseCols = Math.floor(count / rows);
  const remainder = count % rows;
  let offset = 0;

  for (let r = 0; r < rows; r++) {
    const colsInThisRow = baseCols + (r < remainder ? 1 : 0);
    const rowIds = ids.slice(offset, offset + colsInThisRow);
    offset += colsInThisRow;
    if (rowIds.length > 0) {
      const rowLeaves: Layout[] = rowIds.map((id) => ({ type: "leaf", id }));
      rowLayouts.push(build1D(rowLeaves, "h"));
    }
  }

  return build1D(rowLayouts, "v");
}
