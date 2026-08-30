# Decompose Kitchen-Sink PTY Transport & Domain Command Handlers — Design Spec

**Date:** 2026-08-30  
**Status:** Approved  
**Topic:** Codebase Architecture & Deepening  

---

## 1. Problem Statement

The frontend transport layer (`src/lib/pty/transport.ts`, 636 lines) and backend Tauri command registry (`src-tauri/src/pty/commands.rs`, 913 lines) have become omnibus kitchen-sink modules. 

Over multiple milestones, capabilities outside terminal emulation—including Worktree registries, Fleet spawning, Agent profiles, Source Control staging/commits, Hosted PR reviews, Diff comments, and Layout persistence—were placed in the `pty` module under the early rule that "pty/transport.ts is the only file that touches Tauri APIs".

This creates several architectural friction points:
1. **Broken Locality:** Worktree lifecycle changes, Git diff parsing, and PTY stream logic collide in the same files.
2. **False Seams & Failing the Deletion Test:** Mocking `pty/transport.ts` in UI tests (`GitSourceControl.test.tsx`, `WorktreeCreateModal.test.tsx`, `DiffNotesShelf.test.tsx`) couples unrelated domain tests to terminal PTY transport.
3. **Shallow IPC Call Slices:** Store slices manually orchestrate 14 granular low-level `sc_*` or `worktree_*` calls rather than interfacing with cohesive domain adapters.

---

## 2. Goals & Architecture

Decompose the omnibus modules along clean domain seams while preserving 100% backward compatibility during migration:

### 2.1 Frontend Domain Modules (`src/lib/`)
- **`src/lib/pty/transport.ts`**: Dedicated solely to PTY streaming and terminal lifecycle (`ptySpawn`, `ptyWrite`, `ptyResize`, `ptyKill`, `ptyAck`, `ptyList`, and stream events `onPtyData`, `onPtyExit`, `onPtyCwd`, `onSessionWorking`, `onAgentStatus`).
- **`src/lib/worktree/transport.ts`**: Worktree records, Fleet spawning, Agent profiles, and Repo management (`worktreeCreate`, `worktreeList`, `worktreeSet`, `worktreeRemove`, `worktreePurge`, `worktreePs`, `repoAdd`, `repoList`, `fleetSpawn`, `agentProfiles`, `worktreeCreateAgent`, `onWorktreeChanged`).
- **`src/lib/git/transport.ts`**: Full source control, diff inspection, and hosted PR reviews (`scStatus`, `scStage`, `scUnstage`, `scDiscard`, `scCommit`, `scLocalBranches`, `scCheckout`, `scFileDiff`, `scHistory`, `scBranchCompare`, `prReviewStatus`, `prCreateReview`, `prCheckout`, `prSync`, `diffCommentsList`, `diffCommentAdd`, `diffCommentUpdate`, `diffCommentToggle`, `diffCommentDelete`, `onGitChanged`, `onPrChanged`).
- **`src/lib/layout/transport.ts`**: Layout and scrollback snapshot persistence (`saveLayout`, `loadLayout`, `saveScrollback`, `loadScrollback`, `deleteScrollback`, `cleanupStaleScrollbacks`, `confirmSaveComplete`).

### 2.2 Backend Domain Command Modules (`src-tauri/src/`)
- **`src-tauri/src/pty/commands.rs`**: Retains `pty_*` commands and event forwarders (`pty:data`, `pty:exit`, `pty:cwd`, `session-title-changed`, `session-focus-requested`).
- **`src-tauri/src/git/commands.rs`**: Hosts `sc_*`, `pr_*`, and `diff_comment_*` commands plus `git-changed` and `pr-changed` forwarders.
- **`src-tauri/src/git/worktree_commands.rs`**: Hosts `worktree_*`, `repo_*`, `fleet_spawn`, and `agent_profiles` commands plus `worktree-changed` forwarder.
- **`src-tauri/src/layout.rs`**: Hosts `save_layout`, `load_layout`, `save_scrollback`, `load_scrollback`, `delete_scrollback`, `cleanup_stale_scrollbacks`, and `confirm_save_complete`.
- **Wire Invariance:** Tauri command string identifiers (`"sc_status"`, `"worktree_create"`, `"save_layout"`) remain 100% identical.

### 2.3 Strangler Facade Strategy
During the cutover, `src/lib/pty/transport.ts` will temporarily re-export functions and types from the new domain transport modules to guarantee that existing store slices and test suites remain green on Day 1 without large breaking churn.

---

## 3. Scope & Non-Goals

- **In Scope:**
  - Creating `src/lib/worktree/transport.ts`, expanding `src/lib/git/transport.ts`, creating `src/lib/layout/transport.ts`.
  - Splitting `src-tauri/src/pty/commands.rs` into `git/commands.rs`, `git/worktree_commands.rs`, and updating `layout.rs`.
  - Updating `src-tauri/src/lib.rs` invoke handler list.
  - Migrating store slices (`worktreeRegistrySlice`, `sourceControlSlice`, `paneLayoutSlice`, `terminalSessionsSlice`, `terminalStore`).
  - Migrating UI components and tests to mock domain-specific transport modules.
  - Pruning temporary re-exports from `src/lib/pty/transport.ts`.

- **Non-Goals:**
  - Rewriting Zustand store logic or changing the visual UI.
  - Modifying the underlying daemon IPC protocols or named pipe serialization format.

---

## 4. Verification

1. `cargo test -p oppa --lib` and `cargo test -p oppa --test daemon_integration_test` compile and pass.
2. `pnpm vitest run` passes across all frontend unit and component tests.
3. `pnpm build` (`tsc + vite`) succeeds with zero TypeScript errors.
