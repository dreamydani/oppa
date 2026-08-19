# Context Studio Hardening & Capability Expansion

**Date:** 2026-08-20
**Status:** Draft (awaiting user review)
**Milestone:** Context & AI Agent Superpowers
**Predecessor review:** in-chat review of `src-tauri/src/context/`, `src-tauri/src/mcp/`, and `src/components/context/` dated 2026-08-20.

---

## 1. Overview & Objective

The Context & Persona Studio MVP is functionally complete, but the in-depth
review surfaced 20 correctness, robustness, capability, and ergonomics flaws
across the contextual backend (Rust SQLite + FTS5 memory engine), the MCP
server that exposes it to external agents, the Zustand store, and the React
studio UI.

This spec converts every finding the user accepted (Tiers 1-4) into a
single, ship-able design so the Context Studio can be trusted as the
ambient memory of OPPA without observed silent data loss, enums drifting
between layers, or persona fields being silently overwritten by free-form
text.

The work is structured in four tiers that exist for prioritization, not as
gates: any tier can be merged independently once its tests pass.

---

## 2. Correctness Tier 1 — Ship in this PR

### 2.1 SQLite WAL + busy timeout (`manager.rs:48-55`)

`open_conn` opens a plain `Connection::open` with no concurrency pragma.
The detached daemon, the GUI process, and the MCP server may all open the
same `.sqlite` simultaneously. Without WAL, a write from the MCP server
while the GUI is reading `context_list` returns `SQLITE_BUSY` to the
renderer, which `contextStore.savePage` silently swallows.

Change:

```rust
fn open_conn(path: &Path) -> rusqlite::Result<Connection> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    initialize_schema(&conn)?;
    Ok(conn)
}
```

Covers review item 3.3.

### 2.2 Strict enum validation at the boundary (`manager.rs`, `models.rs`)

`ContextPage.category` and `ContextPage.scope` are `String` today
(`models.rs:7, 19`). The DB CHECK constraint catches bad values but the
error is a generic SQLite string. The MCP layer's `eq_ignore_ascii_case`
band-aid (`server.rs:191-195`) hides the root cause.

Change:

- Add `ContextScope` and `ContextCategory` enums with `as_str` and
  `try_from_str` helpers in `models.rs`.
- Add `ContextPage::validate(&self)` returning `Result<(), String>` that
  checks enum membership, non-empty `id`/`title`, and that `path` is
  well-formed (`[a-z0-9][a-z0-9/_\-]*`).
- Call `validate` at the top of `ContextManager::upsert_page` and
  `ContextManager::delete_page`; bubble the descriptive error.

Migration impact: none. Existing rows already conform because the DB CHECK
constraint rejected bad values at insert time.

Covers review items 3.1, 3.11, 3.12.

### 2.3 `is_built_in` column on `context_pages` (`schema.rs:7-20`)

`AgentPersona::from_context_page` decides built-in status by hardcoded ID
list (`models.rs:45-48`). Drift risk: any rename or fifth built-in
introduces a silent mismatch.

Change:

```sql
ALTER TABLE context_pages ADD COLUMN is_built_in INTEGER NOT NULL DEFAULT 0;
UPDATE context_pages SET is_built_in = 1 WHERE id IN
    ('debugger','optimizer','researcher','test_architect');
```

Reuse the check-pattern `IN (0,1)` already used for `pinned`.

Seed in `seed_builtin_personas` (`schema.rs:54-109`) sets `is_built_in = 1`
on the four built-ins. `from_context_page` reads the column. Drop the
hardcoded ID list.

Covers review item 3.5.

### 2.4 Persona `attached_scopes` in a typed column, L2 inspector hidden for personas

`details_l2` is overloaded: a `String` blob for notes, a JSON-encoded
`Vec<String>` for personas (`models.rs:50-53`). Free-form editing of a
persona's L2 silently wipes the scope list.

Change:

- Add `attached_scopes_json TEXT NOT NULL DEFAULT '[]'` to
  `context_pages` (nullable migration that backfills with `'[]'`).
- `AgentPersona::from_context_page` reads `attached_scopes_json`.
- `ContextInspector` hides the L2 textarea when
  `selectedPage.category === "persona"` and shows a chip editor for
  `attached_scopes` instead.
- `details_l2` is preserved for notes only; `details_l2` on a persona row
  is reserved for future use (raw system-prompt examples, etc.) and no
  longer encodes `attached_scopes`.
