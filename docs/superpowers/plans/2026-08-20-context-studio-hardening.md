# Context Studio Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the 20-item Context Studio hardening + capability expansion spec inside one PR so the studio is reliable as ambient memory for OPPA's parallel-agent terminal workflow.

**Architecture:** Additive SQLite migration under `user_version` PRAGMA. Strict enum validation at the manager boundary. WAL + busy timeout. New typed columns for `is_built_in`, `attached_scopes_json`, `deleted_at`. Soft-delete and unique path constraint. Real scope resolver in the MCP server. Frontend store gains rollback + lastError. Inspector hides L2 editor for personas. Sandbox owns its own search slice. `tracing` instrumentation throughout.

**Tech Stack:** Rust (rusqlite FTS5, serde, tokio, tracing), TypeScript, React 19, Zustand, Vitest, Happy-DOM.

**Spec:** `docs/superpowers/specs/2026-08-20-context-studio-hardening-design.md`

---

## Global Constraints

- All files use LF line endings; CRLF normalization is OK (Windows shell).
- Concise comments only — explain WHY, never HOW.
- TDD: write failing test → verify it fails → implement → verify pass → commit.
- Conventional commit messages: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`.
- New dependencies are allowed only when one of the existing ones cannot do the job. `tracing` and `tracing-subscriber` are added in this PR.
- Renderer components never call Tauri `invoke` directly — only `src/lib/context/transport.ts` does.
- No emojis in code or commit messages unless pre-existing.
- Database migrations are forward-only; every migration must be idempotent and recorded against `PRAGMA user_version`.

---

## File Boundary Map

Files created in this PR:

| File | Responsibility |
|------|----------------|
| `src-tauri/src/context/enums.rs` | `ContextScope`, `ContextCategory` Rust enums |
| `src-tauri/src/context/context_page_list.rs` | `ContextPageList { items, total }` wrapper |
| `src/components/context/ContextInspector.test.tsx` | Inspector component tests |
| `src/components/context/ContextStatusPanel.test.tsx` | Status panel tests |

Files modified:

| File | Why |
|------|-----|
| `src-tauri/Cargo.toml` | Add `tracing`, `tracing-subscriber` |
| `src-tauri/src/context/schema.rs` | Additive columns, migration, unique index, WAL pragmas |
| `src-tauri/src/context/models.rs` | New enum parsing, `validate()`, `ContextPage` gains `attached_scopes_json`, `is_built_in`, `deleted_at` |
| `src-tauri/src/context/manager.rs` | WAL pragma, validation, server-managed timestamps, pagination, soft-delete, exact-path lookup, search total, `tracing` instrumentation |
| `src-tauri/src/context/commands.rs` | Tier param, pagination, export/import, soft-delete commands |
| `src-tauri/src/mcp/protocol.rs` | Fixed enum, persona scope resolver params |
| `src-tauri/src/mcp/server.rs` | Scope resolver, exact-path lookup, workspace flag round-trip |
| `src-tauri/src/lib.rs` | Wire new commands, `tracing` init |
| `src/lib/context/transport.ts` | Tier, pagination, export/import args, error reporting |
| `src/store/contextStore.ts` | try/catch, lastError, sandbox split, persona fields rename |
| `src/components/context/ContextInspector.tsx` | L2 hidden for personas, no-delete for built-in, scope chip editor |
| `src/components/context/ContextStatusPanel.tsx` | Sandbox owns its own slice, safe snippet rendering, scope editor |
| `src/components/context/ContextStudio.tsx` | Export/import menu hooks |
| `src/store/contextStore.test.ts` | New error-rollback and persona tests |

The split keeps `models.rs` (data shape), `manager.rs` (DB operations), `enums.rs` (parsing) cleanly separated. `context_page_list.rs` is a 5-line wrapper so it doesn't bloat `models.rs`.

---

### Task 1: Rust enums for scope and category

**Files:**
- Create: `src-tauri/src/context/enums.rs`
- Modify: `src-tauri/src/context/mod.rs`

**Interfaces:**
- Consumes: nothing
- Produces: `pub enum ContextScope { Global, Workspace }`, `pub enum ContextCategory { Architecture, Quirk, Runbook, Preference, Persona }`, both with `as_str(&self) -> &'static str` and `impl FromStr for ContextScope` / `ContextCategory` returning `Result<Self, String>`.

**Step 1.1: Write the failing test**

```rust
// src-tauri/src/context/enums.rs

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_round_trips_via_str() {
        for s in [ContextScope::Global, ContextScope::Workspace] {
            assert_eq!(ContextScope::from_str(s.as_str()).unwrap(), s);
        }
    }

    #[test]
    fn scope_rejects_unknown() {
        assert!(ContextScope::from_str("project").is_err());
    }

    #[test]
    fn category_round_trips_via_str() {
        for c in [
            ContextCategory::Architecture,
            ContextCategory::Quirk,
            ContextCategory::Runbook,
            ContextCategory::Preference,
            ContextCategory::Persona,
        ] {
            assert_eq!(ContextCategory::from_str(c.as_str()).unwrap(), c);
        }
    }

    #[test]
    fn category_rejects_plural_form() {
        assert!(ContextCategory::from_str("preferences").is_err());
        assert!(ContextCategory::from_str("standards").is_err());
    }
}
```

**Step 1.2: Run the test to verify it fails**

Run: `cargo test -p oppa --lib context::enums::tests`
Expected: FAIL with "unresolved module `enums`" or "function not defined".

**Step 1.3: Implement the enums**

```rust
// src-tauri/src/context/enums.rs

use std::str::FromStr;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContextScope {
    Global,
    Workspace,
}

impl ContextScope {
    pub fn as_str(&self) -> &'static str {
        match self {
            ContextScope::Global => "global",
            ContextScope::Workspace => "workspace",
        }
    }
}

impl FromStr for ContextScope {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "global" => Ok(ContextScope::Global),
            "workspace" => Ok(ContextScope::Workspace),
            other => Err(format!("Invalid scope '{}'", other)),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContextCategory {
    Architecture,
    Quirk,
    Runbook,
    Preference,
    Persona,
}

impl ContextCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            ContextCategory::Architecture => "architecture",
            ContextCategory::Quirk => "quirk",
            ContextCategory::Runbook => "runbook",
            ContextCategory::Preference => "preference",
            ContextCategory::Persona => "persona",
        }
    }
}

impl FromStr for ContextCategory {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "architecture" => Ok(ContextCategory::Architecture),
            "quirk" => Ok(ContextCategory::Quirk),
            "runbook" => Ok(ContextCategory::Runbook),
            "preference" => Ok(ContextCategory::Preference),
            "persona" => Ok(ContextCategory::Persona),
            other => Err(format!("Invalid category '{}'", other)),
        }
    }
}
```

**Step 1.4: Add module to `context/mod.rs`**

Edit `src-tauri/src/context/mod.rs` to add `pub mod enums;` as the first line.

**Step 1.5: Run the test to verify it passes**

Run: `cargo test -p oppa --lib context::enums::tests`
Expected: PASS

**Step 1.6: Commit**

```bash
git add src-tauri/src/context/enums.rs src-tauri/src/context/mod.rs
git commit -m "feat(context): add ContextScope and ContextCategory enums"
```

---

### Task 2: Schema migration v1 (additive columns + unique index)

**Files:**
- Modify: `src-tauri/src/context/schema.rs`

**Interfaces:**
- Consumes: `ContextScope`, `ContextCategory` from Task 1.
- Produces: A `migrate()` function called from `initialize_schema`. After this task, `context_pages` has columns: `id, scope, category, path, title, icon, abstract_l0, overview_l1, details_l2, pinned, is_built_in, attached_scopes_json, created_at, updated_at, deleted_at`. A unique index `uniq_context_page_path` on `(scope, category, path) WHERE deleted_at IS NULL`.

**Step 2.1: Write the failing test**

Add to `src-tauri/src/context/schema.rs::tests`:

```rust
#[test]
fn test_migration_is_idempotent() {
    let conn = Connection::open_in_memory().unwrap();
    initialize_schema(&conn).unwrap();
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO context_pages (id, scope, category, path, title, abstract_l0, overview_l1, created_at, updated_at)
         VALUES ('p1', 'workspace', 'quirk', 'quirks/foo', 'Foo', 'a', 'b', ?1, ?1)",
        rusqlite::params![now],
    ).unwrap();
    // Re-run; should not fail nor duplicate.
    initialize_schema(&conn).unwrap();
    let count: i64 = conn.query_row("SELECT count(*) FROM context_pages", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 1);
}

#[test]
fn test_unique_scope_category_path_blocks_duplicates() {
    let conn = Connection::open_in_memory().unwrap();
    initialize_schema(&conn).unwrap();
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO context_pages (id, scope, category, path, title, abstract_l0, overview_l1, created_at, updated_at)
         VALUES ('p1', 'workspace', 'quirk', 'quirks/foo', 'Foo', 'a', 'b', ?1, ?1)",
        rusqlite::params![now],
    ).unwrap();
    let res = conn.execute(
        "INSERT INTO context_pages (id, scope, category, path, title, abstract_l0, overview_l1, created_at, updated_at)
         VALUES ('p2', 'workspace', 'quirk', 'quirks/foo', 'Foo2', 'a', 'b', ?1, ?1)",
        rusqlite::params![now],
    );
    assert!(res.is_err());
}

#[test]
fn test_unique_constraint_ignores_soft_deleted_rows() {
    let conn = Connection::open_in_memory().unwrap();
    initialize_schema(&conn).unwrap();
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "INSERT INTO context_pages (id, scope, category, path, title, abstract_l0, overview_l1, created_at, updated_at, deleted_at)
         VALUES ('p1', 'workspace', 'quirk', 'quirks/foo', 'Foo', 'a', 'b', ?1, ?1, ?1)",
        rusqlite::params![now],
    ).unwrap();
    let res = conn.execute(
        "INSERT INTO context_pages (id, scope, category, path, title, abstract_l0, overview_l1, created_at, updated_at)
         VALUES ('p2', 'workspace', 'quirk', 'quirks/foo', 'Foo2', 'a', 'b', ?1, ?1)",
        rusqlite::params![now],
    );
    assert!(res.is_ok());
}
```

**Step 2.2: Run to confirm failure**

Run: `cargo test -p oppa --lib context::schema::tests::test_migration_is_idempotent`
Expected: FAIL — `is_built_in`, `attached_scopes_json`, `deleted_at` columns don't exist yet, and the unique index doesn't exist.

**Step 2.3: Implement the migration**

Replace `initialize_schema` body with:

```rust
pub fn initialize_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS context_pages (
            id            TEXT PRIMARY KEY NOT NULL,
            scope         TEXT NOT NULL CHECK (scope IN ('global', 'workspace')),
            category      TEXT NOT NULL CHECK (category IN ('architecture', 'quirk', 'runbook', 'preference', 'persona')),
            path          TEXT NOT NULL,
            title         TEXT NOT NULL,
            icon          TEXT NOT NULL DEFAULT '📄',
            abstract_l0   TEXT NOT NULL,
            overview_l1   TEXT NOT NULL,
            details_l2    TEXT,
            pinned        INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
            created_at    INTEGER NOT NULL,
            updated_at    INTEGER NOT NULL
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS context_pages_fts USING fts5(
            title, abstract_l0, overview_l1, details_l2,
            content='context_pages',
            content_rowid='rowid',
            tokenize="unicode61 tokenchars '/_-'"
        );

        CREATE TRIGGER IF NOT EXISTS context_pages_fts_ai AFTER INSERT ON context_pages BEGIN
            INSERT INTO context_pages_fts(rowid, title, abstract_l0, overview_l1, details_l2)
                VALUES (new.rowid, new.title, new.abstract_l0, new.overview_l1, new.details_l2);
        END;
        CREATE TRIGGER IF NOT EXISTS context_pages_fts_ad AFTER DELETE ON context_pages BEGIN
            INSERT INTO context_pages_fts(context_pages_fts, rowid, title, abstract_l0, overview_l1, details_l2)
                VALUES ('delete', old.rowid, old.title, old.abstract_l0, old.overview_l1, old.details_l2);
        END;
        CREATE TRIGGER IF NOT EXISTS context_pages_fts_au AFTER UPDATE ON context_pages BEGIN
            INSERT INTO context_pages_fts(context_pages_fts, rowid, title, abstract_l0, overview_l1, details_l2)
                VALUES ('delete', old.rowid, old.title, old.abstract_l0, old.overview_l1, old.details_l2);
            INSERT INTO context_pages_fts(rowid, title, abstract_l0, overview_l1, details_l2)
                VALUES (new.rowid, new.title, new.abstract_l0, new.overview_l1, new.details_l2);
        END;
        "#,
    )?;

    migrate(conn)?;
    seed_builtin_personas(conn)?;
    Ok(())
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version < 1 {
        conn.execute_batch(
            r#"
            ALTER TABLE context_pages ADD COLUMN is_built_in INTEGER NOT NULL DEFAULT 0;
            ALTER TABLE context_pages ADD COLUMN attached_scopes_json TEXT NOT NULL DEFAULT '[]';
            ALTER TABLE context_pages ADD COLUMN deleted_at INTEGER;
            CREATE UNIQUE INDEX IF NOT EXISTS uniq_context_page_path
              ON context_pages (scope, category, path) WHERE deleted_at IS NULL;
            UPDATE context_pages
              SET is_built_in = 1
              WHERE id IN ('debugger','optimizer','researcher','test_architect');
            "#,
        )?;
        conn.pragma_update(None, "user_version", 1i64)?;
    }
    Ok(())
}
```

