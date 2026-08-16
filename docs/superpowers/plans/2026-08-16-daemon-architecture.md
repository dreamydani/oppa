# OPPA — Daemon Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PTY sessions (including AI CLIs like claude/opencode) survive app restarts, matching Orca's behavior, by moving session ownership into a detached Rust daemon that the app reattaches to.

**Architecture:** A separate `daemon` binary owns `PtyManager` (the existing Tauri-free PTY core). The app talks to it over a named pipe (Windows) / Unix socket (POSIX) with a length-prefixed NDJSON protocol: a control channel (request/response RPC) + a stream channel (one-way `pty:data`/`pty:exit` events). The daemon persists after app close (idle-exits after no sessions for a timeout) and keeps a per-session scrollback ring buffer so reattach repaints the screen. The renderer's `transport.ts`/`TerminalPane.tsx` need no changes for the happy path — the app's daemon client re-emits the same events.

**Tech Stack:** Rust (portable-pty, serde, serde_json, parking_lot; named pipes via `uds_windows`/`miow` or tokio on Windows, `std::os::unix::net` on POSIX), React 19 + TS + zustand (renderer changes).

**Spec:** `docs/superpowers/specs/2026-08-16-terminal-core-design.md` (deferred-daemon note) + the approved plan at `~/.commandcode/plans/oppa-daemon-architecture.md`.

## Global Constraints

- **Rust-first**: no Node runtime. The daemon is a Rust binary.
- **0xc0000139 constraint**: the daemon + protocol must be Tauri-free and testable without Tauri's runtime (Tauri types in test-visible paths break the Windows test binary load).
- **Never drop output**: backpressure (256KB/32KB watermarks) must bridge the IPC hop; pause = stop reading.
- **Backpressure is ACK-based**: renderer ACKs chars; the daemon pauses/resumes the read loop. `ack` becomes an RPC.
- **Process-tree kill**: the daemon kills the full process group on session kill, never leaks shells.
- **Detached daemon**: survives app close on Windows (`CREATE_NO_WINDOW` + detach); single-instance via endpoint bind.
- **Idle exit**: daemon exits after N minutes (e.g. 5) with no sessions and no connected client.
- **Session ids**: persistent/UUID-style (not per-process counter) to avoid collisions across daemon restarts.
- **State vs transport split** (renderer): `transport.ts` is the only Tauri-touching file; the store owns attach-vs-spawn.
- **Testing**: Rust `cargo test -p oppa --lib` (daemon as child process in tests); renderer `pnpm vitest run` with transport mocked.
- **Frequent commits** — every task ends with a commit.

---

### Task 1: Daemon binary scaffold + shared protocol types

**Files:**
- Create: `src-tauri/src/bin/daemon.rs`
- Create: `src-tauri/src/daemon/mod.rs`
- Create: `src-tauri/src/daemon/protocol.rs`
- Modify: `src-tauri/Cargo.toml` (add `[[bin]] daemon`, `uds_windows`/`miow` or tokio, `uuid`)
- Modify: `src-tauri/src/lib.rs` (add `mod daemon;`)

**Interfaces:**
- Consumes: `PtyManager` (existing), serde
- Produces: `daemon::protocol::{Request, Response, Event, Hello}` serde types; a `main()` that binds the endpoint and echoes `Ping -> Pong`.

- [ ] **Step 1: Add the `[[bin]]` target + IPC deps**

In `Cargo.toml` add:
```toml
[[bin]]
name = "oppa-daemon"
path = "src/bin/daemon.rs"
```
And deps: `uuid = { version = "1", features = ["v4"] }`, plus the platform IPC crate (`uds_windows = "1"` on Windows; std unix socket on POSIX). Verify `cargo build --bin oppa-daemon` compiles an empty `main`.

- [ ] **Step 2: Write the protocol types (failing test first)**

