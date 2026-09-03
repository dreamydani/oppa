# Stability Backpressure + Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate terminal freezes, lost output, and broken updates without changing UI features.

**Architecture:** Unify byte accounting behind one owner per seam (BackpressureAccount semantics in Rust, bytes-only ACK on wire), validate lifecycle inputs at the daemon seam, and make release.mjs version-aware with signed per-channel manifests. Small interfaces, deep implementations.

**Tech Stack:** Rust (portable-pty, vt100, Tokio daemon over named pipe / UDS), TypeScript (xterm, zustand, AckCoalescer), scripts/release.mjs + tauri-plugin-updater.

**Spec:** docs/superpowers/specs/2026-08-16-terminal-core-design.md (never-drop, ACK backpressure 256KB high / 32KB low) and docs/superpowers/specs/2026-08-30-developer-oppa-channels-design.md (channel isolation)

## Global Constraints

- Rust-first: all PTY/session/backpressure logic lives in src-tauri/src/pty/.
- Renderer components never call Tauri invoke directly; src/lib/pty/transport.ts is the only file that touches Tauri APIs for PTY.
- Concise comments ONLY — explain WHY, not HOW, 1 line if possible.
- Descriptive variable names; prefer const over let unless reassigned.
- TDD: write failing test first, verify it fails, implement, verify it passes.
- Rust unit tests: cargo test -p oppa --lib in src-tauri.
- Rust daemon integration: cargo test -p oppa --test daemon_integration_test in src-tauri.
- Renderer: pnpm vitest run with @testing-library/react + happy-dom.
- Every task ends with a commit. Conventional messages (fix:, feat:).
- Cross-platform: macOS, Linux, Windows. No hardcoded shell paths or metaKey.

---

### Task 1: Byte-accounting core (Rust batcher + ack semantics)

**Files:**
- Modify: `src-tauri/src/pty/output_batcher.rs:112-130`
- Modify: `src-tauri/src/pty/daemon_session.rs:483-496`
- Test: `src-tauri/src/pty/output_batcher.rs` tests, `src-tauri/src/pty/daemon_session.rs` tests

**Interfaces:**
- Consumes: `pending_bytes: Arc<AtomicUsize>`, `OutputDrain::send_chunk/finish`, `Utf8ChunkDecoder`.
- Produces: `run_batcher` tail emit carries `real byte count (usize)`; `DaemonSession::ack(bytes: usize)` subtracts bytes.

- [ ] **Step 1: Write the failing test for tail byte accounting**

```rust
#[test]
fn close_tail_emit_carries_real_byte_count() {
    let (drain, rx, drained_tx) = new_drain();
    let (event_tx, event_rx) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        run_batcher(rx, drained_tx, 60_000, move |text, bytes| {
            let _ = event_tx.send((text, bytes));
        });
    });
    // "✨" is 3 bytes in UTF-8; send first 2 bytes then close.
    drain.send_chunk(vec![0xE2, 0x9C]);
    drain.finish();
    // First event: decoded "" with 2 bytes accounted.
    let first = event_rx.recv_timeout(std::time::Duration::from_millis(200)).expect("first event");
    assert_eq!(first.1, 2);
    // Second event (replacement char) must carry its own byte length, never 0 with non-empty text.
    let second = event_rx.recv_timeout(std::time::Duration::from_millis(200)).expect("tail event");
    if !second.0.is_empty() {
        assert!(second.1 > 0, "non-empty tail must carry byte count, got {:?}", second);
    }
    let _ = handle.join();
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p oppa --lib output_batcher` in `src-tauri`
Expected: FAIL on `assert!(second.1 > 0)` because current code does `emit(tail, 0)`.

- [ ] **Step 3: Write minimal implementation**

In `src-tauri/src/pty/output_batcher.rs`, change both `Close` and `Disconnected` arms:

```rust
Ok(BatchCommand::Close) => {
    flush_batch(&mut buf, &mut decoder, &mut batch_first_at, &mut emit);
    let tail = decoder.flush();
    if !tail.is_empty() {
        let tail_bytes = tail.len();
        emit(tail, tail_bytes);
    }
    break;
}
```

Apply the same to the `Err(RecvTimeoutError::Disconnected)` arm. In `daemon_session.rs`, rename the `ack` parameter for clarity without changing the wire yet:

```rust
/// Release backpressure by acknowledging processed bytes.
pub fn ack(&self, bytes: usize) -> Result<(), String> {
    self.pending_bytes
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |p| {
            Some(p.saturating_sub(bytes))
        })
        .unwrap_or(0);
    if self.pending_bytes.load(Ordering::SeqCst) < LOW_WATERMARK_BYTES {
        self.paused.unpause();
    }
    Ok(())
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p oppa --lib` in `src-tauri`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pty/output_batcher.rs src-tauri/src/pty/daemon_session.rs
git commit -m "fix(daemon): account tail bytes instead of emit(tail,0)"
```

### Task 2: Wire rename chars -> bytes with compat

**Files:**
- Modify: `src-tauri/src/pty/ipc_protocol.rs:138-140`
- Modify: `src-tauri/src/pty/request_router.rs:201-211`
- Modify: `src-tauri/src/pty/commands.rs:291-292`
- Modify: `src-tauri/src/pty/manager.rs:252-254`
- Modify: `src-tauri/src/pty/daemon_client.rs:543-549`
- Modify: `src/lib/pty/transport.ts:118`
- Modify: `src/store/slices/terminalSessionsSlice.ts:96,286`
- Test: `src/lib/pty/transport.test.ts`, `src/store/terminalStore.test.ts`

**Interfaces:**
- Consumes: Task 1 `ack(bytes)`.
- Produces: Wire `DaemonRequest::Ack { session_id, bytes }` (accepts legacy `chars` via serde alias); TS `ptyAck(id, bytes)`; `ackSession(id, bytes)`.

- [ ] **Step 1: Write the failing test (TS)**

```typescript
it("ptyAck invokes pty_ack with bytes", async () => {
  const { ptyAck } = await import("./transport");
  await ptyAck("abc", 42);
  expect(invokeMock).toHaveBeenCalledWith("pty_ack", { id: "abc", bytes: 42 });
});
```

Update `src/store/terminalStore.test.ts:427` wording from "char count" to "byte count" (same call shape).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/pty/transport.test.ts`
Expected: FAIL because code sends `{ id, chars }`.

- [ ] **Step 3: Write minimal implementation**

Rust `ipc_protocol.rs`:

```rust
Ack {
    session_id: String,
    #[serde(alias = "chars")]
    bytes: usize,
},
```

Update `request_router.rs` Ack arm to use `bytes`, `commands.rs`:

```rust
pub fn pty_ack(manager: State<'_, PtyManager>, id: String, bytes: usize) -> Result<(), String> {
    manager.ack(&id, bytes)
}
```

Update `manager.rs`, `daemon_client.rs` parameter names to `bytes`. TS `transport.ts`:

```typescript
export async function ptyAck(id: string, bytes: number): Promise<void> {
  return invoke("pty_ack", { id, bytes });
}
```

Update `terminalSessionsSlice.ts` signature `ackSession: (id: string, bytes: number) => Promise<void>` and body. Note: Tauri invoke arg name must match Rust param name (`bytes`); keep them in lockstep.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p oppa --lib` in `src-tauri`
Run: `pnpm vitest run src/lib/pty/transport.test.ts src/lib/pty/ackCoalescer.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pty/ipc_protocol.rs src-tauri/src/pty/request_router.rs src-tauri/src/pty/commands.rs src-tauri/src/pty/manager.rs src-tauri/src/pty/daemon_client.rs src/lib/pty/transport.ts src/store/slices/terminalSessionsSlice.ts src/lib/pty/transport.test.ts src/store/terminalStore.test.ts
git commit -m "fix(daemon): rename ack chars to bytes with legacy alias"
```

### Task 3: Lifecycle validation (resize, kill, ready-marker, reattach)

**Files:**
- Modify: `src-tauri/src/pty/request_router.rs:82-103,186-200,212-219`
- Modify: `src-tauri/src/pty/daemon_session.rs:346-353,509-533`
- Test: `src-tauri/src/pty/daemon_server.rs` tests or new `request_router` tests

**Interfaces:**
- Consumes: Task 1-2 accounting.
- Produces: `Resize` rejects 0; streaming ready-marker detection; `Kill` emits Exit before removal; reattach preserves queued bytes.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn resize_zero_is_rejected() {
    // DaemonRequest::Resize { cols: 0, rows: 0 } must return DaemonResponse::Error, never call PtySize{0,0}
}

#[test]
fn ready_marker_split_across_chunks_is_detected() {
    // Feed b"OP" then b"PA_READY..." equivalent marker halves; assert ready_seen becomes true without waiting 15s fallback.
}
```

