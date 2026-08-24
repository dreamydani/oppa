import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useTerminalStore } from "../store/terminalStore";
import type { Layout, Path } from "../store/terminalStore";
import {
  computeFlipTransform,
  playFlip,
  prefersReducedMotion,
  EASE_DOLLY,
  ZOOM_IN_MS,
  ZOOM_OUT_MS,
} from "../lib/pane-manager/maximizeZoom";
import type { FlipRect } from "../lib/pane-manager/maximizeZoom";
import { usePaneDragStore } from "../lib/pane-manager/dragState";
import { createRafCoalescer } from "../lib/layout/rafThrottle";
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
  const saveLayout = useTerminalStore((s) => s.saveLayout);
  const maximizedSessionId = useTerminalStore((s) => s.maximizedSessionId);

  const { isDragging, sourceId, targetId, zone } = usePaneDragStore();

  // Dolly-zoom bookkeeping: leaf elements by session id, the geometry
  // snapshot taken just before a maximize-state change lands, and cancels for
  // any zoom still in flight.
  const leafElsRef = useRef(new Map<string, HTMLElement>());
  const pendingRectsRef = useRef<Map<string, FlipRect> | null>(null);
  const prevMaximizedRef = useRef<string | null>(maximizedSessionId);
  const activeZoomCancelsRef = useRef<Array<() => void>>([]);

  // Snapshot BEFORE React mutates the DOM: the store listener fires during
  // setState, while the old layout is still on screen — the FLIP "First".
  useEffect(() => {
    return useTerminalStore.subscribe((state, prevState) => {
      if (state.maximizedSessionId === prevState.maximizedSessionId) return;
      const rects = new Map<string, FlipRect>();
      leafElsRef.current.forEach((el, id) => {
        const rect = el.getBoundingClientRect();
        rects.set(id, { left: rect.left, top: rect.top, width: rect.width, height: rect.height });
      });
      pendingRectsRef.current = rects;
    });
  }, []);

  useLayoutEffect(() => {
    const prevMaximized = prevMaximizedRef.current;
    prevMaximizedRef.current = maximizedSessionId;
    if (prevMaximized === maximizedSessionId) return;

    activeZoomCancelsRef.current.forEach((cancel) => cancel());
    activeZoomCancelsRef.current = [];

    const prevRects = pendingRectsRef.current;
    pendingRectsRef.current = null;
    if (prefersReducedMotion() || !prevRects) return;

    // Expanding leaf flies out from its slot; collapsing one settles back in.
    const moves: Array<{ id: string; durationMs: number }> = [];
    if (maximizedSessionId && prevRects.has(maximizedSessionId)) {
      moves.push({ id: maximizedSessionId, durationMs: ZOOM_OUT_MS });
    }
    if (prevMaximized && prevMaximized !== maximizedSessionId && prevRects.has(prevMaximized)) {
      moves.push({ id: prevMaximized, durationMs: ZOOM_IN_MS });
    }

    for (const move of moves) {
      const el = leafElsRef.current.get(move.id);
      const prev = prevRects.get(move.id);
      if (!el || !prev) continue;
      const next = el.getBoundingClientRect();
      const flip = computeFlipTransform(prev, next);
      // Zero-area guard covers happy-dom tests and never-laid-out leaves.
      if (!flip) continue;
      activeZoomCancelsRef.current.push(playFlip(el, flip, move.durationMs, EASE_DOLLY));
    }
  }, [maximizedSessionId]);

  useEffect(() => {
    return () => {
      activeZoomCancelsRef.current.forEach((cancel) => cancel());
      activeZoomCancelsRef.current = [];
    };
  }, []);

  const renderTree = (targetLayout: Layout, targetFocusedPath: Path, isTabActive: boolean) => {
    const isAnyMaximized = Boolean(
      isTabActive && maximizedSessionId && containsSession(targetLayout, maximizedSessionId),
    );

    const renderNode = (node: Layout, path: Path): React.ReactNode => {
      if (node.type === "leaf") {
        const isMaximized = isAnyMaximized && node.id === maximizedSessionId;
        const isHidden = isAnyMaximized && !isMaximized;
        const isDragSource = isDragging && node.id === sourceId;
        const isDropTarget = isDragging && node.id === targetId && zone !== null;
        return (
          <div
            key={path.join(".")}
            data-pane-id={node.id}
            ref={(el) => {
              if (el) leafElsRef.current.set(node.id, el);
              else leafElsRef.current.delete(node.id);
            }}
            className={`pane-leaf${isTabActive && path.join(".") === targetFocusedPath.join(".") ? " focused" : ""}${isMaximized ? " maximized" : ""}${isHidden ? " pane-hidden" : ""}${isDragSource ? " is-drag-source" : ""}`}
            onMouseDown={() => {
              if (isTabActive) focusPane(path);
            }}
          >
            <SessionLeaf id={node.id} path={path} />
            {isDropTarget && (
              <div
                className={`pane-drop-overlay zone-${zone}`}
                data-testid="drop-overlay"
              />
            )}
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
              saveLayout={saveLayout}
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

  const terminalTabs = tabs.filter((t) => !t.isWizard);

  if (terminalTabs.length > 1) {
    return (
      <>
        {terminalTabs.map((tab) => {
          const isTabActive = tab.id === (activeTabId || terminalTabs[0].id);
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

  if (terminalTabs.length === 1) {
    const isTabActive = terminalTabs[0].id === (activeTabId || terminalTabs[0].id);
    const tabLayout = isTabActive ? layout : terminalTabs[0].layout;
    const tabFocusedPath = isTabActive ? focusedPath : terminalTabs[0].focusedPath;
    return renderTree(tabLayout, tabFocusedPath, isTabActive);
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

// A thin draggable divider. setRatio fires per pixel for smooth visual
// tracking; saveLayout fires once on drag end (no per-pixel disk I/O).
function SplitDivider({
  path,
  dir,
  setRatio,
  saveLayout,
}: {
  path: Path;
  dir: "h" | "v";
  setRatio: (path: Path, ratio: number) => void;
  saveLayout: () => Promise<void>;
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

      // Ratio updates collapse to one store write per frame (latest wins);
      // endDrag flushes the final value synchronously before persisting.
      const ratioCoalescer = createRafCoalescer<number>((next) => setRatio(path, next));

      const onMove = (ev: PointerEvent) => {
        if (totalLength > 0) {
          const currentPos = dir === "h" ? ev.clientX : ev.clientY;
          const next = Math.min(0.95, Math.max(0.05, (currentPos - origin) / totalLength));
          ratioCoalescer.push(next);
        }
      };

      const endDrag = () => {
        try {
          divider.releasePointerCapture(pointerId);
        } catch {
          // capture already lost — nothing to release
        }
        ratioCoalescer.flushNow();
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", endDrag);
        window.removeEventListener("blur", endDrag);
        void saveLayout().catch(() => {});
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", endDrag);
      window.addEventListener("blur", endDrag);
    },
    [dir, path, setRatio, saveLayout],
  );

  return (
    <div
      className={`pane-divider dir-${dir}`}
      onPointerDown={onPointerDown}
    />
  );
}
