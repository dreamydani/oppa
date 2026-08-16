# OPPA — Terminal Core Design

Date: 2026-08-16
Status: Draft for review

## Purpose

Build a fast, low-memory **terminal core** for the Tauri app in `D:\oppa\oppa`, using the Electron app at `D:\orca\orca` as a **reference architecture** — not a copy. The user wants a step-by-step "ladder" of milestones, each runnable, rather than a big-bang port. This spec covers the first milestone: a single-window terminal with split panes, Rust-managed PTY sessions, ACK-based backpressure, and layout + session-state persistence.

Decisions (locked with user):
1. **Scope**: Terminal core first (splits, xterm.js, Rust PTY). Worktrees/agents later.
2. **Rust-first**: Reimplement PTY, SSH, git, file watching in Rust. No Node runtime in the product.
3. **Own UI**: New, lean React UI inspired by Orca's architecture (zustand store, xterm.js panes) — not Orca's 3,600-file renderer.

## Reference Architecture (Orca, borrowed ideas only)

From exploration of `D:\orca\orca`:

- **Channel naming + shape**: `pty:spawn` / `pty:write` / `pty:resize` / `pty:kill` / `pty:data` (push) / `pty:ack` — Orca's `src/main/ipc/pty.ts` vocabulary.
- **Backpressure**: Orca's `PtyProducerFlowController` uses 256KB high / 32KB low watermarks and calls node-pty `pause()`/`resume()` → stop reading → OS pipe fills → child blocks. We replicate the idea in Rust (stop reading the master fd). No output dropped in v1.
- **Sessions keyed by id in a registry**: Orca's `PtySessionId` + `memory/pty-registry.ts`; ours is `Mutex<HashMap<String, Arc<PtySession>>>`.
- **Shell detection + env**: `$SHELL` → zsh/bash/sh, `COMSPEC` → powershell/cmd, `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=oppa` — direct from Orca's `src/main/providers/local-pty-provider.ts`.

Deliberate simplifications vs Orca (given v1 scope):
- **No forked daemon.** Orca spawns PTYs inside a forked child process (`daemon-entry.ts`) so sessions + scrollback survive app restart. We chose layout + session *state* persistence only, so a single-process registry suffices.
- **No `@xterm/headless` in Rust.** Orca keeps a headless xterm emulator in the main process as the source of truth for snapshots and cold restore. Only matters for scrollback persistence, which is deferred.
- **Never drop output in v1.** Orca drops at extreme renderer backlog (≥2MB cap) with a `droppedOutput` sentinel. We pause-only, no drop.

## Design

### 1. Rust PTY backend (`src-tauri/src/pty/`)

**Modules:**
- `session.rs` — wraps `portable-pty::PtyPair`. Holds the `PtyPair`, a unique id, spawn metadata (shell path, cwd, cols/rows), and an `Arc<AtomicBool>` for backpressure. Spawns the shell via `PtyPair::spawn_command` with a cleaned env (TERM, COLORTERM, TERM_PROGRAM, plus platform default shell detection).
- `manager.rs` — `PtyManager` behind `Mutex<HashMap<String, Arc<PtySession>>>`. Owns session lifecycle: `spawn`, `write`, `resize`, `kill`, `list`, `ack`. Each session's read loop pushes `pty:data` via `app.emit()`, and `pty:exit` when the child exits.
- `commands.rs` — the `#[tauri::command]`s: `pty_spawn`, `pty_write`, `pty_resize`, `pty_kill`, `pty_list`, `pty_ack`. Each takes `State<PtyManager>`.

**Concurrency & backpressure:** each session's read loop is a `std::thread` with an `mpsc::Receiver` for commands (write/resize/kill) and a `sync_channel` for output. A `pending_bytes: AtomicUsize` counter: when `ack` decrements below a low watermark (32KB) the read loop resumes; above a high watermark (256KB) it pauses. The renderer ACKs processed char counts.