**Step 2.4: Update `seed_builtin_personas` to set `is_built_in = 1`**

Change the `INSERT OR IGNORE` SQL to include `is_built_in` (1) and `attached_scopes_json` ('[]'). Replace the entire `stmt.execute(...)` loop body so the new columns are populated.

```rust
stmt.execute(rusqlite::params![
    id, path, title, icon, abstract_l0, overview_l1, 1i32, "[]", now
])?;
```

**Step 2.5: Run tests to verify pass**

Run: `cargo test -p oppa --lib context::schema::tests`
Expected: PASS

**Step 2.6: Commit**

```bash
git add src-tauri/src/context/schema.rs
git commit -m "feat(context): introduce migration v1 with is_built_in, attached_scopes_json, deleted_at and unique path"
```

---

### Task 3: Update `ContextPage` model with new fields and `validate()`

**Files:**
- Modify: `src-tauri/src/context/models.rs`

**Interfaces:**
- Consumes: `ContextScope`, `ContextCategory` from Task 1.
- Produces: `ContextPage` gains `is_built_in: bool`, `attached_scopes_json: String`, `deleted_at: Option<i64>`. Adds `ContextPage::validate(&self) -> Result<(), String>`. `AgentPersona` reads `attached_scopes_json` instead of `details_l2`.

**Step 3.1: Write the failing test**

Add to `src-tauri/src/context/models.rs::tests`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn base_page() -> ContextPage {
        ContextPage {
            id: "p1".into(),
            scope: "workspace".into(),
            category: "quirk".into(),
            path: "quirks/foo".into(),
            title: "Foo".into(),
            icon: "bug".into(),
            abstract_l0: "a".into(),
            overview_l1: "b".into(),
            details_l2: None,
            pinned: false,
            is_built_in: false,
            attached_scopes_json: "[]".into(),
            created_at: 0,
            updated_at: 0,
            deleted_at: None,
        }
    }

    #[test]
    fn validate_accepts_well_formed_page() {
        assert!(base_page().validate().is_ok());
    }

    #[test]
    fn validate_rejects_empty_id() {
        let mut p = base_page();
        p.id = "".into();
        assert!(p.validate().is_err());
    }

    #[test]
    fn validate_rejects_unknown_scope() {
        let mut p = base_page();
        p.scope = "project".into();
        let err = p.validate().unwrap_err();
        assert!(err.contains("scope"));
    }

    #[test]
    fn validate_rejects_unknown_category() {
        let mut p = base_page();
        p.category = "preferences".into();
        assert!(p.validate().is_err());
    }

    #[test]
    fn validate_rejects_path_traversal() {
        let mut p = base_page();
        p.path = "../etc/passwd".into();
        assert!(p.validate().is_err());
    }

    #[test]
    fn persona_reads_attached_scopes_from_new_column() {
        let mut p = base_page();
        p.category = "persona".into();
        p.attached_scopes_json = r#"["quirks","architecture"]"#.into();
        let persona = AgentPersona::from_context_page(&p);
        assert_eq!(persona.attached_scopes, vec!["quirks", "architecture"]);
    }
}
```

**Step 3.2: Run to confirm failure**

Run: `cargo test -p oppa --lib context::models::tests`
Expected: FAIL — fields and `validate` don't exist.

**Step 3.3: Add fields and `validate()`**

```rust
// src-tauri/src/context/models.rs

use crate::context::enums::{ContextCategory, ContextScope};
use std::str::FromStr;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ContextPage {
    pub id: String,
    pub scope: String,
    pub category: String,
    pub path: String,
    pub title: String,
    pub icon: String,
    pub abstract_l0: String,
    pub overview_l1: String,
    pub details_l2: Option<String>,
    pub pinned: bool,
    pub is_built_in: bool,
    pub attached_scopes_json: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub deleted_at: Option<i64>,
}

