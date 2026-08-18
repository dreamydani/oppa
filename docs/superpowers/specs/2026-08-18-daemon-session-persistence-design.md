# OPPA — Detached Daemon & Terminal Session Persistence Design

**Date**: 2026-08-18  
**Status**: Draft for user review  
**Topic**: Detached background daemon architecture, session survival across hot-closes, and live reattachment with headless terminal emulation.

---

## 1. Motivation & Context

In OPPA's initial milestone, the PTY manager (`PtyManager`) was hosted directly inside the main Tauri process (`src-tauri/src/lib.rs`). While this established split panes, ACK-based flow control, and layout persistence, closing the OPPA window immediately terminates the host process and all child shell sessions (bash, zsh, powershell, active dev servers, build tools, REPLs).

In **Orca** (`D:\orca\orca`), terminal sessions survive window closures, app restarts, and hot-reloads without interrupting running background jobs. Orca achieves this by decoupling the GUI from a detached background daemon (`daemon-entry.js`) communicating over Named Pipes / Unix domain sockets, backed by an in-daemon headless terminal emulator (`@xterm/headless`).

This specification defines the architecture to implement **100% behavioral parity with Orca's session survival and warm reattachment model** in OPPA, while leveraging OPPA's native **Tauri 2 + Rust + React** stack for maximum speed and minimal memory consumption.

---

## 2. High-Level Architecture

```
+--------------------------------------------------------------------------------+
| OPPA GUI PROCESS (Tauri 2 + Webview)                                           |
|   - React 19 + xterm.js Panes (UI Layer)                                       |
|   - `transport.ts` & `terminalStore.ts`                                        |
|   - Tauri backend acting as a thin Daemon Client Adapter                       |
+--------------------------------------------------------------------------------+
                                       |
                     IPC: Windows Named Pipe / Unix Domain Socket
                     Framed JSON-RPC + Binary Stream
                                       v
+--------------------------------------------------------------------------------+
| OPPA DETACHED RUST DAEMON (`oppa --daemon`)                                    |
|                                                                                |
|   +------------------------------------------------------------------------+   |
|   | DaemonServer (Tokio Async Runtime, ~5–10 MB RAM)                       |   |
|   |  - Named Pipe / Unix Socket Listener (`\\.\pipe\oppa-daemon-<uid>`)    |   |
|   |  - Handshake & Authentication (Token & Nonce validation)               |   |
|   |  - Idle Watchdog (clean shutdown if 0 clients & 0 sessions for 1 hr)   |   |
|   +------------------------------------------------------------------------+   |
|                                       |                                        |
|   +------------------------------------------------------------------------+   |
|   | TerminalHost & Session Registry                                        |   |
|   |  - Map<String, Arc<DaemonSession>>                                     |   |
|   |  - Process Group / Tree Management                                     |   |
|   +------------------------------------------------------------------------+   |
|                                       |                                        |
|         +-----------------------------+-----------------------------+          |
|         |                                                           |          |
|         v                                                           v          |
|   +----------------------------+                             +-----------------+
|   | DaemonSession 1            |                             | DaemonSession 2 |
|   |  - `portable-pty` Master   |                             |  - portable-pty |
|   |  - `vt100` Screen Parser   |                             |  - `vt100`      |
|   |  - Output Ring Buffer      |                             |  - Output Buffer|
|   |  - ACK Flow Controller     |                             |  - Flow Control |
|   +----------------------------+                             +-----------------+
+--------------------------------------------------------------------------------+
```

---

## 3. Core Components

### 3.1. Unified Binary Architecture (`oppa` vs `oppa --daemon`)
A single compiled binary (`oppa.exe` / `oppa`) handles both GUI and background service modes:
- **Default Mode (`oppa`)**: Boots the Tauri 2 desktop application.
- **Daemon Mode (`oppa --daemon`)**: Skips all GUI/webview initializations and starts the Tokio-based daemon IPC server.

### 3.2. Daemon Launcher & Endpoint Discovery
When the GUI starts up:
1. **Endpoint Probe**: It probes the platform endpoint:
   - **Windows**: `\\.\pipe\oppa-daemon-<username>`
   - **macOS / Linux**: `$XDG_RUNTIME_DIR/oppa.sock` or `~/.oppa/daemon.sock`
2. **Background Spawning**: If the socket is unreachable or refuses connection:
   - On Windows: Launches `oppa.exe --daemon` using `CREATE_NO_WINDOW | DETACHED_PROCESS`.
   - On POSIX: Forks and detaches via `setsid()` with standard I/O redirected to null or log files.
3. **Readiness Handshake**: The GUI awaits socket readiness (timeout: 5s) and performs a `hello` handshake exchange with a local authentication token.

### 3.3. In-Daemon Session Management & `vt100` Screen Emulation
Each session in the daemon contains:
1. **PTY Subprocess**: Controlled via `portable-pty` with shell detection, environment sanitation, and process-tree lifecycle management.
2. **`vt100` Screen Parser**: A fast, pure-Rust virtual terminal emulator (`vt100` crate) that processes all stdout in real-time. It tracks:
   - Visible grid lines, formatted ANSI styles (24-bit truecolor, bold, underline).
   - Absolute cursor coordinates.
   - Alternate screen buffer state (e.g. vim, htop, less).
   - Scrollback history.
