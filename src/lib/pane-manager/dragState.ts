import { create } from "zustand";
import type { DropZone } from "./layout";
import { onNextFrame } from "../layout/frameScheduler";

export interface PaneDragState {
  isDragging: boolean;
  sourceId: string | null;
  targetId: string | null;
  zone: DropZone | null;
  startDrag: (sourceId: string) => void;
  updateDropTarget: (targetId: string | null, zone: DropZone | null) => void;
  endDrag: () => void;
}

export const usePaneDragStore = create<PaneDragState>((set) => ({
  isDragging: false,
  sourceId: null,
  targetId: null,
  zone: null,
  startDrag: (sourceId) =>
    set({ isDragging: true, sourceId, targetId: null, zone: null }),
  updateDropTarget: (targetId, zone) =>
    set({ targetId, zone }),
  endDrag: () =>
    set({ isDragging: false, sourceId: null, targetId: null, zone: null }),
}));

export function calculateDropZone(
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): DropZone {
  const width = rect.width || 1;
  const height = rect.height || 1;
  const relX = Math.max(0, Math.min(1, (clientX - rect.left) / width));
  const relY = Math.max(0, Math.min(1, (clientY - rect.top) / height));

  const distTop = relY;
  const distBottom = 1 - relY;
  const distLeft = relX;
  const distRight = 1 - relX;

  const minDist = Math.min(distTop, distBottom, distLeft, distRight);
  if (minDist === distBottom) return "bottom";
  if (minDist === distLeft) return "left";
  if (minDist === distRight) return "right";
  return "top";
}

export function findDropTargetUnderPointer(
  clientX: number,
  clientY: number,
  sourceId: string,
  container?: HTMLElement | null,
): { targetId: string; zone: DropZone } | null {
  const root = container || (typeof document !== "undefined" ? document : null);
  if (!root) return null;

  const leaves = root.querySelectorAll<HTMLElement>(".pane-leaf[data-pane-id]");
  for (const leaf of leaves) {
    const paneId = leaf.getAttribute("data-pane-id");
    if (!paneId || paneId === sourceId) continue;
    const rect = leaf.getBoundingClientRect();
    if (
      rect.width > 0 &&
      rect.height > 0 &&
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    ) {
      const zone = calculateDropZone(rect, clientX, clientY);
      return { targetId: paneId, zone };
    }
  }

  if (typeof document !== "undefined" && typeof document.elementFromPoint === "function") {
    const el = document.elementFromPoint(clientX, clientY);
    const leaf = el?.closest<HTMLElement>(".pane-leaf[data-pane-id]");
    if (leaf) {
      const paneId = leaf.getAttribute("data-pane-id");
      if (paneId && paneId !== sourceId) {
        const rect = leaf.getBoundingClientRect();
        const zone = calculateDropZone(rect, clientX, clientY);
        return { targetId: paneId, zone };
      }
    }
  }

  return null;
}

export interface DropTarget {
  targetId: string;
  zone: DropZone;
}

export interface DropTargetCoalescer {
  push(clientX: number, clientY: number): void;
  /** Run detection immediately with the latest pointer position; the queued frame becomes a no-op. */
  flushNow(): void;
}

// Collapses pointermove flood into one drop-target detection per animation
// frame (latest coordinates win), and skips store writes when the target is
// unchanged — pane drags query every leaf's rect otherwise.
export function createDropTargetCoalescer(
  detect: (clientX: number, clientY: number) => DropTarget | null,
  onTarget: (target: DropTarget | null) => void,
): DropTargetCoalescer {
  let pendingX = 0;
  let pendingY = 0;
  let hasPending = false;
  let scheduled = false;
  let lastTargetKey: string | null = null;

  const run = () => {
    scheduled = false;
    if (!hasPending) return;
    const x = pendingX;
    const y = pendingY;
    hasPending = false;
    const target = detect(x, y);
    const key = target ? `${target.targetId}:${target.zone}` : "";
    if (key !== lastTargetKey) {
      lastTargetKey = key;
      onTarget(target);
    }
  };

  return {
    push(clientX, clientY) {
      pendingX = clientX;
      pendingY = clientY;
      hasPending = true;
      if (!scheduled) {
        scheduled = true;
        onNextFrame(run);
      }
    },
    flushNow() {
      scheduled = false;
      if (!hasPending) return;
      const x = pendingX;
      const y = pendingY;
      hasPending = false;
      const target = detect(x, y);
      const key = target ? `${target.targetId}:${target.zone}` : "";
      if (key !== lastTargetKey) {
        lastTargetKey = key;
        onTarget(target);
      }
    },
  };
}
