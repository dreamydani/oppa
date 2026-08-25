# Performance & Code Structure Improvement Plan — 2026-08-26

Branch: `perf/structure-improvements`
Ledger: `.superpowers/sdd/2026-08-26-performance-and-structure/progress.md`

Goal: remove the user-felt performance bottlenecks and fix the structural debt
found in the 2026-08-26 audit, without changing any user-visible behavior.

## Audit summary (evidence)

### P0 — critical perf
1. **All 48 Tauri commands are synchronous.** In Tauri 2 sync commands run on
   the main thread → every keystroke (`pty_write`), ACK frame (`pty_ack`),
   git panel refresh (`sc_status` etc.), and cold-scrollback disk read
   (`commands.rs:225`) blocks the UI thread.
   Files: `src-tauri/src/pty/commands.rs`, `src-tauri/src/layout.rs`,
   `src-tauri/src/settings.rs`, `src-tauri/src/fs.rs`, `browser/commands.rs`,
   `workspace_presets.rs`.
2. **Per-write blocking IPC round trip under a global lock.**
   `daemon_client.rs:317-336` `send_request()` holds `request_lock` (serializes
   ALL requests across ALL sessions) and blocks on `recv_timeout(5s)`;
   `write()` (line 443) waits for the daemon's `Ok` per keystroke.
   `ack()` (line 470) is already fire-and-forget — proof the pattern works.
3. **`saveLayout()` full disk write on routine interactions.** 13 direct
   fire-and-forget callers in `terminalStore.ts` (e.g. `selectTab`:1017,
   `renameTab`:1127). Each call serializes layout JSON **plus every session's
   scrollback** (`saveLayout` loops serializers at :1480). Tab switch =
   serializing every terminal buffer to disk.

### P1 — structure
4. God files: `daemon_server.rs` (3752 lines), `terminalStore.ts` (2858),
   `hosted_reviews.rs` (1887), `source_control.rs` (1414), `TerminalPane.tsx`
   (649). Out of scope for this pass except where a task touches them.
5. Dead code: frontend transport fns never called by app code
   (`ptyDisconnect`, `ptyShutdown`, `worktreeShow`, `worktreeCurrent`,
   `worktreeLineage`, `scUpstreamRefresh`); 24× `#[allow(dead_code)]` in Rust.
6. Non-atomic persistence: `layout.rs:14` bare `std::fs::write` (crash mid-write
   corrupts layout.json); `comments_store.rs:75-85` already does tmp+rename.
7. Backend polling loops + hot-path clones (`emit_event` clones per subscriber;
   reader thread `chunk.to_vec()` per 8KB).

### P2 — hygiene
8. `Result<T, String>` errors on all commands; `app_data_dir().unwrap()`
   panics (`settings.rs:105`, `layout.rs:27`); std Mutex unwrap poisoning in
   `extensions/host.rs`; no React ErrorBoundary; Monaco from CDN; FileExplorer
   not virtualized; wheel handler sends up to 5 invokes per event.

## Tasks

Each task: TDD where testable → verify (`cargo test -p oppa --lib`,
`cargo test -p oppa --test daemon_integration_test`, `pnpm vitest run`) →
conventional commit on this branch → ledger update.

### A1 — Async commands (P0 #1)
Change `#[tauri::command]` → `#[tauri::command(async)]` on all command fns so
they execute off the main thread. Internals stay sync; no signature changes.
Acceptance: grep shows zero plain `#[tauri::command]` remaining;
`cargo check`/tests green; app spawns terminal + git panel still works.

### A2 — Fire-and-forget pty_write + lock contention (P0 #2)
`DaemonClient::write` queues the request like `ack` does (no response wait).
Keep `send_request` for genuine RPCs but stop sharing one global mutex across
unrelated request kinds where cheap to do.
Risk: error surfacing for writes disappears — acceptable: a failed pipe breaks
the reader task which surfaces via exit/disconnect path anyway.
Acceptance: daemon_integration_test green (write path covered there);
keystrokes no longer block on RTT.

### A3 — Debounced saveLayout everywhere + dirty scrollbacks (P0 #3)
Route all 13 direct `saveLayout()` callers through
`triggerDebouncedSaveLayout(get)` (2s trailing). Track a per-session
`scrollbackDirty` set updated by `cacheScrollback`; `saveLayout` serializes
only dirty sessions' buffers.
Acceptance: vitest store tests green incl. new test asserting selectTab does
not call transport save immediately; manual: tab switching produces no
immediate layout.json write.

### A4 — Atomic JSON persistence helper (P1 #6)
New shared helper (tmp file + rename, same pattern as comments_store) used by
layout save and settings save. Unit tests: round-trip, crash-simulation
(partial tmp file never becomes the real file).
Acceptance: new rust unit tests green; existing layout/settings tests green.

## Later phases (not started this pass)

- B: split terminalStore into domain slices; split daemon_server router;
  resolve dead code inventory.
- C: condvar backpressure resume, Arc<DaemonEvent> fanout, CommandError type.
- D: ErrorBoundary, Monaco local bundling + manualChunks, FileExplorer
  virtualization, wheel batching.

## Rules

- Never drop terminal output; backpressure semantics unchanged.
- No behavior change visible to users except smoothness.
- Every task ends with a commit + ledger row before starting the next.