In `src-tauri/src/daemon/protocol.rs`, define serde types:
```rust
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Request {
    Ping,
    Spawn { shell: Option<String>, cwd: Option<String>, cols: u16, rows: u16 },
    Write { id: String, data: String },
    Resize { id: String, cols: u16, rows: u16 },
    Kill { id: String },
    Ack { id: String, chars: usize },
    List,
    GetScrollback { id: String },
}
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Response {
    Pong,
    Spawned { id: String },
    Ok,
    Sessions { sessions: Vec<SessionInfo> },
    Scrollback { ansi: String },
    Error { message: String },
}
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct SessionInfo { pub id: String, pub cols: u16, pub rows: u16, pub cwd: Option<String> }
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event { Data { id: String, data: String, seq: u64 }, Exit { id: String, code: Option<i32> } }
```
Write a test asserting round-trip serialization of each variant.

- [ ] **Step 3: Implement + verify**

Run `cargo test -p oppa --lib` (protocol tests pass) and `cargo check --bin oppa-daemon`.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/bin/daemon.rs src-tauri/src/daemon src-tauri/src/lib.rs
git commit -m "feat: daemon binary scaffold with shared protocol types"
```

---

### Task 2: Daemon main — bind endpoint, serve Ping, idle-exit timer

**Files:**
- Modify: `src-tauri/src/bin/daemon.rs`
- Create: `src-tauri/src/daemon/endpoint.rs` (endpoint path/name resolution + bind)
- Test: inline tests

**Interfaces:**
- Consumes: protocol types
- Produces: `daemon::endpoint::endpoint_name(app_data_dir: &Path) -> String` (Windows named pipe name / POSIX socket path); a `main()` that binds, accepts one connection, serves `Ping`, and idle-exits.

- [ ] **Step 1: Write failing test for endpoint resolution**

Test that `endpoint_name` produces a stable, hash-suffixed name from a given app data dir, and that it's platform-consistent.

- [ ] **Step 2: Implement endpoint resolution**

Windows: `\\.\pipe\oppa-daemon-<sha256(app_data_dir)[0:12]>`. POSIX: `<app_data_dir>/daemon.sock`. Use `sha2` or a simple hash for the suffix (add `sha2` dep or fold a uuid-based approach).

- [ ] **Step 3: Implement `main()` bind + Ping loop + idle timer**

Bind the endpoint (named pipe server on Windows via `uds_windows`; `UnixListener` on POSIX). Accept a connection, read length-prefixed NDJSON `Ping`, reply `Pong`. An idle timer thread exits the process after 5 min with no connection.

- [ ] **Step 4: Integration test — spawn daemon as child, Ping**

In a `#[cfg(test)]` (Tauri-free): spawn the daemon binary (`env!("CARGO_BIN_EXE_oppa-daemon")`), connect to the endpoint, send `Ping`, assert `Pong`. This proves the binary + endpoint + framing work end-to-end without Tauri.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/bin/daemon.rs src-tauri/src/daemon
git commit -m "feat: daemon binds endpoint and serves ping"
```

---

### Task 3: Daemon owns PtyManager — Spawn/Write/Resize/Kill/Ack/List over IPC

**Files:**
- Modify: `src-tauri/src/bin/daemon.rs`
- Create: `src-tauri/src/daemon/server.rs` (RPC dispatch + stream events)
- Modify: `src-tauri/src/pty/manager.rs` (expose what's needed; add scrollback tee hook in Task 4)
- Test: integration tests via child-process daemon

**Interfaces:**
- Consumes: `PtyManager`, protocol types
- Produces: a daemon `main()` that serves the full RPC surface. `Spawn` → `PtyManager::spawn` with `OnData`/`OnExit` closures that serialize to `Event::Data`/`Event::Exit` frames on the stream channel. `Write/Resize/Kill/Ack/List` → manager calls.

- [ ] **Step 1: Write failing integration tests**

Spawn the daemon child; connect; `Spawn { shell: "sh", cols, rows }`; assert a session id returns. `Write "echo hi\n"`; assert a `Data` event with "hi" arrives on the stream. `Kill`; assert an `Exit` event.

- [ ] **Step 2: Implement RPC dispatch in the daemon**

The control channel: read request → match → call manager → write response. The stream channel: the `OnData`/`OnExit` closures serialize events and write to the stream connection. Two sockets per client (control + stream), mirroring Orca.

- [ ] **Step 3: Wire ack → backpressure**

`Ack` RPC decrements `pending_bytes` (the manager's existing `ack`). The read loop pauses/resumes as today.

- [ ] **Step 4: Verify all tests pass**

`cargo test -p oppa --lib` — daemon integration tests + the existing 19 manager tests.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/bin/daemon.rs src-tauri/src/daemon/server.rs src-tauri/src/pty/manager.rs
git commit -m "feat: daemon serves pty rpc with event stream"
```

