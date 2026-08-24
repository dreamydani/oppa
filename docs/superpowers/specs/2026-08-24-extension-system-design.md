# Extension System Design (OPPA)

Date: 2026-08-24
Status: Approved direction; Milestone 1 detailed below
Related: 2026-08-16-terminal-core-design.md

## Why

OPPA should let users extend the app the way VS Code does — not by shipping a compiler
(VS Code ships none; extensions are plain JS/TS data + code executed by a bundled runtime),
but by providing:

1. a **manifest format** describing what an extension *contributes*,
2. a **sandboxed runtime** for extension logic (Phase 2),
3. a **capability/permission model** gating what extensions may do,
4. a **surface** where users discover, enable, and disable them.

Distribution needs no cloud: built-ins ship inside the app; later phases add
install-from-file and a git-repo-based index (a registry is just a JSON file in a repo).

## Full roadmap

| Phase | Scope |
|---|---|
| **M1 (this spec)** | Declarative only: manifest schema, discovery/loader, registry + enable/disable persistence, Tauri commands, Extensions panel UI, theme contributions wired end-to-end, one shipped built-in (`oppa.theme-pack`) |
| P2 | Scriptable extensions: QuickJS (`rquickjs`) host inside the daemon, capability-gated host API v0 (notifications, storage, event subscribe, `terminal.write(sessionId)`), consent dialog bound to content fingerprint |
| P3 | UI contributions: status-bar items, sandboxed-iframe panels with host-prepended CSP |
| P4 | Packaging `.oppax` (zip), install-from-file UX, git-repo index browser ("marketplace" without servers) |

Snippet/command contribution *surfaces* intentionally land together with the command-palette
rung; M1's manifest schema already parses them so manifests stay forward-compatible.

## Manifest format (v1)

File name: `oppa-extension.json` at the root of each extension directory.

```jsonc
{
  "id": "oppa.theme-pack",            // ^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$  ("publisher.name")
  "name": "Oppa Theme Pack",
  "version": "1.0.0",                 // semver string, validated loosely (X.Y.Z)
  "description": "Extra terminal themes.",
  "engines": { "oppa": ">=0.1.0" },   // informational in M1; range-checked once API stabilizes
  "capabilities": [],                  // CLOSED SET. Unknown kind => loud validation error.
                                       // M1 declarative extensions need none; ANY listed
                                       // capability fails validation until Phase 2 exists.
  "contributes": {
    "themes": [
      {
        "id": "midnight",              // unique within extension; global id = "<ext.id>:<theme.id>"
        "name": "Midnight",
        "type": "dark",                // "dark" | "light"
        "colors": {                    // xterm ITheme color keys, closed set (see below)
          "background": "#0a0e14",
          "foreground": "#d5d8df",
          "...": "..."
        },
        "previewColors": ["#0a0e14", "#d5d8df", "#58a6ff", "#4ade80"] // exactly 4, for the picker swatch
      }
    ]
    // "snippets": [...], "commands": [...] — schema-parsed in M1, consumed by later surfaces.
    // Hard limits: <= 64 themes/snippets/commands per extension.
  }
}
```

### Validation rules (all failures are loud, never silent)

- `id` matches the publisher.name grammar; duplicate installed id = later one rejected with reason.
- `version` matches `\d+\.\d+\.\d+`.
- Every `capabilities[]` entry must be in the known set (empty in M1 ⇒ any capability errors).
- Theme `colors`: keys restricted to the xterm ITheme color-key set; values must match
  `^#[0-9a-fA-F]{6}$` or `^#[0-9a-fA-F]{8}$`; required keys: `background`, `foreground`.
- `previewColors`: exactly 4 valid colors.
- Duplicate theme `id` within one extension: error.

## Discovery & layout

- **Built-ins** are embedded into the binary at compile time via `include_str!` from
  `src-tauri/resources/extensions/<ext-id>/oppa-extension.json`. No resource-dir/bundle config,
  identical behavior in dev and production builds, trivially unit-testable.