**Backpressure mechanics:** `portable-pty` gives a `master` fd. The read loop blocks on `master.try_read()` into a buffer; when paused, we simply *stop reading* (the OS pipe fills, the child blocks on write — kernel backpressure, same as Orca's `pause()`/`resume()`). We never drop output in v1.

**Shell detection (auto-detect + fallback):**
- macOS/Linux: `$SHELL`, else `/bin/zsh` → `/bin/bash` → `/bin/sh`.
- Windows: `$COMSPEC` → `powershell.exe` → `cmd.exe` (via ConPTY).
- Env: inherit the app's env, set `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=oppa`, `TERM_PROGRAM_VERSION=<ver>`, and a clean `LANG`.

**Tests (Rust):** `cargo test` on `manager.rs` — spawn a shell (e.g., `sh -c 'echo hi'`), assert we receive output, write to stdin, assert echo, resize, kill, and assert the child process tree is gone.

### 2. Renderer bridge (frontend)

**Structure:**
- `src/lib/pty/transport.ts` — the only file that touches Tauri APIs (`invoke`, `listen`). Wraps `pty_spawn`/`pty_write`/`pty_resize`/`pty_kill`/`pty_ack` and subscribes to `pty:data` / `pty:exit` events, routing by session id. Returns unsubscribe handles.
- `src/store/terminalStore.ts` — a zustand store holding `sessions: Record<string, SessionInfo>` (`{ id, title, status, cwd, cols, rows }`) plus layout. Created/updated from `pty:spawned` / `pty:exit` events; `pty_ack` bookkeeping lives here too (pending char count per session).
- `src/components/TerminalPane.tsx` — one `@xterm/xterm` instance per session. On mount, connects transport → renders output → sends `pty_ack` after xterm processes chars. Resize via `FitAddon` → `pty_resize`. Keeps the xterm instance alive while hidden (don't unmount on tab switch).

**The ACK loop:**
1. Rust pushes `pty:data { id, data, seq }`.
2. `TerminalPane` feeds `data` to `term.write()`, and on `term.onWriteParsed` sends `pty_ack { id, chars: data.length, seq }`.
3. Rust decrements `pending_bytes` by `chars`; below 32KB → resume the read loop.
4. If `pending_bytes` exceeds 256KB → Rust pauses reading; the child blocks on the pipe. `yes` can't balloon memory.

**State vs transport split:** components never call `invoke` directly — they read the zustand store and call transport helpers. Keeps the UI testable (mock `transport.ts`) and keeps Tauri out of components.

**Own UI, not Orca's:** one `TerminalPane` + a minimal pane-split layout in v1 (horizontal/vertical split, drag-resize, focus, close). No tab bar in v1 — a pane grid.

### 3. Persistence, error handling, testing

**Persistence (layout + session state):**
- On session spawn, Rust records `{ id, shell, cwd, cols, rows }` in `PtyManager`. The renderer's zustand store tracks the *layout* (pane tree: splits + which session id is in each pane).
- On window close / app exit, the renderer writes the layout + session list to a JSON file in `appDataDir` via a `save_layout` command; Rust writes it. On launch, renderer reads `load_layout`; if present, it calls `pty_spawn` for each stored session with its saved cwd/shell, re-runs the saved pane tree, and attaches.
- Because we deferred the daemon, a restored session is a *new* shell (fresh scrollback) in the *same* pane layout + cwd. That's the honest v1 behavior.

**Error handling:**
- Rust: each command returns `Result<T, String>`; spawn failures (shell not found, bad cwd) return a clear error string that the renderer shows as an inline pane error, not a crash. PTY read errors terminate the session and emit `pty:exit { code, error? }`.
- Renderer: `TerminalPane` shows a one-line error state if spawn fails or the session dies; the pane stays so you can retry.

**Testing:**
- Rust (`cargo test`): spawn/echo/exit assertions, write-echo, resize, kill-tree. Backpressure: spawn `sh -c 'yes'`, assert pending_bytes pauses at the watermark and resumes on ack.
- Renderer (`vitest` + `@testing-library/react`): `transport.ts` mocked; test the zustand store updates on `pty:spawned`/`pty:exit`, and `TerminalPane` renders output + sends acks. Layout store: split/close/navigate.

**Own-UI identity:** this is *oppa*, not a clone — keep the architecture lessons (channel shape, backpressure, registry) but the code, the pane engine, and the UI are new and lean.

## Out of scope (deferred milestones)

- SSH remote environments (russh) — mirrors Orca's `ssh/` module.
- Embedded browser pane (Orca's `browser/` via CDP — hardest; revisit if truly needed).
- Mobile pairing / CLI / relay — Orca's `src/relay` and `src/cli` are Node; decide whether to port to Rust or drop.
- Plugins, speech, updater (Tauri has its own updater).
- Worktrees & agents (a later rung in the ladder).
- Full scrollback persistence across quit (the daemon + headless-buffer machinery).

## Risks / watch-outs

- **portable-pty** on Windows uses ConPTY (good); on macOS/Linux it's forkpty/posix_spawn. Test shell startup + resize early (Rung 1 is the risk retirement).
- **Backpressure + xterm**: Orca's ACK model is subtle; keep our version simple (char-count ACK) and verify with `yes`.
- **Process-tree kill**: don't leak shells. Kill the PTY's process group on close.
- **Keep it a ladder**: each rung ends with something runnable. Don't start Rung 4 until Rung 3 is stable.

## Verification (per rung)

- `pnpm tauri dev` runs; manual checks listed per rung.
- `cargo check` in `src-tauri` clean; `pnpm build` clean.
- Compare idle memory to the Electron Orca baseline (Rung 0) — the goal is a visibly lower footprint.