---

### Task 4: Scrollback ring buffer in the daemon

**Files:**
- Create: `src-tauri/src/daemon/scrollback.rs`
- Modify: `src-tauri/src/bin/daemon.rs` / `server.rs` (tee into buffer, serve `GetScrollback`)
- Test: inline tests + integration

**Interfaces:**
- Consumes: read-loop chunks
- Produces: `Scrollback::new(max_lines, max_bytes) -> Self`, `push(&mut self, chunk: &[u8])`, `to_ansi(&self) -> String`. `GetScrollback { id }` returns the buffered ANSI.

- [ ] **Step 1: Write failing scrollback tests**

Push chunks, assert `to_ansi` returns them in order; push more than cap, assert oldest is evicted; byte cap respected.

- [ ] **Step 2: Implement the ring buffer**

A `VecDeque<Vec<u8>>` with a line/byte budget; `push` appends, evicts from the front past the cap. Keep it a plain byte buffer (no terminal emulation — the renderer's xterm parses it).

- [ ] **Step 3: Tee the read loop into scrollback**

In the daemon's `OnData` closure (or the manager's read loop), push each chunk to the session's scrollback buffer. Serve `GetScrollback` from it.

- [ ] **Step 4: Verify**

Integration test: spawn, write a burst, `GetScrollback` returns the accumulated ANSI.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/daemon/scrollback.rs src-tauri/src/bin/daemon.rs
git commit -m "feat: per-session scrollback ring buffer in daemon"
```

---

### Task 5: App-side daemon client + command proxies

**Files:**
- Create: `src-tauri/src/daemon_client.rs`
- Modify: `src-tauri/src/lib.rs` (manage client, spawn daemon on setup)
- Modify: `src-tauri/src/pty/commands.rs` (commands become proxies)
- Test: Tauri-free client tests

**Interfaces:**
- Consumes: protocol types, `tauri::AppHandle`, `tauri::Emitter`
- Produces: `DaemonClient` with `connect()`, `spawn(...)`, `write(id, data)`, `resize(...)`, `kill(id)`, `ack(id, chars)`, `list()`, `get_scrollback(id)`, `is_connected()`. A listener thread re-emits daemon stream events as `pty:data`/`pty:exit` via `app.emit`. The `#[tauri::command]`s forward to the client.

- [ ] **Step 1: Write failing Tauri-free client test**

Connect to a test daemon (child process), `spawn`/`write`/`list` round-trip.

- [ ] **Step 2: Implement `DaemonClient`**

Connect to the endpoint (named pipe/socket), do the hello/auth handshake (token file), send requests, receive responses. A stream reader thread emits Tauri events.

- [ ] **Step 3: Proxy the commands**

`pty_spawn` etc. call `daemon_client.spawn(...)` instead of `PtyManager` directly. Keep the return types (`Result<_, String>`).

- [ ] **Step 4: Spawn daemon on app setup**

In `lib.rs` setup, probe the endpoint; if refused/missing, spawn `oppa-daemon` detached, wait for ready, connect.

