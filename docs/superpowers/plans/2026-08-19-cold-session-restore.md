# Cold Session Restoration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore terminal sessions, split layouts, directory paths, and scrollback history after a full PC shutdown/reboot with "Session loading..." skeleton and "Session restored" UI banners.

**Architecture:** Dual-tier recovery: Daemon memory mirror for live reattachment (warm), and disk checkpoint snapshot replay + fresh shell respawn in saved CWD for post-reboot recovery (cold). Frontend manages loading and restored banner lifecycles.

**Tech Stack:** Rust (Tauri 2, Tokio, portable-pty, serde_json), React 19, TypeScript, Zustand, @xterm/xterm.

## Global Constraints

- Never drop data during cold restore; UTF-8 truncation boundary strictly enforced.
- Concise 1-line comments explaining WHY, not HOW.
- No vague file or folder names.
- TDD: Write failing tests before implementation.
- Cross-platform path handling (`PathBuf` in Rust, forward slashes / path-agnostic in JS).

---

## Tasks

### Task 1: Rust Snapshot Storage Enhancement & Daemon Cold Rehydration

**Files:**
- Modify: `src-tauri/src/pty/snapshot.rs`
- Modify: `src-tauri/src/pty/ipc_protocol.rs`
- Modify: `src-tauri/src/pty/commands.rs`
- Test: `src-tauri/src/pty/snapshot.rs` (mod tests)

**Interfaces:**
- Consumes: Existing `SnapshotStorage` in `src-tauri/src/pty/snapshot.rs`.
- Produces: Structured `SessionSnapshot` model with `{ session_id, cwd, title, cols, rows, persona_id, scrollback, timestamp }`, updated `PtySpawnResultPayload` with `is_warm: bool` and `cold_scrollback: Option<String>`.

- [ ] **Step 1: Write failing Rust unit tests for structured SessionSnapshot**

```rust
#[test]
fn test_save_and_load_session_snapshot_structured() {
    let temp_dir = std::env::temp_dir().join(format!("oppa_snap_struct_{}", std::process::id()));
    let storage = SnapshotStorage::new(temp_dir.clone());

    let snapshot = SessionSnapshot {
        session_id: "term-cold-1".to_string(),
        cwd: "D:\\oppa\\oppa".to_string(),
        title: Some("oppa-main".to_string()),
        cols: 120,
        rows: 30,
        persona_id: Some("architect".to_string()),
        scrollback: "\x1b[32mSuccess\x1b[0m\r\nDone.".to_string(),
        timestamp: 1724050000000,
    };

    storage.save_snapshot(&snapshot).expect("save succeeds");
    let loaded = storage.load_snapshot("term-cold-1").expect("load succeeds").expect("found");

    assert_eq!(loaded.session_id, "term-cold-1");
    assert_eq!(loaded.cwd, "D:\\oppa\\oppa");
    assert_eq!(loaded.scrollback, "\x1b[32mSuccess\x1b[0m\r\nDone.");

    let _ = fs::remove_dir_all(&temp_dir);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p oppa --lib test_save_and_load_session_snapshot_structured`
Expected: FAIL with `SessionSnapshot` not found or method missing.

- [ ] **Step 3: Implement SessionSnapshot & cold restore helpers in snapshot.rs, ipc_protocol.rs, and commands.rs**

Implement `SessionSnapshot` struct and `save_snapshot` / `load_snapshot` with atomic file write and UTF-8 safe boundary truncation. Update `PtySpawnResultPayload` to return `is_warm` and `cold_scrollback`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p oppa --lib`
Expected: PASS (all 58+ tests passing).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pty/
git commit -m "feat(rust): enhance session snapshot storage and cold restore payload"
```

---

### Task 2: Transport & Store Cold Restore Integration

**Files:**
- Modify: `src/lib/pty/transport.ts`
- Modify: `src/lib/pty/transport.test.ts`
- Modify: `src/store/terminalStore.ts`
- Modify: `src/store/terminalStore.test.ts`

