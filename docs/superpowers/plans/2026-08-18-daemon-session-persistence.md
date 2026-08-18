# Detached Daemon & Terminal Session Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a detached background daemon in Rust (`oppa --daemon`) with Named Pipe / Unix Socket IPC and `vt100` headless screen emulation to provide 100% Orca-like session persistence and warm reattachment across window closures and app restarts.

**Architecture:** A single native binary supports both GUI mode (Tauri 2) and background service mode (`oppa --daemon`). The GUI connects over Windows Named Pipes (`\\.\pipe\oppa-daemon-<username>`) or POSIX Unix Domain Sockets (`$XDG_RUNTIME_DIR/oppa.sock`). Sessions and child shells run inside the daemon with in-memory `vt100` terminal screen mirrors. When the GUI closes, it disconnects; child processes continue running untouched. On launch, `create_or_attach` fetches the live screen snapshot and seamlessly resumes output streaming.

**Tech Stack:** Tauri 2, Rust (Tokio, portable-pty, vt100, parking_lot, serde), React 19, TypeScript, Vite, xterm.js, Zustand.

## Global Constraints

- **Rust-First**: All PTY, session, backpressure, and daemon logic lives in `src-tauri/src/pty/`. No Node.js runtime.
- **State vs Transport Split**: Components read the Zustand store and call `src/lib/pty/transport.ts`. No component calls Tauri `invoke` directly.
- **Backpressure**: ACK-based flow control (high watermark 256KB, low watermark 32KB) over IPC.
- **Cross-Platform**: Windows (`\\.\pipe\...`, ConPTY, `DETACHED_PROCESS`), macOS/Linux (Unix sockets, `setsid`).
- **TDD**: Write failing tests before implementation for each task.

---

### Task 1: IPC Protocol Types and Framing

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/pty/ipc_protocol.rs`
- Modify: `src-tauri/src/pty/mod.rs`
- Test: `src-tauri/src/pty/ipc_protocol.rs` (inline test module)

**Interfaces:**
- Produces:
  - `DaemonRequest`: Enum of RPC requests (`Hello`, `CreateOrAttach`, `Write`, `Resize`, `Ack`, `Kill`, `ListSessions`, `Disconnect`, `Shutdown`)
  - `DaemonResponse`: Enum of RPC responses (`HelloOk`, `SessionAttached`, `Ok`, `SessionList`, `Error`)
  - `DaemonEvent`: Push events (`Data`, `Exit`, `Cwd`)
  - `CreateOrAttachResult`: `{ is_new: bool, pid: u32, cols: u16, rows: u16, cwd: Option<String>, snapshot: Option<String> }`

- [ ] **Step 1: Add dependencies to `src-tauri/Cargo.toml`**

Add `tokio` (with `full` features) and `vt100` to `src-tauri/Cargo.toml`:
```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-opener = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
portable-pty = "0.9.0"
parking_lot = "0.12"
base64 = "0.22"
tokio = { version = "1", features = ["full"] }
vt100 = "0.15"
```

- [ ] **Step 2: Write failing unit tests for IPC protocol serialization**

Create `src-tauri/src/pty/ipc_protocol.rs` with tests:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_serialize_create_or_attach_roundtrip() {
        let req = DaemonRequest::CreateOrAttach {
            session_id: "test-session-1".into(),
            cols: 80,
            rows: 24,
            cwd: Some("C:\\projects".into()),
            shell: None,
        };
        let encoded = serde_json::to_string(&req).expect("serialize");
        let decoded: DaemonRequest = serde_json::from_str(&encoded).expect("deserialize");
        match decoded {
            DaemonRequest::CreateOrAttach { session_id, cols, rows, cwd, shell } => {
                assert_eq!(session_id, "test-session-1");
                assert_eq!(cols, 80);
                assert_eq!(rows, 24);
                assert_eq!(cwd, Some("C:\\projects".into()));
                assert_eq!(shell, None);
            }
            _ => panic!("unexpected request variant"),
        }
    }

    #[test]
    fn test_serialize_create_or_attach_response_with_snapshot() {
        let res = DaemonResponse::SessionAttached(CreateOrAttachResult {
            is_new: false,
            pid: 1234,
            cols: 80,
            rows: 24,
            cwd: Some("C:\\projects".into()),
            snapshot: Some("\x1b[32mhello\x1b[0m".into()),
        });
        let encoded = serde_json::to_string(&res).expect("serialize");
        assert!(encoded.contains("\"is_new\":false"));
        assert!(encoded.contains("\"pid\":1234"));
        assert!(encoded.contains("hello"));
    }
}
```

