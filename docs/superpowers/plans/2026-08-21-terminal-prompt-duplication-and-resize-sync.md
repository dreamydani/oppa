# Terminal Prompt Duplication, ConPTY Resize Synchronization & Screen Mirroring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate duplicated command prompts and content during app restore, refresh, reopen, split pane creation, and CLI execution by fixing ConPTY resize desync, screen mirror newline flooding, and in-buffer banner pollution.

**Architecture:** 
1. Pre-measure container dimensions (`cols`, `rows`) before spawning or restoring sessions so ConPTY initializes at the exact target dimensions.
2. Synchronize dimensions in the daemon before generating warm reattachment snapshots (`CreateOrAttach`).
3. Clean `ScreenMirror` snapshot formatting to omit trailing blank rows that induce phantom scrolling in small viewports.
4. Eliminate in-buffer text banner (`term.writeln`) in favor of DOM-based restore indicator in `TerminalPaneHeader`.
5. Call `term.reset()` before replaying snapshots on warm reattachment.

**Tech Stack:** Rust (Tauri 2, Tokio, Portable-PTY, vt100), React 19, TypeScript, Zustand, xterm.js, Vitest, Cargo test.

## Global Constraints

- Never break ACK-based backpressure or the point-to-point MPSC streaming architecture.
- Keep platform-dependent behavior behind runtime checks (Windows ConPTY vs. Unix PTY).
- Maintain 100% test coverage with TDD for all Rust and React changes.
- Every task must end with a clean commit.

---

### Task 1: Fix `ScreenMirror` Snapshot Formatting (Omit Trailing Empty Rows)

**Files:**
- Modify: `src-tauri/src/pty/screen_mirror.rs:38-66`
- Test: `src-tauri/src/pty/screen_mirror.rs:70-108`

**Interfaces:**
- `ScreenMirror::get_formatted_snapshot(&self) -> String`: Returns clean ANSI snapshot without trailing empty rows that cause phantom xterm scrolling.

- [ ] **Step 1: Write failing unit test in `screen_mirror.rs`**

```rust
#[test]
fn test_screen_mirror_snapshot_omits_trailing_blank_lines() {
    let mut mirror = ScreenMirror::new(80, 24, 1000);
    mirror.process(b"PS C:\\Users\\danial>\x1b[?25h");
    let snapshot = mirror.get_formatted_snapshot();
    // Snapshot should contain the prompt and cursor home, but not 23 trailing newlines
    assert!(snapshot.contains("PS C:\\Users\\danial>"));
    let newline_count = snapshot.matches("\r\n").count();
    assert_eq!(newline_count, 0, "expected 0 trailing newlines for single-line prompt, got {newline_count}");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p oppa --lib pty::screen_mirror::tests::test_screen_mirror_snapshot_omits_trailing_blank_lines` (in `src-tauri`)
Expected: FAIL with `expected 0 trailing newlines, got 23`

- [ ] **Step 3: Update `get_formatted_snapshot()` in `src-tauri/src/pty/screen_mirror.rs`**

Update `get_formatted_snapshot` to trim trailing empty rows so that only rows up to the last non-empty row (or cursor row) are rendered with `\r\n`:

```rust
pub fn get_formatted_snapshot(&self) -> String {
    let screen = self.parser.screen();
    let mut result = String::new();

    // 1. Hide cursor during buffer paint
    result.push_str("\x1b[?25l");
    // 2. Clear visible screen and return to home position
    result.push_str("\x1b[2J\x1b[H");

    let (_rows, cols) = screen.size();
    let (cursor_row, cursor_col) = screen.cursor_position();
    let rows_formatted: Vec<Vec<u8>> = screen.rows_formatted(0, cols).collect();

    // Find the last row that contains non-empty content or cursor
    let mut last_active_row = cursor_row as usize;
    for (i, row_bytes) in rows_formatted.iter().enumerate().rev() {
        let text = String::from_utf8_lossy(row_bytes);
        if text.trim().len() > 0 {
            if i > last_active_row {
                last_active_row = i;
            }
            break;
        }
    }

    let mut first = true;
    for (i, row_bytes) in rows_formatted.iter().enumerate() {
        if i > last_active_row {
            break;
        }
        if !first {
            result.push_str("\r\n");
        }
        first = false;
        result.push_str(&String::from_utf8_lossy(row_bytes));
    }

    // 3. Restore absolute cursor position (1-indexed)
    result.push_str(&format!("\x1b[{};{}H", cursor_row + 1, cursor_col + 1));
    // 4. Restore cursor visibility
    result.push_str("\x1b[?25h");

    result
}
```