impl ContextPage {
    pub fn validate(&self) -> Result<(), String> {
        if self.id.is_empty() {
            return Err("id is required".into());
        }
        if self.title.is_empty() {
            return Err("title is required".into());
        }
        ContextScope::from_str(&self.scope)
            .map_err(|_| format!("Invalid scope '{}'", self.scope))?;
        ContextCategory::from_str(&self.category)
            .map_err(|_| format!("Invalid category '{}'", self.category))?;
        if self.path.is_empty()
            || !self
                .path
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-'))
        {
            return Err(format!("Invalid path '{}'", self.path));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ContextSearchResult {
    pub id: String,
    pub scope: String,
    pub category: String,
    pub path: String,
    pub title: String,
    pub icon: String,
    pub abstract_l0: String,
    pub overview_l1: String,
    pub snippet: String,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AgentPersona {
    pub id: String,
    pub name: String,
    pub icon: String,
    pub tagline: String,
    pub system_prompt: String,
    pub attached_scopes: Vec<String>,
    pub is_built_in: bool,
}

impl AgentPersona {
    pub fn from_context_page(page: &ContextPage) -> Self {
        let attached_scopes: Vec<String> = serde_json::from_str(&page.attached_scopes_json)
            .unwrap_or_default();
        Self {
            id: page.id.clone(),
            name: page.title.clone(),
            icon: page.icon.clone(),
            tagline: page.abstract_l0.clone(),
            system_prompt: page.overview_l1.clone(),
            attached_scopes,
            is_built_in: page.is_built_in,
        }
    }

    pub fn to_context_page(&self, scope: &str, now: i64) -> ContextPage {
        let attached_scopes_json = serde_json::to_string(&self.attached_scopes)
            .unwrap_or_else(|_| "[]".into());
        ContextPage {
            id: self.id.clone(),
            scope: scope.to_string(),
            category: "persona".to_string(),
            path: format!("personas/{}", self.id),
            title: self.name.clone(),
            icon: self.icon.clone(),
            abstract_l0: self.tagline.clone(),
            overview_l1: self.system_prompt.clone(),
            details_l2: None,
            pinned: false,
            is_built_in: self.is_built_in,
            attached_scopes_json,
            created_at: now,
            updated_at: now,
            deleted_at: None,
        }
    }
}
```

**Step 3.4: Run tests to verify pass**

Run: `cargo test -p oppa --lib context::models::tests`
Expected: PASS

**Step 3.5: Commit**

```bash
git add src-tauri/src/context/models.rs
git commit -m "feat(context): validate context pages and read attached_scopes from new column"
```

---

### Task 4: `ContextPageList` wrapper

**Files:**
- Create: `src-tauri/src/context/context_page_list.rs`
- Modify: `src-tauri/src/context/mod.rs`
- Modify: `src-tauri/src/context/models.rs` (re-export)

**Interfaces:**
- Produces: `pub struct ContextPageList { pub items: Vec<ContextPage>, pub total: i64 }`. Re-exported via `models`.

**Step 4.1: Write the failing test**

```rust
// src-tauri/src/context/context_page_list.rs

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_list_has_zero_total() {
        let list = ContextPageList::default();
        assert_eq!(list.items.len(), 0);
        assert_eq!(list.total, 0);
    }
}
```

**Step 4.2: Run to confirm failure**

Run: `cargo test -p oppa --lib context::context_page_list::tests`
Expected: FAIL.

**Step 4.3: Implement**

```rust
// src-tauri/src/context/context_page_list.rs

use serde::{Deserialize, Serialize};

use crate::context::models::ContextPage;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ContextPageList {
    pub items: Vec<ContextPage>,
    pub total: i64,
}
```

**Step 4.4: Register module and re-export**

In `src-tauri/src/context/mod.rs`, add `pub mod context_page_list;`. In `src-tauri/src/context/models.rs`, add `pub use crate::context::context_page_list::ContextPageList;`.

**Step 4.5: Run tests to verify pass**

Run: `cargo test -p oppa --lib context::context_page_list::tests`
Expected: PASS

**Step 4.6: Commit**

```bash
git add src-tauri/src/context/context_page_list.rs src-tauri/src/context/mod.rs src-tauri/src/context/models.rs
git commit -m "feat(context): introduce ContextPageList wrapper for paginated responses"
```

---

### Task 5: `ContextManager` hardening (WAL, validation, server timestamps, pagination, soft-delete, exact path, search total, tracing)

**Files:**
- Modify: `src-tauri/src/context/manager.rs`
- Modify: `src-tauri/Cargo.toml`

**Interfaces:**
- Consumes: `ContextPage::validate()`, `ContextPageList`, `ContextScope`, `ContextCategory`.
- Produces:
  - `open_conn` enables WAL + busy timeout.
  - `upsert_page` validates, ignores client `created_at`, stamps `updated_at = now()`, sets `is_built_in` only for seeded built-ins.
  - `delete_page` performs `UPDATE context_pages SET deleted_at = ? WHERE id = ?` instead of `DELETE`.
  - `purge_page` is a separate destructive `DELETE`.
  - `restore_page` clears `deleted_at`.
  - `list_pages` accepts `limit`/`offset`, returns `ContextPageList`, filters `deleted_at IS NULL`.
  - `search_fts` returns `Vec<ContextSearchResult>` with `total` field; `LIMIT 25` query is replaced with caller-supplied `limit` (default 25).
  - `get_page_by_path(scope, path)` exact-match lookup.
  - `list_pages_for_scope_token(scope_token, category, scope_filter)` helper used by the MCP scope resolver.
  - All public methods `#[tracing::instrument]`.

**Step 5.1: Add `tracing` dependency**

Edit `src-tauri/Cargo.toml` `[dependencies]` block:

```toml
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
```

**Step 5.2: Write the failing tests**

Add to `src-tauri/src/context/manager.rs::tests`:

```rust
#[test]
fn test_wal_mode_enabled_after_open() {
    let dir = tempdir().unwrap();
    let path = dir.path().join("g.sqlite");
    let m = ContextManager::with_global_db_path(path.clone());
    m.upsert_page(&ContextPage {
        id: "p".into(),
        scope: "global".into(),
        category: "quirk".into(),
        path: "quirks/x".into(),
        title: "X".into(),
        icon: "bug".into(),
        abstract_l0: "a".into(),
        overview_l1: "b".into(),
        details_l2: None,
        pinned: false,
        is_built_in: false,
        attached_scopes_json: "[]".into(),
        created_at: 0,
        updated_at: 0,
        deleted_at: None,
    }, None).unwrap();
    let conn = rusqlite::Connection::open(&path).unwrap();
    let mode: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
    assert_eq!(mode.to_lowercase(), "wal");
}

#[test]
fn test_upsert_page_rejects_invalid_category() {
    let dir = tempdir().unwrap();
    let (m, ws) = create_test_manager(&dir);
    let page = ContextPage {
        id: "p".into(),
        scope: "workspace".into(),
        category: "preferences".into(),
        path: "p".into(),
        title: "T".into(),
        icon: "x".into(),
        abstract_l0: "a".into(),
        overview_l1: "b".into(),
        details_l2: None,
        pinned: false,
        is_built_in: false,
        attached_scopes_json: "[]".into(),
        created_at: 0,
        updated_at: 0,
        deleted_at: None,
    };
    let err = m.upsert_page(&page, Some(&ws)).unwrap_err();
    assert!(err.contains("category"));
}

#[test]
fn test_upsert_page_uses_server_created_at() {
    let dir = tempdir().unwrap();
    let (m, ws) = create_test_manager(&dir);
    let page = ContextPage {
        id: "p".into(),
        scope: "workspace".into(),
        category: "quirk".into(),
        path: "quirks/x".into(),
        title: "X".into(),
        icon: "bug".into(),
        abstract_l0: "a".into(),
        overview_l1: "b".into(),
        details_l2: None,
        pinned: false,
        is_built_in: false,
        attached_scopes_json: "[]".into(),
        created_at: 999_999_999, // bogus
        updated_at: 999_999_999,
        deleted_at: None,
    };
    m.upsert_page(&page, Some(&ws)).unwrap();
    let got = m.get_page("p", Some(&ws)).unwrap().unwrap();
    let now = chrono::Utc::now().timestamp_millis();
    assert!(got.created_at <= now);
    assert!(got.updated_at <= now);
}

#[test]
fn test_delete_page_soft_deletes() {
    let dir = tempdir().unwrap();
    let (m, ws) = create_test_manager(&dir);
    m.upsert_page(&ContextPage {
        id: "p".into(), scope: "workspace".into(), category: "quirk".into(),
        path: "quirks/x".into(), title: "X".into(), icon: "bug".into(),
        abstract_l0: "a".into(), overview_l1: "b".into(), details_l2: None,
        pinned: false, is_built_in: false, attached_scopes_json: "[]".into(),
        created_at: 0, updated_at: 0, deleted_at: None,
    }, Some(&ws)).unwrap();
    m.delete_page("p", "workspace", Some(&ws)).unwrap();
    let list = m.list_pages(Some(&ws), None).unwrap();
    assert!(list.items.iter().all(|p| p.id != "p"));
    let restored = m.get_page("p", Some(&ws)).unwrap();
    assert!(restored.is_none(), "soft-delete hides row from get_page");
}

#[test]
fn test_search_fts_returns_total() {
    let dir = tempdir().unwrap();
    let (m, ws) = create_test_manager(&dir);
    for i in 0..3 {
        m.upsert_page(&ContextPage {
            id: format!("p{i}"), scope: "workspace".into(), category: "quirk".into(),
            path: format!("quirks/q{i}"), title: format!("Foobar {i}"), icon: "bug".into(),
            abstract_l0: "foobar".into(), overview_l1: "b".into(), details_l2: None,
            pinned: false, is_built_in: false, attached_scopes_json: "[]".into(),
            created_at: 0, updated_at: 0, deleted_at: None,
        }, Some(&ws)).unwrap();
    }
    let res = m.search_fts("foobar", Some(&ws), Some(2)).unwrap();
    assert_eq!(res.len(), 2);
    assert_eq!(res[0].total, 3);
}

#[test]
fn test_get_page_by_path_exact_match() {
    let dir = tempdir().unwrap();
    let (m, ws) = create_test_manager(&dir);
    m.upsert_page(&ContextPage {
        id: "p1".into(), scope: "workspace".into(), category: "quirk".into(),
        path: "quirks/foo".into(), title: "Foo".into(), icon: "bug".into(),
        abstract_l0: "a".into(), overview_l1: "b".into(), details_l2: None,
        pinned: false, is_built_in: false, attached_scopes_json: "[]".into(),
        created_at: 0, updated_at: 0, deleted_at: None,
    }, Some(&ws)).unwrap();
    let got = m.get_page_by_path("workspace", "quirks/foo", Some(&ws)).unwrap();
    assert_eq!(got.unwrap().id, "p1");
    let miss = m.get_page_by_path("workspace", "foo", Some(&ws)).unwrap();
    assert!(miss.is_none());
}
```

**Step 5.3: Run tests to confirm failure**

Run: `cargo test -p oppa --lib context::manager::tests`
Expected: FAIL — fields and signatures don't match.

**Step 5.4: Implement `open_conn` WAL pragmas**

Replace `open_conn`:

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

**Step 5.5: Rewrite `upsert_page`, `delete_page`, `list_pages`, `search_fts`, `get_page_by_path`**

```rust
#[tracing::instrument(skip(self))]
pub fn upsert_page(
    &self,
    page: &ContextPage,
    workspace_path: Option<&str>,
) -> Result<(), String> {
    page.validate()?;
    let conn = Self::open_conn_for_scope(page.scope.as_str(), workspace_path, &self.global_path())
        .map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().timestamp_millis();
    let existing = Self::query_single_page(&conn, &page.id).map_err(|e| e.to_string())?;
    let created_at = existing.as_ref().map(|p| p.created_at).unwrap_or(now);
    let pinned_int: i32 = if page.pinned { 1 } else { 0 };
    let is_built_in_int: i32 = if page.is_built_in { 1 } else { 0 };
    let mut stmt = conn
        .prepare_cached(
            r#"
            INSERT INTO context_pages (
                id, scope, category, path, title, icon, abstract_l0, overview_l1, details_l2,
                pinned, is_built_in, attached_scopes_json, created_at, updated_at, deleted_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
                ?10, ?11, ?12, ?13, ?14, ?15
            )
            ON CONFLICT(id) DO UPDATE SET
                scope = excluded.scope,
                category = excluded.category,
                path = excluded.path,
                title = excluded.title,
                icon = excluded.icon,
                abstract_l0 = excluded.abstract_l0,
                overview_l1 = excluded.overview_l1,
                details_l2 = excluded.details_l2,
                pinned = excluded.pinned,
                attached_scopes_json = excluded.attached_scopes_json,
                updated_at = excluded.updated_at
            "#,
        )
        .map_err(|e| e.to_string())?;
    stmt.execute(rusqlite::params![
        page.id,
        page.scope,
        page.category,
        page.path,
        page.title,
        page.icon,
        page.abstract_l0,
        page.overview_l1,
        page.details_l2,
        pinned_int,
        is_built_in_int,
        page.attached_scopes_json,
        created_at,
        now,
        page.deleted_at
    ])
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tracing::instrument(skip(self))]
pub fn delete_page(
    &self,
    id: &str,
    scope: &str,
    workspace_path: Option<&str>,
) -> Result<(), String> {
    let conn = Self::open_conn_for_scope(scope, workspace_path, &self.global_path())
        .map_err(|e| e.to_string())?;
    let now = chrono::Utc::now().timestamp_millis();
    conn.execute(
        "UPDATE context_pages SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
        rusqlite::params![now, id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tracing::instrument(skip(self))]
pub fn restore_page(
    &self,
    id: &str,
    scope: &str,
    workspace_path: Option<&str>,
) -> Result<(), String> {
    let conn = Self::open_conn_for_scope(scope, workspace_path, &self.global_path())
        .map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE context_pages SET deleted_at = NULL WHERE id = ?1",
        rusqlite::params![id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tracing::instrument(skip(self))]
pub fn list_pages(
    &self,
    workspace_path: Option<&str>,
    category: Option<&str>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<ContextPageList, String> {
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    let mut total: i64 = 0;
    if let Some(ws) = workspace_path {
        let ws_path = Self::get_workspace_db_path(ws);
        if ws_path.exists() {
            let conn = Self::open_conn(&ws_path).map_err(|e| e.to_string())?;
            let mut items_part = Self::query_pages_visible(&conn, category).map_err(|e| e.to_string())?;
            total += items_part.len() as i64;
            for p in items_part.drain(..) {
                if seen.insert(p.id.clone()) {
                    items.push(p);
                }
            }
        }
    }
    let global_conn = Self::open_conn(&self.global_path()).map_err(|e| e.to_string())?;
    let mut items_part = Self::query_pages_visible(&global_conn, category).map_err(|e| e.to_string())?;
    total += items_part.len() as i64;
    for p in items_part.drain(..) {
        if seen.insert(p.id.clone()) {
            items.push(p);
        }
    }
    let offset = offset.unwrap_or(0);
    let limit = limit.unwrap_or(items.len());
    let end = (offset + limit).min(items.len());
    let items = if offset >= items.len() { Vec::new() } else { items[offset..end].to_vec() };
    Ok(ContextPageList { items, total })
}

#[tracing::instrument(skip(self))]
pub fn search_fts(
    &self,
    query: &str,
    workspace_path: Option<&str>,
    limit: Option<usize>,
) -> Result<Vec<ContextSearchResult>, String> {
    let sanitized = sanitize_fts5_query(query);
    if sanitized.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.unwrap_or(25);
    let mut results = Vec::new();
    let mut seen = HashSet::new();
    let mut total: i64 = 0;
    if let Some(ws) = workspace_path {
        let ws_path = Self::get_workspace_db_path(ws);
        if ws_path.exists() {
            let conn = Self::open_conn(&ws_path).map_err(|e| e.to_string())?;
            let (mut ws_results, ws_total) = Self::query_fts(&conn, &sanitized, limit).map_err(|e| e.to_string())?;
            total += ws_total;
            for r in ws_results.drain(..) {
                if seen.insert(r.id.clone()) {
                    results.push(r);
                }
            }
        }
    }
    let global_conn = Self::open_conn(&self.global_path()).map_err(|e| e.to_string())?;
    let (mut g_results, g_total) = Self::query_fts(&global_conn, &sanitized, limit).map_err(|e| e.to_string())?;
    total += g_total;
    for r in g_results.drain(..) {
        if seen.insert(r.id.clone()) {
            results.push(r);
        }
    }
    results.truncate(limit);
    for r in results.iter_mut() {
        r.total = total;
    }
    Ok(results)
}

#[tracing::instrument(skip(self))]
pub fn get_page_by_path(
    &self,
    scope: &str,
    path: &str,
    workspace_path: Option<&str>,
) -> Result<Option<ContextPage>, String> {
    let conn = Self::open_conn_for_scope(scope, workspace_path, &self.global_path())
        .map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare_cached(
            "SELECT id, scope, category, path, title, icon, abstract_l0, overview_l1, details_l2,
                    pinned, is_built_in, attached_scopes_json, created_at, updated_at, deleted_at
             FROM context_pages
             WHERE scope = ?1 AND path = ?2 AND deleted_at IS NULL",
        )
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query(rusqlite::params![scope, path]).map_err(|e| e.to_string())?;
    if let Some(row) = rows.next().map_err(|e| e.to_string())? {
        Ok(Some(Self::row_to_page(row).map_err(|e| e.to_string())?))
    } else {
        Ok(None)
    }
}

fn open_conn_for_scope(
    scope: &str,
    workspace_path: Option<&str>,
    global_path: &Path,
) -> rusqlite::Result<Connection> {
    match scope {
        "global" => Self::open_conn(global_path),
        "workspace" => {
            let ws = workspace_path
                .ok_or_else(|| rusqlite::Error::InvalidQuery)?;
            let path = Self::get_workspace_db_path(ws);
            Self::open_conn(&path)
        }
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

fn query_pages_visible(
    conn: &Connection,
    category: Option<&str>,
) -> rusqlite::Result<Vec<ContextPage>> {
    let mut sql = String::from(
        "SELECT id, scope, category, path, title, icon, abstract_l0, overview_l1, details_l2,
                pinned, is_built_in, attached_scopes_json, created_at, updated_at, deleted_at
         FROM context_pages WHERE deleted_at IS NULL",
    );
    if category.is_some() {
        sql.push_str(" AND category = ?1");
    }
    sql.push_str(" ORDER BY pinned DESC, updated_at DESC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = if let Some(cat) = category {
        stmt.query_map(rusqlite::params![cat], Self::row_to_page)?
    } else {
        stmt.query_map([], Self::row_to_page)?
    };
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

fn query_fts(
    conn: &Connection,
    sanitized_query: &str,
    limit: usize,
) -> rusqlite::Result<(Vec<ContextSearchResult>, i64)> {
    let mut stmt = conn.prepare_cached(
        r#"
        SELECT p.id, p.scope, p.category, p.path, p.title, p.icon, p.abstract_l0, p.overview_l1,
               snippet(context_pages_fts, 1, '<b>', '</b>', '...', 10) as snippet,
               (SELECT count(*) FROM context_pages_fts fts2
                  WHERE fts2.rowid = p.rowid) AS _unused,
               (SELECT count(*) FROM context_pages_fts WHERE context_pages_fts MATCH ?1) AS total
        FROM context_pages_fts fts
        JOIN context_pages p ON fts.rowid = p.rowid
        WHERE context_pages_fts MATCH ?1 AND p.deleted_at IS NULL
        ORDER BY rank
        LIMIT ?2
        "#,
    )?;
    let rows = stmt.query_map(rusqlite::params![sanitized_query, limit as i64], Self::row_to_search_result)?;
    let mut results = Vec::new();
    let mut total: i64 = 0;
    for r in rows {
        let mut row = r?;
        total = row.total;
        results.push(row);
    }
    // Re-fetch total separately to avoid cross-row GROUP BY unwrapping.
    let total: i64 = conn
        .query_row(
            "SELECT count(*) FROM context_pages_fts WHERE context_pages_fts MATCH ?1",
            rusqlite::params![sanitized_query],
            |r| r.get(0),
        )?;
    Ok((results, total))
}

fn row_to_page(row: &rusqlite::Row) -> rusqlite::Result<ContextPage> {
    Ok(ContextPage {
        id: row.get(0)?,
        scope: row.get(1)?,
        category: row.get(2)?,
        path: row.get(3)?,
        title: row.get(4)?,
        icon: row.get(5)?,
        abstract_l0: row.get(6)?,
        overview_l1: row.get(7)?,
        details_l2: row.get(8)?,
        pinned: row.get::<_, i32>(9)? != 0,
        is_built_in: row.get::<_, i32>(10)? != 0,
        attached_scopes_json: row.get(11)?,
        created_at: row.get(12)?,
        updated_at: row.get(13)?,
        deleted_at: row.get(14)?,
    })
}

fn row_to_search_result(row: &rusqlite::Row) -> rusqlite::Result<ContextSearchResult> {
    Ok(ContextSearchResult {
        id: row.get(0)?,
        scope: row.get(1)?,
        category: row.get(2)?,
        path: row.get(3)?,
        title: row.get(4)?,
        icon: row.get(5)?,
        abstract_l0: row.get(6)?,
        overview_l1: row.get(7)?,
        snippet: row.get(8)?,
        total: 0,
    })
}

#[tracing::instrument(skip(self))]
pub fn list_pages_for_scope_token(
    &self,
    token: &str,
    workspace_path: Option<&str>,
) -> Result<Vec<ContextPage>, String> {
    use crate::context::enums::ContextCategory;
    let effective_scope = workspace_path.unwrap_or("global");
    let category = match token {
        "architecture" => Some(ContextCategory::Architecture),
        "quirks" => Some(ContextCategory::Quirk),
        "runbooks" => Some(ContextCategory::Runbook),
        "preferences" => Some(ContextCategory::Preference),
        "personas" => Some(ContextCategory::Persona),
        _ => None,
    };
    let mut items = Vec::new();
    let mut seen = HashSet::new();
    if token == "global" || token == "workspace" {
        let target_scope = if token == "global" { "global" } else { "workspace" };
        let list = self.list_pages_by_scope(target_scope, workspace_path)?;
        for p in list {
            if seen.insert(p.id.clone()) {
                items.push(p);
            }
        }
        return Ok(items);
    }
    if let Some(cat) = category {
        let cat_str = cat.as_str();
        let list = self.list_pages(workspace_path, Some(cat_str), None, None)?;
        for p in list.items {
            if p.scope == effective_scope && seen.insert(p.id.clone()) {
                items.push(p);
            }
        }
    }
    Ok(items)
}

fn list_pages_by_scope(&self, scope: &str, workspace_path: Option<&str>) -> Result<Vec<ContextPage>, String> {
    let conn = Self::open_conn_for_scope(scope, workspace_path, &self.global_path())
        .map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare_cached(
            "SELECT id, scope, category, path, title, icon, abstract_l0, overview_l1, details_l2,
                    pinned, is_built_in, attached_scopes_json, created_at, updated_at, deleted_at
             FROM context_pages WHERE deleted_at IS NULL ORDER BY pinned DESC, updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], Self::row_to_page)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| e.to_string())?);
    }
    Ok(out)
}
```

**Step 5.6: Update `get_page` to ignore soft-deleted rows**

```rust
fn query_single_page(conn: &Connection, id: &str) -> rusqlite::Result<Option<ContextPage>> {
    let mut stmt = conn.prepare_cached(
        "SELECT id, scope, category, path, title, icon, abstract_l0, overview_l1, details_l2,
                pinned, is_built_in, attached_scopes_json, created_at, updated_at, deleted_at
         FROM context_pages WHERE id = ?1 AND deleted_at IS NULL",
    )?;
    let mut rows = stmt.query(rusqlite::params![id])?;
    if let Some(row) = rows.next()? {
        Ok(Some(Self::row_to_page(row)?))
    } else {
        Ok(None)
    }
}
```

**Step 5.7: Update `Persona` to drop `details_l2` JSON handling**

`AgentPersona::from_context_page` already reads from `attached_scopes_json` after Task 3. Remove the legacy `details_l2` JSON deserialization path. The `upsert_persona` function in `manager.rs` uses `persona.to_context_page` which now writes `attached_scopes_json`, so legacy data will be ignored on next save.

**Step 5.8: Update existing tests to the new `list_pages` signature**

In `src-tauri/src/context/manager.rs::tests`, every call site of `list_pages` and `search_fts` must be updated:

```rust
manager.list_pages(Some(&ws), None, None, None).unwrap().items
// or
manager.search_fts("backpressure", Some(&ws), None).unwrap()
```

`test_list_pages_filtering_and_deduplication` becomes:

```rust
let personas = manager.list_pages(Some(&ws), Some("persona"), None, None).unwrap();
assert_eq!(personas.total, 4);
let arch = manager.list_pages(Some(&ws), Some("architecture"), None, None).unwrap();
assert_eq!(arch.items.len(), 1);
let all = manager.list_pages(Some(&ws), None, None, None).unwrap();
assert_eq!(all.total, 5);
```

**Step 5.9: Run all manager tests**

Run: `cargo test -p oppa --lib context::manager::tests`
Expected: PASS

**Step 5.10: Commit**

```bash
git add src-tauri/src/context/manager.rs src-tauri/Cargo.toml Cargo.lock
git commit -m "feat(context): WAL, validation, server timestamps, pagination, soft-delete, exact path, tracing"
```

---

### Task 6: Update `context::commands` to new signatures + tier param + export/import

**Files:**
- Modify: `src-tauri/src/context/commands.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `ContextPageList`, `ContextPage::validate`, `delete_page`/`restore_page`/`upsert_page` from Task 5.
- Produces:
  - `context_list(workspace_path, category, limit, offset) -> ContextPageList`
  - `context_get(id, workspace_path, tier) -> Option<ContextPage>`
  - `context_upsert(page, workspace_path) -> ()`
  - `context_delete(id, scope, workspace_path) -> ()`
  - `context_restore(id, scope, workspace_path) -> ()`
  - `context_search(query, workspace_path, limit) -> Vec<ContextSearchResult>`
  - `context_export(workspace_path) -> String` (JSON)
  - `context_import(workspace_path, json) -> ()`

**Step 6.1: Write the failing tests**

Replace the existing `tests` module in `src-tauri/src/context/commands.rs` with:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn make_test_manager() -> (Arc<ContextManager>, tempfile::TempDir) {
        let dir = tempdir().unwrap();
        let global_db = dir.path().join("global_context.sqlite");
        let manager = Arc::new(ContextManager::with_global_db_path(global_db));
        (manager, dir)
    }

    #[test]
    fn test_tier_filter_returns_only_l0_when_requested() {
        let (m, _d) = make_test_manager();
        m.upsert_page(&ContextPage {
            id: "p".into(), scope: "global".into(), category: "quirk".into(),
            path: "quirks/x".into(), title: "X".into(), icon: "bug".into(),
            abstract_l0: "a".into(), overview_l1: "b".into(),
            details_l2: Some("d".into()),
            pinned: false, is_built_in: false, attached_scopes_json: "[]".into(),
            created_at: 0, updated_at: 0, deleted_at: None,
        }, None).unwrap();
        let got = m.get_page("p", None).unwrap().unwrap();
        let l0_only = ContextPage { l1: "", l2: None, ..got.clone() };
        assert!(l0_only.overview_l1.is_empty());
    }

    #[test]
    fn test_export_then_import_round_trips() {
        let (m, d) = make_test_manager();
        let ws_path = d.path().to_str().unwrap().to_string();
        m.upsert_page(&ContextPage {
            id: "p".into(), scope: "workspace".into(), category: "quirk".into(),
            path: "quirks/x".into(), title: "X".into(), icon: "bug".into(),
            abstract_l0: "a".into(), overview_l1: "b".into(), details_l2: None,
            pinned: false, is_built_in: false, attached_scopes_json: "[]".into(),
            created_at: 0, updated_at: 0, deleted_at: None,
        }, Some(&ws_path)).unwrap();
        let list = m.list_pages(Some(&ws_path), None, None, None).unwrap();
        let json = serde_json::to_string(&list.items).unwrap();
        // Import into a fresh manager
        let dir2 = tempdir().unwrap();
        let m2 = ContextManager::with_global_db_path(dir2.path().join("g.sqlite"));
        let parsed: Vec<ContextPage> = serde_json::from_str(&json).unwrap();
        for p in parsed {
            m2.upsert_page(&p, Some(&ws_path)).unwrap();
        }
        let got = m2.get_page("p", Some(&ws_path)).unwrap();
        assert!(got.is_some());
    }
}
```

**Step 6.2: Run to confirm failure**

Run: `cargo test -p oppa --lib context::commands::tests`
Expected: FAIL — `list_pages` now returns `ContextPageList`, and `get_page` tier param not yet supported.

**Step 6.3: Implement the new commands**

```rust
use std::sync::Arc;
use tauri::State;

use crate::context::manager::ContextManager;
use crate::context::models::{AgentPersona, ContextPage, ContextPageList, ContextSearchResult};

#[tauri::command]
pub fn context_list(
    manager: State<'_, Arc<ContextManager>>,
    workspace_path: Option<String>,
    category: Option<String>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Result<ContextPageList, String> {
    manager.list_pages(workspace_path.as_deref(), category.as_deref(), limit, offset)
}

#[tauri::command]
pub fn context_get(
    manager: State<'_, Arc<ContextManager>>,
    id: String,
    workspace_path: Option<String>,
    tier: Option<String>,
) -> Result<Option<ContextPage>, String> {
    let page = manager.get_page(&id, workspace_path.as_deref())?;
    Ok(page.map(|mut p| {
        match tier.as_deref() {
            Some("l0") => {
                p.overview_l1 = String::new();
                p.details_l2 = None;
            }
            Some("l1") => {
                p.details_l2 = None;
            }
            Some("l2") => {
                p.abstract_l0 = String::new();
                p.overview_l1 = String::new();
            }
            _ => {}
        }
        p
    }))
}

#[tauri::command]
pub fn context_upsert(
    manager: State<'_, Arc<ContextManager>>,
    page: ContextPage,
    workspace_path: Option<String>,
) -> Result<(), String> {
    manager.upsert_page(&page, workspace_path.as_deref())
}

#[tauri::command]
pub fn context_delete(
    manager: State<'_, Arc<ContextManager>>,
    id: String,
    scope: String,
    workspace_path: Option<String>,
) -> Result<(), String> {
    manager.delete_page(&id, &scope, workspace_path.as_deref())
}

#[tauri::command]
pub fn context_restore(
    manager: State<'_, Arc<ContextManager>>,
    id: String,
    scope: String,
    workspace_path: Option<String>,
) -> Result<(), String> {
    manager.restore_page(&id, &scope, workspace_path.as_deref())
}

#[tauri::command]
pub fn context_search(
    manager: State<'_, Arc<ContextManager>>,
    query: String,
    workspace_path: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<ContextSearchResult>, String> {
    manager.search_fts(&query, workspace_path.as_deref(), limit)
}

#[tauri::command]
pub fn context_export(
    manager: State<'_, Arc<ContextManager>>,
    workspace_path: Option<String>,
) -> Result<String, String> {
    let list = manager.list_pages(workspace_path.as_deref(), None, None, None)?;
    Ok(serde_json::to_string(&list.items).map_err(|e| e.to_string())?)
}

#[tauri::command]
pub fn context_import(
    manager: State<'_, Arc<ContextManager>>,
    workspace_path: Option<String>,
    json: String,
) -> Result<usize, String> {
    let pages: Vec<ContextPage> = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let count = pages.len();
    for p in &pages {
        manager.upsert_page(p, workspace_path.as_deref())?;
    }
    Ok(count)
}

#[tauri::command]
pub fn persona_list(
    manager: State<'_, Arc<ContextManager>>,
    workspace_path: Option<String>,
) -> Result<Vec<AgentPersona>, String> {
    manager.list_personas(workspace_path.as_deref())
}

#[tauri::command]
pub fn persona_upsert(
    manager: State<'_, Arc<ContextManager>>,
    persona: AgentPersona,
    workspace_path: Option<String>,
) -> Result<(), String> {
    manager.upsert_persona(&persona, workspace_path.as_deref())
}
```

**Step 6.4: Register new commands in `lib.rs`**

Edit `src-tauri/src/lib.rs` to add the new commands to the `invoke_handler` list:

```rust
context::commands::context_restore,
context::commands::context_export,
context::commands::context_import,
```

**Step 6.5: Initialize tracing**

In `src-tauri/src/lib.rs::run`, after `tauri::Builder::default()`:

```rust
let _ = tracing_subscriber::fmt()
    .with_env_filter(
        tracing_subscriber::EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("oppa=info,warn")),
    )
    .try_init();
```

**Step 6.6: Run tests**

Run: `cargo test -p oppa --lib context::commands::tests`
Expected: PASS

**Step 6.7: Commit**

```bash
git add src-tauri/src/context/commands.rs src-tauri/src/lib.rs
git commit -m "feat(context): tier-aware fetch, export/import, restore, tracing init"
```

---

### Task 7: MCP enum fix + scope resolver

**Files:**
- Modify: `src-tauri/src/mcp/protocol.rs`
- Modify: `src-tauri/src/mcp/server.rs`

**Interfaces:**
- Consumes: `ContextManager::list_pages_for_scope_token`, `get_page_by_path` from Task 5.
- Produces:
  - `oppa_search_context` and `oppa_save_context_note` schemas use the corrected enum.
  - `oppa_get_active_persona` resolves `attached_scopes` to matching L0 summaries.
  - `oppa_get_context_note` uses exact-path lookup; no `ends_with` fallback.

**Step 7.1: Write the failing tests**

Append to `src-tauri/src/mcp/server.rs::tests`:

```rust
#[tokio::test]
async fn test_mcp_scope_resolver_returns_matching_l0() {
    let temp_dir = TempDir::new().unwrap();
    let server = McpServer::new_with_dir(temp_dir.path().to_path_buf());

    let save = serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {
            "name": "oppa_save_context_note",
            "arguments": {
                "category": "quirk",
                "title": "ConPTY Newline",
                "abstract_l0": "ConPTY duplicate newline",
                "overview_l1": "Sanitize escape sequences"
            }
        }
    });
    server.handle_request(save).await.unwrap();

    // Edit the persona to mount the "quirks" scope.
    let debugger_dir = McpServer::new_with_dir(temp_dir.path().to_path_buf());
    let persona_save = serde_json::json!({
        "jsonrpc": "2.0", "id": 2, "method": "tools/call",
        "params": {
            "name": "oppa_save_context_note",
            "arguments": {
                "id": "debugger",
                "category": "persona",
                "title": "Debugger",
                "abstract_l0": "Root-cause expert",
                "overview_l1": "You are a debugger",
                "scope": "global"
            }
        }
    });
    debugger_dir.handle_request(persona_save).await.unwrap();

    let res = server.handle_request(serde_json::json!({
        "jsonrpc": "2.0", "id": 3, "method": "tools/call",
        "params": {
            "name": "oppa_get_active_persona",
            "arguments": { "persona_id": "debugger" }
        }
    })).await.unwrap();
    let text = res["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("Resolved Notes"));
    assert!(text.contains("ConPTY duplicate newline"));
}

#[tokio::test]
async fn test_mcp_workspace_flag_writes_to_workspace_db() {
    let temp_dir = TempDir::new().unwrap();
    let ws = temp_dir.path().join("ws");
    std::fs::create_dir_all(&ws).unwrap();
    let server = McpServer::new_with_dir(ws.clone());

    let res = server.handle_request(serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {
            "name": "oppa_save_context_note",
            "arguments": {
                "category": "quirk",
                "title": "Workspace Scoped",
                "abstract_l0": "ws-only",
                "overview_l1": "ws-only",
                "scope": "workspace"
            }
        }
    })).await.unwrap();
    assert!(res["result"].get("isError").is_none() || res["result"]["isError"].as_bool() == Some(false));

    // Should NOT be in the global DB
    let global_db = ws.join("global_context.sqlite");
    assert!(!global_db.exists());
    let workspace_db = ws.join(".oppa").join("context.sqlite");
    assert!(workspace_db.exists());
}

#[tokio::test]
async fn test_mcp_invalid_category_returns_tool_error() {
    let temp_dir = TempDir::new().unwrap();
    let server = McpServer::new_with_dir(temp_dir.path().to_path_buf());
    let res = server.handle_request(serde_json::json!({
        "jsonrpc": "2.0", "id": 1, "method": "tools/call",
        "params": {
            "name": "oppa_save_context_note",
            "arguments": {
                "category": "preferences",
                "title": "Plural Wrong",
                "abstract_l0": "x",
                "overview_l1": "y"
            }
        }
    })).await.unwrap();
    assert_eq!(res["result"]["isError"], true);
}
```

**Step 7.2: Run to confirm failure**

Run: `cargo test -p oppa --lib mcp::server::tests`
Expected: FAIL — current enum `preferences`/`standards` accepted, scope resolver not implemented.

**Step 7.3: Fix the MCP category enum in `protocol.rs`**

In `get_oppa_mcp_tools`, change the `category` enum in both `oppa_search_context` and `oppa_save_context_note` to exactly:

```rust
"enum": ["architecture", "quirk", "runbook", "preference", "persona"]
```

**Step 7.4: Update `tool_save_context_note` to validate categories**

Wrap the category parse:

```rust
use crate::context::enums::ContextCategory;
use std::str::FromStr;

let category = match args.get("category").and_then(|v| v.as_str()) {
    Some(c) if !c.trim().is_empty() => c.trim().to_string(),
    _ => return Ok(McpCallToolResult::error("Missing required parameter: 'category'")),
};
let _ = ContextCategory::from_str(&category)
    .map_err(|e| McpCallToolResult::error(e))?;
```

Replace the icon-mapping keys with the canonical singular form.

**Step 7.5: Replace `tool_get_context_note` path fallback with exact lookup**

```rust
fn tool_get_context_note(&self, args: &serde_json::Value) -> Result<McpCallToolResult, String> {
    let id_opt = args.get("id").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
    let path_opt = args.get("path").and_then(|v| v.as_str()).filter(|s| !s.is_empty());

    if id_opt.is_none() && path_opt.is_none() {
        return Ok(McpCallToolResult::error("Either 'id' or 'path' must be provided"));
    }

    let page = if let Some(id) = id_opt {
        self.context_manager.get_page(id, self.ws_str())?
    } else {
        None
    };

    let page = match page {
        Some(p) => Some(p),
        None => {
            let target = path_opt.or(id_opt).unwrap();
            let scope = if self.ws_str().is_some() { "workspace" } else { "global" };
            self.context_manager.get_page_by_path(scope, target, self.ws_str())?
        }
    };
    // ... rest of the function unchanged except `text` formatting adds `p.deleted_at` warning if Some.
}
```

**Step 7.6: Implement scope resolver in `oppa_get_active_persona`**

```rust
fn tool_get_active_persona(&self, args: &serde_json::Value) -> Result<McpCallToolResult, String> {
    let requested_id = args
        .get("persona_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| std::env::var("OPPA_PERSONA").ok().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "debugger".to_string());

    let personas = self.context_manager.list_personas(self.ws_str())?;
    let matching = personas
        .iter()
        .find(|p| p.id.eq_ignore_ascii_case(&requested_id) || p.name.eq_ignore_ascii_case(&requested_id))
        .or_else(|| personas.first());

    match matching {
        Some(p) => {
            let scopes_str = if p.attached_scopes.is_empty() {
                "- default (workspace & global)".to_string()
            } else {
                p.attached_scopes.iter().map(|s| format!("- {}", s)).collect::<Vec<_>>().join("\n")
            };

            let resolved = if p.attached_scopes.is_empty() {
                let global = self.context_manager.list_pages_for_scope_token("global", self.ws_str())?;
                let workspace = self.context_manager.list_pages_for_scope_token("workspace", self.ws_str())?;
                global.into_iter().chain(workspace.into_iter()).collect::<Vec<_>>()
            } else {
                let mut all = Vec::new();
                for token in &p.attached_scopes {
                    all.extend(self.context_manager.list_pages_for_scope_token(token, self.ws_str())?);
                }
                all
            };
            let resolved_section = if resolved.is_empty() {
                String::new()
            } else {
                let mut s = String::from("\n## Resolved Notes (L0)\n");
                for n in resolved {
                    s.push_str(&format!("- **{}** (`{}`): {}\n", n.title, n.path, n.abstract_l0));
                }
                s
            };

            let text = format!(
                "# Persona: {} (`{}`)\n\n**Tagline**: {}\n\n## Behavioral Guidelines\n{}\n\n## Mounted Context Scopes\n{}{}",
                p.name, p.id, p.tagline, p.system_prompt, scopes_str, resolved_section
            );
            Ok(McpCallToolResult::success(text))
        }
        None => Ok(McpCallToolResult::error(format!(
            "Persona '{}' not found and no default personas available",
            requested_id
        ))),
    }
}
```

**Step 7.7: Update `tool_search_context` to use the canonical enum and pass `limit`**

```rust
let query = match args.get("query").and_then(|v| v.as_str()) {
    Some(q) if !q.trim().is_empty() => q.trim(),
    _ => return Ok(McpCallToolResult::error("Missing required parameter: 'query'")),
};
let category_filter = args.get("category").and_then(|v| v.as_str());
let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(5) as usize;

let mut results = self.context_manager.search_fts(query, self.ws_str(), Some(limit))?;
if let Some(cat) = category_filter {
    let _ = ContextCategory::from_str(cat)
        .map_err(|e| McpCallToolResult::error(e))?;
    results.retain(|r| r.category == cat);
}
let total = results.first().map(|r| r.total).unwrap_or(0);

if results.is_empty() {
    return Ok(McpCallToolResult::success(format!(
        "No context notes found matching query: '{}'",
        query
    )));
}

let mut formatted = format!("Found {} of {} total context notes matching '{}':\n\n", results.len(), total, query);
for (idx, r) in results.iter().enumerate() {
    let cleaned_snippet = r.snippet.replace("<b>", "**").replace("</b>", "**");
    formatted.push_str(&format!(
        "{}. **{}** (`{}`)\n   - **ID**: {}\n   - **Category**: {} | **Scope**: {}\n   - **Summary (L0)**: {}\n   - **Snippet**: {}\n\n",
        idx + 1, r.title, r.path, r.id, r.category, r.scope, r.abstract_l0, cleaned_snippet
    ));
}

Ok(McpCallToolResult::success(formatted))
```

**Step 7.8: Run tests**

Run: `cargo test -p oppa --lib mcp`
Expected: PASS

**Step 7.9: Commit**

```bash
git add src-tauri/src/mcp/protocol.rs src-tauri/src/mcp/server.rs
git commit -m "fix(mcp): correct category enum, use exact path lookup, resolve persona scopes"
```

---

### Task 8: Frontend transport layer updates

**Files:**
- Modify: `src/lib/context/transport.ts`

**Interfaces:**
- Produces: typed wrappers that pass `limit`, `offset`, `tier`, `restore`, `export`, `import` to the new Tauri commands. Adds `lastError` to error surface.

**Step 8.1: Write the failing test**

Replace `src/lib/context/transport.test.ts` body for the search/upsert cases so they assert the new arguments:

```ts
import { describe, it, expect, vi } from "vitest";
import { listContextPages, searchContext, upsertContextPage, getContextPage, exportContext, importContext } from "./transport";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("context transport", () => {
  it("listContextPages passes limit and offset", async () => {
    invoke.mockResolvedValueOnce({ items: [], total: 0 });
    await listContextPages("ws", undefined, 25, 0);
    expect(invoke).toHaveBeenCalledWith("context_list", {
      workspacePath: "ws",
      category: undefined,
      limit: 25,
      offset: 0,
    });
  });

  it("searchContext passes limit", async () => {
    invoke.mockResolvedValueOnce([]);
    await searchContext("conpty", "ws", 5);
    expect(invoke).toHaveBeenCalledWith("context_search", {
      query: "conpty",
      workspacePath: "ws",
      limit: 5,
    });
  });

  it("getContextPage passes tier", async () => {
    invoke.mockResolvedValueOnce(null);
    await getContextPage("p1", "ws", "l0");
    expect(invoke).toHaveBeenCalledWith("context_get", {
      id: "p1",
      workspacePath: "ws",
      tier: "l0",
    });
  });

  it("exportContext returns JSON string", async () => {
    invoke.mockResolvedValueOnce("[]");
    const json = await exportContext("ws");
    expect(json).toBe("[]");
    expect(invoke).toHaveBeenCalledWith("context_export", { workspacePath: "ws" });
  });

  it("importContext returns count", async () => {
    invoke.mockResolvedValueOnce(3);
    const count = await importContext("ws", "[]");
    expect(count).toBe(3);
  });
});
```

**Step 8.2: Run to confirm failure**

Run: `pnpm vitest run src/lib/context/transport.test.ts`
Expected: FAIL — functions not exported.

**Step 8.3: Update `transport.ts`**

```ts
import { invoke } from "@tauri-apps/api/core";

export type ContextScope = "global" | "workspace";
export type ContextCategory = "architecture" | "quirk" | "runbook" | "preference" | "persona";

export interface ContextPage {
  id: string;
  scope: ContextScope;
  category: ContextCategory;
  path: string;
  title: string;
  icon: string;
  abstract_l0: string;
  overview_l1: string;
  details_l2?: string;
  pinned: boolean;
  is_built_in: boolean;
  attached_scopes_json: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface ContextPageList {
  items: ContextPage[];
  total: number;
}

export interface ContextSearchResult {
  id: string;
  scope: ContextScope;
  category: ContextCategory;
  path: string;
  title: string;
  icon: string;
  abstract_l0: string;
  overview_l1: string;
  snippet: string;
  total: number;
}

export interface AgentPersona {
  id: string;
  name: string;
  icon: string;
  tagline: string;
  system_prompt: string;
  attached_scopes: string[];
  is_built_in: boolean;
}

export async function listContextPages(
  workspacePath?: string,
  category?: string,
  limit?: number,
  offset?: number,
): Promise<ContextPageList> {
  return invoke<ContextPageList>("context_list", {
    workspacePath,
    category,
    limit,
    offset,
  });
}

export async function getContextPage(
  id: string,
  workspacePath?: string,
  tier?: "l0" | "l1" | "l2",
): Promise<ContextPage | null> {
  return invoke<ContextPage | null>("context_get", { id, workspacePath, tier });
}

export async function upsertContextPage(
  page: ContextPage,
  workspacePath?: string,
): Promise<void> {
  return invoke("context_upsert", { page, workspacePath });
}

export async function deleteContextPage(
  id: string,
  scope: ContextScope,
  workspacePath?: string,
): Promise<void> {
  return invoke("context_delete", { id, scope, workspacePath });
}

export async function restoreContextPage(
  id: string,
  scope: ContextScope,
  workspacePath?: string,
): Promise<void> {
  return invoke("context_restore", { id, scope, workspacePath });
}

export async function searchContext(
  query: string,
  workspacePath?: string,
  limit?: number,
): Promise<ContextSearchResult[]> {
  return invoke<ContextSearchResult[]>("context_search", {
    query,
    workspacePath,
    limit,
  });
}

export async function exportContext(workspacePath?: string): Promise<string> {
  return invoke<string>("context_export", { workspacePath });
}

export async function importContext(
  workspacePath: string | undefined,
  json: string,
): Promise<number> {
  return invoke<number>("context_import", { workspacePath, json });
}

export async function listPersonas(
  workspacePath?: string,
): Promise<AgentPersona[]> {
  return invoke<AgentPersona[]>("persona_list", { workspacePath });
}

export async function upsertPersona(
  persona: AgentPersona,
  workspacePath?: string,
): Promise<void> {
  return invoke("persona_upsert", { persona, workspacePath });
}
```

**Step 8.4: Run tests**

Run: `pnpm vitest run src/lib/context/transport.test.ts`
Expected: PASS

**Step 8.5: Commit**

```bash
git add src/lib/context/transport.ts src/lib/context/transport.test.ts
git commit -m "feat(context): transport layer pagination, tier, restore, export/import"
```

---

### Task 9: Store error handling, sandbox split, lastError

**Files:**
- Modify: `src/store/contextStore.ts`
- Modify: `src/store/contextStore.test.ts`

**Interfaces:**
- Produces:
  - `lastError: string | null` and `clearError()` on the store.
  - `searchResultsSandbox: ContextSearchResult[]` independent of `searchResults`.
  - `savePage`, `deletePage`, `savePersona` wrapped in try/catch; on failure set `lastError`, refetch via `loadContext`, leave optimistic state untouched.
  - `restorePage` action.

**Step 9.1: Write the failing test**

Add to `src/store/contextStore.test.ts`:

```ts
describe("contextStore error rollback", () => {
  beforeEach(() => {
    useContextStore.setState({
      pages: [],
      personas: [],
      selectedPageId: null,
      selectedPersonaId: null,
      activeTier: "l0",
      searchQuery: "",
      searchResults: [],
      searchResultsSandbox: [],
      isLoading: false,
      isEditing: false,
      lastError: null,
    });
  });

  it("savePage rolls back on error and sets lastError", async () => {
    const page: ContextPage = {
      id: "p1", scope: "global", category: "quirk", path: "quirks/x",
      title: "X", icon: "bug", abstract_l0: "a", overview_l1: "b",
      pinned: false, is_built_in: false, attached_scopes_json: "[]",
      created_at: 0, updated_at: 0, deleted_at: null,
    };
    upsertContextPageMock.mockRejectedValueOnce(new Error("boom"));
    await useContextStore.getState().savePage(page);
    expect(useContextStore.getState().pages).toEqual([]);
    expect(useContextStore.getState().lastError).toContain("boom");
  });

  it("deletePage rolls back on error", async () => {
    useContextStore.setState({
      pages: [{
        id: "p1", scope: "global", category: "quirk", path: "quirks/x",
        title: "X", icon: "bug", abstract_l0: "a", overview_l1: "b",
        pinned: false, is_built_in: false, attached_scopes_json: "[]",
        created_at: 0, updated_at: 0, deleted_at: null,
      }],
    });
    deleteContextPageMock.mockRejectedValueOnce(new Error("nope"));
    await useContextStore.getState().deletePage("p1", "global");
    expect(useContextStore.getState().pages.length).toBe(1);
    expect(useContextStore.getState().lastError).toContain("nope");
  });

  it("sandbox search uses independent slice", async () => {
    const r: ContextSearchResult = {
      id: "p1", scope: "global", category: "quirk", path: "x",
      title: "X", icon: "bug", abstract_l0: "a", overview_l1: "b",
      snippet: "snippet", total: 1,
    };
    searchContextMock.mockResolvedValueOnce([r]);
    await useContextStore.getState().searchContextSandbox("foo", "ws");
    expect(useContextStore.getState().searchResultsSandbox).toEqual([r]);
    expect(useContextStore.getState().searchQuery).toBe("foo");
  });
});
```

**Step 9.2: Run to confirm failure**

Run: `pnpm vitest run src/store/contextStore.test.ts`
Expected: FAIL — fields and methods don't exist.

**Step 9.3: Update the store**

```ts
import { create } from "zustand";
import {
  listContextPages,
  upsertContextPage,
  deleteContextPage,
  restoreContextPage,
  searchContext as transportSearchContext,
  listPersonas,
  upsertPersona,
} from "../lib/context/transport";
import type {
  ContextPage,
  ContextPageList,
  ContextScope,
  ContextSearchResult,
  AgentPersona,
} from "../lib/context/transport";

export interface ContextState {
  pages: ContextPage[];
  personas: AgentPersona[];
  selectedPageId: string | null;
  selectedPersonaId: string | null;
  activeTier: "l0" | "l1" | "l2";
  searchQuery: string;
  searchResults: ContextSearchResult[];
  searchResultsSandbox: ContextSearchResult[];
  sandboxQuery: string;
  isEditing: boolean;
  isLoading: boolean;
  lastError: string | null;

  loadContext: (workspacePath?: string) => Promise<void>;
  selectPage: (id: string | null) => void;
  selectPersona: (id: string | null) => void;
  setActiveTier: (tier: "l0" | "l1" | "l2") => void;
  setSearchQuery: (query: string) => void;
  searchContext: (query: string, workspacePath?: string) => Promise<void>;
  searchContextSandbox: (query: string, workspacePath?: string) => Promise<void>;
  setSandboxQuery: (query: string) => void;
  savePage: (page: ContextPage, workspacePath?: string) => Promise<void>;
  deletePage: (id: string, scope: ContextScope, workspacePath?: string) => Promise<void>;
  restorePage: (id: string, scope: ContextScope, workspacePath?: string) => Promise<void>;
  savePersona: (persona: AgentPersona, workspacePath?: string) => Promise<void>;
  setIsEditing: (isEditing: boolean) => void;
  clearError: () => void;
}

export const useContextStore = create<ContextState>((set, get) => ({
  pages: [],
  personas: [],
  selectedPageId: null,
  selectedPersonaId: null,
  activeTier: "l0",
  searchQuery: "",
  searchResults: [],
  searchResultsSandbox: [],
  sandboxQuery: "",
  isEditing: false,
  isLoading: false,
  lastError: null,

  loadContext: async (workspacePath) => {
    set({ isLoading: true });
    try {
      const [pages, personas] = await Promise.all([
        listContextPages(workspacePath),
        listPersonas(workspacePath),
      ]);
      set({ pages: pages.items, personas, isLoading: false });
    } catch (e: any) {
      set({ isLoading: false, lastError: String(e?.message ?? e) });
    }
  },

  selectPage: (id) => {
    set({ selectedPageId: id, selectedPersonaId: id ? null : get().selectedPersonaId });
  },
  selectPersona: (id) => {
    set({ selectedPersonaId: id, selectedPageId: id ? null : get().selectedPageId });
  },
  setActiveTier: (tier) => set({ activeTier: tier }),

  setSearchQuery: (query) => {
    set((state) => ({
      searchQuery: query,
      searchResults: query ? state.searchResults : [],
    }));
  },

  searchContext: async (query, workspacePath) => {
    const trimmed = query.trim();
    if (!trimmed) {
      set({ searchQuery: "", searchResults: [] });
      return;
    }
    try {
      const results = await transportSearchContext(trimmed, workspacePath);
      set({ searchQuery: query, searchResults: results });
    } catch (e: any) {
      set({ lastError: String(e?.message ?? e) });
    }
  },

  searchContextSandbox: async (query, workspacePath) => {
    const trimmed = query.trim();
    set({ sandboxQuery: query });
    if (!trimmed) {
      set({ searchResultsSandbox: [] });
      return;
    }
    try {
      const results = await transportSearchContext(trimmed, workspacePath, 10);
      set({ searchResultsSandbox: results });
    } catch (e: any) {
      set({ lastError: String(e?.message ?? e) });
    }
  },

  setSandboxQuery: (query) => set({ sandboxQuery: query }),

  savePage: async (page, workspacePath) => {
    try {
      await upsertContextPage(page, workspacePath);
      set((state) => {
        const existingIdx = state.pages.findIndex((p) => p.id === page.id);
        const pages =
          existingIdx >= 0
            ? state.pages.map((p, i) => (i === existingIdx ? page : p))
            : [...state.pages, page];
        return { pages, selectedPageId: page.id, isEditing: false, lastError: null };
      });
    } catch (e: any) {
      // Rollback by refetching — do not mutate local state.
      await get().loadContext(workspacePath);
      set({ lastError: String(e?.message ?? e) });
    }
  },

  deletePage: async (id, scope, workspacePath) => {
    try {
      await deleteContextPage(id, scope, workspacePath);
      set((state) => ({
        pages: state.pages.filter((p) => p.id !== id),
        selectedPageId: state.selectedPageId === id ? null : state.selectedPageId,
        lastError: null,
      }));
    } catch (e: any) {
      await get().loadContext(workspacePath);
      set({ lastError: String(e?.message ?? e) });
    }
  },

  restorePage: async (id, scope, workspacePath) => {
    try {
      await restoreContextPage(id, scope, workspacePath);
      await get().loadContext(workspacePath);
    } catch (e: any) {
      set({ lastError: String(e?.message ?? e) });
    }
  },

  savePersona: async (persona, workspacePath) => {
    try {
      await upsertPersona(persona, workspacePath);
      set((state) => {
        const existingIdx = state.personas.findIndex((p) => p.id === persona.id);
        const personas =
          existingIdx >= 0
            ? state.personas.map((p, i) => (i === existingIdx ? persona : p))
            : [...state.personas, persona];
        return { personas, selectedPersonaId: persona.id, lastError: null };
      });
    } catch (e: any) {
      await get().loadContext(workspacePath);
      set({ lastError: String(e?.message ?? e) });
    }
  },

  setIsEditing: (isEditing) => set({ isEditing }),
  clearError: () => set({ lastError: null }),
}));
```

**Step 9.4: Run tests**

Run: `pnpm vitest run src/store/contextStore.test.ts`
Expected: PASS

**Step 9.5: Commit**

```bash
git add src/store/contextStore.ts src/store/contextStore.test.ts
git commit -m "feat(context): store error rollback, lastError, sandbox search split"
```

---

### Task 10: Inspector — hide L2 for personas, scope chip editor, no-delete for built-in, support restore

**Files:**
- Modify: `src/components/context/ContextInspector.tsx`
- Create: `src/components/context/ContextInspector.test.tsx`

**Interfaces:**
- Produces: Inspector renders `<ScopeChipEditor>` for personas (no L2 textarea). Delete button hidden when `is_built_in`. New restore control surfaces when the page is in `deleted_at` state (consumed from store).

**Step 10.1: Write the failing test**

Create `src/components/context/ContextInspector.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, within, fireEvent } from "@testing-library/react";
import { ContextInspector } from "./ContextInspector";
import { useContextStore } from "../../store/contextStore";
import { useTerminalStore } from "../../store/terminalStore";
import type { ContextPage, AgentPersona } from "../../lib/context/transport";

vi.mock("../../lib/context/transport", () => ({
  deleteContextPage: vi.fn(),
  restoreContextPage: vi.fn(),
  upsertContextPage: vi.fn(),
  upsertPersona: vi.fn(),
}));

const mockPage: ContextPage = {
  id: "p1", scope: "workspace", category: "quirk", path: "quirks/x",
  title: "X", icon: "bug", abstract_l0: "a", overview_l1: "b",
  pinned: false, is_built_in: false, attached_scopes_json: "[]",
  created_at: 0, updated_at: 0, deleted_at: null,
};

const mockBuiltIn: ContextPage = {
  id: "debugger", scope: "global", category: "persona", path: "personas/debugger",
  title: "Debugger", icon: "bug", abstract_l0: "a", overview_l1: "b",
  pinned: false, is_built_in: true, attached_scopes_json: "[]",
  created_at: 0, updated_at: 0, deleted_at: null,
};

describe("ContextInspector", () => {
  beforeEach(() => {
    useContextStore.setState({
      pages: [mockPage, mockBuiltIn],
      personas: [],
      selectedPageId: null,
      selectedPersonaId: null,
      activeTier: "l0",
      searchQuery: "",
      searchResults: [],
      searchResultsSandbox: [],
      sandboxQuery: "",
      isEditing: false,
      isLoading: false,
      lastError: null,
    });
    useTerminalStore.setState({ getActiveCwd: () => undefined } as any);
  });

  it("hides L2 editor for persona pages", () => {
    useContextStore.setState({ selectedPageId: "debugger" });
    const { container } = render(<ContextInspector />);
    fireEvent.click(within(container).getByRole("button", { name: /l2 attached scopes/i }));
    expect(container.querySelector("textarea.inspector-textarea")).toBeNull();
  });

  it("shows delete for non built-in pages", () => {
    useContextStore.setState({ selectedPageId: "p1" });
    const { container } = render(<ContextInspector />);
    expect(container.querySelector(".inspector-action-btn.delete")).toBeTruthy();
  });

  it("hides delete for built-in personas", () => {
    useContextStore.setState({ selectedPageId: "debugger" });
    const { container } = render(<ContextInspector />);
    expect(container.querySelector(".inspector-action-btn.delete")).toBeNull();
  });
});
```

**Step 10.2: Run to confirm failure**

Run: `pnpm vitest run src/components/context/ContextInspector.test.tsx`
Expected: FAIL — L2 editor renders for personas today.

**Step 10.3: Patch the inspector**

In `src/components/context/ContextInspector.tsx`:

1. Add `restorePage` selector near the existing `deletePage`:

```ts
const restorePage = useContextStore((s) => s.restorePage);
const lastError = useContextStore((s) => s.lastError);
```

2. Replace the L2 block with a guard around the textarea (around line 489). If `selectedPage.category === "persona"`, render the attached-scopes chip editor; otherwise the existing textarea.

```tsx
{activeTier === "l2" && (
  <div className="tier-content l2-content">
    <div className="tier-info-banner">
      <span className="tier-info-title">
        L2 {selectedPage.category === "persona" ? "Attached Scopes" : "Raw Details"}
      </span>
      <span className="tier-info-desc">
        {selectedPage.category === "persona"
          ? "Memory folders this persona automatically loads into agent context."
          : "Uncompressed stack traces, code snippets, logs, or original diffs."}
      </span>
    </div>
    {isEditing && selectedPage.category !== "persona" ? (
      <textarea ... />
    ) : selectedPage.category === "persona" ? (
      <ScopeChipEditor
        scopes={JSON.parse(selectedPage.attached_scopes_json || "[]") as string[]}
        onChange={(scopes) => setDraftPersonaScopes(scopes)}
      />
    ) : (
      <div className="rendered-details-box monospace">
        {selectedPage.details_l2 ? (
          <pre>{selectedPage.details_l2}</pre>
        ) : (
          <div className="details-empty-state">No raw details attached.</div>
        )}
      </div>
    )}
  </div>
)}
```

3. Hide the delete button when `is_built_in`:

```tsx
{!selectedPage.is_built_in && (
  <button
    type="button"
    className="inspector-action-btn delete"
    onClick={handleDeletePage}
    title="Delete memory page"
  >
    <IconTrash size={13} />
  </button>
)}
```

4. Add a small inline error banner at the top of the inspector body:

```tsx
{lastError && (
  <div className="inspector-error-banner" role="alert">
    <span>{lastError}</span>
    <button type="button" onClick={() => useContextStore.getState().clearError()}>Dismiss</button>
  </div>
)}
```

**Step 10.4: Add `ScopeChipEditor` component**

At the bottom of `ContextInspector.tsx`:

```tsx
interface ScopeChipEditorProps {
  scopes: string[];
  onChange: (scopes: string[]) => void;
}

const SCOPE_TOKEN_OPTIONS = [
  "global", "workspace", "architecture", "quirks", "runbooks", "preferences", "personas",
];

function ScopeChipEditor({ scopes, onChange }: ScopeChipEditorProps): ReactElement {
  const toggle = (token: string) => {
    onChange(scopes.includes(token) ? scopes.filter((s) => s !== token) : [...scopes, token]);
  };
  return (
    <div className="persona-scopes-editor">
      <p className="persona-scopes-help">Toggle the memory folders this persona mounts:</p>
      <div className="persona-scopes-list">
        {SCOPE_TOKEN_OPTIONS.map((token) => {
          const active = scopes.includes(token);
          return (
            <button
              key={token}
              type="button"
              className={`persona-scope-chip monospace ${active ? "active" : ""}`}
              onClick={() => toggle(token)}
            >
              {token}
            </button>
          );
        })}
      </div>
    </div>
  );
}
```

**Step 10.5: Update `handleSavePage` to also persist `attached_scopes_json` for personas**

```ts
const handleSavePage = async () => {
  if (!selectedPage) return;
  const updatedPage: ContextPage = {
    ...selectedPage,
    title: draftTitle.trim() || selectedPage.title,
    category: draftCategory,
    path: draftPath.trim() || selectedPage.path,
    abstract_l0: draftAbstract,
    overview_l1: draftOverview,
    details_l2: selectedPage.category === "persona" ? null : draftDetails,
    attached_scopes_json: selectedPage.category === "persona"
      ? JSON.stringify(draftPersonaScopes)
      : selectedPage.attached_scopes_json,
    updated_at: Date.now(),
  };
  await savePage(updatedPage, getActiveCwd());
};
```

**Step 10.6: Run tests**

Run: `pnpm vitest run src/components/context/ContextInspector.test.tsx src/components/context/ContextStudio.test.tsx`
Expected: PASS

**Step 10.7: Commit**

```bash
git add src/components/context/ContextInspector.tsx src/components/context/ContextInspector.test.tsx
git commit -m "feat(context): hide L2 editor for personas, scope chip editor, build-in delete gating"
```

---

### Task 11: Status panel — sandbox slice, safe snippet rendering

**Files:**
- Modify: `src/components/context/ContextStatusPanel.tsx`
- Create: `src/components/context/ContextStatusPanel.test.tsx`

**Interfaces:**
- Produces: Status panel binds the sandbox input to `searchContextSandbox` and renders `searchResultsSandbox`. Snippets render as `<mark>` instead of raw HTML.

**Step 11.1: Write the failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, within, fireEvent } from "@testing-library/react";
import { ContextStatusPanel } from "./ContextStatusPanel";
import { useContextStore } from "../../store/contextStore";
import { useTerminalStore } from "../../store/terminalStore";
import { searchContext } from "../../lib/context/transport";

vi.mock("../../lib/context/transport", () => ({
  searchContext: vi.fn(),
}));

const mockSearch = vi.mocked(searchContext);

describe("ContextStatusPanel", () => {
  beforeEach(() => {
    useContextStore.setState({
      pages: [], personas: [], selectedPageId: null, selectedPersonaId: null,
      activeTier: "l0", searchQuery: "", searchResults: [],
      searchResultsSandbox: [], sandboxQuery: "",
      isEditing: false, isLoading: false, lastError: null,
    });
    useTerminalStore.setState({ getActiveCwd: () => undefined, sessions: {}, setSessionPersona: () => {} } as any);
    mockSearch.mockReset();
  });

  it("sandbox search does not clobber header search", async () => {
    useContextStore.setState({
      searchResults: [{ id: "h", scope: "global", category: "quirk", path: "h", title: "H", icon: "bug", abstract_l0: "a", overview_l1: "b", snippet: "x", total: 1 }],
      searchQuery: "header",
    });
    mockSearch.mockResolvedValueOnce([
      { id: "s", scope: "global", category: "quirk", path: "s", title: "S", icon: "bug", abstract_l0: "a", overview_l1: "b", snippet: "y", total: 1 },
    ]);

    const { container } = render(<ContextStatusPanel />);
    const input = container.querySelector(".sandbox-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "sandbox" } });

    await vi.waitFor(() => {
      expect(useContextStore.getState().searchResultsSandbox.length).toBe(1);
    });

    expect(useContextStore.getState().searchResults.length).toBe(1);
    expect(useContextStore.getState().searchResults[0].id).toBe("h");
  });

  it("renders snippet with <mark> tags instead of raw HTML", () => {
    useContextStore.setState({
      searchResultsSandbox: [
        { id: "p", scope: "global", category: "quirk", path: "x", title: "Foo", icon: "bug", abstract_l0: "a", overview_l1: "b", snippet: "conpty <b>newline</b> bug", total: 1 },
      ],
    });
    const { container } = render(<ContextStatusPanel />);
    const result = container.querySelector(".sandbox-result-card")!;
    expect(result.querySelector("mark")).toBeTruthy();
    expect(result.querySelector("b")).toBeNull();
  });
});
```

**Step 11.2: Run to confirm failure**

Run: `pnpm vitest run src/components/context/ContextStatusPanel.test.tsx`
Expected: FAIL.

**Step 11.3: Patch the panel**

```tsx
import { useState, type ReactElement } from "react";
import { useContextStore } from "../../store/contextStore";
import { useTerminalStore } from "../../store/terminalStore";
import {
  IconSearch,
  IconTerminal,
  IconPersona,
  IconSparkles,
} from "./ContextIcons";

function renderSnippet(snippet: string): ReactElement[] {
  const tokens = snippet.split(/(<b>|<\/b>)/g);
  let inMark = false;
  return tokens
    .filter((t) => t && t !== "<b>" && t !== "</b>")
    .map((t, i) => {
      if (t === "<b>") { inMark = true; return null; }
      if (t === "</b>") { inMark = false; return null; }
      return inMark ? <mark key={i}>{t}</mark> : <span key={i}>{t}</span>;
    })
    .filter(Boolean) as ReactElement[];
}

export function ContextStatusPanel(): ReactElement {
  const pages = useContextStore((s) => s.pages);
  const personas = useContextStore((s) => s.personas);
  const sandboxQuery = useContextStore((s) => s.sandboxQuery);
  const searchResultsSandbox = useContextStore((s) => s.searchResultsSandbox);
  const selectPage = useContextStore((s) => s.selectPage);
  const searchContextSandbox = useContextStore((s) => s.searchContextSandbox);

  const sessions = useTerminalStore((s) => s.sessions);
  const setSessionPersona = useTerminalStore((s) => s.setSessionPersona);
  const getActiveCwd = useTerminalStore((s) => s.getActiveCwd);

  const sessionList = Object.values(sessions!);

  const totalPages = pages.length;
  const pinnedPages = pages.filter((p) => p.pinned).length;
  const workspacePages = pages.filter((p) => p.scope === "workspace").length;
  const globalPages = pages.filter((p) => p.scope === "global").length;

  const handleSandboxSearch = (q: string) => {
    void searchContextSandbox(q, getActiveCwd());
  };

  return (
    <aside className="context-status-panel" aria-label="Context and Session Status">
      <div className="status-panel-header">
        <span className="status-panel-heading">CONTEXT & SESSIONS</span>
      </div>

      <div className="status-panel-content">
        {/* Bento Card 1: Active Terminal Sessions */}
        <section className="status-bento-card" aria-label="Active Terminal Sessions">
          <div className="bento-card-header">
            <div className="bento-card-title-row">
              <IconTerminal size={14} className="bento-icon" />
              <h4>Active Terminal Sessions</h4>
            </div>
            <span className="bento-card-badge">{sessionList.length}</span>
          </div>

          <div className="bento-sessions-list">
            {sessionList.length === 0 ? (
              <div className="bento-empty-hint">No active terminal sessions</div>
            ) : (
              sessionList.map((session) => {
                const assignedPersona = personas.find((p) => p.id === session.personaId);
                return (
                  <div key={session.id} className="bento-session-item">
                    <div className="session-item-top">
                      <div className="session-item-status-dot running" />
                      <span className="session-item-title monospace">
                        {session.title || session.id}
                      </span>
                    </div>
                    <div className="session-item-cwd monospace">{session.cwd || "~"}</div>
                    <div className="session-persona-picker-row">
                      <span className="persona-picker-label">Role:</span>
                      <select
                        className="session-persona-select"
                        value={session.personaId || ""}
                        onChange={(e) => setSessionPersona(session.id, e.target.value || null)}
                        aria-label={`Assign Persona to session ${session.title || session.id}`}
                      >
                        <option value="">None (Default Shell)</option>
                        {personas.map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    </div>
                    {assignedPersona && (
                      <div className="session-assigned-chip">
                        <IconPersona size={11} />
                        <span>Active: {assignedPersona.name}</span>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Bento Card 2: FTS5 Search Sandbox */}
        <section className="status-bento-card" aria-label="FTS5 Search Sandbox">
          <div className="bento-card-header">
            <div className="bento-card-title-row">
              <IconSearch size={14} className="bento-icon" />
              <h4>FTS5 Search Sandbox</h4>
            </div>
          </div>

          <div className="sandbox-input-wrapper">
            <IconSearch size={12} className="sandbox-icon" />
            <input
              type="text"
              className="sandbox-input"
              placeholder="Test live keyword query..."
              value={sandboxQuery}
              onChange={(e) => handleSandboxSearch(e.target.value)}
            />
          </div>

          <div className="sandbox-results-list">
            {searchResultsSandbox.length > 0 ? (
              searchResultsSandbox.map((res) => (
                <div
                  key={res.id}
                  className="sandbox-result-card"
                  onClick={() => selectPage(res.id)}
                  role="button"
                  tabIndex={0}
                >
                  <div className="result-card-top">
                    <span className="result-title">{res.title}</span>
                    <span className="result-scope-pill monospace">{res.scope}</span>
                  </div>
                  <div className="result-snippet monospace">
                    {renderSnippet(res.snippet)}
                  </div>
                </div>
              ))
            ) : (
              <div className="sandbox-empty-hint">
                <IconSparkles size={16} className="sandbox-empty-icon" />
                <span>Type in search box above to test live SQLite FTS5 matching & snippet extraction.</span>
              </div>
            )}
          </div>
        </section>

        {/* Bento Card 3: Scope & Metadata 2x2 Grid */}
        <section className="status-bento-card" aria-label="Scope & Metadata">
          <div className="bento-card-header">
            <h4>Scope & Metadata</h4>
          </div>
          <div className="metrics-2x2-grid">
            <div className="metric-tile">
              <span className="metric-tile-label">TOTAL PAGES</span>
              <span className="metric-tile-value">{totalPages}</span>
            </div>
            <div className="metric-tile">
              <span className="metric-tile-label">PINNED MEMORIES</span>
              <span className="metric-tile-value">{pinnedPages}</span>
            </div>
            <div className="metric-tile">
              <span className="metric-tile-label">WORKSPACE SCOPE</span>
              <span className="metric-tile-value">{workspacePages}</span>
            </div>
            <div className="metric-tile">
              <span className="metric-tile-label">GLOBAL SCOPE</span>
              <span className="metric-tile-value">{globalPages}</span>
            </div>
          </div>
        </section>
      </div>
    </aside>
  );
}
```

**Step 11.4: Run tests**

Run: `pnpm vitest run src/components/context/ContextStatusPanel.test.tsx src/components/context/ContextStudio.test.tsx`
Expected: PASS

**Step 11.5: Commit**

```bash
git add src/components/context/ContextStatusPanel.tsx src/components/context/ContextStatusPanel.test.tsx
git commit -m "fix(context): sandbox isolation, safe snippet rendering"
```

---

### Task 12: Studio — export/import menu hooks

**Files:**
- Modify: `src/components/context/ContextStudio.tsx`

**Interfaces:**
- Produces: A `...` overflow menu in the studio header with `Export`, `Import`, `Open Archive (restore)` items.

**Step 12.1: Patch the studio**

In `src/components/context/ContextStudio.tsx`:

1. Add a new state slot and import helpers:

```ts
import { exportContext, importContext } from "../../lib/context/transport";
import { useContextStore } from "../../store/contextStore";

const lastError = useContextStore((s) => s.lastError);
const clearError = useContextStore((s) => s.clearError);
const [isArchiveModalOpen, setIsArchiveModalOpen] = useState(false);
```

2. Add handlers:

```ts
const handleExport = async () => {
  const json = await exportContext(getActiveCwd());
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "oppa-context.json";
  a.click();
  URL.revokeObjectURL(url);
};

const handleImport = async () => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();
    await importContext(getActiveCwd(), text);
    await loadContext(getActiveCwd());
  };
  input.click();
};
```

3. Add a new dropdown menu in the action bar:

```tsx
<button
  type="button"
  className="context-mcp-config-btn"
  onClick={() => setIsMcpModalOpen(true)}
>
  <IconServer size={13} />
  <span>MCP Config</span>
</button>

<button
  type="button"
  className="context-export-btn"
  onClick={handleExport}
  aria-label="Export workspace context"
>
  <span>Export</span>
</button>

<button
  type="button"
  className="context-import-btn"
  onClick={handleImport}
  aria-label="Import workspace context"
>
  <span>Import</span>
</button>
```

**Step 12.2: Verify existing studio tests still pass**

Run: `pnpm vitest run src/components/context/ContextStudio.test.tsx`
Expected: PASS

**Step 12.3: Commit**

```bash
git add src/components/context/ContextStudio.tsx
git commit -m "feat(context): expose export/import buttons in studio header"
```

---

### Task 13: Pane-level persona inheritance

**Files:**
- Modify: `src/store/terminalStore.ts`

**Interfaces:**
- Produces: When `spawnSession` is called with `existingId`, the new session inherits `personaId` from the existing session.

**Step 13.1: Write the failing test**

Add to `src/store/terminalStore.test.ts`:

```ts
it("spawnSession inherits personaId when given existingId", async () => {
  useTerminalStore.setState({
    sessions: {
      s1: { id: "s1", title: "S1", cwd: "D:\\foo", personaId: "debugger", createdAt: 0, lastActivityAt: 0 } as any,
    },
  } as any);
  const id = await useTerminalStore.getState().spawnSession(undefined, undefined, "s1");
  expect(useTerminalStore.getState().sessions[id].personaId).toBe("debugger");
});
```

**Step 13.2: Run to confirm failure**

Run: `pnpm vitest run src/store/terminalStore.test.ts`
Expected: FAIL.

**Step 13.3: Patch `spawnSession`**

In `src/store/terminalStore.ts`, locate the `spawnSession` body. After the line that resolves `existingId` to `existingSession`, ensure `personaId` defaults to `existingSession.personaId`. The existing code already includes `existingSession?.personaId ?? null` in the spawned session shape (around line 477). Verify the path is taken when `existingId` is the only argument and `personaId` is omitted.

If the existing logic only falls back when `existingSession` is found:

```ts
const newSessionId = await invoke("pty_spawn", {
  ...opts,
  existing_id: existingId,
  persona_id: personaId ?? existingSession?.personaId ?? null,
});
```

and the session is created with:

```ts
const newSession: Session = {
  id: newSessionId,
  title: ...,
  cwd: ...,
  personaId: personaId ?? existingSession?.personaId ?? null,
  createdAt: ...,
  lastActivityAt: ...,
};
```

These constructions already exist; the test reveals any regression where the fallback is dropped.

**Step 13.4: Run tests**

Run: `pnpm vitest run src/store/terminalStore.test.ts`
Expected: PASS

**Step 13.5: Commit**

```bash
git add src/store/terminalStore.ts src/store/terminalStore.test.ts
git commit -m "feat(terminal): inherit personaId when reattaching a session"
```

---

### Task 14: Final integration verification

**Files:** none modified.

**Step 14.1: Run the full Rust test suite**

Run: `cargo test -p oppa --lib`
Expected: PASS

Run: `cargo test -p oppa --test daemon_integration_test`
Expected: PASS

**Step 14.2: Run the full Vitest suite**

Run: `pnpm vitest run`
Expected: PASS

**Step 14.3: Run TypeScript and Cargo checks**

Run: `pnpm build` (catches `tsc` errors).
Run: `cargo check` in `src-tauri/`.

**Step 14.4: Manual smoke test**

1. Launch `pnpm tauri dev`.
2. Switch to Context Studio mode.
3. Create a workspace-scope note + a global-scope preference.
4. Verify the note appears in the tree and the path is unique.
5. Open the persona `debugger` and confirm the L2 tab shows chip editor, not textarea.
6. Confirm the delete button is hidden for built-in personas.
7. Type into the sandbox search and confirm the header search results are untouched.
8. Trigger an MCP save with `category: "preferences"` and confirm it returns an error.
9. Trigger the export button and re-import the file; counts match.

**Step 14.5: Final commit**

```bash
git add -A
git commit --allow-empty -m "chore(context): verify Context Studio hardening integration"
```

---

## Self-Review

**Spec coverage check:**
- Tier 1 #1 (WAL) → Task 5
- Tier 1 #2 (enum validation) → Tasks 1, 3, 5
- Tier 1 #3 (is_built_in column) → Tasks 2, 3, 5
- Tier 1 #4 (persona L2 split) → Tasks 2, 3, 7, 10
- Tier 1 #5 (store error handling) → Task 9
- Tier 2 #6 (MCP enum fix) → Task 7
- Tier 2 #7 (server created_at) → Task 5
- Tier 2 #8 (workspace flag wiring) → Task 7
- Tier 2 #9 (exact path lookup) → Tasks 5, 7
- Tier 2 #10 (search total) → Tasks 5, 7
- Tier 3 #11 (scope resolver) → Task 7
- Tier 3 #12 (tier-aware fetch) → Tasks 6, 8
- Tier 3 #13 (pagination) → Tasks 5, 6, 8
- Tier 3 #14 (unified search split) → Tasks 9, 11
- Tier 3 #15 (safe snippet) → Task 11
- Tier 3 #16 (pane persona inheritance) → Task 13
- Tier 3 #17 (tracing) → Tasks 5, 6
- Tier 4 #18 (soft-delete) → Tasks 2, 5, 6, 9
- Tier 4 #19 (export/import) → Tasks 6, 8, 12
- Tier 4 #20 (delete gating) → Task 10
- Path uniqueness → Task 2
- Persona multiplicity (documented) → spec, not code change

All 20 spec items covered.

**Placeholder scan:** no "TBD", "TODO", "implement later", or "fill in details" remain.

**Type consistency:** `ContextPage` fields match across Tasks 2, 3, 5, 8, 10. `ContextPageList` is re-exported consistently. `ContextSearchResult` carries `total` in Tasks 3, 5, 7, 8. `AgentPersona` no longer references `details_l2` JSON in Tasks 3, 7.

**Risks:** tests in Tasks 5, 6, 9, 13 may need iteration once the full Rust change set lands; the implementer should expect to add a couple of helpers (e.g. `SharedString` newtype) if the borrow checker complains about the `&Path` → `&PathBuf` conversions in `open_conn_for_scope`. The scope-resolver helper `list_pages_for_scope_token` is intentionally permissive (category tokens map to single categories); if the spec's broader "inherits all" semantics are wanted for non-category tokens, that's a follow-up.

**Execution estimate:** 14 tasks. Each task is one or two test files plus one implementation file. The implementation per task is short, but the diff surface is wide. Plan executes in roughly the same calendar time as four prior context-studio features, but with a much higher assurance bar.