3. **Output Broadcast & ACK Flow Control**:
   - Pushes output chunks to all attached GUI stream subscribers.
   - Enforces the 256KB/32KB high/low watermarks: if client ACKs fall behind, reading from the PTY master fd is paused, causing the OS pipe to fill and backpressure the child process.

---

## 4. IPC Protocol Specification

Communication runs over framed JSON-RPC messages for control commands, with binary streaming channels for output.

### 4.1. RPC Commands
- **`hello { client_version, token }`**: Authenticates client connection and validates protocol version.
- **`create_or_attach { session_id, cols, rows, cwd, shell }`**:
  - If `session_id` is already active in the daemon:
    - Generates an ANSI screen snapshot from the `vt100` emulator.
    - Returns `{ is_new: false, pid: u32, cols: u16, rows: u16, cwd: String, snapshot: String }`.
    - Subscribes the client to live output streaming.
  - If `session_id` is new:
    - Spawns a fresh shell.
    - Returns `{ is_new: true, pid: u32, cols: u16, rows: u16, cwd: String, snapshot: null }`.
- **`write { session_id, data }`**: Writes bytes directly to the PTY stdin.
- **`resize { session_id, cols, rows }`**: Resizes PTY and `vt100` emulator grid.
- **`ack { session_id, chars }`**: Acknowledges processed output bytes for backpressure.
- **`kill { session_id }`**: Sends `SIGTERM`/`SIGKILL` (or `GenerateConsoleCtrlEvent`) to the session process group and cleans up memory.
- **`list_sessions {}`**: Returns status and metadata of all active sessions.
- **`disconnect {}`**: Signals that a GUI client is closing its window. The daemon releases client subscriptions but leaves all sessions and shells running.
- **`shutdown {}`**: Explicit request to terminate all sessions and shut down the daemon process completely.

### 4.2. Push Events
- **`pty:data { session_id, data, seq }`**: PTY stdout payload.
- **`pty:exit { session_id, code }`**: Emitted when child process exits.
- **`pty:cwd { session_id, cwd }`**: Emitted on OSC 7 / OSC 9;9 working directory updates.

---

## 5. Hot-Close & Reattachment Lifecycle

```
[User closes OPPA window]
       |
       v
1. Tauri intercept close event
2. Save layout state (pane tree + session IDs) to `layout.json`
3. Client sends `disconnect` RPC over IPC socket
4. Tauri GUI process terminates
       |
       +---> [Daemon continues running in background]
             [Shells, dev servers, builds continue executing]
             [vt100 parser updates screen buffer in real time]
       |
[User reopens OPPA]
       |
       v
1. Tauri GUI launches and connects to existing daemon endpoint
2. `loadLayout()` reads `layout.json`
3. For each pane: sends `create_or_attach(session_id, ...)`
4. Daemon returns `{ is_new: false, snapshot: "..." }`
5. Frontend writes snapshot to xterm.js pane and resumes stream
6. Result: 100% seamless restore without killing or restarting shells!
```

---

## 6. Cold Restore & Failure Recovery

If the daemon is killed (e.g. OS reboot or force kill):
1. **Periodic Snapshot Persistence**: The daemon periodically writes lightweight checkpoints and metadata (`layout.json` + `terminal-scrollback/<id>.bin`) to `appDataDir`.
2. **Cold Start Rehydration**: When OPPA launches after a reboot, the daemon detects that no live processes exist for the saved IDs, spawns fresh shells in the recorded directories, and pre-seeds the visible scrollback.

---

## 7. Cross-Platform Specifications

| Feature | Windows | macOS / Linux |
| :--- | :--- | :--- |
| **Endpoint Path** | `\\.\pipe\oppa-daemon-<username>` | `$XDG_RUNTIME_DIR/oppa.sock` or `~/.oppa/daemon.sock` |
| **Daemon Spawning** | `Command::new(...)` with `DETACHED_PROCESS | CREATE_NO_WINDOW` | `Command::new(...)` + `setsid()` / detached stdio |
| **Process Termination** | Kill process tree via Win32 Job Object / `taskkill` | Kill process group via `killpg(pgrp, SIGTERM)` |
| **PTY Backend** | `portable-pty` via Windows ConPTY | `portable-pty` via forkpty / posix_spawn |

---

## 8. Verification & Testing Strategy

1. **Rust Integration Tests (`cargo test -p oppa --lib`)**:
   - `test_daemon_spawn_and_connect`: Verify daemon background spawning and handshake over Named Pipes / Unix Sockets.
   - `test_warm_reattach_flow`: Spawn a long-running command (e.g. `sh -c 'echo first; sleep 1; echo second'`), disconnect client, reconnect after 500ms, assert snapshot captures `"first"` and live stream delivers `"second"`.
   - `test_backpressure_over_ipc`: Stream 1MB of `yes` output, verify daemon pauses PTY reading when ACKs stop.
   - `test_idle_shutdown`: Test watchdog timer termination when no clients/sessions exist.
2. **Frontend Vitest Tests (`pnpm vitest run`)**:
   - Mock daemon transport to verify `create_or_attach` snapshot ingestion into xterm.js.
   - Test layout restoration with warm reattachment IDs.
3. **Manual Acceptance**:
   - Start a running counter (`while true; do date; sleep 1; done` / `powershell: while($true){Get-Date; Start-Sleep 1}`).
   - Close OPPA completely.
   - Reopen OPPA: counter must have continued incrementing in the background and rehydrate instantly.
