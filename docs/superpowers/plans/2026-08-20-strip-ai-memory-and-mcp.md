# Strip AI Memory & MCP Subsystems Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Cleanly eliminate all AI memory, Context Studio, and MCP code from main, restoring a lean, pure desktop terminal core with 100% green tests.

**Architecture:** Remove context and mcp modules from Rust backend; remove context components, transport, and store from React frontend; update App.tsx, TabBar.tsx, TerminalPaneHeader.tsx, and 	erminalStore.ts to drop context mode and persona bindings.

**Tech Stack:** Rust / Tauri 2, React 19, TypeScript, Vite, Vitest.

## Global Constraints

- Never break core terminal functionality (daemon reattach, cold restore, split panes, browser hub, editor).
- Complete Memory + MCP code is preserved safely on origin/memory+mcp.
- Every task ends with green tests and clean commits.

---

### Task 1: Remove Rust Context & MCP Modules and Command Registrations

**Files:**
- Delete: src-tauri/src/context/
- Delete: src-tauri/src/mcp/
- Modify: src-tauri/src/lib.rs
- Modify: src-tauri/src/main.rs
- Modify: src-tauri/Cargo.toml

**Interfaces:**
- Removes pub mod context; and pub mod mcp; from lib.rs.
- Removes context_* and persona_* command handlers from 	auri::generate_handler!.
- Removes --mcp CLI argument from main.rs.
- Removes usqlite from Cargo.toml.

- [ ] **Step 1: Delete context and mcp source directories**
- [ ] **Step 2: Update lib.rs to remove module declarations, state management, and command handlers**
- [ ] **Step 3: Update main.rs to remove --mcp arg parsing**
- [ ] **Step 4: Update Cargo.toml to remove usqlite**
- [ ] **Step 5: Run cargo check in src-tauri to verify compilation**
- [ ] **Step 6: Commit:** git commit -m chore(rust): remove context and mcp backend modules

---

### Task 2: Clean Up PTY Session Spawn Options and Persona Envs

**Files:**
- Modify: src-tauri/src/pty/daemon_session.rs
- Modify: src-tauri/src/pty/manager.rs
- Modify: src-tauri/src/pty/commands.rs

**Interfaces:**
- Remove persona_id field from PtySpawnOptions and OPPA_PERSONA env injection.

- [ ] **Step 1: Update daemon_session.rs to remove persona_id and OPPA_PERSONA env var**
- [ ] **Step 2: Update manager.rs and commands.rs to clean persona_id from spawn parameters**
- [ ] **Step 3: Run cargo test -p oppa --lib and cargo test -p oppa --test daemon_integration_test**
- [ ] **Step 4: Commit:** git commit -m chore(pty): remove persona_id and OPPA_PERSONA environment injection

---

### Task 3: Remove Frontend Context Components, Transport, and Stores

**Files:**
- Delete: src/components/context/
- Delete: src/lib/context/
- Delete: src/store/contextStore.ts
- Delete: src/store/contextStore.test.ts

- [ ] **Step 1: Delete src/components/context/ directory and all its files**
- [ ] **Step 2: Delete src/lib/context/ directory**
- [ ] **Step 3: Delete src/store/contextStore.ts and src/store/contextStore.test.ts**
- [ ] **Step 4: Commit:** git commit -m chore(frontend): remove context studio components, transport, and store

---

### Task 4: Clean Up App Navigation, TabBar, Header, and TerminalStore

**Files:**
- Modify: src/App.tsx
- Modify: src/App.test.tsx
- Modify: src/components/TabBar.tsx
- Modify: src/components/TabBar.test.tsx
- Modify: src/components/TitleBar.tsx
- Modify: src/components/TitleBar.test.tsx
- Modify: src/components/TerminalPaneHeader.tsx
- Modify: src/components/TerminalPaneHeader.test.tsx
- Modify: src/store/terminalStore.ts
- Modify: src/store/terminalStore.test.ts

- [ ] **Step 1: Update ActiveMode in App.tsx to terminal | editor | browser and remove ContextStudio view**
- [ ] **Step 2: Remove ?? Context tab and Cmd+4 shortcut in TabBar.tsx and TitleBar.tsx**
- [ ] **Step 3: Remove persona dropdown from TerminalPaneHeader.tsx**
- [ ] **Step 4: Remove personaId from TerminalSession and spawnSession in 	erminalStore.ts**
- [ ] **Step 5: Update affected tests in App.test.tsx, TabBar.test.tsx, TitleBar.test.tsx, TerminalPaneHeader.test.tsx, 	erminalStore.test.ts**
- [ ] **Step 6: Run pnpm vitest run**
- [ ] **Step 7: Commit:** git commit -m chore(ui): remove context tab, persona header controls, and personaId from store

---

### Task 5: Final Full Integration Verification

- [ ] **Step 1: Run cargo test -p oppa --lib (verify all Rust unit tests pass)**
- [ ] **Step 2: Run cargo test -p oppa --test daemon_integration_test (verify daemon tests pass)**
- [ ] **Step 3: Run pnpm vitest run (verify all frontend tests pass)**
- [ ] **Step 4: Run pnpm build (verify TypeScript typecheck and Vite bundling succeed)**
- [ ] **Step 5: Run cargo check in src-tauri (verify Rust build passes)**
