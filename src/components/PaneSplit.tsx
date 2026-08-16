import { useCallback, useEffect, useRef } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useTerminalStore } from "../store/terminalStore";
import type { Layout, Path } from "../store/terminalStore";
import { SessionLeaf } from "./SessionLeaf";

// The fraction of the split's length that `a` keeps. PaneSplit needs this
// exact value to lay the divider out; reading it from the store via a
// selector returns the same number.
function ratioOf(tree: Layout): number {
  return tree.type === "split" ? tree.ratio : 1;
}

// Recursive renderer for the layout tree: leaves become session-backed
// terminal panes, splits become flex rows/columns with a draggable divider.
export function PaneSplit() {
  const layout = useTerminalStore((s) => s.layout);
  const focusedPath = useTerminalStore((s) => s.focusedPath);
  const focusPane = useTerminalStore((s) => s.focusPane);
  const setRatio = useTerminalStore((s) => s.setRatio);

  const renderNode = (node: Layout, path: Path): React.ReactNode => {
    if (node.type === "leaf") {
      return (
        <div
          key={path.join(".")}
          className={`pane-leaf${path.join(".") === focusedPath.join(".") ? " focused" : ""}`}
          onMouseDown={() => focusPane(path)}
        >
          <SessionLeaf id={node.id} />
        </div>
      );
    }
    return (
      <div
        key={path.join(".")}
        className={`pane-split dir-${node.dir}`}
        style={{ flexDirection: node.dir === "h" ? "row" : "column" }}
      >
        <div className="pane-child" style={childStyle(node, 0)}>
          {renderNode(node.a, [...path, 0])}
        </div>
        <SplitDivider
          path={path}
          dir={node.dir}
          ratio={ratioOf(node)}
          setRatio={setRatio}
        />
        <div className="pane-child" style={childStyle(node, 1)}>
          {renderNode(node.b, [...path, 1])}
        </div>
      </div>
    );
  };

  return (
    <div className="pane-root">
      {renderNode(layout, [])}
    </div>
  );
}

// `a` keeps `ratio` of the split's length, `b` the rest.
function childStyle(node: Layout, index: 0 | 1) {
  const fraction = node.type === "split" ? node.ratio : 1;
  return {
    flexGrow: index === 0 ? fraction : 1 - fraction,
    flexBasis: 0,
    minWidth: 0,
    minHeight: 0,
  };
}

// A thin draggable divider. `ratio` and the split's length are baked in at
// drag start, so the divider tracks the cursor exactly and the store only
// receives the final ratio (no per-pixel store churn).
function SplitDivider({
  path,
  dir,
  ratio,
  setRatio,
}: {
  path: Path;
  dir: "h" | "v";
  ratio: number;
  setRatio: (path: Path, ratio: number) => void;
}) {
  const startRef = useRef({ start: 0, length: 1, ratio });

  useEffect(() => {
    startRef.current.ratio = ratio;
  }, [ratio]);

  const onMouseDown = useCallback(
    (e: ReactMouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      // The divider spans the whole cross axis; use the pane's main axis for
      // the drag distance.
      const element = (e.currentTarget.parentElement as HTMLElement | null)?.parentElement;
      const length = element ? element.getBoundingClientRect()[dir === "h" ? "width" : "height"] : 1;
      startRef.current = {
        start: dir === "h" ? e.clientX : e.clientY,
        length: Math.max(length, 1),
        ratio,
      };

      const onMove = (ev: MouseEvent) => {
        const delta =
          (dir === "h" ? ev.clientX : ev.clientY) - startRef.current.start;
        const next = startRef.current.ratio + delta / startRef.current.length;
        setRatio(path, Math.min(1, Math.max(0, next)));
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [dir, path, ratio, setRatio],
  );

  return (
    <div
      className={`pane-divider dir-${dir}`}
      onMouseDown={onMouseDown}
    />
  );
}