- `attached_scopes_json` is deprecated in v1; v2 will remove the column
  and the warning label is documented in the spec.

Migration is a single `ALTER TABLE` with default `'[]'`. Existing personas
that have JSON in `details_l2` are migrated by a one-shot Rust step in
`schema.rs::migrate_legacy_personas` that copies `details_l2` →
`attached_scopes_json` and clears `details_l2` for `category='persona'`
rows.

Covers review item 3.6.

### 2.5 Store error handling and rollback (`contextStore.ts:97-127`)

`savePage`, `deletePage`, `savePersona` mutate local state after a
successful `await invoke(...)` but have no try/catch. A failed upsert
leaves the store out-of-sync with disk and the user gets no feedback.

Change:

- Wrap each mutation in `try/catch`; on error log to console, refetch from
  disk via `loadContext`, and surface a UI error (toast or banner driven
  by a new `lastError: string | null` field).
- Add `lastError` and `clearError()` to the store.

Covers review item 3.4.

---

## 3. Robustness Tier 2 — Same PR

### 3.1 Fix MCP category enum (`protocol.rs:225, 262`)

`McpTool` `oppa_search_context` and `oppa_save_context_note` advertise
`["architecture", "quirk", "runbook", "persona", "preferences",
"standards"]`. The DB CHECK constraint accepts
`["architecture", "quirk", "runbook", "preference", "persona"]`. The MCP
enum is wrong (plural forms, invented `standards`).

Change to exactly the DB CHECK: `["architecture", "quirk", "runbook",
"preference", "persona"]`.

Covers review item 3.18.

### 3.2 Server-side `created_at` management (`manager.rs:92-105`)

`upsert_page` writes `page.created_at` directly from the renderer; any
caller can backdate notes.

Change:

- `upsert_page` ignores client-supplied `created_at` and uses the
  existing row's value when present, otherwise `now()`.
- `updated_at` is always `now()`.
- Document in the model that `created_at` and `updated_at` are
  server-managed.

Covers review item 3.10.

### 3.3 Wire `--workspace` end-to-end in `run_mcp_stdio`

`McpServer::new(workspace_dir)` accepts a workspace path and the MCP
config modal advertises `--workspace <path>`, but the entry point in
`Cargo.toml`/`main.rs` must be wired so the flag actually reaches the
server. Verified by a new test that spawns the binary with `--mcp
--workspace <tmpdir>` and asserts that the server's `list_pages` returns
the in-memory fixture.

Change:

- Confirm `main.rs` parses `--workspace` and passes it to
  `run_mcp_stdio(Some(PathBuf::from(...)))`.
- Add an integration test in `mcp/server.rs` that constructs `McpServer`
  with a temp workspace, invokes `handle_request` for
  `oppa_save_context_note` with `scope: "workspace"`, then verifies the
  row lands in the workspace DB (not the global one).

Covers review item 3.7.

### 3.4 Replace `path.ends_with` fallback (`server.rs:217-263`)

`tool_get_context_note` linear-scans `list_pages` and may match a
partial suffix.

Change:

- Add a `ContextManager::get_page_by_path(scope, path)` that does
  `WHERE scope = ? AND path = ?` (exact match per scope).
- Worker flow: try by id, then by exact path, then return an error.
- Drop the `ends_with` heuristic.

Covers review item 3.8.

### 3.5 Search total count and MCP `total` field

`search_fts` truncates at 25 (`manager.rs:189`) and the MCP caller
truncates at `limit` (`server.rs:196`). Agents can't tell if they got
the full result set.

Change:

- `ContextSearchResult` rows gain a `total: i64` field (constant for the
  whole result set, set once).
- `oppa_search_context` MCP output includes the total at the top of the
  formatted text: `"Found X of N total context notes matching '...'"`.

Covers review item 3.9.

---

## 4. Capability Tier 3 — Same PR

### 4.1 Real scope resolver in `oppa_get_active_persona` (`server.rs:144-178`)

`attached_scopes` is stored but never resolved. The MCP response shape
promises agent context but the agent gets only the scope names.

Change:

- When a persona has non-empty `attached_scopes`, query each scope with
  exact-path match: `WHERE category = ? OR path LIKE ?%` per scope.
