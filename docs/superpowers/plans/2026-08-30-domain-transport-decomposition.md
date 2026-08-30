# Decompose Kitchen-Sink PTY Transport & Domain Command Handlers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose the omnibus 636-line frontend `pty/transport.ts` and 913-line backend `pty/commands.rs` into domain-aligned transport adapters and command handlers (`pty`, `worktree`, `git`, `layout`), eliminating false dependencies while keeping all existing tests green throughout.

**Architecture:** Split transport functions and Rust commands along clean domain seams with an invariant Tauri IPC wire protocol. Use a two-phase strangler facade pattern in `src/lib/pty/transport.ts` to ensure 100% backward compatibility during incremental slice and test migration.

**Tech Stack:** Tauri 2, Rust (Tokio, portable-pty), React 19, TypeScript, Zustand, Vitest.

## Global Constraints

- **Wire Invariance:** Tauri command strings (`"sc_status"`, `"worktree_create"`, `"save_layout"`, `"pty_spawn"`) must remain identical.
- **TDD:** Write or run the test first, ensure green status at each milestone.
- **Test Integrity:** Never break existing test suites (`cargo test` and `pnpm vitest run`).
- **Code Style:** Concise comments explaining WHY, descriptive variable names, strictly follow `/codebase-design` vocabulary.

---

### Task 1: Backend Rust Domain Command Modules Reorganization

