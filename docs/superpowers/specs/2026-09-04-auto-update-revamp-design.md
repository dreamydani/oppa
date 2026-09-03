# Orca-Parity Auto-Update Design

## Problem

The installed stable app never shows the "Update now / Not now" card (reported on 0.2.2,
never seen on any version), and the v1 flow ends at opening a browser download —
nothing like Orca's in-app check → download → restart.

## Root causes (verified)

1. **Startup race.** `main.tsx` fires `applyChannelIdentity()` and renders immediately;
   `UpdateBanner` checks once on mount while the cached channel is still `null`, so
   `checkForUpdate()` resolves `null` and never re-checks (`channel.ts:10-12`,
   `updater.ts:40-43`, `UpdateBanner.tsx:45-60`).
2. **No newer release existed** until v0.2.3 (installed 0.2.2 === latest), compounding (1).
3. **Cross-version Ack break (introduced by us).** The `chars`→`bytes` rename has an
   old→new-only alias. A new GUI talking to a still-running old daemon gets every
   `pty_ack` rejected → backpressure freeze after restart. Must be fixed before any
   auto-restart ships.
4. **No CI, Windows-only local releases** (no `.github/workflows`), so macOS/Linux have
   no update artifacts. MSI-primary vs NSIS-updater duality unverified.

## Goals

- Stable installs show an UpdateCard whenever a newer release exists (Orca parity).
- One-click download → install → restart, manual at each step (never silent).
- Sessions survive updates via the detached daemon + warm reattach.
- Zero paid certificates: minisign trust (free, mandatory anyway). OS code signing
  stays a deferred, additive upgrade.
- Two-hop migration: one last manual browser install of an updater-capable build,
  native updates from there (0.2.2/0.2.3 binaries can never self-heal the race).

## Non-goals

Paid OS signing, silent auto-download, Linux deb/rpm updater path (AppImage only),
hourly/daily fleets, command palette / app menu (neither exists — Settings instead).

## Architecture

- **Trust (free).** Minisign keypair (`tauri signer generate`, human step, offline
  backup). Real pubkey in `tauri.conf.json`; `createUpdaterArtifacts: true`;
  macOS ad-hoc `signingIdentity: "-"` (mandatory on Apple Silicon or updated apps
  report "damaged"); updater + process capability entries.
- **Dual manifest transition.** Every release emits legacy `oppa-update-manifest.json`
  (keeps old binaries on the working browser flow — no flag day) and plugin-format
  `latest.json` with per-platform `{url, signature}` plus `.sig` assets.
- **NSIS-primary.** `setup.exe` is the ranked installer and manifest `download`;
  MSI remains an alternate asset. One installer tech on the update path.
- **Daemon compat.** Ack carries both `bytes` and `chars` (serde ignores unknowns both
  ways); `DAEMON_PROTOCOL_VERSION` bumped with rotation note. Old↔new pairs keep
  working in both directions.
- **Backend.** Plugin `check()` behind the channel gate; download with progress;
  `downloadAndInstall()` + `relaunch()` gated by the daemon-busy probe
  (idle → go; busy → "N sessions running, update anyway?"; unknown → proceed,
  never claim safe). Legacy custom flow kept as fallback for one release.
- **Surfaces.** `UpdateBanner` → stateful `UpdateCard` (available / downloading % /
  downloaded-restart / error-retry); status-bar segment; Settings update section
  (auto-check toggle + Check-now). Dismissal stays per-version.
- **Scheduling.** First check deferred past window-ready; daily timer with backoff;
  focus/resume re-checks with persisted `lastCheckAt` + 6h floor (rate-limit safety).
  Stable only; dev never checks.
- **Channels.** `rc` variant on `OPPA_CHANNEL` (dev stays update-free). RC GitHub
  releases MUST be `prerelease: true` (else stable `latest` picks them up); rc
  endpoint resolves via releases-API prerelease filter, never `latest/download`.

## Error handling

Fail-silent to the user (offline, 404, bad JSON → no card), but every outcome is
debug-logged (channel, available, version) so "no card" is diagnosable. Error card
with retry only after an explicit user action fails (download/install error).

## Testing

TDD everywhere: failing test first per task. Rust `cargo test -p oppa --lib` +
`--test daemon_integration_test`; renderer `pnpm vitest run`; release
`pnpm vitest run scripts/release.test.mjs`. Live gates: two-hop migration test,
old-binary browser-flow test, real-Windows MSI/NSIS update test (single install
location, correct version, sessions alive), rc-flag assertion test.

## Key custody (binding)

The private minisign key + password never enter the repo, chat, or agent context.
Loss bricks updates for existing installs; leak lets anyone ship as us. Rotation
procedure: ship a build signed by the old key embedding the new pubkey.
