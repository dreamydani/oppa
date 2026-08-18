# Draggable Pane Swapping & Reordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement animated drag-and-drop terminal pane swapping/reordering via the header bar with 4-zone drop preview overlays, keyboard shortcuts (`Alt+Shift+Arrows`), and 100% live PTY preservation.

**Architecture:** Pure immutable binary-tree transformations in `src/lib/pane-manager/layout.ts` and `src/store/terminalStore.ts`. React DOM keep-alive ensures active `xterm.js` terminals and Tokio daemon PTYs are never unmounted or restarted during swaps. Dragging is managed via pointer events with pointer capture on the header bar's empty region with a 5px threshold.

**Tech Stack:** React 19, TypeScript, Zustand, Lucide Icons, Vitest, Happy-DOM, Vanilla CSS.

## Global Constraints

- **Live PTY Preservation**: Terminal instances, daemon PTY sessions, and scrollback histories must never restart or be disposed during pane moves.
- **Header Ergonomics**: Empty space in `.pane-header-drag-zone` is draggable; title has `max-width: 180px; text-overflow: ellipsis; white-space: nowrap; overflow: hidden;`.
- **5px Drag Threshold**: Moving mouse < 5px performs focus/click; >= 5px activates drag and displays drop overlay.
- **State vs Transport Split**: Components interact only via Zustand store; no Tauri invoke calls from components.
- **Testing**: TDD with unit and component tests passing via `pnpm vitest run`.

---

### Task 1: Core Layout Tree Reorganization Helpers

**Files:**
- Modify: `src/lib/pane-manager/layout.ts`
- Test: `src/lib/pane-manager/layout.test.ts`

**Interfaces:**
- Produces:
  - `swapLeaves(tree: Layout, idA: string, idB: string): Layout`
  - `moveLeaf(tree: Layout, sourceId: string, targetId: string, zone: 'top' | 'bottom' | 'left' | 'right'): Layout`

- [ ] **Step 1: Write failing unit tests for `swapLeaves` and `moveLeaf`**

```typescript
// in src/lib/pane-manager/layout.test.ts
describe("swapLeaves", () => {
  it("swaps two leaf ids in a simple split", () => {
    const tree: Layout = {
      type: "split",
      dir: "h",
      ratio: 0.5,
      a: { type: "leaf", id: "s1" },
      b: { type: "leaf", id: "s2" },
    };
    const next = swapLeaves(tree, "s1", "s2");
    expect(next).toEqual({
      type: "split",
      dir: "h",
      ratio: 0.5,
      a: { type: "leaf", id: "s2" },
      b: { type: "leaf", id: "s1" },
    });
  });
});

describe("moveLeaf", () => {
  it("moves source leaf next to target leaf in vertical bottom zone", () => {
    const tree: Layout = {
      type: "split",
      dir: "h",
      ratio: 0.5,
      a: { type: "leaf", id: "s1" },
      b: {
        type: "split",
        dir: "v",
        ratio: 0.5,
        a: { type: "leaf", id: "s2" },
        b: { type: "leaf", id: "s3" },
      },
    };
    // Move s1 to below s2
    const next = moveLeaf(tree, "s1", "s2", "bottom");
    expect(containsLeaf(next, "s1")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm vitest run src/lib/pane-manager/layout.test.ts`
Expected: FAIL (`swapLeaves` / `moveLeaf` not exported)

- [ ] **Step 3: Implement `swapLeaves` and `moveLeaf` in `layout.ts`**

