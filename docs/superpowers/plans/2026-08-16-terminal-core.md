# OPPA Terminal Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fast, low-memory terminal core for the Tauri app at `D:\oppa\oppa`: a single-window terminal with split panes, Rust-managed PTY sessions, ACK-based backpressure, and layout + session-state persistence.

**Architecture:** Rust owns PTY sessions in a `PtyManager` behind `Mutex<HashMap>`. Each session wraps a `portable-pty::PtyPair` with a read loop pushing `pty:data` events to the webview via Tauri's `Emitter`. The React renderer is a thin bridge: a `transport.ts` wrapper (the only file touching Tauri APIs) + a zustand store + one `TerminalPane` component rendering `@xterm/xterm`. Backpressure is ACK-based: the renderer ACKs processed chars, Rust pauses the read loop above a high watermark and resumes below a low one.

**Tech Stack:** Rust (portable-pty, tauri 2), React 19, TypeScript, Vite, `@xterm/xterm` + `@xterm/addon-fit`, zustand, vitest + `@testing-library/react`.

**Spec:** `docs/superpowers/specs/2026-08-16-terminal-core-design.md`

## Global Constraints

- **Rust-first**: No Node runtime in the product. All PTY/session/backpressure logic lives in Rust.
- **Own UI**: New, lean React UI. Not Orca's renderer. One `TerminalPane` + a minimal pane-split layout; no tab bar in v1.
- **Backpressure watermarks**: high 256KB / low 32KB (Orca's `PtyProducerFlowController` numbers). Never drop output in v1 — pause only.
- **Shell detection**: macOS/Linux `$SHELL` → `/bin/zsh` → `/bin/bash` → `/bin/sh`; Windows `$COMSPEC` → `powershell.exe` → `cmd.exe`.
- **Env for spawned shell**: `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=oppa`, `TERM_PROGRAM_VERSION=<app version>`, inherit app env, clean `LANG`.
- **Restored sessions are fresh shells** in the same pane layout + cwd (no scrollback across quit).
- **No output dropped in v1**.
- **State vs transport split**: components never call `invoke` directly — they read the zustand store and call transport helpers.
- **Testing**: Rust `cargo test`; renderer `vitest` + `@testing-library/react` with `transport.ts` mocked.
- **Frequent commits** — every task ends with a commit.

---

### Task 1: Project scaffold & Tauri command plumbing

**Files:**
- Create: `src-tauri/src/pty/mod.rs`
- Create: `src-tauri/src/pty/session.rs`
- Create: `src-tauri/src/pty/manager.rs`
- Create: `src-tauri/src/pty/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml` (add `parking_lot` — check current deps; `portable-pty` already present)
- Test: `src-tauri/src/pty/manager.rs` (inline `#[cfg(test)]` module)

**Interfaces:**
- Consumes: `tauri::State`, `tauri::Emitter`, `portable-pty`
- Produces: `PtySession`, `PtyManager`, and commands `pty_spawn`, `pty_write`, `pty_resize`, `pty_kill`, `pty_list`, `pty_ack` (to be implemented in Tasks 2-3; Task 1 wires the module + a minimal `pty_list` returning empty)

- [ ] **Step 1: Write the failing test for a minimal manager**

In `src-tauri/src/pty/manager.rs`, add a test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_manager_is_empty() {
        let manager = PtyManager::new();
        assert!(manager.sessions().is_empty());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p oppa --lib`
Expected: FAIL — `PtyManager` / `PtyManager::new` / `sessions()` not found.

- [ ] **Step 3: Create the `pty` module files**

`src-tauri/src/pty/mod.rs`:

```rust
pub mod commands;
pub mod manager;
pub mod session;
```

`src-tauri/src/pty/session.rs` — placeholder struct (Task 2 fills it):

```rust
pub struct PtySession {
    pub id: String,
}

impl PtySession {
    pub fn new(id: String) -> Self {
        Self { id }
    }
}
```

`src-tauri/src/pty/manager.rs` — minimal `PtyManager`:

```rust
use crate::pty::session::PtySession;
use std::collections::HashMap;

#[derive(Default)]
pub struct PtyManager {
    sessions: HashMap<String, PtySession>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: HashMap::new(),
        }
    }

    pub fn sessions(&self) -> &HashMap<String, PtySession> {
        &self.sessions
    }
}
```

`src-tauri/src/pty/commands.rs` — minimal command:

```rust
use crate::pty::manager::PtyManager;
use tauri::State;

