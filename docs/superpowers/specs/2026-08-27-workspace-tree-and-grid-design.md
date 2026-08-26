# Workspace Tree & Multi-Branch Grid Layout — Design Spec

Date: 2026-08-27
Branch: `feat/workspace-tree-and-grid`
Status: APPROVED (user decisions recorded below)
Companion plan: `docs/superpowers/plans/2026-08-27-workspace-tree-and-grid.md`

## Problem & Vision

Currently, OPPA separates terminal tabs and worktrees into two distinct sidebar views. Users cannot easily see the full project structure at a glance, nor can they view and interact with **multiple active branch terminals simultaneously** in a coordinated grid.

As illustrated in user diagram `Screenshot 2026-08-27 003603.png`:
1. **Left Sidebar**: Must display a hierarchical tree grouped by `<project name>` (repository name), with nested branch nodes (`- branch 1`, `- branch 2`, `- branch 3`) showing their active terminal status and branch details.
2. **Main Section**: Must render the active terminals for each branch simultaneously in a multi-pane split/grid layout (e.g., 2 top panes + 1 bottom pane for 3 active branches, or 2x2 grid for 4 branches).

---

## Approved Design & Feature Scope

### 1. Left Sidebar: Hierarchical Project & Branch Tree

**F1. Unified Project Tree Structure (`ProjectTreeView.tsx`)**
- Top-level **Project Group Header**:
  - Displays `<project name>` (repository display name/basename, e.g. `oppa`), repository path tooltip, and total active terminals counter badge.
  - Quick action toolbar: `+ Worktree` (quick spawn) and `🚀 Spawn Fleet` (open fleet sheet).
- Nested **Branch Workspace Items (`- branch 1`, `- branch 2`, ...)**:
  - Branch icon & name (e.g. `🌿 main`, `🌿 feat-auth`, `🌿 fix-perf`).
  - Live status indicator dot/pill: 🟢 `idle`, ⚡ `working agent`, 💤 `sleeping`.
  - Active terminal count badge (e.g. `1 terminal`, `2 terminals`).
  - Git status indicators when available (`+14 -3`, linked PR badge).
  - Sub-items: If a branch contains multiple split panes (e.g. `1. Claude Code`, `2. Vite Dev Server`), they expand cleanly as nested session rows under that branch.
- Selection & Navigation:
  - Clicking a branch focuses its active pane in the main viewport.
  - Double clicking / clicking the "Tile in Grid" icon ensures the branch is visible in the active multi-branch split layout.

### 2. Main Viewport: Multi-Branch Active Grid Layout

**F2. Intelligent Multi-Branch Grid Tiling (`layoutCoordinator.ts` / `tileBranches`)**
- When multiple branches are active or when the user triggers "Tile Project Grid":
  - **1 branch**: Full-viewport single pane.
  - **2 branches**: 50/50 vertical split (Side-by-side).
  - **3 branches**: Top row 50/50 split (Branch 1 + Branch 2) and bottom row full-width (Branch 3), matching the exact layout in `Screenshot 2026-08-27 003603.png`.
  - **4 branches**: 2x2 symmetrical split grid.
- All tiled panes remain fully interactive with independent xterm instances, backpressure handling, and daemon persistence.

**F3. Pane Header Branch Badges & Solo/Zoom Mode (`TerminalPaneHeader.tsx`)**
- Each terminal pane header displays:
  - Worktree Branch Chip (`🌿 feat-auth`).
  - Working / Idle agent status icon.
  - **"Solo / Zoom" Toggle (`⛶`)**: Instantly expands the focused branch's terminal to 100% of the viewport and zooms back out to the multi-branch grid layout when toggled again.
  - Quick actions: Split Pane, Close Pane, and Open Diff/Review.

### 3. State & Store Architecture

**F4. Project Tree Data Mapping (`src/store/slices/worktreeRegistrySlice.ts` / `layoutQueries.ts`)**
- Pure computed selector `selectProjectTree(state)`:
  - Groups `worktrees` by `repo_id` / `repoPath`.
  - Maps open `sessions` and `tabs` to their respective `worktreeId`.
  - Computes aggregate session status per branch and per project.
- Action `tileProjectBranches(repoId, worktreeIds?)`:
  - Builds a balanced binary `Layout` tree containing the active leaf sessions for the specified worktrees and sets it on the active tab without restarting shell processes.
- Action `focusBranchPane(worktreeId)`:
  - Finds the tab and leaf path bound to `worktreeId` and activates focus.

---

## Non-Goals & Boundaries
- No backend PTY protocol changes required (the existing daemon IPC, `worktree_list`, `worktree_create_fleet`, and session registry handle multi-session worktree binding).
- Keyboard pane shortcuts (`Ctrl+Alt+Arrows`, `Ctrl+Shift+D`, `Ctrl+Shift+E`) remain 100% compatible.

---

## Verification & Testing Plan
1. **Unit Tests (`worktreeRegistrySlice.test.ts`, `paneLayoutSlice.test.ts`)**:
   - Verify `selectProjectTree` correctly groups branches under project headers with mapped live sessions.
   - Verify `tileProjectBranches` builds the exact 3-pane layout for 3 branches (top-left, top-right, bottom).
2. **Component Tests (`ProjectTreeView.test.tsx`, `LeftSidebar.test.tsx`, `TerminalPaneHeader.test.tsx`)**:
   - Verify sidebar renders `<project name>` with `- branch 1`, `- branch 2`, `- branch 3`.
   - Verify clicking branch nodes focuses or tiles corresponding terminal panes.
   - Verify Solo / Zoom toggle maximizes and restores multi-branch grid layout.
3. **Full Vitest & Build Verification**:
   - Run `pnpm vitest run` (all test suites passing).
   - Run `pnpm build` (`tsc && vite build`).
