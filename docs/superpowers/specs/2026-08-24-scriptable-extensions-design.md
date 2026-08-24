# Scriptable Extensions Design (OPPA — Phase 2)

Date: 2026-08-24
Status: Approved direction
Related: 2026-08-24-extension-system-design.md (M1, shipped)

## Goal

Let extensions contain code. A scriptable extension is a manifest plus one JavaScript
entry file executed inside a **sandboxed QuickJS engine** (`rquickjs 0.12`) embedded in
the GUI process. Code can only act through a tiny capability-gated host API; there is no
filesystem access, no network, and no process spawning from extension code.

## Decisions (user-approved)

- **Host location: GUI process**, not the daemon. Matches where the M1 registry lives;
  notifications route natively to the webview; engines die with the window, which is
  correct v0 behavior. Daemon placement revisited only if automations must survive
  restarts.
- **First dogfood: completion notifier** — notifies when long-running sessions exit.
- **JS surface: flat `oppa.*` API in v0** (implementation detail documented here; the
  namespaced names below map onto it).

## Manifest additions (v2)

```jsonc
{
  "id": "acme.notifier",
  "main": "main.js",                    // NEW: presence => scriptable extension
  "capabilities": ["notifications", "events"],  // now non-empty allowed; closed set
  "contributes": { }                     // optional for scriptable extensions
}
```

Capability closed set (v2): `notifications`, `storage`, `terminal:write`, `events`.
Unknown entries still fail validation loudly. `main` must be a bare file name
(no separators, no `..`).

## Sandbox model

Per scriptable extension:

- One dedicated OS thread owning one QuickJS `Runtime` + `Ctx` (rquickjs runtimes are
  single-threaded by design).
- `set_memory_limit(8 MiB)`, `set_max_stack_size(512 KiB)`.
- **Interrupt handler** checks two shared flags:
  - kill flag (teardown) → engine unwinds immediately,
  - per-call deadline (watchdog) → any single host-dispatched JS call exceeding its CPU
    budget (~250 ms) is aborted.
- The engine thread runs a message loop over an mpsc channel:
  - `Event(kind, payload)` → dispatch to registered handlers,
  - `Shutdown` → clean teardown.
- Entry contract: `main.js` is evaluated as a **script** with a global `oppa` object
  injected. Top-level statements run at activation; handlers register via
  `oppa.on(kind, fn)`.

## Host API v0

| Capability | API | Notes |
|---|---|---|
| `notifications` | `oppa.notify(title, body)` | Emitted to webview; renderer shows a toast. Rate-limited (max ~10/min/extension). |
| `storage` | `oppa.storage.get(key)`, `oppa.storage.set(key, value)` | Per-extension JSON KV under `<appData>/extension-storage/<id>.json`. Values are JSON-serializable only. |
| `terminal:write` | `oppa.writeTerminal(sessionId, text)` | Explicit session id required — never "the active terminal" (focus-race rule). Rides the existing write path. |
| `events` | `oppa.on(kind, fn)` | Closed set: `session-exit`, `title-changed`, `focus-changed`. Raw PTY output is deliberately excluded (backpressure hazard). |

Every host call passes one chokepoint: capability check → argument validation → execute →
error capture. An uncaught exception or budget abort marks the engine crashed.

## Consent & fingerprints

- `fingerprint = sha256(canonical(manifest JSON) + raw main.js bytes)`.
- Consents persist in `extensions-state.json` v2:
  `{ disabled_ids, consents: { id: fingerprint }, errors: { id: message } }`.
- Enabling a scriptable extension whose stored consent ≠ current fingerprint requires
  explicit user consent via dialog listing the capabilities. Any content change re-prompts.
- Consent grant is atomic with enable (`grant_extension_consent(id, fingerprint)`).

## Lifecycle & supervision

- Boot: engines start for enabled + consented + `main`-bearing extensions.
- Toggle off / disable: `Shutdown` sent, thread joins best-effort, state cleaned.
- Crash (uncaught error / budget abort / OOM): engine reports back over a report channel;
  supervisor records the error into `errors`, disables the extension, persists, and emits
  an event so the panel can show "Crashed: <reason>". Auto-restart is manual only in v0.
- Built-in scriptable extensions embed both manifest and `main.js` via `include_str!`.

## Renderer changes

- `list_extensions` items gain: `is_scriptable`, `capabilities[]`,
  `consent_required`, `crash_error`.
- Extensions panel: "Code" badge on scriptable entries; enabling one opens a consent
  modal (capability list, plain-language descriptions); crash banner with reason.
- Minimal toast stack fed by `extensions:notify` events.

## Authoring kit

- `docs/extensions/sdk/oppa.d.ts` — TypeScript definitions for the `oppa` global.
- `docs/extensions/template/` — minimal starter (manifest + main.ts compiled with esbuild
  to main.js). Authors use standard tooling; OPPA ships no compiler.
- Dogfood built-in: `oppa.completion-notifier` — tracks live sessions via
  `title-changed`, stores first-seen timestamps in storage, fires `notify` on
  `session-exit` for sessions older than 30s. Exercises events + storage +
  notifications end-to-end.

## Testing strategy

- Rust: manifest v2 rules (main path grammar, capability set), fingerprint stability and
  change detection, consent persistence round-trip, engine tests against real rquickjs
  (hello-world eval, handler registration, event dispatch, memory-limit abort,
  infinite-loop budget abort via interrupt handler, shutdown semantics), capability-gate
  table tests (denied namespace throws ReferenceError-like error string).
- Renderer: consent modal flow (deny reverts switch, grant enables), crash banner render,
  toast stack behavior. Transport mocked per repo convention.

## Non-goals (Phase 2)

Raw PTY output subscriptions, network/fs/process capabilities, daemon-side engines,
UI panels (P3), marketplace/packaging (P4), async promises across host calls
(sync-only callbacks in v0).