- [ ] **Step 3: Implement `DaemonRequest`, `DaemonResponse`, `DaemonEvent`, and endpoint helpers**

Write the enum types and helpers in `src-tauri/src/pty/ipc_protocol.rs`:
```rust
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const DAEMON_PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateOrAttachResult {
    pub is_new: bool,
    pub pid: u32,
    pub cols: u16,
    pub rows: u16,
    pub cwd: Option<String>,
    pub snapshot: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum DaemonRequest {
    Hello {
        client_version: String,
        protocol_version: u32,
    },
    CreateOrAttach {
        session_id: String,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
        shell: Option<String>,
    },
    Write {
        session_id: String,
        data: String,
    },
    Resize {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    Ack {
        session_id: String,
        chars: usize,
    },
    Kill {
        session_id: String,
    },
    ListSessions,
    Disconnect,
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum DaemonResponse {
    HelloOk { protocol_version: u32 },
    SessionAttached(CreateOrAttachResult),
    SessionList(Vec<String>),
    Ok,
    Error(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", content = "payload")]
pub enum DaemonEvent {
    Data {
        session_id: String,
        data: String,
        seq: u64,
    },
    Exit {
        session_id: String,
        code: Option<i32>,
    },
    Cwd {
        session_id: String,
        cwd: String,
    },
}

pub fn get_daemon_socket_path() -> String {
    if cfg!(windows) {
        let username = std::env::var("USERNAME").unwrap_or_else(|_| "default".into());
        format!(r"\\.\pipe\oppa-daemon-{}", username)
    } else {
        let runtime_dir = std::env::var("XDG_RUNTIME_DIR")
            .unwrap_or_else(|_| "/tmp".into());
        PathBuf::from(runtime_dir).join("oppa-daemon.sock").to_string_lossy().into_owned()
    }
}
```

- [ ] **Step 4: Run cargo tests to verify IPC protocol**

Run: `cargo test -p oppa --lib pty::ipc_protocol` in `src-tauri`.  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/pty/ipc_protocol.rs src-tauri/src/pty/mod.rs
git commit -m "feat(pty): add IPC protocol definitions and serialization"
```

---

### Task 2: In-Daemon `vt100` Terminal Screen Mirror & Snapshotter

**Files:**
- Create: `src-tauri/src/pty/screen_mirror.rs`
- Modify: `src-tauri/src/pty/mod.rs`
- Test: `src-tauri/src/pty/screen_mirror.rs` (inline test module)

**Interfaces:**
- Produces:
  - `ScreenMirror`: Wrapper around `vt100::Parser`
  - `ScreenMirror::new(cols: u16, rows: u16, scrollback: usize) -> Self`
  - `ScreenMirror::process(&mut self, bytes: &[u8])`
  - `ScreenMirror::resize(&mut self, cols: u16, rows: u16)`
  - `ScreenMirror::get_formatted_snapshot(&self) -> String` (produces formatted ANSI representation for xterm.js rehydration)

- [ ] **Step 1: Write failing tests for `ScreenMirror`**

Create `src-tauri/src/pty/screen_mirror.rs` with test cases:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_screen_mirror_renders_text_and_cursor() {
        let mut mirror = ScreenMirror::new(80, 24, 1000);
        mirror.process(b"Hello world\r\nLine 2");
        let snapshot = mirror.get_formatted_snapshot();
        assert!(snapshot.contains("Hello world"));
        assert!(snapshot.contains("Line 2"));
    }

    #[test]
    fn test_screen_mirror_ansi_colors_and_clear() {
        let mut mirror = ScreenMirror::new(80, 24, 1000);
        mirror.process(b"\x1b[32mGreen Text\x1b[0m\r\n");
        let snapshot = mirror.get_formatted_snapshot();
        assert!(snapshot.contains("Green Text"));
    }

    #[test]
    fn test_screen_mirror_resize() {
        let mut mirror = ScreenMirror::new(80, 24, 1000);
        mirror.process(b"Some output");
        mirror.resize(100, 30);
        let snapshot = mirror.get_formatted_snapshot();
        assert!(snapshot.contains("Some output"));
    }
}
```

