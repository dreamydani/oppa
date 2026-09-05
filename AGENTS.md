# Oppa — Contributor Agent Guide

Oppa is a fast, low-memory desktop terminal built with **Tauri 2 + Rust** (backend) and **React 19 + TypeScript + Vite** (frontend).

## Architecture

- Rust owns PTY, session, and flow-control logic in `src-tauri/src/pty/`.
- `oppa --daemon` runs the headless Tokio daemon; the GUI connects over named pipes or Unix domain sockets and auto-spawns the daemon when absent. Sessions survive GUI restarts.
- Renderer components never call Tauri APIs directly. `src/lib/pty/transport.ts` is the sole Tauri boundary; UI reads the zustand store in `src/store/terminalStore.ts`.
- Backpressure is ACK-based (pause above 256 KB, resume below 32 KB). Never drop output.
- Shell detection follows `$SHELL` then fallback shells on macOS/Linux and `$COMSPEC` then fallbacks on Windows. Spawned shells set `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=oppa`.
- Layout persists to `appDataDir/layout.json` and warmly reattaches when the daemon is alive.

## Style

- One-line WHY-comments only. No narration of the obvious.
- Concrete module names after the domain concept. Never `helpers`, `utils`, `common`, or `misc`.
- Concrete types over loose strings. `const` over `let` unless reassigned.
- Match the surrounding file's conventions.

## Testing

- Practice TDD: failing test first, then implementation.
- Rust unit: `cargo test -p oppa --lib` in `src-tauri`.
- Rust daemon integration: `cargo test -p oppa --test daemon_integration_test` in `src-tauri`.
- Renderer: `pnpm vitest run` (`transport.ts` is mocked in component tests).
- End each task with a conventional commit (`feat:`, `fix:`, `docs:`).

## Cross-Platform

- Target macOS, Linux, and Windows behind runtime checks.
- Kill the PTY process group on close; never leak shells.
- Use `PathBuf` / `tauri::Manager::path()` in Rust and path joins in JS. Never assume separators.
- `metaKey` on Mac, `ctrlKey` elsewhere.

## Workflows

- Desktop dev: `pnpm tauri dev`. Web-only UI: `pnpm dev`.
- Build: `pnpm build` plus `cargo check` in `src-tauri`.
- See `README.md`, `docs/ARCHITECTURE.md`, `docs/STYLEGUIDE.md`, and `CONTRIBUTING.md`.