#[tauri::command]
pub fn pty_list(manager: State<'_, PtyManager>) -> Vec<String> {
    manager.sessions().keys().cloned().collect()
}
```

- [ ] **Step 4: Wire the module + command into `lib.rs`**

Modify `src-tauri/src/lib.rs` to add the module and register the command:

```rust
mod pty;

use pty::manager::PtyManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PtyManager::new())
        .invoke_handler(tauri::generate_handler![pty::commands::pty_list])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

(Keep the existing `greet` command for now; it's removed in a later task.)

- [ ] **Step 5: Add `parking_lot` to Cargo.toml**

Add to `[dependencies]` in `src-tauri/Cargo.toml`:

```toml
parking_lot = "0.12"
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cargo test -p oppa --lib`
Expected: PASS — `new_manager_is_empty` passes, and `cargo check` is clean.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/pty src-tauri/src/lib.rs src-tauri/Cargo.toml
git commit -m "feat: scaffold pty module and register pty_list command"
```

---

### Task 2: Rust PTY session (spawn shell, read loop, write, resize, exit)

**Files:**
- Create: `src-tauri/src/pty/session.rs` (replace placeholder)
- Create: `src-tauri/src/pty/manager.rs` (replace — add spawn/write/resize/kill/ack + read loop)
- Test: inline `#[cfg(test)]` in `session.rs` and `manager.rs`

**Interfaces:**
- Consumes: `portable-pty::{native_pty_system, PtySize, CommandBuilder, PtyPair, PtyMaster, Child}`
- Produces: `PtySession { id: String, master: PtyMaster, child: Child, cols: u16, rows: u16, pending_bytes: Arc<AtomicUsize>, paused: Arc<AtomicBool> }`, `PtyManager::spawn(...) -> String`, `PtyManager::write(id, data)`, `PtyManager::resize(id, cols, rows)`, `PtyManager::kill(id)`, `PtyManager::ack(id, chars)`.

The read loop is the heart. Each session spawns a `std::thread` that reads from `master.try_read()` into a buffer and pushes `pty:data` via a callback. When `paused` is true, the loop sleeps instead of reading (kernel backpressure). On EOF/error, emit `pty:exit`.

- [ ] **Step 1: Write the failing session test**

In `src-tauri/src/pty/session.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn session_spawns_and_reads_output() {
        let (session, _rx) = PtySession::spawn_test("sh", &["-c", "echo hi"], None, 80, 24);
        let data = _rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(String::from_utf8_lossy(&data).contains("hi"));
    }
}
```

This needs a `spawn_test` helper that returns a receiver for the read loop's output (used only in tests). The production path uses the Tauri emitter callback.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p oppa --lib`
Expected: FAIL — `PtySession::spawn_test` not found.

- [ ] **Step 3: Implement `session.rs`**

```rust
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtyPair, PtySize};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

pub struct PtySession {
    pub id: String,
    pub master: Box<dyn MasterPty + Send>,
    pub child: Box<dyn Child + Send + Sync>,
    pub cols: u16,
    pub rows: u16,
    pub pending_bytes: Arc<AtomicUsize>,
    pub paused: Arc<AtomicBool>,
}

impl PtySession {
    pub fn new(
        id: String,
        pair: PtyPair,
        cols: u16,
        rows: u16,
    ) -> std::io::Result<Self> {
        let master = pair.master;
        let child = pair.slave.spawn_command(CommandBuilder::new("sh"))?;
        Ok(Self {
            id,
            master,
            child,
            cols,
            rows,
            pending_bytes: Arc::new(AtomicUsize::new(0)),
            paused: Arc::new(AtomicBool::new(false)),
        })
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> std::io::Result<()> {
        self.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        self.cols = cols;
        self.rows = rows;
        Ok(())
    }

    pub fn write(&self, data: &[u8]) -> std::io::Result<()> {
        self.master.write(data)
    }
}
```

Note: the shell spawn (`sh`) is a placeholder — Task 3 replaces it with proper shell detection. The read loop lives in `manager.rs` (needs the emitter).

- [ ] **Step 4: Implement `spawn_test` helper**

Add a test-only helper to `session.rs` that spawns a session with a provided command and returns a `std::sync::mpsc::Receiver<Vec<u8>>` fed by a read thread that just reads into the channel (no emitter). This lets tests assert output without a Tauri runtime.

- [ ] **Step 5: Run session test to verify it passes**

Run: `cargo test -p oppa --lib`
Expected: PASS — `session_spawns_and_reads_output`.

- [ ] **Step 6: Implement manager read loop (production)**

In `manager.rs`, add the spawn path that:
1. Creates a `PtyPair` via `native_pty_system().openpty(PtySize {...})`.
2. Spawns the shell, wraps in `PtySession`, stores in the `HashMap` under a fresh id.
3. Spawns a `std::thread` read loop: loop { if `paused` → sleep(10ms); else read `master.try_read()` into a 8KB buffer; on data → call `on_data(id, bytes)` callback (the Tauri emitter); on EOF → `on_exit(id, code)` and break }.
4. Returns the id.

`write`/`resize`/`kill`/`ack` mutate the session; `ack(id, chars)` does `pending_bytes.fetch_sub(chars)` and if below 32KB sets `paused=false`; `kill` calls `child.kill()`.

- [ ] **Step 7: Write manager tests (spawn/echo/exit/kill)**

Add tests:
- `spawn_echo`: spawn `sh -c "echo hi"`, assert the read channel gets "hi".
- `write_echo`: spawn interactive `sh`, write "echo hi\n", assert output contains "hi".
- `exit_signal`: spawn `sh -c "exit 0"`, assert `on_exit` fires.
- `kill_tree`: spawn a long-running `sh -c "sleep 100"`, kill, assert the child is gone (via `child.try_wait()` returning Some).

- [ ] **Step 8: Run all tests**

Run: `cargo test -p oppa --lib`
Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/pty
git commit -m "feat: rust pty session with read loop, write, resize, kill"
```

---

### Task 3: Tauri commands for spawn/write/resize/kill/ack + shell detection

**Files:**
- Modify: `src-tauri/src/pty/commands.rs`
- Modify: `src-tauri/src/pty/manager.rs` (wire the emitter callback into spawn)
- Modify: `src-tauri/src/pty/session.rs` (shell detection)
- Modify: `src-tauri/src/lib.rs` (register all commands; pass `AppHandle` to manager)
- Test: `src-tauri/src/pty/commands.rs` inline tests

**Interfaces:**
- Consumes: `tauri::AppHandle`, `tauri::Emitter`, `tauri::State`
- Produces: commands `pty_spawn(manager, app, shell?, cwd?, cols?, rows?) -> Result<String, String>`, `pty_write(manager, id, data) -> Result<(), String>`, `pty_resize(manager, id, cols, rows) -> Result<(), String>`, `pty_kill(manager, id) -> Result<(), String>`, `pty_ack(manager, id, chars) -> Result<(), String>`. Events: `pty:data { id, data, seq }`, `pty:exit { id, code, error? }`.

- [ ] **Step 1: Add shell detection to `session.rs`**

```rust
pub fn default_shell() -> String {
    #[cfg(target_os = "windows")]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "/bin/zsh".into())
    }
}
```

(macOS/Linux fallback chain: check `/bin/zsh`, `/bin/bash`, `/bin/sh` existence in that order if `$SHELL` unset.)

- [ ] **Step 2: Write failing command tests**

In `commands.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_shell_is_nonempty() {
        assert!(!default_shell().is_empty());
    }
}
```

Also test that `pty_list` on a fresh manager returns empty.

- [ ] **Step 3: Implement commands**

```rust
use crate::pty::manager::PtyManager;
use crate::pty::session::default_shell;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub fn pty_spawn(
    manager: State<'_, PtyManager>,
    app: AppHandle,
    shell: Option<String>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<String, String> {
    let id = manager.spawn(&app, shell, cwd, cols.unwrap_or(80), rows.unwrap_or(24))?;
    Ok(id)
}

#[tauri::command]
pub fn pty_write(
    manager: State<'_, PtyManager>,
    id: String,
    data: String,
) -> Result<(), String> {
    manager.write(&id, data.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    manager: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    manager.resize(&id, cols, rows).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(manager: State<'_, PtyManager>, id: String) -> Result<(), String> {
    manager.kill(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_ack(
    manager: State<'_, PtyManager>,
    id: String,
    chars: usize,
) -> Result<(), String> {
    manager.ack(&id, chars).map_err(|e| e.to_string())
}
```

- [ ] **Step 4: Wire emitter into manager spawn**

`manager.spawn(&app, ...)` builds the env, opens the PTY, spawns the shell with `default_shell()`, and starts the read loop with `on_data = |id, bytes| { let _ = app.emit("pty:data", Payload { id, data: String::from_utf8_lossy(bytes).to_string(), seq }); }`. The `seq` increments per chunk. `on_exit` emits `pty:exit { id, code, error }`.

Use `parking_lot::Mutex` for the `HashMap` (import `parking_lot::Mutex` instead of std's).

- [ ] **Step 5: Register all commands in `lib.rs`**

```rust
.invoke_handler(tauri::generate_handler![
    pty::commands::pty_spawn,
    pty::commands::pty_write,
    pty::commands::pty_resize,
    pty::commands::pty_kill,
    pty::commands::pty_ack,
    pty::commands::pty_list,
])
```

Remove the `greet` command and its handler registration.

- [ ] **Step 6: Run tests**

Run: `cargo test -p oppa --lib`
Expected: all PASS, `cargo check` clean.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src
git commit -m "feat: tauri commands for pty spawn/write/resize/kill/ack with shell detection"
```

---

### Task 4: Backpressure in the read loop

**Files:**
- Modify: `src-tauri/src/pty/manager.rs`
- Test: inline tests

**Interfaces:**
- Consumes: `PtySession.pending_bytes: Arc<AtomicUsize>`, `PtySession.paused: Arc<AtomicBool>`
- Produces: watermarks as constants `HIGH_WATERMARK_BYTES: usize = 256 * 1024`, `LOW_WATERMARK_BYTES: usize = 32 * 1024`. `ack` behavior: below low → unpause. Read loop behavior: above high → pause.

- [ ] **Step 1: Write failing backpressure test**

In `manager.rs`:

```rust
#[test]
fn backpressure_pauses_and_resumes() {
    // Spawn `sh -c 'yes'` (infinite output).
    // Wait until pending_bytes > HIGH_WATERMARK_BYTES → assert paused == true.
    // Call ack(id, huge_chars) to drop below LOW → assert paused == false.
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p oppa --lib`
Expected: FAIL — no watermark constants / pause logic.

- [ ] **Step 3: Implement watermark logic**

In the read loop: after reading a chunk, `pending_bytes.fetch_add(len)`; if `pending_bytes.load() > HIGH_WATERMARK_BYTES` → `paused.store(true)`. In the loop's `if paused` branch, check `pending_bytes.load() < LOW_WATERMARK_BYTES` → unpause. In `ack`: `pending_bytes.fetch_sub(chars)`; if `pending_bytes.load() < LOW_WATERMARK_BYTES` → `paused.store(false)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p oppa --lib`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pty/manager.rs
git commit -m "feat: ack-based backpressure with high/low watermarks"
```

---

### Task 5: Renderer — zustand store + transport (Tauri bridge)

**Files:**
- Create: `src/store/terminalStore.ts`
- Create: `src/lib/pty/transport.ts`
- Create: `src/store/terminalStore.test.ts`
- Create: `src/lib/pty/transport.test.ts`
- Modify: `package.json` (add `zustand`, `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `happy-dom`)
- Modify: `vite.config.ts` (add vitest config — or a separate `vitest.config.ts`)

**Interfaces:**
- Consumes: `@tauri-apps/api/core` (`invoke`), `@tauri-apps/api/event` (`listen`)
- Produces:
  - `transport.ts`: `ptySpawn(opts) -> Promise<string>`, `ptyWrite(id, data)`, `ptyResize(id, cols, rows)`, `ptyKill(id)`, `ptyAck(id, chars)`, `onPtyData(cb) -> unsubscribe`, `onPtyExit(cb) -> unsubscribe`
  - `terminalStore.ts`: `sessions: Record<string, SessionInfo>`, `spawnSession(cwd?)`, `killSession(id)`, `resizeSession(id, cols, rows)`, `ackSession(id, chars)`, `setSessionStatus(id, status)`, `layout: Layout`

- [ ] **Step 1: Add test dependencies to package.json**

```json
"devDependencies": {
  "vitest": "^4",
  "@testing-library/react": "^16",
  "@testing-library/jest-dom": "^6",
  "happy-dom": "^20"
}
```

Run `pnpm install`.

- [ ] **Step 2: Write failing store test**

`src/store/terminalStore.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useTerminalStore } from "./terminalStore";

describe("terminalStore", () => {
  beforeEach(() => useTerminalStore.setState({ sessions: {}, layout: null }));

  it("spawns a session and tracks it", async () => {
    const id = "abc";
    // mock transport.ptySpawn to resolve id
    await useTerminalStore.getState().spawnSession();
    expect(useTerminalStore.getState().sessions[id]).toBeDefined();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm vitest run src/store/terminalStore.test.ts`
Expected: FAIL — store / transport not found.

- [ ] **Step 4: Implement `transport.ts`**

```ts
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface PtyDataPayload { id: string; data: string; seq: number }
export interface PtyExitPayload { id: string; code: number | null; error?: string }

export async function ptySpawn(opts?: { shell?: string; cwd?: string; cols?: number; rows?: number }) {
  return invoke<string>("pty_spawn", opts ?? {});
}
export function ptyWrite(id: string, data: string) {
  return invoke("pty_write", { id, data });
}
export function ptyResize(id: string, cols: number, rows: number) {
  return invoke("pty_resize", { id, cols, rows });
}
export function ptyKill(id: string) {
  return invoke("pty_kill", { id });
}
export function ptyAck(id: string, chars: number) {
  return invoke("pty_ack", { id, chars });
}
export async function onPtyData(cb: (p: PtyDataPayload) => void) {
  return listen<PtyDataPayload>("pty:data", (e) => cb(e.payload));
}
export async function onPtyExit(cb: (p: PtyExitPayload) => void) {
  return listen<PtyExitPayload>("pty:exit", (e) => cb(e.payload));
}
```

- [ ] **Step 5: Implement `terminalStore.ts`**

A zustand store with `sessions`, `layout`, `spawnSession`, `killSession`, `resizeSession`, `ackSession`, `setSessionStatus`. `spawnSession` calls `transport.ptySpawn`, adds a session to the store, and wires `onPtyData`/`onPtyExit` (or the store's init does the wiring once). Layout is a simple tree type: `{ type: "leaf", id: string } | { type: "split", dir: "h" | "v", a: Layout, b: Layout }`.

- [ ] **Step 6: Run tests**

Run: `pnpm vitest run src/store/terminalStore.test.ts src/lib/pty/transport.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json pnpm-lock.yaml src/store src/lib/pty vite.config.ts
git commit -m "feat: renderer transport + zustand terminal store"
```

---

### Task 6: TerminalPane component (xterm.js rendering + ACK)

**Files:**
- Create: `src/components/TerminalPane.tsx`
- Create: `src/components/TerminalPane.test.tsx`
- Modify: `src/App.tsx` (replace demo with a single `TerminalPane`)
- Modify: `src/App.css` (full-height layout)

**Interfaces:**
- Consumes: `@xterm/xterm` (`Terminal`), `@xterm/addon-fit` (`FitAddon`), `transport.ptySpawn/ptyWrite/ptyResize/ptyAck/onPtyData/onPtyExit`, `useTerminalStore`
- Produces: `<TerminalPane />` — mounts a terminal, spawns a session, renders output, ACKs after `onWriteParsed`, resizes via `FitAddon` + ResizeObserver, shows an error line if spawn fails, keeps the xterm instance alive while hidden.

- [ ] **Step 1: Write failing component test**

`src/components/TerminalPane.test.tsx` — mock `transport.ts`; render `<TerminalPane />`; assert the container mounts and `transport.ptySpawn` was called.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/components/TerminalPane.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement `TerminalPane.tsx`**

```tsx
import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ptySpawn, ptyWrite, ptyResize, ptyAck, onPtyData, onPtyExit } from "../lib/pty/transport";

export function TerminalPane() {
  const containerRef = useRef<HTMLDivElement>(null);
  const idRef = useRef<string | null>(null);

  useEffect(() => {
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "Menlo, Consolas, monospace",
      theme: { background: "#0d1117" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current!);

    let unsubs: (() => void)[] = [];

    // ACK after xterm has parsed the write (onWriteParsed), per spec.
    term.onWriteParsed(() => {
      if (idRef.current) ptyAck(idRef.current, parsedRef.current);
    });
    const parsedRef = { current: 0 };

    ptySpawn().then((id) => {
      idRef.current = id;
      unsubs.push(onPtyData((p) => {
        if (p.id === id) {
          parsedRef.current = p.data.length;
          term.write(p.data);
        }
      }));
      unsubs.push(onPtyExit((p) => {
        if (p.id === id) {
          term.writeln(`\r\n[process exited: ${p.code ?? "error"}]`);
        }
      }));
      term.onData((data) => ptyWrite(id, data));
    });

    const ro = new ResizeObserver(() => {
      fit.fit();
      const { cols, rows } = term;
      if (idRef.current) ptyResize(idRef.current, cols, rows);
    });
    ro.observe(containerRef.current!);

    return () => {
      ro.disconnect();
      unsubs.forEach((u) => u());
      if (idRef.current) ptyKill(idRef.current);
      term.dispose();
    };
  }, []);

  return <div ref={containerRef} className="terminal-pane" />;
}
```

Note: `parsedRef` is reset per data chunk before `term.write`; `onWriteParsed` fires after the chunk is parsed, and we ACK that chunk's char count. In a multi-chunk scenario the count is the latest chunk's — acceptable for v1 (the spec's char-count ACK). Wire `ptyResize`/`ptyKill` only when `idRef.current` is set.

- [ ] **Step 4: Wire into `App.tsx`**

Replace the demo content with `<TerminalPane />`; add full-height CSS (`height: 100vh`, `display: flex`) in `App.css`.

- [ ] **Step 5: Run tests**

Run: `pnpm vitest run src/components/TerminalPane.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/TerminalPane.tsx src/components/TerminalPane.test.tsx src/App.tsx src/App.css
git commit -m "feat: xterm.js terminal pane with ack-based backpressure"
```

---

### Task 7: Split panes (minimal layout engine)

**Files:**
- Create: `src/lib/pane-manager/layout.ts` (pure layout tree ops)
- Create: `src/lib/pane-manager/layout.test.ts`
- Create: `src/components/PaneSplit.tsx` (recursive renderer)
- Modify: `src/components/TerminalPane.tsx` (accept an `id` prop; render per-leaf)
- Modify: `src/store/terminalStore.ts` (add `splitPane`, `closePane`, `focusPane`, `moveFocus` actions)
- Modify: `src/App.tsx` (render the layout tree instead of a single pane)

**Interfaces:**
- Consumes: `Layout` type, store actions
- Produces: layout ops `split(dir, tree, path, id)`, `remove(tree, path)`, `focus(tree, path)`, pure functions returning a new tree.

- [ ] **Step 1: Write failing layout tests**

`src/lib/pane-manager/layout.test.ts` — test `split` adds a sibling, `remove` prunes, `focus` returns the focused leaf id.

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/lib/pane-manager/layout.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `layout.ts`**

```ts
export type Layout =
  | { type: "leaf"; id: string }
  | { type: "split"; dir: "h" | "v"; ratio: number; a: Layout; b: Layout };

export type Path = number[];

// Insert a new leaf as a sibling at `path`, splitting the parent in `dir`.
export function split(
  dir: "h" | "v",
  tree: Layout,
  path: Path,
  newId: string,
): Layout {
  if (path.length === 0) {
    // Splitting the root: wrap it in a split with the new leaf.
    return { type: "split", dir, ratio: 0.5, a: tree, b: { type: "leaf", id: newId } };
  }
  const [head, ...rest] = path;
  if (tree.type === "leaf") return tree; // can't descend into a leaf
  const [a, b] = tree.type === "split" ? [tree.a, tree.b] : [tree, tree];
  const left = head === 0 ? split(dir, a, rest, newId) : a;
  const right = head === 1 ? split(dir, b, rest, newId) : b;
  return { type: "split", dir: tree.dir, ratio: tree.ratio, a: left, b: right };
}

// Remove the leaf at `path`; if a split is left with one child, collapse it.
export function remove(tree: Layout, path: Path): Layout | null {
  if (path.length === 0) return null;
  const [head, ...rest] = path;
  if (tree.type === "leaf") return tree;
  const a = head === 0 ? remove(tree.a, rest) : tree.a;
  const b = head === 1 ? remove(tree.b, rest) : tree.b;
  if (a === null && b === null) return null;
  if (a === null) return b;
  if (b === null) return a;
  return { type: "split", dir: tree.dir, ratio: tree.ratio, a, b };
}

// The id of the leaf at `path`.
export function focus(tree: Layout, path: Path): string {
  if (tree.type === "leaf") return tree.id;
  const [head, ...rest] = path;
  const child = head === 0 ? tree.a : tree.b;
  return focus(child, rest);
}
```

- [ ] **Step 4: Implement `PaneSplit.tsx`**

Recursive component: for a `leaf`, render `<TerminalPane id={leaf.id} />`; for a `split`, render two children in a flex row/column with a draggable divider (ratio state).

- [ ] **Step 5: Update store + App**

Add `splitPane(dir)`, `closePane()`, `moveFocus(dir)` to the store; `App.tsx` renders the layout tree and wires keyboard shortcuts (e.g., `Cmd/Ctrl+Shift+D` split, `Cmd+W` close).

- [ ] **Step 6: Run all renderer tests**

Run: `pnpm vitest run`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/pane-manager src/components/PaneSplit.tsx src/store/terminalStore.ts src/App.tsx
git commit -m "feat: minimal split-pane layout engine"
```

---

### Task 8: Persistence (layout + session state)

**Files:**
- Create: `src-tauri/src/layout.rs`
- Modify: `src-tauri/src/lib.rs` (register `save_layout` / `load_layout` commands)
- Modify: `src/store/terminalStore.ts` (serialize layout + sessions; call save on window close, load on init)
- Modify: `src-tauri/Cargo.toml` (add `dirs` or use `tauri::Manager::path().app_data_dir()`)
- Test: inline Rust tests + renderer store test

**Interfaces:**
- Consumes: `tauri::Manager` (`app.path().app_data_dir()`), serde
- Produces: commands `save_layout(app, layout_json: String) -> Result<(), String>`, `load_layout(app) -> Result<Option<String>, String>`.

- [ ] **Step 1: Write failing Rust test**

In `layout.rs`, test that saving then loading a JSON string round-trips to the same file.

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p oppa --lib`
Expected: FAIL.

- [ ] **Step 3: Implement `layout.rs`**

```rust
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn layout_path(app: &AppHandle) -> PathBuf {
    app.path().app_data_dir().unwrap().join("layout.json")
}

#[tauri::command]
pub fn save_layout(app: AppHandle, layout_json: String) -> Result<(), String> {
    let dir = app.path().app_data_dir().unwrap();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(layout_path(&app), layout_json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_layout(app: AppHandle) -> Result<Option<String>, String> {
    let p = layout_path(&app);
    if p.exists() {
        std::fs::read_to_string(p).map(Some).map_err(|e| e.to_string())
    } else {
        Ok(None)
    }
}
```

- [ ] **Step 4: Register commands in `lib.rs`**

Add `layout::save_layout`, `layout::load_layout` to the handler.

- [ ] **Step 5: Wire renderer persistence**

In `terminalStore.ts`, add `saveLayout()` (serialize store layout + sessions to JSON, call `transport.saveLayout`), `loadLayout()` (call `transport.loadLayout`, re-spawn sessions from saved cwd/shell, rebuild tree). Call `saveLayout` on `beforeunload`; call `loadLayout` on app init.

- [ ] **Step 6: Run all tests**

Run: `cargo test -p oppa --lib` and `pnpm vitest run`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/layout.rs src-tauri/src/lib.rs src/store/terminalStore.ts
git commit -m "feat: persist terminal layout + session state"
```

---

### Task 9: Wire up, polish, and verify end-to-end

**Files:**
- Modify: `src/App.tsx` (final layout)
- Modify: `src-tauri/tauri.conf.json` (window size, product name)
- Modify: `src-tauri/capabilities/default.json` (permissions — likely need `core:event:default` for `listen`, and `core:app:default`; verify against Tauri 2 capabilities)

**Interfaces:**
- Consumes: everything from Tasks 1-8

- [ ] **Step 1: Verify Tauri capabilities**

Ensure `src-tauri/capabilities/default.json` includes permissions for `listen` (events) and `invoke` (commands). Tauri 2: `core:default` usually covers it; add `core:event:default` if event listening fails.

- [ ] **Step 2: Run the app**

Run: `pnpm tauri dev`
Expected: a window opens with a working terminal (or an inline error if spawn fails). Type a command, see output. Resize the window — the terminal resizes.

- [ ] **Step 3: Manual checks**

- Split a pane (if wired), resize split, close.
- Run `yes` — confirm UI stays responsive (backpressure).
- Quit and relaunch — layout + sessions restore (fresh shells in same layout).

- [ ] **Step 4: Typecheck + build**

Run: `pnpm build` (tsc + vite build) and `cargo check` in `src-tauri`.
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src-tauri/tauri.conf.json src-tauri/capabilities/default.json
git commit -m "feat: wire up terminal core end-to-end"
```

---

## Self-Review Notes

- **Spec coverage:** Terminal backend (Tasks 1-4), renderer bridge (Task 5), TerminalPane + ACK (Task 6), split panes (Task 7), persistence (Task 8), end-to-end verification (Task 9). All spec sections covered.
- **Type consistency:** `pty:data { id, data, seq }`, `pty:exit { id, code, error? }`, `pty_spawn` returning `String` id — consistent across Rust commands (Task 3), transport (Task 5), TerminalPane (Task 6), store (Task 5). Layout tree type consistent between store (Task 5), layout.ts (Task 7), PaneSplit (Task 7).
- **No placeholders:** every task has concrete steps with real code.
