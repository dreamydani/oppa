import { useCallback } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useTerminalStore } from "../store/terminalStore";
import type { Layout, Path } from "../store/terminalStore";
import { SessionLeaf } from "./SessionLeaf";

// True when `id` is present as a leaf anywhere in `tree`.
function containsSession(tree: Layout, id: string): boolean {
  if (tree.type === "leaf") return tree.id === id;
  return containsSession(tree.a, id) || containsSession(tree.b, id);
}

// Recursive renderer for the layout tree: leaves become session-backed
// terminal panes, splits become flex rows/columns with a draggable divider.
export function PaneSplit() {
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const layout = useTerminalStore((s) => s.layout);
  const focusedPath = useTerminalStore((s) => s.focusedPath);
  const focusPane = useTerminalStore((s) => s.focusPane);
  const setRatio = useTerminalStore((s) => s.setRatio);
  const maximizedSessionId = useTerminalStore((s) => s.maximizedSessionId);

  const renderTree = (targetLayout: Layout, targetFocusedPath: Path, isTabActive: boolean) => {
    const isAnyMaximized = Boolean(
      isTabActive && maximizedSessionId && containsSession(targetLayout, maximizedSessionId),
    );

    const renderNode = (node: Layout, path: Path): React.ReactNode => {
      if (node.type === "leaf") {
        const isMaximized = isAnyMaximized && node.id === maximizedSessionId;
        const isHidden = isAnyMaximized && !isMaximized;
        return (
          <div
            key={path.join(".")}
            className={`pane-leaf${isTabActive && path.join(".") === targetFocusedPath.join(".") ? " focused" : ""}${isMaximized ? " maximized" : ""}${isHidden ? " pane-hidden" : ""}`}
            onMouseDown={() => {
              if (isTabActive) focusPane(path);
            }}
          >
            <SessionLeaf id={node.id} path={path} />
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
          {!isAnyMaximized && (
            <SplitDivider
              path={path}
              dir={node.dir}
              setRatio={setRatio}
            />
          )}
          <div className="pane-child" style={childStyle(node, 1)}>
            {renderNode(node.b, [...path, 1])}
          </div>
        </div>
      );
    };

    return (
      <div
        className={`pane-root${isAnyMaximized ? " has-maximized-pane" : ""}`}
        style={{
          display: isTabActive ? "flex" : "none",
          width: "100%",
          height: "100%",
        }}
      >
        {renderNode(targetLayout, [])}
      </div>
    );
  };

  if (tabs.length > 1) {
    return (
      <>
        {tabs.map((tab) => {
          const isTabActive = tab.id === (activeTabId || tabs[0].id);
          const tabLayout = isTabActive ? layout : tab.layout;
          const tabFocusedPath = isTabActive ? focusedPath : tab.focusedPath;
          return (
            <div
              key={tab.id}
              className="tab-split-wrapper"
              style={{
                display: isTabActive ? "flex" : "none",
                width: "100%",
                height: "100%",
                flex: 1,
                minHeight: 0,
                minWidth: 0,
              }}
            >
              {renderTree(tabLayout, tabFocusedPath, isTabActive)}
            </div>
          );
        })}
      </>
    );
  }

  return renderTree(layout, focusedPath, true);
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
  setRatio,
}: {
  path: Path;
  dir: "h" | "v";
  setRatio: (path: Path, ratio: number) => void;
}) {
  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const divider = e.currentTarget;
      const pointerId = e.pointerId;
      const splitEl = divider.parentElement;
      const rect = splitEl?.getBoundingClientRect();
      const totalLength = rect ? (dir === "h" ? rect.width : rect.height) : 0;
      const origin = rect ? (dir === "h" ? rect.left : rect.top) : 0;

      divider.setPointerCapture(pointerId);

      const onMove = (ev: PointerEvent) => {
        if (totalLength > 0) {
          const currentPos = dir === "h" ? ev.clientX : ev.clientY;
          const next = Math.min(0.95, Math.max(0.05, (currentPos - origin) / totalLength));
          setRatio(path, next);
        }
      };

      const endDrag = () => {
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
      window.addEventListener("blur", endDrag);
    },
    [dir, path, setRatio],
  );

  return (
    <div
      className={`pane-divider dir-${dir}`}
      onPointerDown={onPointerDown}
    />
  );
}
