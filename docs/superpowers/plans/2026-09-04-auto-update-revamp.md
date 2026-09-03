# Auto-Update Revamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Orca-parity in-app updates (check → download → restart, sessions survive) with zero paid certificates.

**Architecture:** Tauri-native updater on minisign trust; dual-manifest transition; NSIS-primary; dual-field Ack for daemon compat; stateful UpdateCard; guarded scheduling; stable+rc channels.

**Tech Stack:** Tauri 2 + Rust (`tauri-plugin-updater`, `@tauri-apps/plugin-updater`, `@tauri-apps/plugin-process`), React 19 + zustand, `scripts/release.mjs`, GitHub Actions matrix.

**Spec:** docs/superpowers/specs/2026-09-04-auto-update-revamp-design.md

## Global Constraints

- Rust-first: PTY/daemon logic in src-tauri/src/pty/; updater backend in src-tauri/src/updater.rs.
- Renderer components never call Tauri invoke directly except through domain transport seams (`src/lib/pty/transport.ts` for PTY; updater calls go through `src/lib/updater.ts`).
- Concise comments ONLY — WHY, not HOW, 1 line if possible.
- TDD: failing test first, verify fail, implement, verify pass. Every task ends with a commit (`fix:`/`feat:` conventional).
- Rust: `cargo test -p oppa --lib` + `cargo test -p oppa --test daemon_integration_test` in src-tauri. Renderer: `pnpm vitest run`. Release: `pnpm vitest run scripts/release.test.mjs`.
- Cross-platform; no hardcoded shell paths; stable-only update checks (dev never checks).
- Private minisign key NEVER enters repo/chat/context. Public key only, provided by the human.

---

### Task 1: Update race fix

**Files:**
- Modify: `src/lib/updater.ts` (`checkForUpdate`)
- Modify: `src/lib/updater.test.ts`
- Modify: `src/components/UpdateBanner.tsx` (focus re-check)
- Modify: `src/components/UpdateBanner.test.tsx`
- Modify: `src-tauri/src/updater.rs` (tests only: 3-field manifest parse)

**Interfaces:**
- Consumes: `resolveChannel`, `getChannel` from `../lib/channel`.
- Produces: `checkForUpdate()` self-resolves channel when cache empty; banner re-checks once on focus if mount check was empty.

- [ ] **Step 1: Write failing tests**

```typescript
it("resolves an uncached channel and returns the payload on stable", async () => {
  invokeMock.mockResolvedValueOnce("stable");
  invokeMock.mockResolvedValueOnce({ version: "0.2.3", download: "https://example.com/i.msi", available: true });
  const result = await checkForUpdate();
  expect(invokeMock).toHaveBeenNthCalledWith(1, "app_channel");
  expect(invokeMock).toHaveBeenCalledWith("check_for_update");
  expect(result?.available).toBe(true);
});
```

Banner test: mount with `checkForUpdate` → null, fire `window` focus, now resolve payload ⇒ banner appears. Rust test: 3-field manifest JSON (`version`/`download`/`signature`) parses into `UpdateManifest`.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm vitest run src/lib/updater.test.ts src/components/UpdateBanner.test.tsx`
Run: `cargo test -p oppa --lib updater` in `src-tauri`
Expected: FAIL (null on unresolved channel; no focus listener; strict struct shape assumed).

- [ ] **Step 3: Minimal implementation**

```typescript
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  // Callers may run before applyChannelIdentity finishes; a null cache
  // must not permanently suppress the check.
  const channel = getChannel() ?? (await resolveChannel().catch(() => null));
  if (channel !== "stable") return null;
  try {
    return await invoke<UpdateInfo>("check_for_update");
  } catch {
    return null;
  }
}
```

Banner: one-shot `focus` listener only when the mount check returned empty; remove on info or unmount. Persist `lastCheckAt` in settings; skip re-checks within 6h. One debug log line with channel/available/version.

- [ ] **Step 4: Verify pass**

Run: `pnpm vitest run src/lib/updater.test.ts src/components/UpdateBanner.test.tsx`
Run: `cargo test -p oppa --lib` in `src-tauri`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/updater.ts src/lib/updater.test.ts src/components/UpdateBanner.tsx src/components/UpdateBanner.test.tsx src-tauri/src/updater.rs
git commit -m "fix(updater): self-resolving channel check with focus re-check"
```

### Task 2: Dual-emit Ack + daemon protocol bump

**Files:**
- Modify: `src-tauri/src/pty/ipc_protocol.rs` (Ack carries `bytes` + `chars`, bump `DAEMON_PROTOCOL_VERSION`)
- Modify: `src-tauri/src/pty/daemon_client.rs`, `manager.rs`, `commands.rs` (dual construction)
- Modify: `src/lib/pty/transport.ts` (send both fields)
- Test: `src-tauri/src/pty/ipc_protocol.rs` tests, `daemon_server.rs` cross-version test, `src/lib/pty/transport.test.ts`

**Interfaces:**
- Consumes: Task 1 nothing (independent).
- Produces: Ack parseable by old (`chars`) and new (`bytes`) daemons in both directions.

