# Developer OPPA and Stable OPPA: Build Channels, Isolated Instances, and Seamless Updates

## Problem Statement

The user (the sole OPPA user today) wants a second, separate "Developer OPPA" build of the app — a copy of the current app, no extra UI — that they can run side by side with the stable "working" OPPA they use daily. They develop and test new features in Developer OPPA without disturbing their daily stable session, and only when a feature is ready do they "push" it to the stable app. They explicitly want the stable app to keep running terminal sessions uninterrupted when it updates (no session loss), and they want the update to be a deliberate, visible event ("Update now / Not now") at stable startup — not a surprise mid-work change.

Today none of this exists: there is no CI, no release pipeline, no auto-update, no changelog, no documented install path. The app is a single binary with no channel concept; the daemon is spawned from `current_exe`, shares a per-user socket, and on protocol mismatch the GUI **kills and respawns the daemon** — losing all sessions. Two builds of the same binary would share the same data dir (`com.pc.oppa`) and the same daemon pipe, colliding on layout, settings, worktrees, and session snapshots.

## Solution

Treat Developer OPPA and Stable OPPA as **two build channels of one codebase** (the VS Code Stable/Insiders and Chrome Canary/Stable model): same repo, built at different points, with a channel tag baked in at build time. The channel decides:

- **Isolation** — each channel uses its own data dir and its own daemon pipe, so they never share layout/settings/sessions and never collide.
- **Identity** — Developer OPPA's window title reads "Developer OPPA" (the only visible difference); it never checks for updates.
- **The push flow** — the user develops in Developer OPPA, then triggers a release (from a Developer OPPA session) via a `pnpm release` script: bump version → build installer → upload to GitHub Releases → publish an update manifest. Stable OPPA checks that manifest at startup, shows "Update now / Not now", and updates in place.

The update is **seamless**: the GUI updates instantly, but the daemon — the process that owns the terminal sessions — is decoupled from the GUI install, lives in its own directory, and upgrades itself lazily only when safe (zero sessions or at reboot). Running terminal sessions are never interrupted by an update.

## User Stories

1. As a solo OPPA user, I want a Developer OPPA build that is a one-to-one copy of the current app (no extra buttons or separate UI), so that I can use it to develop and test features without any differences from what I'll ship.
2. As a solo OPPA user, I want Developer OPPA to use a separate data directory and daemon pipe from my stable OPPA, so that my daily stable sessions, settings, layout, and worktrees are never disturbed while I work in the dev build.
3. As a solo OPPA user, I want Developer OPPA's window title to say "Developer OPPA", so that I can tell the two windows apart at a glance.
4. As a solo OPPA user, I want Developer OPPA to never check for or prompt about updates, so that I'm never interrupted while developing and testing.
5. As a solo OPPA user, I want the stable OPPA to remain the app I use daily, with no changes to its behavior or UI, so that I'm not distracted by updates until I choose to take them.
6. As a solo OPPA user, I want to write and test new features in Developer OPPA with hot reload while my stable OPPA keeps running, so that I can iterate on features without touching my working app.
7. As a solo OPPA user, I want to commit and push my feature work to the repo's `main` branch (origin, `github.com/dreamydani/oppa`), so that the "push moment" is a normal git push.
8. As a solo OPPA user, I want to trigger a release from a Developer OPPA session, so that the deliberate "feature is ready" action lives where the work happens.
9. As a solo OPPA user, I want the release trigger to bump the version manually (I type the new version), so that I control exactly what version ships.
10. As a solo OPPA user, I want the release to build the installer and publish it to GitHub Releases along with an update manifest, so that the new stable version is available and discoverable.
11. As a solo OPPA user, I want stable OPPA to check the update manifest at startup, so that it learns about a new version without me having to do anything.
12. As a solo OPPA user, I want stable OPPA to show an "Update now / Not now" banner when a newer version exists, so that the update is my choice, at my timing.
13. As a solo OPPA user, I want "Not now" to dismiss the banner until the next startup, so that I can defer the update to a clean moment.
14. As a solo OPPA user, I want "Update now" to download and install the new version and restart the app, so that I get the new feature.
15. As a solo OPPA user, I want the update to never interrupt my running terminal sessions, so that a long build or dev server keeps running across the update.
16. As a solo OPPA user, I want the daemon to live separately from the GUI install, so that the GUI update never touches the process holding my sessions.
17. As a solo OPPA user, I want the daemon to upgrade itself only when safe (zero sessions or at reboot), so that it never sacrifices a running session to upgrade.
18. As a solo OPPA user, I want the update to happen through versioned install folders, so that Windows never blocks the update by locking a running executable.
19. As a solo OPPA user, I want the app to warn me if I choose to update while sessions are running, so that an interruption is always my informed choice.
20. As a solo OPPA user, I want the dev channel to be able to kill/restart its own daemon freely during development, so that hot-reload testing is unhindered, without ever affecting the stable daemon's sessions.
21. As a solo OPPA user, I want the release pipeline to be the seed of a future CI pipeline, so that later a git push can trigger the same release automatically.
22. As a solo OPPA user, I want the stable app to still restore my layout (panes and positions) after an update, so that my working arrangement comes back even if sessions cold-restore.