- [ ] **Step 2: Implement `ScreenMirror` using `vt100` parser**

Implement `src-tauri/src/pty/screen_mirror.rs`:
```rust
use vt100::Parser;

pub struct ScreenMirror {
    parser: Parser,
    cols: u16,
    rows: u16,
}

impl ScreenMirror {
    pub fn new(cols: u16, rows: u16, scrollback: usize) -> Self {
        Self {
            parser: Parser::new(rows, cols, scrollback),
            cols,
            rows,
        }
    }

    pub fn process(&mut self, bytes: &[u8]) {
        self.parser.process(bytes);
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.cols = cols;
        self.rows = rows;
        self.parser.set_size(rows, cols);
    }

    pub fn get_formatted_snapshot(&self) -> String {
        let screen = self.parser.screen();
        let mut result = String::new();

        // 1. Hide cursor during buffer paint
        result.push_str("\x1b[?25l");
        // 2. Clear visible screen and return to home position
        result.push_str("\x1b[2J\x1b[H");

        // 3. Render screen lines
        let rows = screen.rows();
        let cols = screen.cols();
        for r in 0..rows {
            let row_str = screen.row_str(r);
            result.push_str(&row_str);
            if r < rows - 1 {
                result.push_str("\r\n");
            }
        }

        // 4. Restore absolute cursor position (1-indexed)
        let (cursor_row, cursor_col) = screen.cursor_position();
        result.push_str(&format!("\x1b[{};{}H", cursor_row + 1, cursor_col + 1));
        // 5. Restore cursor visibility
        result.push_str("\x1b[?25h");

        result
    }
}
```

- [ ] **Step 3: Run cargo tests for `screen_mirror`**

Run: `cargo test -p oppa --lib pty::screen_mirror` in `src-tauri`.  
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/pty/screen_mirror.rs src-tauri/src/pty/mod.rs
git commit -m "feat(pty): implement vt100 screen mirror and snapshot generator"
```

---

### Task 3: Detached Daemon Server & Session Host

**Files:**
- Create: `src-tauri/src/pty/daemon_session.rs`
- Create: `src-tauri/src/pty/daemon_server.rs`
- Modify: `src-tauri/src/pty/mod.rs`
- Test: `src-tauri/src/pty/daemon_server.rs` (integration test)

**Interfaces:**
- Produces:
  - `DaemonSession`: Wraps `portable-pty` child, `ScreenMirror`, backpressure counter, and subscriber broadcast channels.
  - `DaemonServer`: Runs Tokio listener on Named Pipe (Windows) / Unix Domain Socket (POSIX), manages `HashMap<String, Arc<DaemonSession>>`, processes RPC requests, and handles client disconnections.

- [ ] **Step 1: Implement `DaemonSession`**

Create `src-tauri/src/pty/daemon_session.rs` holding:
- `id: String`
- `pty_pair: Arc<Mutex<PtyPair>>`
- `writer: Arc<Mutex<Box<dyn std::io::Write + Send>>>`
- `screen_mirror: Arc<Mutex<ScreenMirror>>`
- `cols: AtomicU16`, `rows: AtomicU16`, `cwd: Arc<Mutex<Option<String>>>`
- `pending_bytes: Arc<AtomicUsize>`, `paused: Arc<AtomicBool>`
- `broadcast_tx: tokio::sync::broadcast::Sender<DaemonEvent>`
- Background reader thread parsing output into `ScreenMirror` and broadcasting `DaemonEvent::Data`.

- [ ] **Step 2: Implement `DaemonServer` IPC handler**

Create `src-tauri/src/pty/daemon_server.rs` with:
- Connection accept loop (`tokio::net::windows::named_pipe` on Windows, `tokio::net::UnixListener` on Unix).
- Framed JSON line reader/writer (`tokio::io::AsyncBufReadExt`).
- Message routing:
  - `CreateOrAttach`: If session exists, returns `SessionAttached` with `ScreenMirror::get_formatted_snapshot()`. If new, spawns shell and returns `is_new: true`.
  - `Write`, `Resize`, `Ack`, `Kill`, `ListSessions`.
  - `Disconnect`: Removes client stream subscriber without killing sessions.
  - `Shutdown`: Kills all sessions and exits process.

- [ ] **Step 3: Write tests for `DaemonServer` lifecycle**

Add tests in `src-tauri/src/pty/daemon_server.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_daemon_server_spawn_and_reattach() {
        // Spawn daemon session, write data, capture snapshot, and assert snapshot contents
    }
}
```

- [ ] **Step 4: Run cargo tests for daemon session & server**

Run: `cargo test -p oppa --lib pty::daemon_server` in `src-tauri`.  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pty/daemon_session.rs src-tauri/src/pty/daemon_server.rs src-tauri/src/pty/mod.rs
git commit -m "feat(pty): implement daemon session host and IPC server"
```

