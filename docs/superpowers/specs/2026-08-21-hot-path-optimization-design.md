# OPPA — Hot Path Optimization Design

**Date:** 2026-08-21
**Status:** Draft for review
**Target:** PTY reader thread, daemon IPC server, Cargo release profile, renderer persistence layer
**Predecessor:** Builds on `2026-08-21-terminal-performance-and-stability-design.md` (byte-ACKs, MPSC subscribers, UTF-8 residuals — already implemented)

---

## 1. Purpose & Motivation

A full-stack audit identified six remaining performance flaws along the terminal hot path (PTY read → screen mirror → IPC serialize → named pipe → webview) plus one avoidable startup/persistence cost. All fixes are **behavior-preserving**: byte-identical terminal output, identical event ordering, identical backpressure guarantees (never drop output), identical user-visible UI.

Locked scope (user-approved): **B1–B5 + F2**. Explicitly deferred: F3 (per-pane listener fan-out), F4 (ACK batching), F5 (Vite config) — marginal impact, revisit later.

## 2. Findings → Fixes

### B1 — Missing `[profile.release]` + tokio feature bloat

**Finding:** `src-tauri/Cargo.toml` has no `[profile.release]` section (default opt-level 3, 16 codegen units, no LTO, symbols kept) and `tokio = { features = ["full"] }`.

**Fix:**
```toml
[profile.release]
lto = "fat"
codegen-units = 1
strip = true

[dependencies]
tokio = { version = "1", features = ["rt-multi-thread", "macros", "net", "io-util", "sync", "time", "fs"] }
```
No source changes. Verify `cargo check --release` passes; add features only if compilation reveals gaps.

### B2 — Per-chunk allocation storm in reader thread

**Finding:** `Utf8ChunkDecoder::decode` (`utf8_decoder.rs:20-26`) copies every chunk via `chunk.to_vec()` **even when the residual buffer is empty** (the common case). One needless heap alloc + memcpy per PTY chunk.

**Fix:** When residual is empty, decode directly from the input slice — no combined buffer, no copy. Residual path unchanged. Add an equivalence test asserting the fast path and residual path produce identical results across split boundaries.

### B3 — Polling where blocking waits belong

**Finding (a):** Backpressure pause loop (`daemon_session.rs:166-171`) sleeps 10 ms per iteration while paused — up to 10 ms added latency on every resume, plus constant wakeups.
**Finding (b):** Watchdog thread (`daemon_session.rs:221-242`) polls `try_wait()` every 10 ms forever, per session.