- Resolve the union of matching pages, fetch their L0 (and L1 if the
  request asks for `with_l1: bool`).
- Include the resolved context in the persona response as a Markdown
  section `## Resolved Notes (L0)` with id + title + L0 + path.

Mapping table (uses existing DB categories):

| Scope token      | Resolves to                                         |
|------------------|-----------------------------------------------------|
| `global`         | rows where `scope='global'` (any category)          |
| `workspace`      | rows where `scope='workspace'` (any category)       |
| `architecture`   | rows where `category='architecture'` AND `scope` equals the active MCP workspace |
| `quirks`         | rows where `category='quirk'` AND scope matches active workspace |
| `runbooks`       | rows where `category='runbook'` AND scope matches active workspace |
| `preferences`    | rows where `category='preference'` AND scope matches active workspace |
| `personas`       | rows where `category='persona'` AND scope matches active workspace |

"Active workspace" is the `workspace_dir` passed to `McpServer::new`, or
empty (`scope='global'`) when no workspace is bound. Empty
`attached_scopes` means "inherits everything in the active scope" — the
current behavior. The empty-default route queries all pages in the
active scope and summarizes their L0.

Covers review item 3.13.

### 4.2 Tier-aware fetch (`commands.rs:17-23`)

Today `context_get` returns the full row including L2. The spec's
"progressive disclosure" promise is honored by the UI but not by the
transport.

Change:

- Add `tier: Option<&str>` parameter to `context_get` in Rust; allowed
  values `None` (all), `Some("l0")`, `Some("l1")`, `Some("l2")`.
- When a tier is requested, blank out the other two fields in the
  response.
- TypeScript `getContextPage` accepts optional `tier` and passes it as
  `tier` argument to the Tauri command.
- Renderer uses `tier="l0"` for the tree preview, `tier="l1"` for the
  inspector mid-tab, `tier="l2"` only when the user opens the L2 tab.

Covers the spec-promise gap noted in section 1.1 of the review.

### 4.3 Pagination on `list_pages` (`manager.rs:127-154`)

`list_pages` returns the full Vec every call. For a workspace with
hundreds of notes or a growing global DB this scales linearly.

Change:

- Add `limit: Option<usize>` and `offset: Option<usize>` parameters.
- Return a `ContextPageList { items: Vec<ContextPage>, total: i64 }`
  wrapper instead of bare `Vec`.
- Apply same to `search_fts` (returns `total` from §3.5).

Covers review item 3.17.

### 4.4 Unified search input (`ContextStudio.tsx:79-85` + `ContextStatusPanel.tsx:108-118`)

The header search and the sandbox search both write to the same
`searchResults` slice. Typing in one while the other is focused
clobbers results.

Change:

- Promote the sandbox to use its own slice: `searchResultsSandbox: Vec<...>`.
- Header still mutates `searchResults` (the canonical binding for the
  tree).

Covers review item 3.15.

### 4.5 Safe snippet rendering (`ContextStatusPanel.tsx:134-137`)

`res.snippet` is injected via `dangerouslySetInnerHTML`. Today the only
HTML emitted is `<b>...</b>` from SQLite's `snippet()`. Future
risk if anyone else writes HTML into the index.

Change:

- Render snippets as plain text with explicit `<mark>` wrappers around
  matched terms. New helper `renderSnippet(text: string): ReactNode[]`
  that splits on `<b>`/`</b>` and emits `<mark>` for the matched spans.
- Removes `dangerouslySetInnerHTML` entirely.

Covers review item 3.16.

### 4.6 Pane-level persona inheritance (`terminalStore.ts:430-477`)

`spawnSession` defaults `personaId` to `null` if not passed. Pane
splits lose persona context.

Change:

- When `existingId` is provided (warm reattach), `spawnSession` reads
  `existingSession.personaId` and passes it through.
- When a new pane is split from an existing session, the terminal
  component passes the existing `personaId` to `spawnSession`.

Covers review item 3.14.

### 4.7 Observability via `tracing`

`ContextManager` has no logging. Add `#[tracing::instrument]` to all
public methods and emit `info!` for search calls with the query and
result count.

Covers review item 3.20.

---

## 5. Ergonomics Tier 4 — Same PR

### 5.1 Soft-delete with `deleted_at` (`schema.rs:7-20`)

