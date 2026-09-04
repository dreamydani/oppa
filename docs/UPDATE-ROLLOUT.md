# Update rollout

Companion to the design spec
(`docs/superpowers/specs/2026-09-04-auto-update-revamp-design.md`) — this file
is the human runbook, not a second spec. Mechanism details live there.

## Two-hop migration

0.2.2/0.2.3 binaries can never self-heal: the startup race (banner checks
before the channel resolves) plus the old `oppa-update-manifest.json`
endpoint mean no installed app will offer itself the updater-capable build.
One manual browser install of the first updater-capable release is required;
native updates work from there.

## H1 — keygen ceremony

1. On an offline/trusted machine: `pnpm tauri signer generate -w <secret-path>`.
2. Paste the public key into `src-tauri/tauri.conf.json` (`plugins.updater.pubkey`).
3. Add repo secrets: `TAURI_SIGNING_PRIVATE_KEY` (contents of the secret file),
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` only if the key has one.
4. Back up the secret file offline. Key custody rules (loss bricks updates,
   leak lets anyone ship as us, rotation ships old-signed + new pubkey) are in
   the spec — follow them exactly.

## H2 — first-dispatch acceptance checklist

Run the `release` workflow on `rc` first and confirm each item before stable:

- [ ] `.sig` discovery on all 3 OSes (windows `.exe`, macOS `.dmg`/`.app.tar.gz`, linux `.AppImage`).
- [ ] Feed merge output (`release-assets/latest*.json`) lists every platform triple, each with non-empty `url` + `signature`.
- [ ] rc-tag refresh uploaded `latest-rc.json` to the moving `rc` release.
- [ ] Endpoint fetch from a clean machine: stable `.../releases/latest/download/latest.json`
      and rc `.../releases/download/rc/latest-rc.json` both return the feed.

## H3 — publish + verify ladder

1. Dispatch `release` on `rc`, work the H2 checklist.
2. Install the rc artifact on each OS: version correct, single install location, sessions alive after relaunch.
3. Dispatch `release` on `stable`; confirm `latest.json` serves the new version.
4. On a machine running the previous stable, wait for (or trigger) the daily
   check and walk the card: available → downloading % → Restart now → sessions reattach warm.
