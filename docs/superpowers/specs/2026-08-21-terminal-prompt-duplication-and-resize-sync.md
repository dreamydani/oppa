# OPPA — Terminal Prompt Duplication, ConPTY Resize Synchronization & Screen Mirroring Design

**Date:** 2026-08-21  
**Status:** Draft for review  
**Target:** Terminal Core, PTY Daemon, IPC Transport, Screen Mirroring, Session Lifecycle, xterm.js Rendering  

---

## 1. Problem Statement & Motivation

When refreshing the application, reopening tabs, restoring saved workspaces, splitting panes, or running CLI tools, terminal panes occasionally exhibit **duplicated command prompts** (e.g. `PS C:\Users\danial>` appearing on Row 1 and again at Row 10–12 with the active cursor).

A multi-subsystem investigation across the Rust daemon, ConPTY integration, and React terminal lifecycle isolated the 5 compounding root causes:

1. **Unmeasured Initial Spawn Dimensions (`80x24` Default):**
   When sessions spawn or restore, `ptySpawn` is called without explicit `cols` / `rows`, defaulting to `80x24`. In a grid split (e.g. 6 panes), the DOM container is significantly smaller (e.g. `50x14`). When `TerminalPane` mounts, `ResizeObserver` detects the real size and triggers `ptyResize(50, 14)` 100ms later. On Windows, `ResizePseudoConsole` triggers `PSReadLine` to reflow the buffer and redraw the prompt at the bottom of the new smaller viewport, while the original prompt rendered at `80x24` remains visible at Row 1.
2. **`ScreenMirror` Virtual Screen Newline Flooding:**
   `ScreenMirror::get_formatted_snapshot()` unconditionally iterates over all 24 virtual rows with `\r\n`. Rendering 24 lines into a 14-line container pushes Row 1 into xterm's scrollback history and leaves blank lines in the viewport.
3. **In-Buffer `[Session Restored]` Text Injection:**
   `TerminalPane.tsx` calls `term.writeln("\r\n── [Session Restored] ──\r\n")` directly into the xterm stream on restore, shifting xterm's cursor 2 lines downwards while the daemon's PTY cursor remains on the prompt line.
4. **Cold Restore Scrollback vs. New Shell Startup Output Race:**
   During cold restore after daemon shutdown, serialized scrollback (ending with a prompt) is written to xterm, followed immediately by the newly spawned shell process's startup prompt.
5. **Missing Pre-Snapshot Resize in Daemon Reattach:**
   `CreateOrAttach` generates `session.get_snapshot()` before applying the reattaching client's requested `cols` and `rows`.

---

## 2. Architectural Design

### 2.1 Pre-Measured DOM Dimensions on Spawn & Restore

```
[ SessionLeaf / TerminalPane Container ]
       │
       ▼ (Propose / Measure DOM dimensions before spawn)
[ DOM Width & Height ] ──► [ cols, rows computed via Font Metrics ]
       │
       ▼
[ spawnSession(cwd, shell, id, { cols, rows }) ]
       │
       ▼
[ ptySpawn(opts with exact cols & rows) ]
       │
       ▼
[ ConPTY / PseudoConsole created at EXACT target dimensions ]
```

1. **Pre-measuring Dimensions:**
   Before invoking `spawnSession` in `SessionLeaf.tsx` or layout restoration in `terminalStore.ts`, calculate target `cols` and `rows` using font metrics and container element bounding rectangles or stored layout weights, avoiding the default `80x24` mismatch.
2. **Pass Dimensions in `PtySpawnOptions`:**
   Ensure `cols` and `rows` are passed through `ptySpawn` to `commands.rs` -> `DaemonRequest::CreateOrAttach`.

### 2.2 Pre-Snapshot Resize Synchronization in Daemon

```
[ DaemonRequest::CreateOrAttach { session_id, cols, rows, ... } ]
       │
       ▼
[ Session Exists in Registry? ]
       │
       ├──► YES: 1. session.resize(cols, rows)  <── RESIZE FIRST
       │         2. snapshot = session.get_snapshot()
       │         3. Return CreateOrAttachResult with updated snapshot & dimensions
       │
       └──► NO:  1. DaemonSession::spawn(..., cols, rows)
                 2. Return CreateOrAttachResult (is_new: true)
```

1. **Resize Before Snapshot:**
   When reattaching to an existing session in `daemon_server.rs`, if `cols > 0 && rows > 0`, call `session.resize(cols, rows)` before `session.get_snapshot()`. This ensures the virtual `ScreenMirror` is reflowed to the client's current geometry before ANSI snapshot generation.

### 2.3 Clean `ScreenMirror` Snapshot Formatting (No Phantom Newlines)

1. **Trim Trailing Empty Rows:**
   In `ScreenMirror::get_formatted_snapshot()`, scan from the bottom of the screen to find the last non-empty row. Only join lines up to the last active row (or emit rows within the screen viewport without extra trailing `\r\n` characters).
2. **Absolute Cursor Positioning:**
   Keep cursor hiding (`\x1b[?25l`), screen clear & home (`\x1b[2J\x1b[H`), non-scrolling row paint, and explicit cursor restoration (`\x1b[{row};{col}H\x1b[?25h`).

### 2.4 Pure UI Session Restore Indicator (Zero Terminal Buffer Pollution)

1. **Remove In-Buffer Divider:**
   Remove `term.writeln("\r\n── [Session Restored] ──\r\n")` from `TerminalPane.tsx`.
2. **Header Badge UI:**
   Display the restoration indicator exclusively in the DOM via `TerminalPaneHeader.tsx` (`● Restored` indicator with dismiss button or auto-fade), keeping xterm's character grid 100% byte-aligned with the daemon PTY.

### 2.5 Clean Terminal Reset on Warm Reattach

1. **Reset Viewport Before Snapshot:**
   Call `term.reset()` before writing `restoredScrollback` to ensure cursor and scroll offsets start cleanly at origin `(1, 1)` without stale buffer remnants.

---

## 3. Detailed Data Flow & Component Responsibilities

### 3.1 `src-tauri/src/pty/`
- **`screen_mirror.rs`**:
  - Update `get_formatted_snapshot` to render the exact rows without extraneous trailing `\r\n` lines.
- **`daemon_server.rs`**:
  - In `handle_request(DaemonRequest::CreateOrAttach)`: resize existing session to requested `(cols, rows)` before capturing snapshot.

### 3.2 `src/store/terminalStore.ts` & `src/lib/pty/transport.ts`
- **`terminalStore.ts`**:
  - Update `spawnSession` to accept `{ cols?: number; rows?: number }`.
  - Pass pane geometry during `loadLayout` and `spawnSession`.
- **`TerminalPane.tsx`**:
  - Remove `term.writeln` restored banner.
  - Call `term.reset()` when applying warm snapshot.
  - Measure DOM dimensions immediately on mount before triggering initial resize.

---

## 4. Verification & Testing Strategy

1. **Rust Unit & Integration Tests:**
   - Test `screen_mirror` snapshot formatting with various row counts and trailing empty lines.
   - Test `daemon_server` `CreateOrAttach` reattach flow with dynamic resize before snapshot.
2. **Frontend Vitest Tests:**
   - Test `TerminalPane` mounting with snapshot restore, verifying no in-buffer banner is written.
   - Test `spawnSession` with explicit `{ cols, rows }`.
3. **End-to-End Visual Verification:**
   - Reopen multi-pane grid (e.g. 6-pane 3x2 grid), verify prompt appears exactly once at Row 1 with cursor immediately following prompt.
   - Refresh app / restart daemon, verify zero duplicate prompts.
