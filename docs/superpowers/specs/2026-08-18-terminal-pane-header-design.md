# Terminal Pane Header Bar Design Specification

## Overview

Provide each terminal pane in OPPA's split workbench with a dedicated, fully-functional top header bar matching Orca's aesthetics (`D:\orca\orca`). The header gives direct visual title context, inline renaming, pane maximization/restoration, targeted directional splitting (split right, split bottom), and single-pane closing.

## UI / Layout & Interaction

### Header Dimensions & Styling
- **Height**: `28px`
- **Background**: `var(--card)` (`#171717`) or subtle surface tint (`rgba(255, 255, 255, 0.03)`)
- **Border**: `1px solid var(--border)` on the bottom edge
- **Typography**: `--font-sans`, `12px`, semibold, color `var(--foreground)` with muted CWD/status indicators.

### Controls & Affordances (Left to Right)
1. **Title Area (Left)**:
   - Displays custom session title, or formatted CWD basename (e.g. `OC | Greeting` or `oppa`).
   - Double-click or click to enter inline rename mode (rendered as `<input className="pane-header-rename-input" />`).
   - Submits rename on `Enter` / `Blur`; cancels on `Escape`.
2. **Action Buttons (Right)**:
   - **More Options (`...` / `MoreHorizontal`)**:
     - Opens a sleek dropdown menu with actions:
       - *Clear Scrollback* (clears terminal buffer & scrollback cache)
       - *Rename Pane*
       - *Split Right*
       - *Split Down*
   - **Expand / Maximize (`Maximize2` / `Minimize2`)**:
     - Toggles maximization for this pane.
     - When maximized, the split grid is bypassed to show only this terminal leaf at 100% dimensions; button flips to `Minimize2` (restore). Clicking again restores the full split grid.
   - **Split to Right (`SplitSquareHorizontal` / `SquareSplitHorizontal`)**:
     - Calls `splitPane("h", path)` on the specific pane's path, creating a side-by-side sibling to the right.
   - **Split Bottom (`SplitSquareVertical` / `SquareSplitVertical`)**:
     - Calls `splitPane("v", path)` on the specific pane's path, creating a stacked child below.
   - **Close Terminal (`X`)**:
     - Calls `closePane(path)` on the specific pane, closing only this pane.

## Store State & Architecture

1. **`renameSession: (id: string, title: string) => void`**:
   - Updates `sessions[id].title` in `useTerminalStore`.
2. **`maximizedSessionId: string | null`**:
   - `toggleMaximizePane: (id: string) => void`
   - In `PaneSplit.tsx`, if `maximizedSessionId` matches a live session in the current tab, render only `<div className="pane-leaf maximized"><SessionLeaf id={maximizedSessionId} path={...} /></div>`.
3. **`SessionLeaf` and `TerminalPane` Integration**:
   - Pass `path: Path` down to `SessionLeaf` -> `TerminalPane` -> `TerminalPaneHeader`.
   - `TerminalPane` renders `<TerminalPaneHeader id={id} path={path} />` above `<div className="terminal-pane" />`.

## Testing Strategy
- Vitest unit & integration tests:
  - `src/components/TerminalPaneHeader.test.tsx`:
    - Renders title and all action buttons.
    - Inline renaming triggers `renameSession`.
    - Maximize button toggles store's `maximizedSessionId`.
    - Split Right / Split Bottom triggers `splitPane` with exact `path`.
    - Close button triggers `closePane` with exact `path`.
    - More options menu opens and triggers clear scrollback.
  - `src/components/PaneSplit.test.tsx`:
    - Verifies rendering maximized pane when `maximizedSessionId` is set.
