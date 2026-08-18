# Draggable Pane Swapping & Reordering Design Specification

## Overview

Enable intuitive, animated drag-and-drop swapping and reordering of terminal panes in OPPA's split workbench, alongside directional keyboard shortcuts (`Alt+Shift+Arrows`). The feature preserves running PTY shells and xterm buffers across all reorder operations with zero process restarts or buffer flickers.

---

## User Interaction & Affordances

### 1. Header Bar Drag Region
- **Title Constraint**: Pane title has a constrained maximum width (`max-width: 180px; text-overflow: ellipsis; white-space: nowrap; overflow: hidden;`).
- **Draggable Header Region (`.pane-header-drag-zone`)**: The empty gap between the title and action buttons occupies `flex: 1`, providing a generous drag surface with `cursor: grab` (`cursor: grabbing` while dragging).
- **Click vs Drag Discrimination**:
  - Dragging initiates only after cursor moves past a **5px threshold** (`Math.hypot(dx, dy) >= 5`).
  - Single clicks on the header focus the pane (`focusPane`).
  - Double clicking the title initiates inline renaming.
  - Action buttons (`Split`, `Maximize`, `Close`, `Ports`, `Menu`) call `e.stopPropagation()` so button clicks never trigger drag.

### 2. 4-Zone Drop Overlay & Target Detection
- When dragging a pane over another pane in the grid:
  - Cursor position within target pane bounding rect resolves into one of 4 quadrants:
    - **Top Half (`zone: 'top'`)**: Split / dock above target.
    - **Bottom Half (`zone: 'bottom'`)**: Split / dock below target.
    - **Left Half (`zone: 'left'`)**: Split / dock to the left of target.
    - **Right Half (`zone: 'right'`)**: Split / dock to the right of target.
- **Preview Overlay (`.pane-drop-overlay`)**:
  - Styled with OPPA's dark-tech indigo palette:
    `background: rgba(99, 102, 241, 0.12); border: 1.5px solid rgba(129, 140, 248, 0.6); box-shadow: 0 0 20px rgba(99, 102, 241, 0.2); border-radius: 6px;`
  - Positioned over the active target quadrant with smooth CSS transitions (`transition: all 120ms cubic-bezier(0.16, 1, 0.3, 1)`).
- **Source Pane**: Dimmed to `opacity: 0.45` during active drag.

### 3. Keyboard Shortcuts for Pane Swapping
- `Alt+Shift+Left` / `Alt+Shift+Right`: Swap focused pane with the sibling/adjacent pane horizontally.
- `Alt+Shift+Up` / `Alt+Shift+Down`: Swap focused pane with the sibling/adjacent pane vertically.

---

## Layout Tree Architecture & PTY Preservation

### 1. Pure Layout Tree Reorganization
- Moving or swapping panes performs immutable tree transformations on the active tab's `Layout` tree in `src/lib/pane-manager/layout.ts` and `src/store/terminalStore.ts`:
  - `swapPanes: (sourceId: string, targetId: string) => void`: Swaps the leaf positions of two sessions in the binary tree.
  - `movePane: (sourceId: string, targetId: string, zone: 'top' | 'bottom' | 'left' | 'right') => void`:
    1. Removes `sourceId` leaf from its current position in the tree (promoting its former sibling).
    2. Inserts a new split node at `targetId`'s position containing `[source, target]` with direction `h` (for left/right) or `v` (for top/bottom).
- **Zero Process Restart Guarantee**:
  - `sessions` in `terminalStore` and daemon PTY processes remain completely untouched and running.
  - Existing DOM keep-alive and React reconciliation remap the active terminal panes to their new grid slots without unmounting or re-initializing `xterm.js`.
  - `ResizeObserver` automatically executes `fit.fit()` on layout settle.

---

## Testing Strategy

1. **Unit & Logic Tests (`layout.test.ts`, `terminalStore.test.ts`)**:
   - `swapPanes` correctly exchanges leaf IDs in simple splits and deeply nested split trees.
   - `movePane` detaches source leaf, promotes sibling, and creates appropriate horizontal/vertical split at target.
   - Preserves focused path and active tab synchronization.
2. **Component & Drag Tests (`TerminalPaneHeader.test.tsx`, `PaneSplit.test.tsx`)**:
   - Drag handle pointerdown / pointermove / pointerup triggers drag threshold and displays drop overlay.
   - Releasing over drop zone calls store's `movePane`.
   - Keyboard shortcuts (`Alt+Shift+Arrows`) trigger directional swapping.
   - Action buttons and rename input do not trigger drag.