## Implementation Decisions

### Channel model (one codebase, two builds)

- Add a **channel** concept (`dev` | `stable`) determined at build time (Rust env/compile flag, e.g. `OPPA_CHANNEL`). The same binary stays the dev/stable gate; no second repo, no fork, no second codebase.
- Channel drives: data dir name (e.g. `com.pc.oppa-dev` vs `com.pc.oppa`), daemon socket path suffix, window title ("Developer OPPA" vs "oppa"), and whether the updater is compiled/active (stable only).
- Developer OPPA is a one-to-one copy of the app UI — no separate buttons, no dev-only UI. The only visible difference is the window title (and any theme accent derived from the channel, kept minimal).

### Instance isolation

- **Data dir**: make the app-data-dir resolver channel-aware (in the same place as `resolve_app_data_dir` in `snapshot.rs`), so dev and stable write to distinct directories. Layout, settings, worktrees, snapshots, and the discovery file all live per-channel.
- **Daemon pipe**: make the socket-path resolver channel-aware (`get_daemon_socket_path` in `ipc_protocol.rs`), so each channel gets its own pipe/daemon. The daemon is spawned per-channel.
- **Spawner**: `ensure_daemon_running` / `ensure_daemon_running_at` must use the channel's pipe and data dir; the dev channel can kill/restart its own daemon freely without touching stable's.

### Seamless update (daemon survives updates)

- **Decouple the daemon from the GUI install.** The daemon binary lives in its own directory (in the app data dir, per Q17a), not inside the versioned GUI install folder. GUI updates never write there.
- **Versioned install folders.** The GUI installs side-by-side into versioned folders (e.g. `app-0.1.0/`, `app-0.2.0/`); a shortcut/current pointer follows the newest. On Windows this avoids overwriting a running executable.
- **Lazy daemon upgrade.** The daemon swaps itself to a newer version only when safe: when it has zero running sessions, or at next machine reboot — whichever comes first. The small rule: *sessions running → stay put (new GUI talks to old daemon); no sessions (or rebooting) → upgrade in the background.*
- **Backward-compatible protocol.** Change the protocol-version policy so old daemons can serve new GUIs (additive, negotiated messages). Replace the current kill-and-respawn `restart_stale_daemon` path (`manager.rs` / `daemon_spawner.rs`) with an attach-to-existing-daemon policy; only force a daemon swap when the old daemon genuinely cannot serve the new GUI, and then only with an explicit warning when sessions are running.
- **Update UX**: stable checks the manifest at startup → shows "Update now / Not now" banner. "Update now" → downloads new version into a versioned folder, restarts the GUI (which connects to the old daemon, sessions warm-reattach), and the daemon upgrades lazily. "Not now" dismisses until next startup.
- **Session-running warning**: if the user chooses "Update now" while sessions are running, show "N sessions are still running. Updating will close them. Update anyway / Not now." — only a truly breaking protocol swap (rare) would force a daemon restart, and only through this warning.
- **Layout restore**: on GUI restart/update, the existing layout persistence (`paneLayoutSlice` + snapshot storage) restores panes/positions; sessions restore via the existing warm/cold paths.

