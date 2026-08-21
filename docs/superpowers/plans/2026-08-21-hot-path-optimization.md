# Hot Path Optimization — Implementation Plan

Date: 2026-08-21
Spec: `docs/superpowers/specs/2026-08-21-hot-path-optimization-design.md`
Ledger: `.superpowers/sdd/2026-08-21-hot-path-optimization/progress.md`

Rules: TDD where a new test is feasible; every task ends with full verification + a conventional commit. Implementers do not dispatch subagents; the controller reviews after each task.

---

## Task 1 — B1: Release profile + tokio feature trim

**Files:** `src-tauri/Cargo.toml`
**Work:**
1. Add `[profile.release]` with `lto = "fat"`, `codegen-units = 1`, `strip = true`.
2. Replace `tokio = { features = ["full"] }` with the minimal feature set: `["rt-multi-thread", "macros", "net", "io-util", "sync", "time", "fs"]`. Re-add only what the compiler demands.
**Verify:** `cargo check` (dev), `cargo check --release`, `cargo test -p oppa --lib`.
**Commit:** `perf(src-tauri): add release profile and trim tokio features`

## Task 2 — B2: Utf8ChunkDecoder zero-copy fast path

**Files:** `src-tauri/src/pty/utf8_decoder.rs`
**TDD:** First add a test that decodes a byte sequence split across many random boundaries and asserts output equals a single-shot decode of the whole input, plus an explicit empty-residual case asserting no intermediate buffer path changes results.
**Work:** When `residual` is empty, run `std::str::from_utf8` directly on the input slice (no `to_vec()`). Residual non-empty path keeps the combined-buffer logic unchanged.
**Verify:** `cargo test -p oppa --lib utf8` then full lib suite.
**Commit:** `perf(pty): avoid per-chunk copy in UTF-8 decoder fast path`

## Task 3 — B3a: Futex-based backpressure pause

**Files:** `src-tauri/src/pty/daemon_session.rs`
**Work:**
1. Reader thread pause branch: instead of `sleep(POLL_INTERVAL)` loop, use `paused.wait(true)` semantics (`AtomicBool::wait`) with predicate re-check on wake (`pending < LOW_WATERMARK_BYTES` clears the flag).
2. `ack()`: when pending drops below low watermark → `paused.store(false)` + `paused.notify_all()`.
3. Reader resume check after wake mirrors today's logic exactly.
**Verify:** `cargo test -p oppa --lib daemon_session`; confirm existing backpressure/multibyte ACK tests pass; ensure no busy loop remains (grep for POLL_INTERVAL usage in reader).
**Commit:** `perf(pty): park backpressure pause on futex wait instead of 10ms poll`

## Task 4 — B3b: Watchdog adaptive poll backoff

**Files:** `src-tauri/src/pty/daemon_session.rs`
**Work:** Watchdog loop interval starts at 10 ms, doubles each iteration up to 50 ms cap while child is alive. Exit emission path unchanged.
**Verify:** `cargo test -p oppa --lib daemon_session` (exit-event tests must still complete well within timeouts).
**Commit:** `perf(pty): adaptive backoff for session watchdog polling`

## Task 5 — B4: Daemon writer-task batched flushes

**Files:** `src-tauri/src/pty/daemon_server.rs`
**Work:** Writer task in `handle_client_stream`: block on first `recv`, then bounded drain via `try_recv` (≤64 messages or ≤256 KB) into a reusable `Vec<u8>`; single `write_all` + `flush` per batch. Message framing (`\n`-terminated JSON lines) untouched.
**Verify:** `cargo test -p oppa --test daemon_integration_test` — roundtrip, ack-one-way, and streaming-content tests prove framing/order integrity. Also `cargo test -p oppa --lib daemon_server`.
**Commit:** `perf(daemon): batch outbound IPC writes into single flush per burst`

## Task 6 — B5: Narrow session-registry lock scope on attach

**Files:** `src-tauri/src/pty/daemon_server.rs`
**Work:** In `CreateOrAttach`: attach arm clones the `Arc<DaemonSession>` under the lock, drops the lock, then performs resize + snapshot + response construction. Spawn arm keeps the lock across spawn+insert (double-spawn protection preserved). Write/Ack/Kill arms already clone-and-release; leave as-is.
**Verify:** `cargo test -p oppa --lib daemon_server` including `test_create_or_attach_resizes_before_taking_snapshot`.
**Commit:** `perf(daemon): release registry lock before snapshot render on attach`

## Task 7 — F2: Debounced layout saves in renderer store

**Files:** `src/store/terminalStore.ts` (+ tests)
**Work:**
1. Replace direct `void get().saveLayout().catch(() => {})` post-action call sites (createTab, closeTab, selectTab, renameTab, splitPane, closePane, swapPanes, movePane, wakeTab, setRatio callers already debounced, plus any others found by grep beyond line 1633) with `triggerDebouncedSaveLayout(get)`.
2. Keep immediate saves ONLY on the close-handshake path and initial `loadLayout` completion save if present.
3. Update any test asserting immediate save invocation to assert the debounce trigger (e.g., fake timers advance).
**Verify:** `pnpm vitest run` full suite green.
**Commit:** `perf(store): route layout persistence through existing 2s debounce`

---

## Final Review Gate

Controller runs: full Rust suites + vitest + `pnpm build` + `cargo check --release`; reviews cumulative diff against spec §3 non-goals (wire protocol frozen, watermark constants unchanged, UI untouched); writes ledger verdict.