Add `deleted_at INTEGER` column. All read queries filter
`WHERE deleted_at IS NULL`. Add a `restore` and `purge` action to the
inspector; the latter is destructive and requires a confirmation modal.

Covers review item 4.18.

### 5.2 Export / import workspace context (`commands.rs`)

Add `context_export(workspace_path) -> String` returning a JSON snapshot
of all non-deleted pages, and `context_import(workspace_path, json)`
that upserts. Renderer exposes both via a "..." menu in the inspector
header.

Covers review item 4.19.

### 5.3 Persona delete gating (`ContextInspector.tsx:390-397`)

The trash button is shown for all pages including built-in personas
(`is_built_in = 1`). Hide / disable the delete button for built-in
personas with a tooltip explaining they are immutable.

Covers review item 4.20.

---

## 6. Path Uniqueness Decision

Per the brainstorming session, non-persona context pages enforce
`UNIQUE (scope, category, path)`. Personas derive path from id, so this
constraint applies to notes only.

Schema change:

```sql
ALTER TABLE context_pages ADD COLUMN scope_category_path TEXT
  GENERATED ALWAYS AS (scope || '/' || category || '/' || path) STORED;
CREATE UNIQUE INDEX uniq_context_page_path
  ON context_pages (scope, category, path) WHERE deleted_at IS NULL;
```

Application behavior:

- `upsert_page` returns a `PathExistsError` on conflict; the renderer
  offers "rename" or "merge" dialogs.
- `PersonaModal` and `ContextStudio` draft-note creation generate
  `path` from a slugified title + short timestamp to avoid collisions.

The personas derive path explicitly so they never collide with note
paths.

---

## 7. Persona Multiplicity Decision

Personas are **shared by id across terminals, agents, and panes**. Two
panes running the `debugger` persona both reference the same row
(id=`debugger`, path=`personas/debugger`). This is correct because
persona data is a system prompt + behavioral rules, not per-agent state.

Documented in the inspector's header tooltip and in the spec section 3
of `2026-08-18-context-persona-studio-design.md`. No code change.

---

## 8. Migration Plan

The schema evolves additively over multiple releases:

1. **v1 (this PR)** — adds columns (`is_built_in`, `attached_scopes_json`,
   `deleted_at`), adds index, adds generated `scope_category_path`. All
   new columns are nullable or have defaults. Existing rows read fine.
2. **v2 (next release)** — flips persona `details_l2` to be unused; the
   inspector no longer offers an L2 editor for personas; legacy
   `details_l2` JSON on persona rows is purged.
3. **v3 (cleanup)** — drop `details_l2` for personas entirely if
   `attached_scopes_json` is sufficient.

Migration is implemented in `schema.rs::migrate()`:

```rust
fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let version: i64 = conn.query_row(
        "PRAGMA user_version",
        [],
        |row| row.get(0),
    )?;
    if version < 1 {
        conn.execute_batch("
            ALTER TABLE context_pages ADD COLUMN is_built_in INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE context_pages ADD COLUMN attached_scopes_json TEXT NOT NULL DEFAULT '[]';
            ALTER TABLE context_pages ADD COLUMN deleted_at INTEGER;
            CREATE UNIQUE INDEX IF NOT EXISTS uniq_context_page_path
              ON context_pages (scope, category, path) WHERE deleted_at IS NULL;
            UPDATE context_pages
              SET is_built_in = 1
              WHERE id IN ('debugger','optimizer','researcher','test_architect');
            PRAGMA user_version = 1;
        ")?;
    }
    Ok(())
}
```

Confirmed idempotent by `test_schema_migration_is_repeatable`.

---

## 9. Testing Strategy

### 9.1 Rust unit tests

- `schema::tests::test_wal_mode_enabled_after_open`
- `schema::tests::test_schema_migration_is_repeatable`
- `schema::tests::test_unique_scope_category_path_blocks_duplicates`
- `manager::tests::test_upsert_page_rejects_invalid_category`
- `manager::tests::test_upsert_page_uses_server_created_at`
- `manager::tests::test_delete_page_sets_deleted_at_not_remove`
- `manager::tests::test_search_fts_returns_total`
- `manager::tests::test_get_page_by_path_exact_match`
- `mcp::server::tests::test_mcp_scope_resolver_returns_matching_l0`
- `mcp::server::tests::test_mcp_scope_resolver_inherits_all_when_empty`
- `mcp::server::tests::test_mcp_workspace_flag_writes_to_workspace_db`

