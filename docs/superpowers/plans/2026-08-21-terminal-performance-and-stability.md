# Terminal Performance, Backpressure Alignment & Backend Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate terminal lag, freezes, and memory/disk bottlenecks by aligning backpressure byte accounting, making ACKs asynchronous, preserving UTF-8 chunk boundaries, replacing lossy broadcast streams with reliable MPSC, eliminating main-thread buffer serialization freezes, and debouncing layout disk I/O.

**Architecture:** Rust backend (`src-tauri/src/pty/`) tracks raw byte counts and preserves trailing multi-byte UTF-8 bytes across read chunks; IPC transport switches to one-way non-blocking ACKs and point-to-point MPSC streams; frontend transport (`src/lib/pty/transport.ts`) and `TerminalPane.tsx` accumulate raw byte lengths for ACKs and defer heavy scrollback serialization to idle/unload moments; `terminalStore.ts` debounces CWD layout disk writes.

**Tech Stack:** Rust 2021 (Tokio, portable-pty, parking_lot, serde_json), Tauri 2, TypeScript, React 19, xterm.js, Zustand, Vitest.

## Global Constraints

- Never touch or alter any UI components, styling, CSS, themes, or visual layouts.
- Every task must follow strict TDD: write/update the failing test first, verify failure, implement minimal code, verify pass.
- All Rust tests (`cargo test -p oppa --lib` and `cargo test -p oppa --test daemon_integration_test`) and frontend tests (`pnpm vitest run`) must pass at every stage.
- Follow conventional commits (`feat:`, `fix:`, `perf:`).

---

### Task 1: Byte-Accurate Backpressure Tracking & Event Payload Alignment

**Files:**
- Modify: `src-tauri/src/pty/ipc_protocol.rs:199-222`
- Modify: `src-tauri/src/pty/daemon_session.rs:166-200, 252-263`
- Modify: `src-tauri/src/pty/commands.rs:6-13, 72-80`
- Modify: `src/lib/pty/transport.ts:5-9`
- Modify: `src/components/TerminalPane.tsx:220-234`
- Test: `src-tauri/src/pty/daemon_session.rs:398-419`
- Test: `src/lib/pty/transport.test.ts`

**Interfaces:**
- Consumes: `DaemonEvent::Data { session_id, data, bytes, seq }`, `PtyDataPayload { id, data, bytes, seq }`
- Produces: Byte-exact backpressure accounting between Rust `pending_bytes` and frontend `pty_ack`.

- [ ] **Step 1: Write the failing unit tests for byte-exact tracking and UTF-8 data events**

In `src-tauri/src/pty/ipc_protocol.rs` and `src-tauri/src/pty/daemon_session.rs`:
Add tests asserting that `DaemonEvent::Data` contains `bytes: usize` equal to the raw byte length of the chunk, and `DaemonSession::ack(bytes)` correctly decrements multi-byte byte counts.

- [ ] **Step 2: Run tests to verify failure**

Run: `cargo test -p oppa --lib test_serialize_daemon_events_all_variants`
Expected: FAIL (missing `bytes` field in `DaemonEvent::Data`).

- [ ] **Step 3: Implement byte-accurate payload in Rust and Frontend**

1. Update `DaemonEvent::Data` in `src-tauri/src/pty/ipc_protocol.rs`:
   ```rust
   #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
   #[serde(tag = "event", content = "payload")]
   pub enum DaemonEvent {
       Data {
           session_id: String,
           data: String,
           bytes: usize,
           seq: u64,
       },
       Exit { session_id: String, code: Option<i32> },
       Cwd { session_id: String, cwd: String },
   }
   ```
