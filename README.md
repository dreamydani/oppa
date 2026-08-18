# OPPA ⚡

**OPPA** is a fast, low-memory desktop terminal and developer workbench built with **Tauri 2 + Rust** (backend) and **React 19 + TypeScript + Vite** (frontend).

---

## Key Features

- **Detached Background Daemon & Session Persistence**: Terminal sessions run inside a detached Rust daemon. Shells, active long-running jobs, and process trees stay alive across GUI window closes and app restarts.
- **Warm Reattachment & Screen Mirroring**: Reopening OPPA instantly reattaches to running daemon sessions. An in-memory VT100 screen mirror restores full terminal formatting, text, and cursor state without resetting the shell.
- **Split Panes & Workspaces**: Flexible pane splitting, tabbed layouts, and workspace presets for multi-project workflows.
- **Built-in Browser Hub**: Embedded webview browser viewport for local development servers, documentation, and previewing web applications side-by-side with your terminal.
- **Code Editor Workbench**: Built-in editor pane with syntax highlighting, Markdown preview, and diff inspection.
- **Robust ACK-based Backpressure**: Flow-control system prevents memory bloat during massive terminal output streams while guaranteeing zero dropped bytes.

---

## Architecture & Detached Daemon

OPPA uses a unified binary architecture:

```
                  ┌─────────────────────────────────┐
                  │        OPPA GUI Process         │
                  │   (Tauri 2 + React 19 Frontend) │
                  └───────────────┬─────────────────┘
                                  │
                  IPC (Named Pipe / Unix Domain Socket)
                  Newline-delimited JSON-RPC
                                  │
                                  ▼
                  ┌─────────────────────────────────┐
                  │    OPPA Daemon Process (--daemon)│
                  │  ┌───────────────────────────┐  │
                  │  │       DaemonServer        │  │
                  │  ├───────────────────────────┤  │
                  │  │ Session Registry (PTYs)   │  │
                  │  │ ScreenMirror (vt100 state)│  │
                  │  │ Flow Control / ACKs       │  │
                  │  └───────────────────────────┘  │
                  └─────────────────────────────────┘
```

### Detached Daemon Mode (`--daemon`)
- Starting the binary with `--daemon` boots the headless Tokio runtime hosting `DaemonServer`.
- If no daemon is active when the GUI launches, OPPA automatically spawns a background daemon.
- Closing the GUI window issues a `Disconnect` RPC call; the daemon and all child shells continue running in the background.
- Closing an individual terminal pane sends a `Kill` command, terminating the process group and freeing session resources.

### IPC Protocol
Communication between GUI and daemon occurs over:
- **Windows**: Named pipes (`\\.\pipe\oppa-daemon`)
- **macOS / Linux**: Unix domain sockets (`/tmp/oppa-daemon.sock` or `$XDG_RUNTIME_DIR/oppa-daemon.sock`)

Messages are newline-delimited JSON objects supporting bi-directional requests (`DaemonRequest`), responses (`DaemonResponse`), and streaming events (`DaemonEvent::Data`, `DaemonEvent::Exit`, `DaemonEvent::Cwd`).

### Warm Reattachment & Screen Snapshots
When a session is created or reattached via `CreateOrAttach`:
1. If the session exists (`is_new: false`), the daemon captures the current screen contents using its in-memory `ScreenMirror` (`vt100::Parser`) and returns an ANSI snapshot string.
2. The frontend writes the snapshot directly to the xterm terminal instance, immediately restoring visual state.
3. Live streaming of output and input resumes seamlessly.

---

## Getting Started

### Prerequisites

- **Node.js**: v18+ (recommended: v20+)
- **pnpm**: `corepack enable pnpm` or `npm install -g pnpm`
- **Rust**: 1.77+ (`rustup`)

### Development

Install dependencies:
```bash
pnpm install
```

Run desktop application in development mode:
```bash
pnpm tauri dev
```

Run web-only UI development server:
```bash
pnpm dev
```

---

## Testing & Verification

Run all test suites:

```bash
# Rust unit tests
cargo test -p oppa --lib

# Rust daemon end-to-end integration tests
cargo test -p oppa --test daemon_integration_test

# Frontend test suite
pnpm vitest run

# Production type check & frontend build
pnpm build
```

---

## License

MIT