**Fix (a):** Replace the sleep-poll with `AtomicBool::wait` / `notify_all` (stable std futex): reader parks while `paused == true`; `ack()` stores `false` + `notify_all` once `pending < LOW_WATERMARK`. Resume conditions identical to today (either the reader thread or `ack()` may clear the flag when pending drops below the low watermark).
**Fix (b):** Adaptive backoff on the watchdog poll: 10 ms → doubling → capped at 50 ms. Worst-case exit-detection latency stays ≤ 50 ms (imperceptible; today's `pty:exit` path is already async through the same channel).

### B4 — Per-event write + flush on the daemon IPC socket (chosen design)

**Finding:** `handle_client_stream`'s writer task (`daemon_server.rs:199-208`) does `recv → write_all → flush` **per message**. Under heavy output this is one syscall pair per chunk, plus the `format!("{json}\n")` intermediate allocation.

**Decision (controller ruling, per user delegation):** Coalesce at the **writer-task level only**, leaving event production untouched:

1. Writer task blocks on `out_rx.recv()` for the first message (zero added latency vs today).
2. Then drains `out_rx.try_recv()` in a bounded loop (cap: 64 messages or 256 KB, whichever first) into a single reusable `Vec<u8>` buffer.
3. One `write_all` + one `flush` per drained batch.

Every event remains its own newline-delimited JSON line — **framing, ordering, and event granularity are bit-identical**; only syscall count drops. No protocol change, no timing change for the first event of a burst. This was chosen over subscriber-side coalescing (which would merge chunks into fewer `pty:data` events) because it keeps the wire contract frozen while capturing nearly all of the win.

### B5 — Session-registry lock held across expensive work

**Finding:** `CreateOrAttach` (`daemon_server.rs:77-110`) holds the sessions `Mutex` across `get_snapshot()` (full vt100 formatted-screen render) and shell spawn. Every Write/Ack/ListSessions from any client blocks behind an attach's snapshot render.

**Fix:** Split the arm:
- **Attach path:** look up the `Arc<DaemonSession>` under the lock, drop the lock, then resize + snapshot + build the response.
- **Spawn path:** still holds the lock across spawn-insertion (unchanged) to preserve the existing guarantee that concurrent `CreateOrAttach` calls for the same id cannot double-spawn.

### F2 — Layout save storms bypass the debounce

**Finding:** `triggerDebouncedSaveLayout` (2 s debounce) exists, but ten call sites invoke `saveLayout()` directly — notably `selectTab` (`terminalStore.ts:855`), which serializes *every* open terminal via SerializeAddon and writes files on **every tab switch**. Same pattern in `createTab`, `closeTab`, `renameTab`, `splitPane`, `closePane`, `swapPanes`, `movePane`, `wakeTab`, `renameTab`.

**Fix:** Route all post-action `saveLayout` call sites through `triggerDebouncedSaveLayout(get)`. The close-handshake path (`app:before-close` → final `saveLayout` → `confirm_save_complete`) stays synchronous/immediate — that is where durability matters. Trade-off (accepted): a hard kill within the 2 s debounce window may lose the very last layout mutation — identical exposure the CWD-update path already has.

## 3. Non-goals / unchanged contracts

- Wire protocol (`DaemonRequest`/`DaemonResponse`/`DaemonEvent` shapes) — frozen.
- Backpressure watermarks (256 KB / 32 KB) and never-drop guarantee — unchanged.
- Frontend component tree, DOM, styling — untouched (F2 touches only store action plumbing).
- Scrollback persistence semantics on unmount/close — unchanged.

## 4. Verification

Per task, in order:
1. `cargo test -p oppa --lib` (in `src-tauri`)
2. `cargo test -p oppa --test daemon_integration_test`
3. `pnpm vitest run` (frontend tasks)
4. Final: `cargo check` + `pnpm build`

Specific gates:
- B2: new decoder fast-path/residual-equivalence test.
- B3a: existing multibyte ACK test + a pause/resume test must still pass; manual sanity via `yes | head -c 10M` style throughput (no stall, no drop).
- B4: existing IPC roundtrip test asserts interleaved request/response and streamed data still arrive correctly framed.
- B5: `test_create_or_attach_resizes_before_taking_snapshot` must pass unchanged.
- F2: `terminalStore.test.ts` green; adjust any test asserting immediate save calls to assert the debounced trigger instead (behavior contract updated in test, not in product semantics).

## 5. Risks

| Area | Risk | Mitigation |
|---|---|---|
| B1 | Stripped tokio features break a transitive need | Compiler errors surface immediately; re-add smallest set |
| B3a | Missed wakeup hangs the reader | `ack()` always pairs `store(false)` with `notify_all`; reader re-checks predicate after every wake (futex lost-wakeup safety) |
| B4 | Batch buffer growth under pathological bursts | Hard caps (64 msgs / 256 KB) force a flush |
| B5 | Subtle reorder changes attach response | Snapshot taken after resize, same order as today, just outside the lock |
| F2 | Tests assert synchronous save | Update tests to observe debounced trigger; product durability preserved via close handshake |

## 6. Execution

Subagent-driven per `.superpowers` workflow: one implementer task per fix, controller review after each, ledger at `.superpowers/sdd/2026-08-21-hot-path-optimization/progress.md`, conventional commit per task.
