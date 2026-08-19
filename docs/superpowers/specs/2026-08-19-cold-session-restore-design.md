# Cold Session Restoration Specification: Daemon Disk Checkpoints & Replay Flow

## 1. Overview & Goal

When OPPA closes while the PC remains running, the background daemon maintains active shells in memory (**Warm Reattachment**). However, when the PC shuts down, reboots, or crashes, all in-memory processes are terminated by the OS.

The goal of this specification is to implement **Cold Session Restoration** (inspired by Orca's dual-tier architecture):
1. **Periodic & Exit Disk Checkpoints**: The daemon/PTY manager continuously writes session metadata (`cwd`, `title`, `cols`, `rows`, `personaId`) and raw/ANSI scrollback checkpoints to disk (`appDataDir/snapshots/<session_id>.snapshot`).
2. **Cold Start Replay**: After a reboot, when OPPA launches with 0 running sessions in memory, it reconstructs the saved layout, paints the persisted scrollback history to the terminal emulator, and launches fresh shells seated in the exact same directories.
3. **Session Loading & Restored Banner UI**: Displays a polished `"Session loading..."` placeholder during boot and a clean `"● Session restored"` banner in the pane header upon completion (dismissed seamlessly on user interaction).

---

## 2. Architecture Comparison: Warm vs. Cold

```
                                  [ OPPA Starts ]
                                         │
                         Is Daemon active in RAM with session?
                                        / \
                                 YES   /   \   NO (PC was shut down / daemon restarted)
                                      /     \
                       ┌─────────────▼─┐   ┌─▼──────────────────────────┐
                       │ Warm Reattach │   │        Cold Restore        │
                       │ (RAM Mirror)  │   │  (Disk Checkpoint Replay)  │
                       └───────────────┘   └────────────────────────────┘
                              │                          │
                    Instant reattachment          1. Show "Session Loading..."
                    to live running shell         2. Read snapshot from disk
                                                  3. Replay scrollback into xterm
                                                  4. Spawn fresh shell in saved CWD
                                                  5. Show "● Session Restored" banner
```

---

## 3. Technical Specifications

### 3.1 Daemon Disk Checkpoint Writer (`src-tauri/src/pty/snapshot.rs`)
- **Storage Directory**: `appDataDir/snapshots/`
- **File Format**: Binary / JSON snapshot containing:
  ```json
  {
    "sessionId": "term-1",
    "cwd": "D:\\oppa\\oppa",
    "title": "oppa",
    "cols": 120,
    "rows": 30,
    "personaId": "architect",
    "scrollback": "...",
    "timestamp": 1724050000000
  }
  ```
- **Write Policy**:
  - **Debounced Flush**: Daemon writes updated scrollback/CWD every 5 seconds if changed.
  - **Graceful Shutdown Flush**: Flushes all active sessions to disk on window close / `app:before-close` / SIGINT/SIGTERM.
  - **Size Cap**: Bounds scrollback to the last 1MB (UTF-8 safe boundary truncation).

### 3.2 Cold Rehydration Protocol (`daemon_server.rs` & `commands.rs`)
- When `pty_spawn` or `create_or_attach` is called with an existing `session_id`:
  - If session exists in memory: returns `{ is_new: false, warm: true, snapshot: live_mirror, cwd: ... }`.
  - If session does NOT exist in memory but exists in snapshot storage:
    1. Spawns fresh child shell initialized in `saved_snapshot.cwd`.
    2. Returns `{ is_new: false, warm: false, snapshot: None, cold_scrollback: saved_snapshot.scrollback, cwd: saved_snapshot.cwd }`.

### 3.3 Frontend Session Lifecycle & Replay (`terminalStore.ts`, `TerminalPane.tsx`)
1. **Session Status Extension**:
   - `SessionInfo.status: "spawning" | "loading" | "restoring" | "running" | "error"`.
   - `SessionInfo.isRestored?: boolean`.
2. **"Session Loading" Skeleton**:
   - When a pane is being restored from a cold boot, display an unobtrusive skeleton with the target workspace/cwd and a spinning/pulsing indicator: `"Session loading..."`.
3. **Scrollback Replay**:
   - Write the recovered cold scrollback into `@xterm/xterm` buffer before connecting the live shell data stream.
   - Insert a clean, subtle separator divider:
     ```
     ── [Session Restored · CWD: ~/oppa] ────────────────────────────────
     ```
4. **"Session Restored" Banner (`TerminalPaneHeader.tsx`)**:
   - Displays a sleek badge in the pane header: `● Session restored` (amber spot dot).
   - Dismissal: Automatically fades out on user keypress (`onData` / `keydown`) or manual close `✕`.

---

## 4. Design & Aesthetics (`taste-skill` & `minimalist-ui`)

- **Restored Badge**:
  - Background: `rgba(245, 158, 11, 0.1)` (warm amber tint).
  - Border: `1px solid rgba(245, 158, 11, 0.25)`.
  - Dot: `#f59e0b` (pulsing subtle 6px circle).
  - Text: `#fbbf24`, `font-size: 11px`, `font-weight: 500`.
- **Loading Skeleton**:
  - Background: `#121214`.
  - Shimmer: subtle gradient pulse `rgba(255, 255, 255, 0.03)`.
  - Text: `#71717a`, `font-size: 12px`.

---

## 5. Verification & Test Plan

- **Rust Unit & Integration Tests**:
  - `test_save_and_load_session_snapshot_roundtrip`: verifies serializing and reading session snapshot with scrollback, cwd, and dimensions.
  - `test_cold_restore_spawns_fresh_shell_in_saved_cwd`: verifies fresh shell spawn seated in previous cwd when daemon has no in-memory session.
- **Frontend Unit Tests**:
  - `terminalStore.test.ts`: verifies `loadLayout` marks sessions as restoring and replays scrollback correctly without data loss.
  - `TerminalPane.test.tsx`: verifies `"Session loading..."` renders during rehydration and `"Session restored"` banner appears after rehydration.
  - `TerminalPaneHeader.test.tsx`: verifies clicking or typing dismisses the restored banner.
- **End-to-End Verification**:
  - `cargo test -p oppa --lib` (100% pass)
  - `pnpm vitest run` (100% pass)
  - `pnpm build` (100% pass)
