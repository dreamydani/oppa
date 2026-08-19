# Spec: Strip AI Memory & MCP Subsystems (Restoring Pure Terminal Core)

## 1. Objective

Remove all traces of the Context Studio, SQLite-based tiered memory (L0/L1/L2), Persona models, and the Stdio Model Context Protocol (MCP) server from the main branch.

The result will be a lean, lightning-fast desktop terminal and workspace application (Terminal, Editor, Browser) with zero memory/MCP bloat. The complete Memory + MCP subsystem is safely preserved on the remote branch origin/memory+mcp.

---

## 2. Inventory of Components to Remove

### 2.1 Backend (Rust / Tauri)
1. **Modules**:
   - src-tauri/src/context/ (entire module: enums.rs, models.rs, schema.rs, manager.rs, commands.rs, context_page_list.rs, mod.rs).
   - src-tauri/src/mcp/ (entire module: protocol.rs, server.rs, mod.rs).
2. **Commands & App State**:
   - Remove context::commands::* from 	auri::generate_handler!.
   - Remove ContextManager state from pp.manage(...).
3. **CLI Arguments**:
   - In src-tauri/src/main.rs, remove --mcp / -w parsing and tests.
4. **PTY Session Spawning**:
   - Remove persona_id from PtySpawnOptions and OPPA_PERSONA env injection in daemon_session.rs, manager.rs, and commands.rs.
5. **Dependencies**:
   - Remove usqlite from src-tauri/Cargo.toml.

### 2.2 Frontend (React / TypeScript)
1. **Components**:
   - src/components/context/ (entire directory: ContextStudio.tsx, ContextInspector.tsx, ContextStatusPanel.tsx, ContextTree.tsx, PersonaModal.tsx, McpConfigModal.tsx, ContextIcons.tsx, ContextStudio.css, and all associated .test.tsx files).
2. **State & Stores**:
   - src/store/contextStore.ts and src/store/contextStore.test.ts.
   - Remove personaId from TerminalSession in src/store/terminalStore.ts.
3. **Transport Layer**:
   - src/lib/context/ (	ransport.ts, 	ransport.test.ts).
4. **Navigation & Mode Switching**:
   - In src/App.tsx: remove ContextStudio view, remove Cmd+4 shortcut, restrict ActiveMode to terminal | editor | browser.
   - In src/components/TabBar.tsx & src/components/TitleBar.tsx: remove ?? Context tab button and shortcuts.
   - In src/components/TerminalPaneHeader.tsx: remove persona role dropdown.

---

## 3. Preserved Architecture & Guarantees

All core terminal capabilities remain 100% intact and functional:
- **Rust Tokio Daemon**: Named pipe / Unix socket IPC, session survival across GUI restarts.
- **PTY Backpressure**: ACK-based flow control (256KB pause / 32KB resume).
- **Session Restorations**: Cold restore (layout.json + scrollback snapshots) & warm reattachment (ScreenMirror ANSI snapshot).
- **Workspaces**: Left sidebar, file tree, git status, editor split, embedded browser view.
- **Test Integrity**: Full green test suites across all remaining Rust and React components.