- [ ] **Step 5: Verify**

`cargo test` (client tests + all existing), `cargo check`.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/daemon_client.rs src-tauri/src/lib.rs src-tauri/src/pty/commands.rs
git commit -m "feat: app daemon client proxies pty commands"
```

---

### Task 6: Renderer — attachSession, loadLayout attach-vs-spawn, detach-on-close

**Files:**
- Modify: `src/lib/pty/transport.ts` (add `daemonList`, `getScrollback`, `attachSession`)
- Modify: `src/store/terminalStore.ts` (add `attachSession`, `loadLayout` attaches to live sessions)
- Modify: `src/App.tsx` (close handshake detaches, doesn't kill)
- Modify: `src/components/TerminalPane.tsx` (render scrollback replay on attach)
- Test: store + pane tests

**Interfaces:**
- Consumes: `transport.daemonList()` -> `SessionInfo[]`, `transport.getScrollback(id)` -> `string`
- Produces: store `attachSession(id)` — registers a session from the daemon list; `loadLayout` — for each saved leaf, if a live session id exists, attach; else spawn fresh.

- [ ] **Step 1: Write failing store tests**

`attachSession` registers a daemon-listed session. `loadLayout` with a live daemon session attaches (no spawn) vs a dead one spawns fresh.

- [ ] **Step 2: Implement transport + store**

`transport.daemonList()`, `getScrollback(id)`, store `attachSession`. `loadLayout` becomes: `const live = await daemonList(); for each leaf: if live[id] attach else spawnSession`.

- [ ] **Step 3: TerminalPane scrollback replay**

On attach, fetch scrollback and `term.write(ansi)` before live data (the `seq` gap is handled by the daemon continuing from its counter).

- [ ] **Step 4: App close detaches**

The close handshake (`app:before-close`) still saves the layout, but does NOT kill sessions — the daemon keeps them. `confirm_save_complete` still lets the app exit; the daemon idle-exits later.

- [ ] **Step 5: Verify**

`pnpm vitest run` (all renderer tests), `pnpm build`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/pty/transport.ts src/store/terminalStore.ts src/App.tsx src/components/TerminalPane.tsx
git commit -m "feat: reattach to live daemon sessions on restore"
```

---

### Task 7: End-to-end verification + polish

**Files:**
- Modify: `src-tauri/src/lib.rs` (final close semantics)
- Modify: `src-tauri/src/bin/daemon.rs` (idle-exit tuning, auth token)
- Manual verification checklist

- [ ] **Step 1: Auth token hardening**

Daemon writes a token file (random UUID, 0600) next to the endpoint; the client hello must present it. Test that a wrong-token connection is rejected.

- [ ] **Step 2: Idle-exit verification**

Start daemon, connect + spawn a session, disconnect (simulate app close), verify the daemon keeps the session, then idle-exits after the timeout with no sessions.

- [ ] **Step 3: Full suite + smoke**

`cargo test -p oppa --lib`, `cargo check`, `pnpm vitest run`, `pnpm build`. Launch the app binary (smoke).

- [ ] **Step 4: Human verification checklist (documented for the user)**

Open claude/opencode in a pane → close app → relaunch → agent resumes with scrollback. Verify daemon process survives app close and idle-exits.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs src-tauri/src/bin/daemon.rs
git commit -m "feat: daemon auth token and idle lifecycle polish"
```

---

## Self-Review Notes

- **Spec coverage:** daemon binary (1-2), PTY ownership + IPC (3), scrollback (4), app client + proxies (5), renderer attach (6), end-to-end (7). All plan sections covered.
- **Type consistency:** `Request`/`Response`/`Event`/`SessionInfo` serde types consistent across daemon, client, and transport. `pty:data { id, data, seq }` / `pty:exit { id, code }` unchanged (renderer compatibility).
- **No placeholders:** every task has concrete steps with code.
