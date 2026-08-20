# Editor UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the OPPA Code Editor Workbench tab bar, breadcrumbs, action toolbar, and styling to match OPPA's dark minimalist aesthetic and eliminate clunky colors/borders.

**Architecture:** Refactor `src/components/editor/` components (`EditorTabBar.tsx`, `EditorBreadcrumbs.tsx`, `EditorViewport.tsx`, `CodeEditor.tsx`, `EditorViewport.css`) to use modern pill tabs, Lucide icons, unified theme tokens, and refined micro-interactions.

**Tech Stack:** React 19, TypeScript, Lucide React icons, Zustand, Vitest.

## Global Constraints

- **Scope Isolation**: Only files in `src/components/editor/` and `docs/superpowers/` may be modified.
- **Git Branch**: Work on `feat/editor-ui-redesign`.
- **Aesthetic**: OPPA dark minimalist theme (`--workspace-bg`, `--card`, `--sidebar`, `--border`), Geist/Geist Mono typography, no harsh top borders or raw unicode emojis.
- **Tests**: All Vitest unit tests in `src/components/editor/` must pass cleanly.

---

### Task 1: Redesign `EditorTabBar.tsx` and File Badges

**Files:**
- Modify: `src/components/editor/EditorTabBar.tsx`
- Test: `src/components/editor/EditorTabBar.test.tsx`

- [ ] **Step 1: Update unit tests in `EditorTabBar.test.tsx`**

Ensure tests assert on the rendered tabs, active status, close button, language icon/badge indicators, and new file trigger.

- [ ] **Step 2: Run test to verify status**

Run: `pnpm vitest run src/components/editor/EditorTabBar.test.tsx`

- [ ] **Step 3: Implement redesigned `EditorTabBar.tsx`**

Replace primitive `PL`/`TS` block badges with sleek file type icons or elegant minimal badges, rounded tab cards (`border-radius: 6px`), polished dirty indicator (`●`), subtle close button, and OPPA-styled `+` new tab button.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/editor/EditorTabBar.test.tsx`

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/EditorTabBar.tsx src/components/editor/EditorTabBar.test.tsx
git commit -m "feat(editor): redesign EditorTabBar with sleek tabs and file badges"
```

---

### Task 2: Redesign `EditorBreadcrumbs.tsx` and Action Toolbar

**Files:**
- Modify: `src/components/editor/EditorBreadcrumbs.tsx`
- Test: `src/components/editor/EditorBreadcrumbs.test.tsx`

- [ ] **Step 1: Update unit tests in `EditorBreadcrumbs.test.tsx`**

Update tests to verify breadcrumbs path rendering, markdown mode switching (`Code`, `Preview`, `Split`), diff toggle, format action, and save action.

- [ ] **Step 2: Run test to verify status**

Run: `pnpm vitest run src/components/editor/EditorBreadcrumbs.test.tsx`

- [ ] **Step 3: Implement redesigned `EditorBreadcrumbs.tsx`**

Use Lucide icons (`ChevronRight`, `Code`, `Eye`, `Columns2`, `GitCompare`, `Sparkles`, `Save`, `Check`) for sleek action buttons and breadcrumbs trail.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/editor/EditorBreadcrumbs.test.tsx`

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/EditorBreadcrumbs.tsx src/components/editor/EditorBreadcrumbs.test.tsx
git commit -m "feat(editor): redesign EditorBreadcrumbs with Lucide icons and segmented toolbar"
```

---

### Task 3: Overhaul `EditorViewport.css` & Polish Viewport Canvas

**Files:**
- Modify: `src/components/editor/EditorViewport.css`
- Modify: `src/components/editor/EditorViewport.tsx`
- Test: `src/components/editor/EditorViewport.test.tsx`

- [ ] **Step 1: Run viewport tests**

Run: `pnpm vitest run src/components/editor/EditorViewport.test.tsx`

- [ ] **Step 2: Update `EditorViewport.css` with OPPA Minimalist Theme**

Restyle:
- `.editor-tab-bar` & `.editor-tab` (remove harsh cyan top line, use subtle elevated active pill, smooth hover, elegant close button).
- `.editor-breadcrumbs` (sleek height, refined trail, micro-action buttons with subtle borders).
- `.code-editor-container` & `.editor-gutter` (clean monospace gutter with matching border, smooth line numbers).
- `.editor-empty-state` (centered minimal empty card with styled workspace chips).

- [ ] **Step 3: Run all editor test files**

Run: `pnpm vitest run src/components/editor`

- [ ] **Step 4: Commit**

```bash
git add src/components/editor/EditorViewport.css src/components/editor/EditorViewport.tsx src/components/editor/EditorViewport.test.tsx
git commit -m "style(editor): modernize editor viewport stylesheet and layout"
```

---

### Task 4: Full Verification & Quality Check

**Files:**
- Verify: `src/components/editor/`

- [ ] **Step 1: Run full Vitest suite**

Run: `pnpm vitest run`

- [ ] **Step 2: Run TypeScript build**

Run: `pnpm build`

- [ ] **Step 3: Verify git status to confirm no external files were touched**

Run: `git status`

- [ ] **Step 4: Final commit & summary**