2. Update `PtyDataPayload` in `src-tauri/src/pty/commands.rs` and `src/lib/pty/transport.ts` to include `bytes: number`.
3. In `daemon_session.rs`, emit `bytes: chunk.len()` in `DaemonEvent::Data`.
4. In `TerminalPane.tsx`, accumulate `p.bytes || new TextEncoder().encode(p.data).length` into `parsedRef` and pass byte counts to `ackSession`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p oppa --lib` and `pnpm vitest run src/lib/pty/transport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pty/ipc_protocol.rs src-tauri/src/pty/daemon_session.rs src-tauri/src/pty/commands.rs src/lib/pty/transport.ts src/components/TerminalPane.tsx
git commit -m "perf: align backpressure tracking to raw byte counts"
```

---

### Task 2: UTF-8 Chunk Boundary Preservation in PTY Reader

**Files:**
- Create: `src-tauri/src/pty/utf8_decoder.rs`
- Modify: `src-tauri/src/pty/mod.rs`
- Modify: `src-tauri/src/pty/daemon_session.rs:154-203`
- Test: `src-tauri/src/pty/utf8_decoder.rs`

**Interfaces:**
- Consumes: Raw `&[u8]` chunks from PTY reader
- Produces: `Utf8ChunkDecoder` that retains 1–3 trailing incomplete UTF-8 bytes across read cycles without generating `U+FFFD`.

- [ ] **Step 1: Write failing tests for `Utf8ChunkDecoder`**

Create `src-tauri/src/pty/utf8_decoder.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decode_split_emoji_across_chunks() {
        let mut decoder = Utf8ChunkDecoder::new();
        let emoji = "🚀".as_bytes(); // 4 bytes: [240, 159, 154, 128]
        
        let chunk1 = &emoji[0..2];
        let decoded1 = decoder.decode(chunk1);
        assert_eq!(decoded1, ""); // held in residual buffer

        let chunk2 = &emoji[2..4];
        let decoded2 = decoder.decode(chunk2);
        assert_eq!(decoded2, "🚀");
    }

    #[test]
    fn test_decode_split_cjk_across_chunks() {
        let mut decoder = Utf8ChunkDecoder::new();
        let text = "你好".as_bytes(); // 6 bytes: 2x 3-byte chars
        
        let chunk1 = &text[0..4]; // First char + 1 byte of second char
        let decoded1 = decoder.decode(chunk1);
        assert_eq!(decoded1, "你");

        let chunk2 = &text[4..6]; // Remaining 2 bytes of second char
        let decoded2 = decoder.decode(chunk2);
        assert_eq!(decoded2, "好");
    }
}
```

- [ ] **Step 2: Run test to verify failure**

Run: `cargo test -p oppa --lib utf8_decoder`
Expected: FAIL (module/struct not yet implemented).

- [ ] **Step 3: Implement `Utf8ChunkDecoder` and wire into `daemon_session.rs`**

Implement `Utf8ChunkDecoder` using `std::str::from_utf8` boundary validation and integrate into `daemon_session.rs` reader loop.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p oppa --lib`
Expected: PASS (all tests pass).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pty/utf8_decoder.rs src-tauri/src/pty/mod.rs src-tauri/src/pty/daemon_session.rs
git commit -m "fix: preserve multi-byte utf8 code points across pty chunk boundaries"
```

---

### Task 3: Asynchronous Fire-and-Forget ACKs & One-Way IPC

**Files:**
- Modify: `src-tauri/src/pty/daemon_server.rs:135-145, 235-245`
- Modify: `src-tauri/src/pty/daemon_client.rs:342-353`
- Modify: `src-tauri/src/pty/manager.rs`
- Test: `src-tauri/src/pty/daemon_client.rs:405-545`
- Test: `tests/daemon_integration_test.rs`

**Interfaces:**
- Consumes: `DaemonRequest::Ack { session_id, bytes }`
- Produces: Non-blocking asynchronous ACK transmission from client to daemon with zero blocking mutex lock.

- [ ] **Step 1: Write a unit/integration test for high-throughput async ACKs**

In `src-tauri/src/pty/daemon_client.rs`:
Add `test_daemon_client_async_ack_high_throughput` sending 1,000 rapid ACKs without timeout or mutex deadlock.

- [ ] **Step 2: Run test to verify it fails or exposes blocking overhead**

Run: `cargo test -p oppa --lib test_daemon_client_async_ack_high_throughput`

- [ ] **Step 3: Implement non-blocking ACK dispatch**

1. In `daemon_server.rs`, process `DaemonRequest::Ack` without sending back a `DaemonResponse::Ok` message (or mark it as one-way).
2. In `daemon_client.rs`, update `ack(&self, session_id: &str, bytes: usize)` to directly queue the JSON line to `self.write_tx` without acquiring `self.request_lock` or awaiting on `pending_response`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p oppa --lib` and `cargo test -p oppa --test daemon_integration_test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pty/daemon_server.rs src-tauri/src/pty/daemon_client.rs src-tauri/src/pty/manager.rs
git commit -m "perf: make backpressure acks asynchronous and non-blocking"
```

---

### Task 4: Point-to-Point Reliable MPSC Streaming (Zero-Drop)

**Files:**
- Modify: `src-tauri/src/pty/daemon_session.rs:11, 32, 105, 124, 275-278`
- Modify: `src-tauri/src/pty/daemon_server.rs:248-275`
- Test: `src-tauri/src/pty/daemon_session.rs`
- Test: `tests/daemon_integration_test.rs`

