# Workspace Tree & Multi-Branch Grid Layout — Implementation Plan

Spec: `docs/superpowers/specs/2026-08-27-workspace-tree-and-grid-design.md`
Branch: `feat/workspace-tree-and-grid`
Ledger: `.superpowers/sdd/2026-08-27-workspace-tree-and-grid/progress.md`

Execution: subagent-driven — fresh implementer per task, brief inlined in the dispatch, review after each task, ledger row per commit. Implementers never dispatch subagents.

---

## M1 — Left Sidebar: Hierarchical Project & Branch Tree

### T1 — Project Tree Computed Model & Store Selectors `M1-T1`
Files: `src/store/slices/worktreeRegistrySlice.ts`, `src/store/slices/layoutQueries.ts`, `src/store/terminalStore.test.ts`.
- Add `ProjectTreeData`, `ProjectNode`, and `BranchNode` interfaces:
  - `ProjectNode`: `{ repoId, repoPath, repoName, branches: BranchNode[], totalLiveSessions: number }`
  - `BranchNode`: `{ worktreeId, name, branch, path, status, sessionIds: string[], prUrl, missingOnDisk, retired }`
- Implement pure selector `selectProjectTree(state: TerminalState): ProjectNode[]` joining repos, registered worktrees, and active sessions.
- TDD Acceptance: `pnpm vitest run src/store/terminalStore.test.ts` passes with test cases verifying repo grouping, branch mapping, and session count computation.

### T2 — Project Tree View Component `M1-T2`
Files: new `src/components/worktree/ProjectTreeView.tsx`, `src/components/worktree/ProjectTreeView.css`, `src/components/worktree/ProjectTreeView.test.tsx`, `src/components/LeftSidebar.tsx`.
- Implement `ProjectTreeView` rendering:
  - Project header: `<project name>` (repo name), path tooltip, active terminals badge, `+ Worktree` / `🚀 Spawn Fleet` buttons, and `⊞ Tile Grid` button.
  - Nested branch list (`- branch 1`, `- branch 2`, `- branch 3`) with branch icon (`🌿`), live status dot (🟢 ⚡ 💤), terminal count chip, and quick actions menu.
  - Expandable nested terminal sub-rows if a branch has multiple split sessions.
  - Clicking a branch calls `focusBranchPane(worktreeId)` / `createTab` if not open.
- Embed `ProjectTreeView` in `LeftSidebar.tsx` under the Worktree view.
- TDD Acceptance: `pnpm vitest run src/components/worktree/ProjectTreeView.test.tsx` passes with full render, click, and action tests.

---

## M2 — Main Viewport: Multi-Branch Grid Layout & Solo/Zoom Mode

### T3 — Multi-Branch Grid Layout Builder & Store Actions `M2-T3`
Files: `src/lib/pane-manager/gridLayout.ts`, `src/store/slices/paneLayoutSlice.ts`, `src/store/slices/layoutQueries.ts`, `src/store/terminalStore.test.ts`, `src/lib/pane-manager/gridLayout.test.ts`.
- In `gridLayout.ts`, add `buildMultiBranchGridLayout(leafIds: string[]): Layout`:
  - 1 leaf: `leaf(id0)`
  - 2 leaves: `split("v", leaf(id0), leaf(id1))`
  - 3 leaves: `split("h", split("v", leaf(id0), leaf(id1)), leaf(id2))` (matches the exact top 2 + bottom 1 layout from user screenshot)
  - 4 leaves: `split("h", split("v", leaf(id0), leaf(id1)), split("v", leaf(id2), leaf(id3)))`
- In `paneLayoutSlice.ts`, add `tileProjectBranches(repoId: string)` action:
  - Collects or creates active sessions for the project's worktree branches.
  - Sets the balanced multi-branch layout on the active tab without restarting shell processes.
- Add `focusBranchPane(worktreeId: string)` action to focus existing branch leaf or open/tile if not active.
- TDD Acceptance: `pnpm vitest run src/lib/pane-manager/gridLayout.test.ts src/store/terminalStore.test.ts` passes.

### T4 — Pane Header Branch Badge & Solo/Zoom Mode `M2-T4`
Files: `src/components/TerminalPaneHeader.tsx`, `src/components/TerminalPaneHeader.css`, `src/components/TerminalPaneHeader.test.tsx`.
- In `TerminalPaneHeader.tsx`:
  - Render a prominent **Branch Chip** (`🌿 <branch-name>`) when the session is bound to a worktree.
  - Add **Solo / Zoom (`⛶`)** button:
    - Calls `toggleMaximizePane(sessionId)`.
    - Shows an active "Restoring Grid" highlight when maximized so the user can easily toggle between single-branch focus and the full multi-branch overview grid.
- TDD Acceptance: `pnpm vitest run src/components/TerminalPaneHeader.test.tsx` passes.

---

## M3 — Verification & Final Review

### T5 — Full Test Suite & Build Verification `M3-T5`
- Run `pnpm vitest run` across all 68+ test files.
- Run `pnpm build` (`tsc && vite build`).
- Run `cargo test -p oppa --lib`.
