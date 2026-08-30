# Memory

## Project Overview

**OPPA** is a fast, low-memory desktop terminal app built with **Tauri 2 + Rust** (backend) and **React 19 + TypeScript + Vite** (frontend). It is an original reimplementation inspired by the architecture of the Electron app **Orca** (`D:\orca\orca`) — we borrow design ideas (channel naming, backpressure model, session registry), never code. See `docs/superpowers/specs/2026-08-16-terminal-core-design.md` for the design and `docs/superpowers/plans/2026-08-16-terminal-core.md` for the implementation plan.

**Current milestone:** terminal core — split panes, Rust-managed PTY sessions, ACK-based backpressure, layout + session-state persistence. Later rungs (deferred): worktrees & agents, SSH remote environments, embedded browser, mobile pairing.

## Architecture

- **Rust-first**: all PTY/session/backpressure logic lives in `src-tauri/src/pty/` (`daemon_server.rs`, `daemon_client.rs`, `daemon_session.rs`, `screen_mirror.rs`, `commands.rs`). No Node runtime in the product.
- **Detached Daemon**: unified binary architecture where `oppa --daemon` starts a headless background Tokio daemon (`run_daemon()`). The GUI process connects as `DaemonClient` (or auto-spawns the daemon on demand). Terminal sessions survive GUI restarts and window closes.
- **IPC Protocol**: communication between GUI and daemon occurs over named pipes (Windows: `\\.\pipe\oppa-daemon`) or Unix domain sockets (`/tmp/oppa-daemon.sock` / XDG runtime dir) via newline-delimited JSON messages (`DaemonRequest`, `DaemonResponse`, `DaemonEvent`).
- **Warm Reattachment & Screen Mirroring**: daemon maintains an in-memory `ScreenMirror` (`vt100::Parser`) for each session. When the GUI reconnects, `create_or_attach` returns `is_new: false` along with an ANSI screen snapshot for instant UI hydration without restarting the shell.
- **State vs transport split**: the renderer's components never call Tauri `invoke` directly. `src/lib/pty/transport.ts` is the *only* file that touches Tauri APIs; components read the zustand store (`src/store/terminalStore.ts`) and call transport helpers.
- **Session registry**: `DaemonServer` owns sessions in a `Mutex<HashMap<String, Arc<DaemonSession>>>`. Each session wraps a `portable-pty::PtyPair` with a read loop pushing `pty:data` events; `pty:exit` on child exit.
- **Backpressure (the core lesson, from Orca)**: ACK-based. Renderer ACKs processed chars; Rust pauses the read loop above the high watermark (256KB) and resumes below the low (32KB). Pause = stop reading → OS pipe fills → child blocks. **Never drop output in v1.**
- **Shell detection**: macOS/Linux `$SHELL` → `/bin/zsh` → `/bin/bash` → `/bin/sh`; Windows `$COMSPEC` → `powershell.exe` → `cmd.exe`. Spawned-shell env: `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=oppa`, inherit app env.
- **Persistence**: layout + workspace state saved on window close to `appDataDir/layout.json`; restored sessions warmly reattach to existing shells in the daemon or fall back to cold restore if the daemon was stopped.

## Code Style

- **Concise comments ONLY** — explain WHY, not HOW. 1 line if possible. Never be verbose or walk through the obvious.
- **Descriptive variable names**; extract complex conditions into meaningful boolean variables.
- **Never use vague names** (`helpers`, `utils`, `common`, `misc`) for files, folders, or modules — name files after the concrete domain concept they contain. If a file is becoming a dumping ground, split it.
- Prefer concrete types over loose strings; prefer `const` over `let` unless reassigned.
- Follow existing patterns in the codebase; match the surrounding file's style.

## Testing

- **TDD**: write the failing test first, verify it fails, implement, verify it passes.
- **Rust unit tests**: `cargo test -p oppa --lib` in `src-tauri`.
- **Rust daemon integration tests**: `cargo test -p oppa --test daemon_integration_test` in `src-tauri`.
- **Renderer**: `pnpm vitest run` with `@testing-library/react` + `happy-dom`. `transport.ts` is mocked in component tests.
- Every task ends with a commit. Commit messages follow conventional style (`feat:`, `fix:`, `docs:`).

## Cross-Platform

OPPA targets **macOS, Linux, and Windows**. Keep platform-dependent behavior behind runtime checks:

- **Shell paths**: never hardcode `/bin/zsh` or `powershell.exe` — use the detection chain above.
- **PTY backends**: `portable-pty` uses ConPTY on Windows, forkpty/posix_spawn on macOS/Linux. Test shell startup + resize early on each platform.
- **Process-tree kill**: kill the PTY's process group on close — never leak shells.
- **Paths**: use Rust `PathBuf` / `tauri::Manager::path()` (`app_data_dir()`) and JS `path`-style joins — never assume `/` or `\`.
- **Keyboard shortcuts**: never hardcode `metaKey`; platform-check to pick `metaKey` on Mac and `ctrlKey` on Linux/Windows.

## Common Workflows

- **Dev (desktop)**: `pnpm tauri dev`
- **Dev (web only)**: `pnpm dev`
- **Build**: `pnpm build` (tsc + vite) + `cargo check` in `src-tauri`
- **Rust tests**: `cargo test -p oppa --lib` and `cargo test -p oppa --test daemon_integration_test` (run in `src-tauri`)
- **Renderer tests**: `pnpm vitest run`
- **Reference**: Orca source at `D:\orca\orca` — read for architecture ideas, never copy code.

## Superpowers Workflow

This project uses the superpowers skillset:

- **Specs** live in `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` (approved by the user before implementation).
- **Plans** live in `docs/superpowers/plans/YYYY-MM-DD-<feature>.md` and are executed with **subagent-driven development** — a fresh implementer subagent per task, a task review after each (spec compliance + code quality), a broad final review, and a **ledger** at `.superpowers/sdd/<plan-basename>/progress.md` tracking every task's commits, fix rounds, and rulings.
- Implementers never dispatch subagents. Reviews come from the controller.
- `.superpowers/` is git-ignored scratch; the git history is the record.
- The four things that stop execution: irreversible/destructive ops, security-sensitive actions, side effects outside the worktree, a plan so broken every path forward is a guess. Everything else is ruled on and ledgered.

## Agent skills

### Issue tracker

GitHub issues (managed via `gh` CLI). See `docs/agents/issue-tracker.md`.

### Triage labels

Default 5-role vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context (`CONTEXT.md` and `docs/adr/` at root). See `docs/agents/domain.md`.