- [ ] **Step 1: Failing tests**
  - Rust: old-shape JSON `{"type":"Ack","payload":{"session_id":"s","chars":7}}` deserializes to `bytes==7`; new-shape `{..., "bytes":7}` also parses; both-fields JSON parses.
  - TS: `ptyAck("abc", 42)` invokes with `{ id: "abc", bytes: 42, chars: 42 }`.
- [ ] **Step 2: Run to verify fail** (`cargo test -p oppa --lib ipc_protocol`; `pnpm vitest run src/lib/pty/transport.test.ts`)
- [ ] **Step 3: Implement** — add `chars` field back with serde default+alias dance so all three shapes parse; construct both fields at every Ack send site; bump `DAEMON_PROTOCOL_VERSION` with a rotation comment.
- [ ] **Step 4: Full Rust suites pass** (lib + daemon_integration_test).
- [ ] **Step 5: Commit** `fix(daemon): dual-field Ack for cross-version update compat`

### Task 3: Updater trust wiring (no key needed)

**Files:**
- Modify: `src-tauri/tauri.conf.json` (`createUpdaterArtifacts: true`, macOS ad-hoc `signingIdentity: "-"`; pubkey left as-is with a `REPLACE-WITH-REAL-PUBKEY` marker comment — JSON has no comments, so document in surrounding release docs instead; do NOT invent a fake key)
- Modify: `src-tauri/Cargo.toml` (+ `tauri-plugin-process`), `src-tauri/src/lib.rs` (init process plugin)
- Modify: `package.json` (+ `@tauri-apps/plugin-process`)
- Modify: `src-tauri/capabilities/default.json` (updater + process permission sets)
- Test: `cargo check` in src-tauri; `pnpm build` (tsc+vite) green; no new unit tests (config-only; verified by build)

- [ ] **Step 1: Apply config/dep changes**
- [ ] **Step 2: Verify** `cargo check` + `pnpm build` pass
- [ ] **Step 3: Commit** `feat(updater): trust wiring for native updates (pubkey pending human keygen)`

### Task 4: release.mjs dual manifest + NSIS primary + flag discipline

**Files:**
- Modify: `scripts/release.mjs`, `scripts/release.test.mjs`
- Produces: `buildLatestJson(platforms)` generator; NSIS-first ranking; `--channel stable|rc`; prerelease-flag assertion.

- [ ] **Step 1: Failing tests**
  - `buildLatestJson` emits exact plugin schema (`version`, `pub_date`, `notes`, `platforms` per-OS `{url, signature}`) from fixture inputs.
  - NSIS setup.exe outranks MSI for same version.
  - `assertReleaseFlags("rc", false)` throws (rc must be prerelease); `assertReleaseFlags("stable", true)` throws.
- [ ] **Step 2: `pnpm vitest run scripts/release.test.mjs` FAIL**
- [ ] **Step 3: Implement** (keep legacy manifest byte-identical; add `signature` passthrough already present).
- [ ] **Step 4: PASS. Commit** `feat(release): dual manifest, NSIS-primary, channel flag discipline`

### Task 5: Native backend seam

**Files:**
- Modify: `src/lib/updater.ts` (native `check()`/`downloadAndInstall()` via `@tauri-apps/plugin-updater`, progress callbacks), `src/lib/updater.test.ts` (mock plugin module)
- Modify: `src-tauri/src/updater.rs` (retire custom fetch when native active? NO — keep custom as fallback for one release; gate native behind real-pubkey presence is automatic since plugin verifies against baked pubkey)
- Produces: `checkForNativeUpdate()`, `downloadNativeUpdate(onProgress)`, `installAndRelaunch()` guarded by `probeUpgradeSafety`.

- [ ] **Step 1-2: Failing tests** with mocked `@tauri-apps/plugin-updater` (available → payload; download emits progress events; busy probe blocks install).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: `pnpm vitest run src/lib/updater.test.ts` PASS. Commit** `feat(updater): native check-download-install seam`

### Task 6: UpdateCard + settings + status-bar

**Files:**
- Modify: `src/components/UpdateBanner.tsx` → stateful card (available/downloading %/downloaded-restart/error-retry), tests
- Modify: Settings update section (auto-check toggle + Check-now), status-bar segment
- Produces: Orca-like surfaces; dismissal per-version preserved.

TDD per state; commit `feat(ui): stateful update card with settings and status segment`.

### Task 7: Scheduling

**Files:** scheduler module (deferred first check, daily + backoff, focus/resume guards with `lastCheckAt`), tests with fake timers.
Commit `feat(updater): deferred, daily, and wake-triggered checks`.

### Task 8: Session-safe restart verification

**Files:** integration test (spawn sessions → simulate update restart handshake → assert warm reattach to live shells); docs note.
Commit `test(updater): session-safe restart verification`.

### Task 9: RC channel + CI matrix

**Files:**
- Modify: `src-tauri/src/channel.rs` (+ `Rc` variant, endpoint per channel), tests
- Create: `.github/workflows/release.yml` (win/mac/linux matrix + manifest merge)
- Commit `feat(channels): rc channel with isolated manifest feed` + `ci(release): multi-OS build matrix`.

## Human gates (cannot be agent-executed)

- H1 (before any signed release): generate minisign keypair locally, back up offline, provide PUBLIC key + set CI secrets.
- H2: real-Windows MSI/NSIS update test on a physical machine.
- H3: publish the first updater-capable release (browser hop), then verify native update to the next.