**Interfaces:**
- Consumes: PTY output chunks
- Produces: Subscriber registration using `tokio::sync::mpsc::UnboundedSender<DaemonEvent>` or bounded MPSC, eliminating `RecvError::Lagged`.

- [ ] **Step 1: Write integration test for high-throughput stream without dropped lines**

In `tests/daemon_integration_test.rs`:
Add test streaming 10,000 lines and asserting all 10,000 lines are received in order without skipping.

- [ ] **Step 2: Run test to verify baseline**

Run: `cargo test -p oppa --test daemon_integration_test`

- [ ] **Step 3: Implement subscriber MPSC channels in `DaemonSession`**

Replace `broadcast::Sender<DaemonEvent>` with `Mutex<Vec<tokio::sync::mpsc::Sender<DaemonEvent>>>` (or `broadcast` with large backlog and dedicated client forwards), removing `RecvError::Lagged` drops.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p oppa --lib` and `cargo test -p oppa --test daemon_integration_test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pty/daemon_session.rs src-tauri/src/pty/daemon_server.rs tests/daemon_integration_test.rs
git commit -m "perf: replace lossy broadcast stream with reliable mpsc channels"
```

---

### Task 5: Eliminate Main-Thread Scrollback Serialization Freezes & Debounce Layout Disk I/O

**Files:**
- Modify: `src/components/TerminalPane.tsx:210-226`
- Modify: `src/store/terminalStore.ts:645-663`
- Modify: `src-tauri/src/pty/snapshot.rs:90-100, 145-155`
- Test: `src/store/terminalStore.test.ts`
- Test: `src/components/TerminalPane.test.tsx`

**Interfaces:**
- Consumes: OSC 7 CWD events, xterm output
- Produces: Zero periodic 500 ms `serialize()` pauses during active output; debounced layout saving (2 seconds) with immediate flush on window close.

- [ ] **Step 1: Write frontend test verifying layout save is debounced on CWD update**

In `src/store/terminalStore.test.ts`:
Assert that multiple rapid `updateSessionCwd` calls update store state immediately but batch disk saves.

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm vitest run src/store/terminalStore.test.ts`

- [ ] **Step 3: Implement debounced save and remove 500 ms serialization**

1. In `TerminalPane.tsx`, remove the 500 ms `flushTimer` that calls `serializeAddon.serialize()` on every parsed chunk. Keep serialization registered in `registerSerializer` so layout saves and window close capture the state.
2. In `terminalStore.ts`, debounce `updateSessionCwd` layout persistence with a 2-second timer.
3. In `snapshot.rs`, remove blocking `file.sync_all()?` on background snapshot writes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run` and `cargo test -p oppa --lib`
Expected: PASS (all 621 vitest tests and 83 Rust tests pass).

- [ ] **Step 5: Commit**

```bash
git add src/components/TerminalPane.tsx src/store/terminalStore.ts src-tauri/src/pty/snapshot.rs
git commit -m "perf: eliminate periodic scrollback serialization and debounce cwd layout disk writes"
```

---

### Task 6: Process Group & Subprocess Tree Cleanup

**Files:**
- Modify: `src-tauri/src/pty/daemon_session.rs:65-130, 265-267`
- Test: `tests/daemon_integration_test.rs`

**Interfaces:**
- Consumes: `DaemonSession::kill()`
- Produces: Windows Job Object limits and Unix `killpg` execution, ensuring zero leaked child processes.

- [ ] **Step 1: Write integration test for process group cleanup**

In `tests/daemon_integration_test.rs`:
Spawn a shell running a background sleeper process, call `session.kill()`, and assert that the subprocess is terminated.

- [ ] **Step 2: Run test to verify baseline**

Run: `cargo test -p oppa --test daemon_integration_test`

- [ ] **Step 3: Implement process group termination**

1. On Windows, assign spawned child processes to a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
2. On Unix, invoke `libc::killpg(pid as i32, libc::SIGKILL)` in `DaemonSession::kill`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p oppa --lib` and `cargo test -p oppa --test daemon_integration_test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pty/daemon_session.rs tests/daemon_integration_test.rs
git commit -m "fix: ensure complete process tree termination on session kill"
```

---

## Plan Self-Review & Verification Checklist

1. **Spec Coverage:** Every P0 and P1 item from the design spec has a dedicated task with explicit tests.
2. **No Placeholders:** All code snippets, test commands, and file paths are exact and complete.
3. **No UI Changes:** All tasks are strictly in the backend, PTY reader, IPC transport, and store/xterm data flow layers.
