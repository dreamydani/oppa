# Developer OPPA Channels — Implementation Plan

Binding spec: `docs/superpowers/specs/2026-08-30-developer-oppa-channels-design.md` (also GitHub issue #1).

## Global Constraints

- One codebase, one repo (`dreamydani/oppa`). Never fork; never a second repo.
- Channel is a build-time tag (`dev` | `stable`) that drives: data dir name (`com.pc.oppa` vs `com.pc.oppa-dev`), daemon socket path suffix, window title, and updater presence (stable only; dev never checks).
- Developer OPPA is a one-to-one copy of the app UI — no separate buttons, no dev-only UI. Only visible difference is the window title.
- Sessions are sacred: updates never kill running terminal sessions by default. The daemon lives separately from the GUI install, and upgrades lazily (zero sessions or reboot).
- Protocol versioning is additive/backward-compatible: old daemons serve new GUIs (`MIN_SUPPORTED_DAEMON_PROTOCOL_VERSION == DAEMON_PROTOCOL_VERSION == 6` today).
- The release pipeline is a seed, not CI: `pnpm release` (manual version, build, GitHub Releases + manifest).
- Manifest + installers live on GitHub Releases (`dreamydani/oppa`).

## Task 1 — Channel flag + isolated data dir + daemon pipe (Rust foundation)

Add a build-time channel concept to the Rust side.

- Define a `channel` module (e.g. `src-tauri/src/channel.rs`) exposing:
  - `enum Channel { Dev, Stable }`
  - `Channel::current()` — resolved from a build-time flag (compile-time env `OPPA_CHANNEL`; default `Stable` when unset).
  - `Channel::data_dir_suffix()` / app-data-dir resolver (`com.pc.oppa` stable, `com.pc.oppa-dev` dev).
  - `Channel::socket_path()` — daemon socket path suffixed by channel.
- Make `resolve_app_data_dir` (snapshot.rs) and `get_daemon_socket_path` (ipc_protocol.rs) channel-aware.
- Make the daemon spawner use the channel's socket path; `run_daemon` and `PtyManager::get_client` resolve channel-aware paths.
- Tests: distinct data dirs + socket paths per channel; `Channel::current()` defaults to stable.

## Task 2 — Channel-aware window title + GUI data-dir isolation + identity

- **GUI data-dir isolation** (routed from Task 1's review): all GUI-persisted state (settings, layout, scrollback, workspace presets, extension state) routes through a channel-aware `resolve_gui_data_dir(app)` helper so dev never shares state with stable.
- Expose the channel to the frontend (Tauri command `app_channel` returning "dev"/"stable").
- Window title: "Developer OPPA" for dev, "oppa" for stable (via a frontend `src/lib/channel.ts` seam setting `document.title` on boot).
- Tests: Rust helper both channels + app_channel payload; frontend title tests.

## Task 3 — `pnpm release` script + version bump + update manifest (release pipeline seed)

- `scripts/release.mjs` (no new npm deps): pure version logic (readVersions, bumpVersion, semver validation) separated from CLI/IO.
- Flow: prompt for version (manual) → bump three version files (`package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`) → `pnpm tauri build` → find installer → write manifest `{version, download}` → `gh release create` (args array, no shell) → summary.
- Safety: gh pre-flight before touching files; restore-on-build-failure (three files + Cargo.lock when present) so no partial state.
- Wire `"release"` script in package.json. Tests: pure logic (12+), restore path.

## Task 4 — `tauri-plugin-updater` + update manifest check (stable only)

- Add `tauri-plugin-updater` (Rust + JS); register **stable-only** (dev never checks — confirmed user requirement).
- `tauri.conf.json` updater endpoint → GitHub Releases manifest URL (`releases/latest/download/oppa-update-manifest.json`).
- Rust `check_for_update` command: dev → None; stable → fetch manifest (reqwest with timeouts), compare versions (`is_newer_available`, malformed → not newer), return `{version, download, available}`; offline degrades silently.
- Frontend `src/lib/updater.ts` seam `checkForUpdate()` gating on channel.
- Tests: Rust pure logic (9+), frontend seam (4).

## Task 5 — "Update now / Not now" banner UI (stable startup)

- `src/components/UpdateBanner.tsx`: on mount calls `checkForUpdate()`; if `available`, shows "Update now / Not now" (mirrors GlobalFailureBanner styling).
- "Not now" persists `general.dismissedUpdateVersion` (per-version, backward-compatible settings on both Rust serde + TS); "Update now" (v1) opens the download URL via the opener plugin.
- Mount in `src/App.tsx`. Tests: 8 component tests + 1 Rust serde test.

## Task 6 — Decouple daemon from GUI install + lazy daemon upgrade + protocol compat

Scope: deliver the code-testable core; document the installer-side (versioned folders + daemon-in-data-dir) follow-up.

- Protocol becomes minimum-supported: `MIN_SUPPORTED_DAEMON_PROTOCOL_VERSION = 6`; client/daemon/CLI accept `>= MIN_SUPPORTED` (new GUI → old daemon); `restart_stale_daemon` fires only below-minimum.
- Lazy upgrade: `DaemonRequest::UpgradeIfIdle` + `DaemonResponse::Busy(u32)`; `daemon_can_upgrade()` client helper (zero live sessions → idle).
- Daemon-path resolver `daemon_executable_path()`: prefers `<app_data_dir>/daemon/oppa-daemon(.exe)` when present, else `current_exe`.
- Tests: attach-old-daemon, below-minimum reject (symmetric), upgrade idle/busy, resolver prefer/fallback.

## Task 7 — Session-running warning on update + layout restore + wire daemon_can_upgrade

- Rust `can_upgrade_daemon` command (stable only): pure payload mapping idle/busy/unknown; **Err/unknown never safe** (Task 6 carried note); dev not-applicable.
- Frontend `probeUpgradeSafety()` seam; banner rewires "Update now": idle → proceed; busy → "N sessions are still running. Updating will close them." with Update anyway / Not now; unknown → proceed without claiming safe.
- Layout-restore boot wiring pinned by an App test (loadLayout called once on boot).
- Tests: 6 Rust mapping tests + updater/banner component tests.

## Final Review

- Full test suite (`cargo test -p oppa --lib`, `cargo test -p oppa --test daemon_integration_test`, `pnpm vitest run`, `npx tsc --noEmit`).
- Whole-branch code review on the most capable model; triage deferred minors; land the installer-side follow-up (versioned install folders, daemon-in-data-dir, CLI `open` spawn path) as the immediate next branch.
