# Writing an OPPA extension (Phase 2 preview)

Scriptable extensions run inside a sandboxed QuickJS engine: no filesystem, no
network, no processes — only the capability-gated `oppa` API.

## Layout

```
my-extension/
├── oppa-extension.json   # manifest: id, main, capabilities
└── main.js               # bundled entry script
```

## Steps

1. Copy `template/` and rename the id to `yourname.something`.
2. Author `main.ts` against [`sdk/oppa.d.ts`](../sdk/oppa.d.ts).
3. Bundle to one file: `npx esbuild main.ts --bundle --format=iife --outfile=main.js`
4. Drop the folder into `<appData>/oppa/extensions/<id>/`.
5. Restart oppa → Extensions panel (right rail, puzzle icon) → enable it.
   Scriptable extensions ask for consent before their code first runs; any code
   or permission change re-prompts.

## Capabilities

| Capability | Unlocks |
|---|---|
| `notifications` | `oppa.notify(title, body)` |
| `storage` | `oppa.storage.get/set` (per-extension KV) |
| `terminal:write` | `oppa.writeTerminal(sessionId, text)` |
| `events` | `oppa.on("session-exit" \| "title-changed" \| "focus-changed", fn)` |

## Hard limits

- 8 MiB heap, 512 KiB stack per extension
- ~250 ms CPU budget per event dispatch — runaway handlers are aborted and the
  extension is disabled with the error shown in the panel
- Notifications are rate-limited to 10/minute

See `docs/superpowers/specs/2026-08-24-scriptable-extensions-design.md` for the full design.
