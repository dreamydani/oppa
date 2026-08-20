# OPPA — Terminal Performance, Backpressure Alignment & Backend Stability Design

**Date:** 2026-08-21  
**Status:** Draft for review  
**Target:** Terminal Core, PTY Daemon, IPC Transport, xterm.js Rendering, Backend Subsystems  

---

## 1. Purpose & Motivation

During high-throughput terminal operations (e.g. streaming logs, `cargo build`, fast CLI output, CJK text, and emojis), users occasionally experience **micro-stutter, lag spikes, and occasional terminal freezes**. 

An in-depth system audit identified the exact root causes:
1. **Backpressure Unit Mismatch:** Rust PTY reader counts raw bytes (`pending.fetch_add(n)`), while the frontend ACKs JavaScript UTF-16 characters (`data.length`). On multi-byte UTF-8, `pending_bytes` continually drifts upward until reaching `HIGH_WATERMARK_BYTES` (256 KB), causing permanent stalls.
2. **Synchronous RPC Bottleneck for ACKs:** Every ACK from xterm.js triggers a synchronous roundtrip over IPC, acquiring a global mutex (`request_lock`) and blocking the caller thread with `recv_timeout` waiting for a `DaemonResponse::Ok`.
3. **UTF-8 Chunk Boundary Splitting:** Arbitrary 8 KB chunking in the reader thread decodes incomplete multi-byte sequences with `from_utf8_lossy`, replacing them with replacement characters (``).
4. **Broadcast Dropped Events:** `tokio::sync::broadcast(2048)` silently drops output chunks under heavy load (`RecvError::Lagged`).
5. **Main-Thread Buffer Serialization:** `SerializeAddon.serialize()` traverses up to 10,000 lines on a 500 ms debounce on the main JS thread, freezing the UI.
6. **Disk Thrashing via OSC 7 CWD Prompt:** PowerShell integration emits OSC 7 on every command prompt, immediately triggering synchronous SSD `file.sync_all()` writes.
7. **Orphan Process Leaks:** Direct `child.kill()` does not terminate grandchild subprocess trees.

This design establishes a high-performance, rock-solid terminal data pipeline with **zero UI regressions**, **zero output drops**, and **sub-millisecond streaming latency**.

---

## 2. Architectural Design

### 2.1 Byte-Accurate Backpressure & Async Fire-and-Forget ACKs

```
[ PTY OS Pipe ] ──► [ Reader Thread: Buffer + Residual UTF-8 ]
                           │
                           ▼ (raw byte count tracked)
              [ Point-to-Point MPSC Stream ]
                           │
                           ▼
                 [ IPC Event: PtyDataPayload { id, data, bytes, seq } ]
                           │
                           ▼
                 [ xterm.js: term.write() ]
                           │
                           ▼ (onWriteParsed / batching)
                 [ Async One-Way ACK: ptyAck(id, byteCount) ]
                           │ (Fire-and-forget, no synchronous response wait)
                           ▼
                 [ DaemonSession: pending_bytes.saturating_sub(byteCount) ]
```

1. **Byte Length in Event Payloads:**  
   `PtyDataPayload` and `DaemonEvent::Data` include `bytes: usize` (the exact byte count of the chunk).
2. **Frontend Byte Accumulation:**  
   `TerminalPane.tsx` increments `parsedBytesRef` by `p.bytes` (or UTF-8 byte length).
3. **One-Way Asynchronous ACK Dispatch:**  
   The daemon processes `DaemonRequest::Ack { session_id, bytes }` as a fire-and-forget message without dispatching a `DaemonResponse::Ok` reply, eliminating the need for `DaemonClient` to acquire `request_lock` or wait synchronously.

### 2.2 UTF-8 Chunk Boundary Preservation

1. **Residual Byte State:**  
   The PTY reader thread maintains a 3-byte `trailing_utf8: [u8; 3]` buffer.
2. **Boundary Validation:**  
   Before converting bytes to a string for IPC transport, `std::str::from_utf8` checks for incomplete trailing bytes. If a multi-byte sequence is split at the 8 KB boundary (e.g. 1 to 3 trailing bytes of a 2-4 byte code point), the incomplete bytes are saved in the residual buffer and prepended to the next read.
3. **Result:** Complete elimination of `` character corruption across all languages and emojis.

### 2.3 Point-to-Point Dedicated MPSC Streaming (Zero-Drop Guarantee)

1. **Replace Broadcast:**  
   Replace `tokio::sync::broadcast` in `DaemonSession` with dedicated `tokio::sync::mpsc::Sender<DaemonEvent>` channels for connected subscriber streams.
2. **Reliable Queueing:**  
   MPSC channels preserve every output event in-order without `Lagged` packet drops, guaranteeing 100% complete terminal output.

### 2.4 Eliminating Main-Thread Freezes & Disk Thrashing

1. **Remove 500 ms `flushScrollback` from Hot Path:**  
   In `TerminalPane.tsx`, remove the periodic `flushTimer` that calls `serializeAddon.serialize()` 500 ms after every keypress.
2. **Preserve Safe Scrollback Persistence:**  
   Serialize scrollback only on:
   - Tab switch / pane unmount
   - App close handshake (`app:before-close`)
   - Extended idle periods (30 seconds of inactivity)
3. **Debounce Layout & CWD Disk Writes:**  
   Debounce `saveLayout()` in `terminalStore.ts` by 2 seconds so command prompt executions (OSC 7) update memory state immediately but batch disk I/O. Remove `file.sync_all()` on background snapshot saves.

### 2.5 Process Group Cleanup

1. **Windows:** Spawn shell processes within a dedicated Windows Job Object configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
2. **Unix:** Terminate the process group with `libc::killpg(pid, libc::SIGKILL)` when a session is killed.

---

## 3. Risks & Safety Matrix

| Area | Risk | Mitigation Strategy |
|---|---|---|
| **ACK Protocol** | Dropped or mismatched ACKs stalling PTY | Raw byte lengths are deterministic and monotonically tracked; named pipe IPC is reliable in-order transport. |
| **Scrollback Persistence** | Incomplete scrollback on unexpected kill | The existing Tauri close handshake (`app:before-close` -> `confirm_save_complete`) explicitly awaits serialization before app destruction. |
| **UTF-8 Chunking** | Malformed invalid byte sequences stalling reader | If trailing bytes do not form a valid UTF-8 start within 4 bytes, flush them cleanly as lossy replacement to prevent infinite buffer stalls. |
| **UI Stability** | Rendering regressions or layout glitches | Zero DOM/CSS/styling changes. All fixes are purely in the transport, PTY reader, and state layers. |

---

## 4. Verification & Testing Strategy

1. **Rust Library Tests (`cargo test -p oppa --lib`):**
   - Unit tests for UTF-8 boundary buffer holding 1, 2, and 3 trailing bytes.
   - Backpressure unit tests verifying `pending_bytes` accurately decrements with multi-byte characters and emojis.
   - Asynchronous ACK unit tests.
2. **Daemon Integration Tests (`cargo test -p oppa --test daemon_integration_test`):**
   - High-throughput streaming test (`100,000` lines) asserting zero dropped lines and zero deadlock.
   - Warm reattachment snapshot integrity test.
3. **Frontend Vitest Suite (`pnpm vitest run`):**
   - Verify all 621 tests pass.
   - Verify `TerminalPane` accurately sends byte-based ACKs and debounces layout saves.