**Interfaces:**
- Consumes: `PtySpawnResultPayload` from Task 1 via Tauri IPC.
- Produces: `PtySpawnResult` with `is_warm?: boolean` and `cold_scrollback?: string`, `SessionInfo.isRestored?: boolean`, `SessionInfo.status: "loading" | "restoring" | "running"`, `dismissSessionRestoredBanner(sessionId: string)`.

- [ ] **Step 1: Write failing unit tests in terminalStore.test.ts for cold restore session lifecycle**

```typescript
it("marks session as restored and populates restoredScrollbacks when cold restore payload received", async () => {
  ptySpawnMock.mockResolvedValue({
    id: "term-cold-1",
    is_new: false,
    is_warm: false,
    cold_scrollback: "previous output\r\n",
    cwd: "/home/user/project",
    cols: 80,
    rows: 24,
    pid: 1234,
  } as any);

  await useTerminalStore.getState().spawnSession("/home/user/project", undefined, "term-cold-1");

  const session = useTerminalStore.getState().sessions["term-cold-1"];
  expect(session.isRestored).toBe(true);
  expect(useTerminalStore.getState().restoredScrollbacks["term-cold-1"]).toBe("previous output\r\n");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/store/terminalStore.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement transport types and terminalStore cold restore handling**

Update `PtySpawnResult` in `src/lib/pty/transport.ts`. Update `spawnSession` and `loadLayout` in `src/store/terminalStore.ts` to populate `isRestored: true`, handle `cold_scrollback`, and implement `dismissSessionRestoredBanner`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/pty/transport.test.ts src/store/terminalStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pty/transport.ts src/lib/pty/transport.test.ts src/store/terminalStore.ts src/store/terminalStore.test.ts
git commit -m "feat(store): integrate cold restore payload, isRestored flag, and banner dismissal"
```

---

### Task 3: UI Loading Skeleton & "Session Restored" Banner in TerminalPane

**Files:**
- Modify: `src/components/TerminalPane.tsx`
- Modify: `src/components/TerminalPane.css`
- Modify: `src/components/TerminalPaneHeader.tsx`
- Modify: `src/components/TerminalPaneHeader.css`
- Modify: `src/components/SessionLeaf.tsx`
- Test: `src/components/TerminalPane.test.tsx`
- Test: `src/components/TerminalPaneHeader.test.tsx`

**Interfaces:**
- Consumes: `SessionInfo.isRestored`, `SessionInfo.status`, `dismissSessionRestoredBanner` from Task 2.
- Produces: Loading skeleton UI during cold restoration, rendered `"● Session restored"` badge in `TerminalPaneHeader`, auto-dismissal on keypress/click.

- [ ] **Step 1: Write failing tests in TerminalPaneHeader.test.tsx and TerminalPane.test.tsx**

```typescript
it("renders 'Session restored' pill badge in pane header when session.isRestored is true", () => {
  useTerminalStore.setState({
    sessions: {
      "s-1": {
        id: "s-1",
        title: "oppa",
        status: "running",
        cwd: "/home/user",
        isRestored: true,
        cols: 80,
        rows: 24,
      },
    },
  });

  render(<TerminalPaneHeader id="s-1" />);
  expect(screen.getByText(/Session restored/i)).toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/TerminalPaneHeader.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement loading skeleton and restored badge UI with auto-dismissal**

In `TerminalPaneHeader.tsx`, render the `"● Session restored"` pill badge when `session.isRestored` is true. In `TerminalPane.tsx`, attach keydown / onData listener to call `dismissSessionRestoredBanner(id)` when user types. Add sleek dark styling in `TerminalPaneHeader.css` and `TerminalPane.css`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/TerminalPaneHeader.test.tsx src/components/TerminalPane.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run full test suite & build verification**

Run: `pnpm vitest run && cargo test -p oppa --lib && pnpm build`
Expected: 100% PASS on all tests, 0 build errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/
git commit -m "feat(ui): add session loading skeleton and Session Restored banner with auto-dismiss"
```

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-19-cold-session-restore.md`. Two execution options:

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
