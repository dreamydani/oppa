import { useCallback, useEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
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

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      // currentTarget is only valid during dispatch; the window-level
      // handlers below need the divider and pointer id captured.
      const divider = e.currentTarget;
      const pointerId = e.pointerId;
      // The divider spans the whole cross axis; use the pane's main axis for
      // the drag distance.
      const element = (divider.parentElement as HTMLElement | null)?.parentElement;
      const length = element ? element.getBoundingClientRect()[dir === "h" ? "width" : "height"] : 1;
      startRef.current = {
        start: dir === "h" ? e.clientX : e.clientY,
        length: Math.max(length, 1),
        ratio,
      };

      // Pointer capture keeps the drag alive even when the cursor leaves the
      // window, and guarantees a pointerup is delivered wherever the button
      // is released — no window-level listeners that could leak.
      divider.setPointerCapture(pointerId);

      const onMove = (ev: PointerEvent) => {
        const delta =
          (dir === "h" ? ev.clientX : ev.clientY) - startRef.current.start;
        const next = startRef.current.ratio + delta / startRef.current.length;
        setRatio(path, Math.min(1, Math.max(0, next)));
      };
      const endDrag = () => {
        // Release capture first. Browsers implicitly release capture when
        // the window blurs, so releasing again can throw — ignore. Real
        // browsers also fire a synthetic pointerup on release that re-enters
        // endDrag; it is idempotent (guarded release + removeEventListener).
        try {
          divider.releasePointerCapture(pointerId);
        } catch {
          // capture already lost — nothing to release
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", endDrag);
        window.removeEventListener("blur", endDrag);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", endDrag);
      // Releasing the button outside the window (or alt-tabbing away) may
      // never deliver a pointerup; the window blur is the last resort that
      // cleans the listeners up instead of leaking them.
      window.addEventListener("blur", endDrag);
    },
    [dir, path, ratio, setRatio],
  );

  return (
    <div
      className={`pane-divider dir-${dir}`}
      onPointerDown={onPointerDown}
    />
  );
}