### Release pipeline

- Add a `pnpm release` script (run from a Developer OPPA session) that: prompts for the new version (manual, per Q13) → bumps version in `package.json`, `Cargo.toml`, `tauri.conf.json` → builds the installer (`pnpm tauri build`) → uploads to GitHub Releases → publishes an update manifest (JSON: version + download URL).
- Manifest + installers live on GitHub Releases (`dreamydani/oppa`), per Q14. This is the standard Tauri updater feed.
- This script is the seed of a future CI pipeline (later: push to `main` → GitHub Actions runs the same release steps).

### Updater

- Add `tauri-plugin-updater` and wire the manifest endpoint into the stable build only (channel-gated). The dev build never initializes the updater.
- The "Update now / Not now" banner is a small startup UI in the stable build; settings respect "Not now" dismissal until next launch.

## Testing Decisions

- **What makes a good test**: test external behavior, not internals — e.g. "a new GUI attaches to an old daemon and sessions survive" and "an update leaves running sessions untouched," not the internal plumbing of the version-negotiation.
- **Modules to test**:
  - `daemon_spawner` / `manager` / `daemon_client`: protocol-version attach-vs-respawn policy; attach to old daemon succeeds; sessions survive a new-GUI connect; dev vs stable use distinct pipes.
  - `snapshot.rs` / `runtime_metadata.rs`: channel-aware data dir resolves to distinct per-channel dirs; discovery file written/read per channel.
  - `ipc_protocol`: additive protocol version negotiation; old-client/old-daemon compat round-trips (existing serde round-trip tests already cover defaulted additive fields).
  - `oppa-cli` / `command_tree`: `--profile`/channel flag surface; `pnpm release` script end-to-end (version bump, build, manifest).
  - Frontend (vitest + `@testing-library/react`, `transport.ts` mocked): the "Update now / Not now" banner renders and its dismiss/update actions behave; the updater is initialized only for stable.
- **Prior art**: existing daemon integration tests (`daemon_integration_test`), `daemon_client` serde round-trip tests, `daemon_spawner` probe/shutdown tests, manager `setup_test_server_and_manager`, and the existing vitest component tests with mocked transport.

## Out of Scope

- **CI pipeline** (GitHub Actions release automation) — the release script is the seed; CI comes later per the user's explicit deferral.
- **Auto-update for the dev channel** — the dev build never checks for updates (confirmed decision).
- **True PTY handoff between daemons** (passing file descriptors / ConPTY handles from old to new daemon) — the decoupled-daemon + lazy-upgrade design already gives zero session interruption; migration is a stretch option explicitly not in v1.
- **Multi-user / public distribution** — the user is the sole user for now.
- **Any dev-only UI** — Developer OPPA is a one-to-one copy of the app.
- **Changelog/auto-generated release notes** — manual version bump only for now.

## Further Notes

- The reference repo Orca (at `D:\orca\orca`) was used for architecture ideas (channel naming, backpressure, session registry) — never copied code.
- The "small rule" for daemon upgrade is literally: *upgrade when sessions are empty, or at next boot — whichever comes first.*
- The dev build is source-driven: you "update" it by pulling/editing code, never by downloading. This is why it never checks for updates.
- The stable app's "Update now" timing advantage (banner at startup, before work begins) means session-running warnings are the exception, not the norm.