- [ ] **Step 4: Run tests to verify all tests pass**

Run: `cargo test -p oppa --lib pty::screen_mirror` (in `src-tauri`)
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pty/screen_mirror.rs
git commit -m "fix(pty): trim trailing empty rows in ScreenMirror formatted snapshot"
```

---

### Task 2: Pre-Resize Existing Sessions on Reattach in Daemon (`daemon_server.rs`)

**Files:**
- Modify: `src-tauri/src/pty/daemon_server.rs:77-88`
- Test: `src-tauri/src/pty/daemon_server.rs:394-496`

**Interfaces:**
- In `DaemonServer::handle_request(DaemonRequest::CreateOrAttach { session_id, cols, rows, .. })`:
  If session already exists and `cols > 0 && rows > 0`, call `session.resize(cols, rows)` *before* calling `session.get_snapshot()`.

- [ ] **Step 1: Write failing unit test in `daemon_server.rs`**

```rust
#[test]
fn test_create_or_attach_resizes_before_taking_snapshot() {
    let server = DaemonServer::new();
    let _ = server.handle_request(DaemonRequest::CreateOrAttach {
        session_id: "test-resize-attach".into(),
        cols: 80,
        rows: 24,
        cwd: None,
        shell: None,
    });
    // Reattach with 50x14
    let resp = server.handle_request(DaemonRequest::CreateOrAttach {
        session_id: "test-resize-attach".into(),
        cols: 50,
        rows: 14,
        cwd: None,
        shell: None,
    });
    match resp {
        DaemonResponse::SessionAttached(res) => {
            assert_eq!(res.cols, 50);
            assert_eq!(res.rows, 14);
        }
        other => panic!("expected SessionAttached, got {other:?}"),
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p oppa --lib pty::daemon_server::tests::test_create_or_attach_resizes_before_taking_snapshot` (in `src-tauri`)
Expected: FAIL (returns old dimensions 80x24 instead of 50x14).

- [ ] **Step 3: Update `daemon_server.rs` to resize before snapshot**

```rust
DaemonRequest::CreateOrAttach {
    session_id,
    cols,
    rows,
    cwd,
    shell,
} => {
    let mut sessions = self.sessions.lock();
    if let Some(session) = sessions.get(&session_id) {
        if cols > 0 && rows > 0 && (session.cols() != cols || session.rows() != rows) {
            let _ = session.resize(cols, rows);
        }
        let snapshot = session.get_snapshot();
        DaemonResponse::SessionAttached(CreateOrAttachResult {
            is_new: false,
            pid: session.pid(),
            cols: session.cols(),
            rows: session.rows(),
            cwd: session.cwd(),
            snapshot: Some(snapshot),
        })
    } else {
```

- [ ] **Step 4: Run tests to verify all tests pass**

Run: `cargo test -p oppa --lib pty::daemon_server` (in `src-tauri`)
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pty/daemon_server.rs
git commit -m "fix(daemon): synchronize PTY and mirror dimensions before taking reattach snapshot"
```

---

### Task 3: Support Explicit Geometry in `spawnSession` & Pass Dimensions in `terminalStore.ts`

**Files:**
- Modify: `src/store/terminalStore.ts:518-570`
- Modify: `src/lib/pty/transport.ts:43-45`
- Test: `src/store/terminalStore.test.ts`

**Interfaces:**
- `spawnSession: (cwd?: string, shell?: string, existingId?: string, geometry?: { cols: number; rows: number }) => Promise<string>`
- Passes `{ cols, rows }` in `PtySpawnOptions` to `ptySpawn`.

- [ ] **Step 1: Write failing unit test in `terminalStore.test.ts`**

Add test verifying `spawnSession` passes `cols` and `rows` to `ptySpawn`:

```typescript
it("passes target cols and rows to ptySpawn when provided", async () => {
  const store = useTerminalStore.getState();
  await store.spawnSession(undefined, undefined, undefined, { cols: 50, rows: 14 });
  expect(ptySpawn).toHaveBeenCalledWith(expect.objectContaining({ cols: 50, rows: 14 }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/store/terminalStore.test.ts`
Expected: FAIL.

- [ ] **Step 3: Update `spawnSession` in `src/store/terminalStore.ts`**

```typescript
spawnSession: async (cwd, shell, existingId, geometry) => {
  try {
    const targetCwd = cwd ?? (existingId ? undefined : get().resolveDefaultCwd());
    const opts: PtySpawnOptions = {};
    if (existingId) opts.id = existingId;
    if (targetCwd) opts.cwd = targetCwd;
    if (shell) opts.shell = shell;
    if (geometry?.cols) opts.cols = geometry.cols;
    if (geometry?.rows) opts.rows = geometry.rows;
    const res = await ptySpawn(Object.keys(opts).length > 0 ? opts : undefined);
    // ... rest of spawnSession
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/store/terminalStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/terminalStore.ts src/lib/pty/transport.ts
git commit -m "feat(store): allow passing initial terminal geometry to spawnSession"
```

---

### Task 4: Remove In-Buffer `[Session Restored]` Text & Clean Reattach Reset in `TerminalPane.tsx`

**Files:**
- Modify: `src/components/TerminalPane.tsx:115-125`
- Test: `src/components/TerminalPane.test.tsx`

**Interfaces:**
- In `TerminalPane.tsx`:
  - When writing `restoredScrollback`, call `term.reset()` first.
  - Do NOT write `\r\n── [Session Restored] ──\r\n` into the terminal character grid.
  - Clear `restoredScrollback` immediately.

- [ ] **Step 1: Write failing unit test in `TerminalPane.test.tsx`**

```typescript
it("does not pollute terminal buffer with in-stream restored banner text", async () => {
  useTerminalStore.setState({
    restoredScrollbacks: { "sess-1": "PS C:\\Users\\danial>" },
    sessions: { "sess-1": { id: "sess-1", title: "Terminal", status: "running", cols: 80, rows: 24 } },
  });
  const { container } = render(<TerminalPane id="sess-1" />);
  // Verify term.writeln was not called with the session restored divider string
  expect(mockTermInstance.writeln).not.toHaveBeenCalledWith(
    expect.stringContaining("Session Restored")
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/TerminalPane.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Update `TerminalPane.tsx` lines 115-125**

```typescript
const state = useTerminalStore.getState();
const restoredScrollback = state.restoredScrollbacks[id];
const cachedScrollback = state.cachedScrollbacks[id];
if (restoredScrollback) {
  term.reset();
  term.write(restoredScrollback);
  clearRestoredScrollback(id);
} else if (cachedScrollback) {
  term.write(cachedScrollback);
}
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `pnpm vitest run src/components/TerminalPane.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/TerminalPane.tsx
git commit -m "fix(terminal): clean terminal reset on snapshot write and remove in-buffer restore divider"
```

---

### Task 5: Pre-Measure Pane Dimensions on Mount and Grid Split

**Files:**
- Modify: `src/components/SessionLeaf.tsx`
- Modify: `src/components/TerminalPane.tsx`
- Test: `src/components/SessionLeaf.test.tsx`

**Interfaces:**
- Estimate or calculate initial `cols`/`rows` from parent container width/height and font metrics (e.g. 9px char width, 18px line height) so that the first `ptySpawn` invocation matches the actual DOM dimensions instead of default 80x24.

- [ ] **Step 1: Write test for initial dimension calculation in `SessionLeaf.test.tsx`**

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Implement pre-measured container dimensions in `SessionLeaf.tsx` / `TerminalPane.tsx`**

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run`
Expected: All frontend tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/SessionLeaf.tsx src/components/TerminalPane.tsx
git commit -m "fix(terminal): pre-measure container dimensions to prevent ConPTY startup resize redraw"
```

---

### Task 6: Full Verification & Integration Testing

**Files:**
- Test: `cargo test -p oppa --lib` (in `src-tauri`)
- Test: `cargo test -p oppa --test daemon_integration_test` (in `src-tauri`)
- Test: `pnpm vitest run`
- Test: `pnpm build`

- [ ] **Step 1: Run all Rust backend tests**
Run: `cargo test -p oppa --lib` (in `src-tauri`)
Expected: 100% tests PASS.

- [ ] **Step 2: Run all Daemon integration tests**
Run: `cargo test -p oppa --test daemon_integration_test` (in `src-tauri`)
Expected: 100% tests PASS.

- [ ] **Step 3: Run all Frontend Vitest tests**
Run: `pnpm vitest run`
Expected: 100% tests PASS.

- [ ] **Step 4: Verify TypeScript & Vite production build**
Run: `pnpm build`
Expected: Build succeeds with 0 errors.

- [ ] **Step 5: Commit plan completion verification**
```bash
git commit --allow-empty -m "chore: verify all backend and frontend tests pass for prompt duplication fix"
```