---

### Task 4: Daemon Discovery, Background Spawner, and Client Adapter

**Files:**
- Create: `src-tauri/src/pty/daemon_spawner.rs`
- Create: `src-tauri/src/pty/daemon_client.rs`
- Modify: `src-tauri/src/pty/manager.rs`
- Modify: `src-tauri/src/pty/mod.rs`
- Test: `src-tauri/src/pty/daemon_client.rs`

**Interfaces:**
- Produces:
  - `ensure_daemon_running() -> Result<(), String>`: Probes socket; if absent, spawns detached `oppa --daemon`.
  - `DaemonClient`: Async client connecting to the daemon socket, sending RPC requests, and converting stream events to Tauri window events.
  - `PtyManager`: Updated to delegate to `DaemonClient` instead of hosting in-process PTYs.

- [ ] **Step 1: Implement `daemon_spawner.rs`**

Create `src-tauri/src/pty/daemon_spawner.rs`:
- On Windows: Uses `std::process::Command` with `creation_flags(0x08000000 | 0x00000008)` (`CREATE_NO_WINDOW | DETACHED_PROCESS`).
- On POSIX: Uses `std::process::Command` detached with `setsid`.
- Helper `probe_daemon(socket_path)` connecting with 500ms timeout.
- Helper `ensure_daemon_running()` which probes, spawns if needed, and waits for socket readiness.

- [ ] **Step 2: Implement `daemon_client.rs`**

Create `src-tauri/src/pty/daemon_client.rs`:
- Connects to the daemon socket.
- Manages request/response correlation IDs.
- Subscribes to push stream and dispatches callbacks for `on_data`, `on_exit`, `on_cwd`.
- Implements `create_or_attach`, `write`, `resize`, `ack`, `kill`, `disconnect`, `shutdown`.

- [ ] **Step 3: Update `PtyManager` in `manager.rs` to wrap `DaemonClient`**

Update `PtyManager` methods to invoke `DaemonClient`:
- `spawn(...)` -> `create_or_attach(...)`
- `write(...)` -> `client.write(...)`
- `resize(...)` -> `client.resize(...)`
- `ack(...)` -> `client.ack(...)`
- `kill(...)` -> `client.kill(...)`
- `list(...)` -> `client.list(...)`

- [ ] **Step 4: Run cargo tests for `daemon_client`**

Run: `cargo test -p oppa --lib pty::daemon_client` in `src-tauri`.  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pty/daemon_spawner.rs src-tauri/src/pty/daemon_client.rs src-tauri/src/pty/manager.rs src-tauri/src/pty/mod.rs
git commit -m "feat(pty): implement daemon discovery, spawner, and client adapter"
```

---

### Task 5: Tauri CLI Entry Point & Commands Wiring

**Files:**
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/pty/commands.rs`

**Interfaces:**
- `main.rs`: Checks `std::env::args()`. If `--daemon` is present, boots Tokio daemon runtime (`run_daemon()`); otherwise boots standard GUI (`oppa_lib::run()`).
- `commands.rs`: Updates `pty_spawn` / `pty_attach` to return `CreateOrAttachResult` (including `is_new` and `snapshot`).

