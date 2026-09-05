# Oppa Architecture

This document describes the system design behind Oppa's persistent terminal sessions. It is the curated public companion to the contributor guide in `AGENTS.md`.

## Overview

Oppa ships as a single binary with two roles: a Tauri 2 GUI process (React 19 frontend) and a headless Tokio daemon that owns all PTY state. The daemon outlives the GUI, so shells, jobs, and process trees survive window closes and app restarts.

## Detached daemon

- `oppa --daemon` starts the headless daemon hosting `DaemonServer`.
- When the GUI launches with no daemon present, it spawns one in the background automatically.
- Closing the window issues `Disconnect`; the daemon and all child shells keep running.
- Closing a pane issues `Kill`, which terminates the PTY process group and frees session resources. Process groups are always terminated on close; shells are never leaked.

## IPC transport

- Windows: named pipe. macOS and Linux: Unix domain socket (`/tmp` or the XDG runtime directory).
- Messages are newline-delimited JSON: `DaemonRequest`, `DaemonResponse`, and streaming `DaemonEvent` (`Data`, `Exit`, `Cwd`).
- Renderer code never touches Tauri IPC directly. `src/lib/pty/transport.ts` is the sole transport module; components use the zustand store in `src/store/terminalStore.ts`.

## Session registry and screen mirroring

- `DaemonServer` holds sessions in a map of session ID to session handle. Each session wraps a `portable-pty` pair with a read loop emitting data events and an exit event on child termination.
- Each session maintains a `ScreenMirror` backed by a `vt100::Parser`.
- `CreateOrAttach` behaves as follows: a new ID spawns a shell; an existing ID returns `is_new: false` with an ANSI snapshot captured from the mirror. The frontend paints the snapshot into its xterm instance, then live streaming resumes. No shell restart is required.

## Flow control

Backpressure is ACK-based. The renderer acknowledges processed bytes; the daemon pauses its read loop above the high watermark (256 KB of unacknowledged output) and resumes below the low watermark (32 KB). Pausing stops reads, which lets the OS pipe fill and the child block naturally. Output is never dropped.

## Shell detection

- macOS and Linux: `$SHELL`, then `/bin/zsh`, `/bin/bash`, `/bin/sh`.
- Windows: `$COMSPEC`, then `powershell.exe`, then `cmd.exe`.
- Spawned shells inherit the app environment with `TERM=xterm-256color`, `COLORTERM=truecolor`, and `TERM_PROGRAM=oppa` set.

## Persistence

- Layout and workspace state are saved on window close to `appDataDir/layout.json`.
- On relaunch, sessions warmly reattach to live daemon shells when available and fall back to cold restore when the daemon is unavailable.

## Build channels

One codebase produces two channels selected at compile time via `OPPA_CHANNEL` (unset means `stable`):

- Stable uses the production data directory and daemon endpoint and checks for updates on startup.
- Developer builds use an isolated data directory and daemon endpoint, a distinct window title, and never check for updates.