Implement recursive leaf search, replacement, detachment (promoting sibling when removing a leaf), and wrapping target in a new split with direction `h` (for `'left'` / `'right'`) or `v` (for `'top'` / `'bottom'`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/pane-manager/layout.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/pane-manager/layout.ts src/lib/pane-manager/layout.test.ts
git commit -m "feat: add swapLeaves and moveLeaf tree transformation functions"
```

---

### Task 2: Store Actions for Pane Swapping & Directional Keyboard Navigation

**Files:**
- Modify: `src/store/terminalStore.ts`
- Test: `src/store/terminalStore.test.ts`

**Interfaces:**
- Consumes: `swapLeaves`, `moveLeaf` from `src/lib/pane-manager/layout.ts`
- Produces in `TerminalStore`:
  - `swapPanes: (sourceId: string, targetId: string) => void`
  - `movePane: (sourceId: string, targetId: string, zone: 'top' | 'bottom' | 'left' | 'right') => void`
  - `swapFocusedPane: (dir: 'left' | 'right' | 'up' | 'down') => void`

- [ ] **Step 1: Write failing tests for `swapPanes`, `movePane`, and `swapFocusedPane`**

```typescript
// in src/store/terminalStore.test.ts
describe("swapPanes and movePane store actions", () => {
  it("swapPanes swaps two session leaf locations in active tab", () => {
    useTerminalStore.setState({
      layout: {
        type: "split",
        dir: "h",
        ratio: 0.5,
        a: { type: "leaf", id: "s1" },
        b: { type: "leaf", id: "s2" },
      },
    });
    useTerminalStore.getState().swapPanes("s1", "s2");
    const layout = useTerminalStore.getState().layout;
    expect(layout).toEqual({
      type: "split",
      dir: "h",
      ratio: 0.5,
      a: { type: "leaf", id: "s2" },
      b: { type: "leaf", id: "s1" },
    });
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm vitest run src/store/terminalStore.test.ts`
Expected: FAIL (`swapPanes` not a function)

- [ ] **Step 3: Implement store actions in `terminalStore.ts`**

Add `swapPanes`, `movePane`, and `swapFocusedPane` to store state, updating active tab layout, focused path, and triggering `saveLayout()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/store/terminalStore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/terminalStore.ts src/store/terminalStore.test.ts
git commit -m "feat: add swapPanes, movePane, and swapFocusedPane actions to store"
```

---

### Task 3: Draggable Header Bar Region, Drop Overlay & Animations

**Files:**
- Modify: `src/components/TerminalPaneHeader.tsx`
- Modify: `src/components/TerminalPaneHeader.css`
- Modify: `src/components/PaneSplit.tsx`
- Modify: `src/App.css`
- Test: `src/components/TerminalPaneHeader.test.tsx`
- Test: `src/components/PaneSplit.test.tsx`

**Interfaces:**
- Consumes: `movePane` from `terminalStore`
- Produces: Interactive drag header and 4-zone drop preview overlay rendered inside `PaneSplit`

- [ ] **Step 1: Write failing component tests for drag reordering**

```typescript
// in src/components/TerminalPaneHeader.test.tsx and PaneSplit.test.tsx
it("renders draggable header region with max title constraint", () => {
  const { container } = render(<TerminalPaneHeader id="s1" />);
  expect(container.querySelector(".pane-header-drag-zone")).not.toBeNull();
  expect(container.querySelector(".terminal-pane-title")).not.toBeNull();
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm vitest run src/components/TerminalPaneHeader.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement header drag zone, pointer capture, and 4-zone drop overlay**

1. In `TerminalPaneHeader.tsx`:
   - Add `.pane-header-drag-zone` in the empty middle space of the header.
   - Constrain `.terminal-pane-title` with `max-width: 180px`.
   - On pointerdown on the drag zone, set pointer capture and track 5px threshold.
   - Broadcast active drag state with source session id and pointer coordinates.
2. In `PaneSplit.tsx` / `App.css`:
   - Compute drop target pane and resolve 4-zone (`'top' | 'bottom' | 'left' | 'right'`).
   - Render `.pane-drop-overlay` positioned over the targeted quadrant with indigo glowing border and smooth transition.
   - Add `.is-drag-source` to source pane leaf with dimmed opacity (`opacity: 0.45`).
   - On pointerup, call `movePane(sourceId, targetId, zone)`.

- [ ] **Step 4: Run component tests to verify pass**

Run: `pnpm vitest run src/components/TerminalPaneHeader.test.tsx src/components/PaneSplit.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/TerminalPaneHeader.tsx src/components/TerminalPaneHeader.css src/components/PaneSplit.tsx src/App.css src/components/TerminalPaneHeader.test.tsx src/components/PaneSplit.test.tsx
git commit -m "feat: implement header drag region, 4-zone drop overlay, and smooth drag animation"
```

---

### Task 4: Keyboard Shortcuts & End-to-End Verification

**Files:**
- Modify: `src/App.tsx`
- Test: `src/App.test.tsx`

**Interfaces:**
- Consumes: `swapFocusedPane` from `terminalStore`

- [ ] **Step 1: Write tests for `Alt+Shift+Arrow` keyboard shortcuts**

```typescript
// in src/App.test.tsx
it("swaps focused pane on Alt+Shift+Arrow shortcut", () => {
  // Test Alt+Shift+ArrowRight triggers swapFocusedPane("right")
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm vitest run src/App.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement `Alt+Shift+Arrows` shortcuts in `App.tsx`**

Attach keydown listener to handle `Alt+Shift+ArrowUp/Down/Left/Right` by calling `swapFocusedPane(dir)`.

- [ ] **Step 4: Run all test suites and production build**

Run: `pnpm vitest run`
Run: `pnpm build`
Run: `cargo test -p oppa --lib` (in `src-tauri`)

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/App.test.tsx
git commit -m "feat: add Alt+Shift+Arrows keyboard shortcuts for directional pane swapping"
```
