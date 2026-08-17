# Terminal Pane Header Bar Implementation Plan

Provide each terminal pane with a dedicated, functional top header bar with title/rename, more menu, expand/maximize toggle, split to right, split bottom, and close.

**Spec:** `docs/superpowers/specs/2026-08-18-terminal-pane-header-design.md`

## Tasks

### Task 1: Terminal Store Extensions for Pane Header (Session Renaming & Maximize/Restore State)
- Files: `src/store/terminalStore.ts`, `src/store/terminalStore.test.ts`
- Add `renameSession: (id: string, title: string) => void`
- Add `maximizedSessionId: string | null` (default `null`)
- Add `toggleMaximizePane: (id?: string) => void`
- Tests: Unit tests for `renameSession`, `toggleMaximizePane` (setting and toggling back to null).
- Commit: `feat(store): add renameSession and toggleMaximizePane state`

### Task 2: TerminalPaneHeader Component & Styling
- Files: `src/components/TerminalPaneHeader.tsx`, `src/components/TerminalPaneHeader.css`, `src/components/TerminalPaneHeader.test.tsx`
- Layout:
  - 28px height, `var(--card)` background, `1px solid var(--border)` bottom border.
  - Left: Title label, click/double-click to inline rename (`<input>` with Enter/Blur submit, Esc cancel).
  - Right:
    - More options button (`...`) with dropdown menu (Clear buffer, Rename, Split).
    - Expand/Maximize button (`Maximize2` / `Minimize2` based on `maximizedSessionId === id`).
    - Split Right button (`SplitSquareHorizontal` calling `splitPane("h", path)`).
    - Split Bottom button (`SplitSquareVertical` calling `splitPane("v", path)`).
    - Close button (`X` calling `closePane(path)`).
- Tests: Unit tests in `TerminalPaneHeader.test.tsx` for rendering, renaming, maximize toggle, split right/bottom, close, and dropdown menu.
- Commit: `feat: add TerminalPaneHeader component and styling`

### Task 3: Integration into TerminalPane, SessionLeaf, and PaneSplit
- Files: `src/components/PaneSplit.tsx`, `src/components/SessionLeaf.tsx`, `src/components/TerminalPane.tsx`, `src/App.css`, test files
- Pass `path: Path` through `PaneSplit` -> `SessionLeaf` -> `TerminalPane` -> `TerminalPaneHeader`.
- In `PaneSplit.tsx`, check `maximizedSessionId`: if non-null and belongs to a live session in the current tab layout, render only that maximized leaf.
- In `TerminalPane.tsx`, render `<TerminalPaneHeader id={id} path={path} onClear={() => term.clear()} />` above the terminal viewport.
- Run full suite: `pnpm vitest run`, `cargo test -p oppa --lib`, `pnpm build`.
- Commit: `feat: integrate TerminalPaneHeader and maximize pane support in PaneSplit`