- **User extensions** live at `<app_data>/extensions/<ext-id>/oppa-extension.json`
  (one directory per extension). M1 has no installer UI — this layout is scanned so
  hand-dropped folders work immediately; hash-addressed immutable installs arrive in P4.
- Malformed manifests never abort startup: they are reported as entries with an `error`
  reason so the Extensions panel can show what failed and why.

## Registry & enabled-state persistence

- `ExtensionRegistry` (Tauri-managed `Mutex<…>`) holds loaded manifests + disabled set.
- Enabled-state persists at `<app_data>/extensions-state.json`: `{ "disabled_ids": [] }`,
  saved on every toggle. Built-ins can be disabled but never uninstalled.
- Disabling a theme extension instantly removes its themes from pickers; a terminal currently
  set to a removed theme falls back to `oppa_dark` on next resolve (graceful, documented).

## Tauri commands (Rust-first, mirroring settings.rs patterns)

Tauri-free cores take explicit paths (`*_at`) and are unit-tested; thin `#[tauri::command]`
wrappers resolve real paths.

| Command | Returns |
|---|---|
| `list_extensions()` | `ExtensionInfo[]`: id, name, version, description, is_builtin, enabled, error?, counts per contribution kind |
| `set_extension_enabled(id, enabled)` | Ok/Err; unknown id ⇒ Err |
| `get_contributions()` | All contributions from *enabled* extensions: `themes: ContributedTheme[]` (fully resolved ITheme maps), plus snippets/commands lists for future consumers |

## Renderer integration (state-vs-transport split preserved)

- `src/lib/extensions/extensionTransport.ts` — the ONLY file touching Tauri APIs for this
  domain (mirrors `src/lib/pty/transport.ts`). Exports typed wrappers + payload interfaces.
- `src/store/extensionStore.ts` — zustand store: `{ status, extensions, load(), setEnabled() }`.
  On successful load it pushes resolved themes into the terminal-theme registry.
- `src/lib/theme/terminalThemes.ts` gains a small module-level registry:
  `registerExtensionThemes(entries)` / `unregisterExtensionThemes(extId)`;
  `getAllTerminalThemes()` merges built-in metadata with contributed themes;
  `getTerminalTheme(id)` resolves contributed ids before falling back to defaults.
  `TerminalThemeId` widens to include `(string & {})` so extension ids type-check while
  keeping literal autocompletion for built-ins.
- `AppearanceSettingsPane` merges `getAllTerminalThemes()` with contributed themes from the
  store; contributed cards show an "Extension" badge (teaches the concept passively).

## UI entry point (decided)

- Third icon tab (**Puzzle**, lucide) in the right sidebar `ActivityBar` →
  `rightSidebarTab: "explorer" | "git" | "extensions"` renders `ExtensionsPanel.tsx`.
- Panel lists installed extensions: name/version/publisher, description, Built-in badge,
  enable/disable switch, expandable detail (declared contributions, validation error if any).
- `Ctrl/Cmd+Shift+X` opens the right sidebar and selects the Extensions tab
  (VS Code muscle memory).
- This panel is the future home of P4 install/index features — nothing thrown away.

## Shipped built-in (dogfood)

`oppa.theme-pack` v1.0.0 — 3 original dark terminal themes. Proves the entire pipeline:
manifest → discovery → registry → commands → store → theme registry → picker → xterm.

Snippets/command packs ship when their consuming surfaces exist (command-palette rung).

## Testing strategy

- **Rust (TDD)**: manifest validation table tests (grammar, closed capability set, color-key
  set, limits); discovery over temp dirs (missing/malformed manifest tolerated, reported);
  enable-state persistence round-trip; command-level handlers against managed state.
  `cargo test -p oppa --lib`.
- **Renderer (vitest)**: transport mocked per repo convention; extensionStore load/error/
  toggle flows; theme registration/merge/fallback in terminalThemes; ExtensionsPanel render +
  toggle wiring; ActivityBar third tab; AppearanceSettingsPane merge badge.
  `pnpm vitest run`.

## Explicit non-goals (M1)

No script execution, no network access from extensions, no iframe panels, no packaging/
installer UX, no Monaco theme contributions (P2+), no marketplace index.