### 9.2 Frontend tests

- `contextStore.test.ts::test_save_page_rolls_back_on_error`
- `contextStore.test.ts::test_delete_page_rolls_back_on_error`
- `contextStore.test.ts::test_save_persona_attached_scopes_round_trip`
- `ContextInspector.test.tsx::test_l2_editor_hidden_for_personas`
- `ContextInspector.test.tsx::test_delete_button_hidden_for_built_in_personas`
- `ContextStatusPanel.test.tsx::test_sandbox_does_not_clobber_header_search`
- `ContextStatusPanel.test.tsx::test_snippet_renders_mark_tags_not_html`

### 9.3 E2E

- `pnpm vitest run` + `cargo test -p oppa --lib` + the existing
  `daemon_integration_test` plus a new MCP integration test that drives
  the full binary via stdio.

---

## 10. Risk & Rollback

- **WAL mode**: databases opened by older non-WAL-aware OPPA builds will
  downgrade silently. The journal_mode pragma is idempotent and the
  WAL file is co-located with the main DB. No external coordination
  required.
- **Schema migration**: reversible by dropping the added columns and
  index. The `user_version` PRAGMA records the migration state so
  re-running is safe.
- **MCP category enum change**: clients currently sending `preferences`
  or `standards` will get a schema-level MCP error. Documented in the
  CHANGELOG; this is a breaking change but the enum was wrong.
- **Soft-delete**: read paths must NOT forget `WHERE deleted_at IS NULL`.
  Add a smoke test that lists pages after a delete and verifies the
  count.

---

## 11. Files to Touch

Rust:
- `src-tauri/src/context/schema.rs` (additive columns, migrate, index)
- `src-tauri/src/context/manager.rs` (WAL, validation, server timestamps,
  pagination, get_page_by_path, search total)
- `src-tauri/src/context/models.rs` (`ContextScope`, `ContextCategory`
  enums, `ContextPage::validate`, `ContextPageList`)
- `src-tauri/src/context/commands.rs` (tier param, pagination params,
  export/import)
- `src-tauri/src/mcp/protocol.rs` (fixed enum, scope resolver input)
- `src-tauri/src/mcp/server.rs` (scope resolver, workspace flag verified,
  exact-path lookup)
- `src-tauri/src/lib.rs` (wire new commands)

Frontend:
- `src/lib/context/transport.ts` (tier, pagination, export/import args)
- `src/store/contextStore.ts` (try/catch, error state, sandbox split)
- `src/components/context/ContextInspector.tsx` (L2 hidden for personas,
  no-delete for built-in, scope chip editor)
- `src/components/context/ContextStatusPanel.tsx` (sandbox owns its own
  results, safe snippet rendering)
- `src/components/context/ContextStudio.tsx` (unified search input,
  export/import menu)

Tests:
- `src-tauri/src/context/{schema,manager,commands}.rs` test modules
- `src-tauri/src/mcp/server.rs` test modules
- `src/store/contextStore.test.ts`
- `src/components/context/{ContextInspector,ContextStatusPanel}.test.tsx`

---

## 12. Acceptance Criteria

A PR that resolves this spec is **done** when:

1. `cargo test -p oppa --lib` and `cargo test -p oppa --test
   daemon_integration_test` pass.
2. `pnpm vitest run` passes.
3. The four MCP tools in `oppa --mcp` accept the corrected enum and
   return the resolved scope context.
4. Opening a workspace DB while the GUI is running and the MCP server is
   running produces no `SQLITE_BUSY` errors.
5. Creating two notes with the same `(scope, category, path)` in the
   inspector surfaces a clear error and offers a rename / merge.
6. Free-form editing of a persona's L2 is no longer possible; `attached
   _scopes` round-trips correctly.
7. The header search and the sandbox search maintain independent result
   sets.
8. Snippet rendering does not use `dangerouslySetInnerHTML`.

---

## 13. Out of Scope

- Authentication / authorization on the MCP server (still trust-bound).
- Multi-user collaboration on the same workspace DB.
- Background re-indexing of FTS5 (triggers cover live updates; bulk
  re-index is `INSERT INTO context_pages_fts(context_pages_fts) VALUES
  ('rebuild')` and not exposed yet).
- A real `archive` UI for soft-deleted notes (the column exists; the
  UI can land later).