**Files:**
- Create: `src-tauri/src/git/commands.rs`
- Create: `src-tauri/src/git/worktree_commands.rs`
- Modify: `src-tauri/src/git/mod.rs`
- Modify: `src-tauri/src/layout.rs`
- Modify: `src-tauri/src/pty/commands.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `PtyManager`, `AppHandle`, `State`, git and worktree models.
- Produces: 
  - `crate::pty::commands::{pty_spawn, pty_write, pty_resize, pty_kill, pty_ack, pty_list, ...}`
  - `crate::git::commands::{sc_status, sc_stage, sc_unstage, sc_discard, sc_commit, sc_local_branches, sc_checkout, sc_file_diff, sc_history, sc_branch_compare, sc_fetch, sc_pull, sc_fast_forward, sc_push, sc_upstream_refresh, sc_merge_to_base, sc_generate_commit_message, sc_generate_pr_message, pr_*, diff_comment_*}`
  - `crate::git::worktree_commands::{repo_add, repo_list, worktree_create, worktree_create_agent, worktree_create_fleet, agent_profiles, worktree_list, worktree_show, worktree_current, worktree_set, worktree_remove, worktree_purge, worktree_ps, worktree_lineage}`
  - `crate::layout::{save_layout, load_layout, save_scrollback, load_scrollback, delete_scrollback, cleanup_stale_scrollbacks, confirm_save_complete}`

- [ ] **Step 1: Create `src-tauri/src/git/commands.rs` with source control, diff comment, and PR review Tauri command handlers.**
- [ ] **Step 2: Create `src-tauri/src/git/worktree_commands.rs` with worktree, repo, and fleet command handlers.**
- [ ] **Step 3: Move layout and scrollback storage command handlers into `src-tauri/src/layout.rs`.**
- [ ] **Step 4: Trim `src-tauri/src/pty/commands.rs` down to PTY session stream commands and PTY forwarders.**
- [ ] **Step 5: Update `src-tauri/src/git/mod.rs` and `src-tauri/src/lib.rs` invoke handlers.**
- [ ] **Step 6: Run Rust unit tests to verify compilation and passes.**
  Run: `cargo test -p oppa --lib` in `src-tauri`
  Expected: PASS
- [ ] **Step 7: Commit backend command decomposition.**
  ```bash
  git add src-tauri/src/
  git commit -m "refactor(backend): decompose pty commands into git, worktree, and layout command modules"
  ```

---

### Task 2: Frontend Domain Transports & Re-export Facade

**Files:**
- Create: `src/lib/worktree/transport.ts`
- Modify: `src/lib/git/transport.ts`
- Create: `src/lib/layout/transport.ts`
- Modify: `src/lib/pty/transport.ts`
- Create: `src/lib/worktree/transport.test.ts`
- Modify: `src/lib/git/transport.test.ts`
- Create: `src/lib/layout/transport.test.ts`

**Interfaces:**
- Produces:
  - `src/lib/worktree/transport.ts`: `worktreeCreate`, `worktreeList`, `worktreeSet`, `worktreeRemove`, `worktreePurge`, `worktreePs`, `repoAdd`, `repoList`, `fleetSpawn`, `agentProfiles`, `worktreeCreateAgent`, `onWorktreeChanged`, and associated types.
  - `src/lib/git/transport.ts`: `getGitStatus`, `scStatus`, `scStage`, `scUnstage`, `scDiscard`, `scCommit`, `scLocalBranches`, `scCheckout`, `scFileDiff`, `scHistory`, `scBranchCompare`, `prReviewStatus`, `prCreateReview`, `prCheckout`, `prSync`, `diffCommentsList`, `diffCommentAdd`, `diffCommentUpdate`, `diffCommentToggle`, `diffCommentDelete`, `onGitChanged`, `onPrChanged`, and associated types.
  - `src/lib/layout/transport.ts`: `saveLayout`, `loadLayout`, `saveScrollback`, `loadScrollback`, `deleteScrollback`, `cleanupStaleScrollbacks`, `confirmSaveComplete`.
  - `src/lib/pty/transport.ts`: Core PTY functions (`ptySpawn`, `ptyWrite`, `ptyResize`, `ptyKill`, `ptyAck`, `ptyList`, `onPtyData`, `onPtyExit`, `onPtyCwd`, `onSessionWorking`, `onAgentStatus`, `onTitleChanged`, `onFocusRequested`) plus temporary re-exports for backward compatibility.

- [ ] **Step 1: Create `src/lib/worktree/transport.ts` and write `src/lib/worktree/transport.test.ts`.**
- [ ] **Step 2: Expand `src/lib/git/transport.ts` with all source control / review endpoints and write `src/lib/git/transport.test.ts`.**
- [ ] **Step 3: Create `src/lib/layout/transport.ts` and write `src/lib/layout/transport.test.ts`.**
- [ ] **Step 4: Update `src/lib/pty/transport.ts` to re-export moved domain methods and types as a transitional facade.**
- [ ] **Step 5: Run vitest across all transport tests.**
  Run: `pnpm vitest run src/lib/`
  Expected: PASS
- [ ] **Step 6: Commit frontend domain transports.**
  ```bash
  git add src/lib/
  git commit -m "feat(transport): create domain transport modules for worktree, git, and layout with facade re-exports"
  ```

---

### Task 3: Migrate Zustand Store Slices

**Files:**
- Modify: `src/store/slices/worktreeRegistrySlice.ts`
- Modify: `src/store/slices/sourceControlSlice.ts`
- Modify: `src/store/slices/paneLayoutSlice.ts`
- Modify: `src/store/slices/terminalSessionsSlice.ts`
- Modify: `src/store/terminalStore.ts`

**Interfaces:**
- Consumes: Direct imports from `../lib/worktree/transport`, `../lib/git/transport`, `../lib/layout/transport`, `../lib/pty/transport`.

- [ ] **Step 1: Update `worktreeRegistrySlice.ts` to import exclusively from `../lib/worktree/transport`.**
- [ ] **Step 2: Update `sourceControlSlice.ts` to import exclusively from `../lib/git/transport`.**
- [ ] **Step 3: Update `paneLayoutSlice.ts` to import layout and scrollback functions from `../lib/layout/transport`.**
- [ ] **Step 4: Update `terminalStore.ts` event listeners to import `onWorktreeChanged` from `worktree/transport`, `onGitChanged`/`onPrChanged` from `git/transport`, and PTY listeners from `pty/transport`.**
- [ ] **Step 5: Run store unit tests.**
  Run: `pnpm vitest run src/store/`
  Expected: PASS
- [ ] **Step 6: Commit store slice migrations.**
  ```bash
  git add src/store/
  git commit -m "refactor(store): migrate slices to import directly from domain transport modules"
  ```

---

### Task 4: Migrate Component Imports & Test Mocks, Prune Legacy Re-exports

**Files:**
- Modify: `src/components/right-sidebar/GitSourceControl.test.tsx`
- Modify: `src/components/right-sidebar/ReviewComposer.test.tsx`
- Modify: `src/components/right-sidebar/DiffNotesShelf.test.tsx`
- Modify: `src/components/right-sidebar/PrChecksCard.test.tsx`
- Modify: `src/components/right-sidebar/RightSidebar.test.tsx`
- Modify: `src/components/worktree/WorktreeCreateModal.test.tsx`
- Modify: `src/components/worktree/WorktreeCreateModal.tsx`
- Modify: `src/components/workspace/WorktreeActionsMenu.test.tsx`
- Modify: `src/components/workspace/WorkspaceList.test.tsx`
- Modify: `src/lib/git/diffCommentFormat.test.ts`
- Modify: `src/lib/pty/transport.ts` (Prune transitional re-exports)

- [ ] **Step 1: Update git right-sidebar component test files to mock `src/lib/git/transport` instead of `pty/transport`.**
- [ ] **Step 2: Update worktree component test files to mock `src/lib/worktree/transport` instead of `pty/transport`.**
- [ ] **Step 3: Remove transitional re-exports from `src/lib/pty/transport.ts` to enforce clean seams.**
- [ ] **Step 4: Run typecheck and all tests.**
  Run: `pnpm tsc --noEmit && pnpm vitest run`
  Expected: PASS
- [ ] **Step 5: Commit component & test mock migrations.**
  ```bash
  git add src/
  git commit -m "refactor(ui): align component imports and test mocks with domain transports and prune facade"
  ```

---

### Task 5: Full Suite Verification & Build Sanity Check

**Files:**
- Test: Full repository test suites and build pipeline.

- [ ] **Step 1: Run Rust unit tests.**
  Run: `cargo test -p oppa --lib` (in `src-tauri`)
  Expected: All Rust unit tests pass.
- [ ] **Step 2: Run Rust daemon integration tests.**
  Run: `cargo test -p oppa --test daemon_integration_test` (in `src-tauri`)
  Expected: All integration tests pass.
- [ ] **Step 3: Run Vitest frontend test suite.**
  Run: `pnpm vitest run`
  Expected: All Vitest suites pass.
- [ ] **Step 4: Run full project build.**
  Run: `pnpm build`
  Expected: Vite build succeeds with zero bundle or type errors.
- [ ] **Step 5: Commit final verification marker if needed.**