For kill ordering: spawn a session, call Kill, assert an Exit event was emitted for that session id before the map entry vanished (use existing event subscriber test harness in daemon_server.rs tests).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p oppa --lib` in `src-tauri`
Expected: FAIL (resize 0 accepted; split marker missed).

- [ ] **Step 3: Write minimal implementation**

`request_router.rs` Resize arm:

```rust
DaemonRequest::Resize { session_id, cols, rows } => {
    if cols == 0 || rows == 0 {
        return DaemonResponse::Error("cols and rows must be > 0".to_string());
    }
    // ... existing lookup + session.resize(cols, rows)
}
```

Ready-marker: carry `READY_MARKER.len() - 1` overlap bytes between chunks. Keep a small `Vec<u8>` tail buffer on the reader loop; prepend it before scanning, then retain the last `marker_len - 1` bytes for the next iteration. (Why: `windows()` on a single chunk misses markers split across reads.)

Kill: emit `DaemonEvent::Exit` via subscribers before `sessions.remove`, or document that watchdog owns Exit and Kill only signals the child; do not remove-then-kill silently. Minimal: keep remove-then-kill but call `session.kill()` and then explicitly emit Exit through the server event bus so listeners never hang.

Reattach: in `CreateOrAttach` existing-session branch, do not blindly `reset_pending()` to 0 while the batcher queue holds data. Minimal for this task: keep `reset_pending()` but add a comment + unpause; full drain-aware reset is follow-up if batcher queue depth is not observable here. Do not invent cross-thread queue inspection.

Unix kill: use recorded pgid with pid fallback:

```rust
#[cfg(unix)]
{
    if self.pid > 0 {
        unsafe {
            // Prefer process group, fall back to pid on ESRCH.
            if libc::killpg(self.pid as i32, libc::SIGKILL) != 0 {
                let _ = libc::kill(self.pid as i32, libc::SIGKILL);
            }
        }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p oppa --lib` in `src-tauri`
Run: `cargo test -p oppa --test daemon_integration_test` in `src-tauri`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pty/request_router.rs src-tauri/src/pty/daemon_session.rs
git commit -m "fix(daemon): validate resize, split ready-marker, orderly kill"
```

### Task 4: Release installer + manifest hardening

**Files:**
- Modify: `scripts/release.mjs:72-76,339-394`
- Modify: `scripts/release.test.mjs`
- Test: `node --test scripts/release.test.mjs`

**Interfaces:**
- Consumes: none.
- Produces: `findInstaller(root, version, arch)` version+arch aware; `collectInstallers` race-tolerant; `writeManifest` includes signature slot; `atomicWrite` unique tmp + cleanup.

- [ ] **Step 1: Write the failing tests**

```javascript
test("findInstaller prefers matching version over newer mtime", () => {
  // fixture dir with oppa-0.2.1.msi (newer mtime) and oppa-0.2.2.msi (older mtime):
  // findInstaller(root, "0.2.2", "x64") must return the 0.2.2 file.
});

test("collectInstallers survives race-deleted file", () => {
  // file vanishes between readdir and statSync: must not throw.
});

test("writeManifest includes signature slot", () => {
  const { manifest } = writeManifest("0.2.2", "oppa-0.2.2.msi");
  assert.ok("signature" in manifest);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test scripts/release.test.mjs`
Expected: FAIL (version ignored, race throws, no signature key).

- [ ] **Step 3: Write minimal implementation**

```javascript
export function findInstaller(projectRoot, version, arch = process.arch) {
  // ... bundleDir resolution unchanged ...
  const installers = collectInstallers(bundleDir);
  const versioned = version ? installers.filter((f) => basename(f).includes(version)) : installers;
  const pool = versioned.length > 0 ? versioned : installers;
  const archFiltered = pool.filter((f) => basename(f).includes(arch) || !/x64|arm64|aarch64/.test(basename(f)));
  const ranked = (archFiltered.length > 0 ? archFiltered : pool);
  if (ranked.length === 0) throw new Error(`no installer found under ${bundleDir}`);
  return ranked[0];
}
```

`collectInstallers` sort with try/catch around `statSync`; `atomicWrite` tmp `.<base>.<pid>.<rand>.tmp` + cleanup on failure; `writeManifest(version, installerFilename, signature = "")` returns `{ version, download, signature }`. Add `--dry-run` flag that prints `gh` args without spawning (pure path, testable).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test scripts/release.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/release.mjs scripts/release.test.mjs
git commit -m "fix(release): version-aware installer pick, tolerant scan, manifest signature slot"
```

### Task 5: Frontend ACK wiring (bytes + idRef)

**Files:**
- Modify: `src/components/TerminalPane.tsx:496-497`
- Modify: `src/lib/pty/ackCoalescer.test.ts`
- Modify: `src/store/terminalStore.test.ts:427`
- Test: `src/lib/pty/ackCoalescer.test.ts`, `src/components/TerminalPane.test.tsx`

**Interfaces:**
- Consumes: Task 2 `ptyAck(id, bytes)`, `ackSession(id, bytes)`.
- Produces: Pane forwards `payload.bytes` (raw byte length, never `data.length`); unmount flush uses live id.

- [ ] **Step 1: Write the failing test**

```typescript
it("forwards raw byte counts, not string length", () => {
  // payload { data: "🚀", bytes: 4 }: coalescer.add must receive 4, not 1 (UTF-16 length 2, char count 1).
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/pty/ackCoalescer.test.ts`
Expected: FAIL if call site uses `data.length`.

- [ ] **Step 3: Write minimal implementation**

In `TerminalPane.tsx`, ensure the data handler does:

```tsx
const ackCoalescer = new AckCoalescer((bytes) => {
  void ackSession(idRef.current, bytes).catch(() => {});
});
// on data:
ackCoalescer.add(payload.bytes);
```

Never `payload.data.length`. Fix the stale-`id` closure by reading `idRef.current` at flush time. Update test wording "char count" → "byte count".

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/pty/ackCoalescer.test.ts src/lib/pty/transport.test.ts src/components/TerminalPane.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/TerminalPane.tsx src/lib/pty/ackCoalescer.test.ts src/store/terminalStore.test.ts
git commit -m "fix(ui): ack raw bytes with live session id"
```