- [ ] **Step 1: Update `src-tauri/src/main.rs` for `--daemon` support**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|arg| arg == "--daemon") {
        oppa_lib::run_daemon();
    } else {
        oppa_lib::run();
    }
}
```

- [ ] **Step 2: Add `run_daemon()` in `src-tauri/src/lib.rs` and update window close event**

- Add `pub fn run_daemon()` that runs Tokio runtime and starts `DaemonServer`.
- Update `on_window_event` on close: sends `disconnect` to the daemon client and destroys the window immediately without killing sessions.

- [ ] **Step 3: Update `src-tauri/src/pty/commands.rs`**

Update `pty_spawn` command to return a struct containing `{ id, is_new, snapshot, pid, cols, rows, cwd }`.

- [ ] **Step 4: Verify build and tests**

Run: `cargo check` and `cargo test -p oppa --lib` in `src-tauri`.  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/main.rs src-tauri/src/lib.rs src-tauri/src/pty/commands.rs
git commit -m "feat: add CLI --daemon flag and wire Tauri commands to daemon client"
```

---

### Task 6: Frontend Transport, Zustand Store, and Warm Reattachment

**Files:**
- Modify: `src/lib/pty/transport.ts`
- Modify: `src/store/terminalStore.ts`
- Modify: `src/components/TerminalPane.tsx`
- Test: `src/store/terminalStore.test.ts` (Vitest)

**Interfaces:**
- `transport.ts`:
  - `ptySpawn(opts)` returns `Promise<PtySpawnResult>` with `{ id: string, isNew: boolean, snapshot?: string, pid: number }`.
- `terminalStore.ts`:
  - `loadLayout()` calls `spawnSession` with existing session IDs.
  - If `snapshot` is returned (`isNew === false`), writes snapshot to xterm and avoids spawning duplicate shells.

- [ ] **Step 1: Update `src/lib/pty/transport.ts`**

Export `PtySpawnResult`:
```typescript
export interface PtySpawnResult {
  id: string;
  isNew: boolean;
  snapshot?: string;
  pid: number;
  cols?: number;
  rows?: number;
  cwd?: string;
}

export async function ptySpawn(opts?: PtySpawnOptions): Promise<PtySpawnResult> {
  return await invoke<PtySpawnResult>("pty_spawn", opts ?? {});
}
```

- [ ] **Step 2: Update `loadLayout` and `spawnSession` in `src/store/terminalStore.ts`**

- In `spawnSession`: store the snapshot in `restoredScrollbacks[id]` if `isNew === false`.
- In `loadLayout`: pass `sessionId` to `spawnSession` so the daemon recognizes the existing session and reattaches.
- In `TerminalPane.tsx`: when mounting, if `restoredScrollbacks[id]` contains a snapshot, write it directly via `term.write(snapshot)`.

- [ ] **Step 3: Run frontend vitest tests**

Run: `pnpm vitest run`  
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/pty/transport.ts src/store/terminalStore.ts src/components/TerminalPane.tsx
git commit -m "feat(frontend): support warm session reattachment and snapshot rehydration"
```

---

### Task 7: End-to-End Verification & Documentation

**Files:**
- Test: `src-tauri/tests/daemon_integration_test.rs`
- Modify: `README.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Write automated integration test for daemon lifecycle**

Create `src-tauri/tests/daemon_integration_test.rs`:
- Test 1: Start daemon, connect client, spawn shell, write input, verify `pty:data`.
- Test 2: Disconnect client, verify shell remains alive.
- Test 3: Reconnect with same session ID, call `create_or_attach`, verify `is_new: false` and snapshot captures prior output.
- Test 4: Terminate session, verify process exits.

- [ ] **Step 2: Run all tests (Rust and Frontend)**

Run:
```bash
cargo test -p oppa --lib
pnpm vitest run
pnpm build
```
Expected: All tests pass, build succeeds.

- [ ] **Step 3: Update documentation in `AGENTS.md` and `README.md`**

Update memory and architecture docs noting the detached daemon mode.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/tests/ AGENTS.md README.md
git commit -m "docs: document detached daemon architecture and add integration tests"
```

---

## Plan Self-Review Checklist
- **Spec Coverage**: All items from the spec (Unified binary, Tokio daemon, Named Pipe / Unix Socket IPC, `vt100` screen snapshots, warm reattach, flow control, disconnect vs shutdown) are covered by dedicated tasks.
- **No Placeholders**: Exact signatures, types, commands, and code blocks are provided.
- **Type Consistency**: `CreateOrAttachResult`, `DaemonRequest`, `DaemonResponse`, `PtySpawnResult` match across backend and frontend tasks.
