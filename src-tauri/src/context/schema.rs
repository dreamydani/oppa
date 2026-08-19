use rusqlite::Connection;

/// Initializes SQLite tables, FTS5 virtual index, and sync triggers.
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

/// Applies forward-only schema migrations recorded against user_version.
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
            -- Backfill legacy personas if details_l2 contained JSON scope array
            UPDATE context_pages
              SET attached_scopes_json = details_l2, details_l2 = NULL
              WHERE category = 'persona' AND details_l2 IS NOT NULL AND details_l2 LIKE '[%';
            UPDATE context_pages
              SET is_built_in = 1
              WHERE id IN ('debugger', 'optimizer', 'researcher', 'test_architect');
            "#,
        )?;
        conn.pragma_update(None, "user_version", 1i64)?;
    }
    Ok(())
}

/// Seeds standard built-in personas into global context.
fn seed_builtin_personas(conn: &Connection) -> rusqlite::Result<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let personas = [
        (
            "debugger",
            "Debugger",
            "🐛",
            "Root-cause isolation and fix verification expert",
            "You are an expert debugging assistant. You systematically isolate root causes, examine stack traces, reproduce minimal test cases, and verify fixes with unit tests.",
        ),
        (
            "optimizer",
            "Optimizer",
            "⚡",
            "Performance profiling and zero-overhead optimization specialist",
            "You are an expert performance engineer. You analyze latency, memory allocation, asymptotic complexity, and cache efficiency to deliver optimal execution speed.",
        ),
        (
            "researcher",
            "Researcher",
            "🔬",
            "Architecture analysis and deep codebase explorer",
            "You are an expert codebase researcher. You explore architectures, trace cross-module dependencies, evaluate design trade-offs, and produce clear technical documentation.",
        ),
        (
            "test_architect",
            "Test Architect",
            "🧪",
            "Test-driven development, regression suites, and verification specialist",
            "You are an expert test architect. You design comprehensive test suites, enforce test-driven development (TDD), ensure high edge-case coverage, and eliminate regressions.",
        ),
    ];

    let mut stmt = conn.prepare_cached(
        r#"
        INSERT OR IGNORE INTO context_pages (
            id, scope, category, path, title, icon, abstract_l0, overview_l1, details_l2, pinned, is_built_in, attached_scopes_json, created_at, updated_at
        ) VALUES (?1, 'global', 'persona', ?2, ?3, ?4, ?5, ?6, NULL, 0, 1, '[]', ?7, ?7)
        "#,
    )?;

    for (id, title, icon, abstract_l0, overview_l1) in personas {
        let path = format!("personas/{}", id);
        stmt.execute(rusqlite::params![
            id,
            path,
            title,
            icon,
            abstract_l0,
            overview_l1,
            now
        ])?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn test_initialize_context_schema_creates_tables_and_fts5() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();

        // Verify context_pages table exists
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='context_pages'")
            .unwrap();
        let exists: bool = stmt.exists([]).unwrap();
        assert!(exists);

        // Verify FTS5 virtual table exists
        let mut stmt_fts = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='context_pages_fts'")
            .unwrap();
        let fts_exists: bool = stmt_fts.exists([]).unwrap();
        assert!(fts_exists);
    }

    #[test]
    fn test_fts5_triggers_insert_update_delete() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();

        // Insert a new page
        conn.execute(
            r#"
            INSERT INTO context_pages (
                id, scope, category, path, title, icon, abstract_l0, overview_l1, details_l2, pinned, created_at, updated_at
            ) VALUES ('quirk-pty', 'workspace', 'quirk', 'quirks/pty-ack', 'PTY Flow Control', '🐛', 'ACK backpressure mechanism', 'Pauses at 256KB and resumes at 32KB', 'Detailed log trace', 1, 100, 100)
            "#,
            [],
        ).unwrap();

        // Query FTS5 table
        let mut fts_query = conn
            .prepare("SELECT rowid FROM context_pages_fts WHERE context_pages_fts MATCH 'backpressure'")
            .unwrap();
        let fts_rows: Vec<i64> = fts_query
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(fts_rows.len(), 1);

        // Update page
        conn.execute(
            r#"
            UPDATE context_pages
            SET abstract_l0 = 'Custom throttle control mechanism'
            WHERE id = 'quirk-pty'
            "#,
            [],
        ).unwrap();

        // Old keyword should no longer match
        let mut fts_old_query = conn
            .prepare("SELECT rowid FROM context_pages_fts WHERE context_pages_fts MATCH 'backpressure'")
            .unwrap();
        let old_rows: Vec<i64> = fts_old_query
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(old_rows.len(), 0);

        // New keyword matches
        let mut fts_updated_query = conn
            .prepare("SELECT rowid FROM context_pages_fts WHERE context_pages_fts MATCH 'throttle'")
            .unwrap();
        let updated_rows: Vec<i64> = fts_updated_query
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(updated_rows.len(), 1);

        // Delete page
        conn.execute("DELETE FROM context_pages WHERE id = 'quirk-pty'", []).unwrap();
        let mut fts_deleted_query = conn
            .prepare("SELECT rowid FROM context_pages_fts WHERE context_pages_fts MATCH 'throttle'")
            .unwrap();
        let deleted_rows: Vec<i64> = fts_deleted_query
            .query_map([], |row| row.get(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert_eq!(deleted_rows.len(), 0);
    }

    #[test]
    fn test_built_in_personas_seeded() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();

        let mut stmt = conn
            .prepare("SELECT id, title, icon, category, scope, is_built_in, attached_scopes_json, details_l2 FROM context_pages WHERE category='persona' ORDER BY id")
            .unwrap();
        let personas: Vec<(String, String, String, String, String, i64, String, Option<String>)> = stmt
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                    row.get(7)?,
                ))
            })
            .unwrap()
            .map(|r| r.unwrap())
            .collect();

        assert_eq!(personas.len(), 4);
        assert_eq!(personas[0].0, "debugger");
        assert_eq!(personas[0].1, "Debugger");
        assert_eq!(personas[0].2, "🐛");
        assert_eq!(personas[0].3, "persona");
        assert_eq!(personas[0].4, "global");
        assert_eq!(personas[0].5, 1);
        assert_eq!(personas[0].6, "[]");
        assert_eq!(personas[0].7, None);

        assert_eq!(personas[1].0, "optimizer");
        assert_eq!(personas[1].5, 1);
        assert_eq!(personas[2].0, "researcher");
        assert_eq!(personas[2].5, 1);
        assert_eq!(personas[3].0, "test_architect");
        assert_eq!(personas[3].5, 1);
    }

    #[test]
    fn test_schema_initialization_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();
        initialize_schema(&conn).unwrap();

        let mut stmt = conn
            .prepare("SELECT count(*) FROM context_pages WHERE category='persona'")
            .unwrap();
        let count: i64 = stmt.query_row([], |row| row.get(0)).unwrap();
        assert_eq!(count, 4);
    }

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
        let count: i64 = conn.query_row("SELECT count(*) FROM context_pages WHERE id='p1'", [], |r| r.get(0)).unwrap();
        assert_eq!(count, 1);
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(version, 1);
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

    #[test]
    fn test_legacy_persona_scopes_migrated_from_details_l2() {
        let conn = Connection::open_in_memory().unwrap();
        // Create full v0 schema before migration was introduced
        conn.execute_batch(
            r#"
            CREATE TABLE context_pages (
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

            CREATE VIRTUAL TABLE context_pages_fts USING fts5(
                title, abstract_l0, overview_l1, details_l2,
                content='context_pages',
                content_rowid='rowid',
                tokenize="unicode61 tokenchars '/_-'"
            );

            CREATE TRIGGER context_pages_fts_ai AFTER INSERT ON context_pages BEGIN
                INSERT INTO context_pages_fts(rowid, title, abstract_l0, overview_l1, details_l2)
                    VALUES (new.rowid, new.title, new.abstract_l0, new.overview_l1, new.details_l2);
            END;

            CREATE TRIGGER context_pages_fts_ad AFTER DELETE ON context_pages BEGIN
                INSERT INTO context_pages_fts(context_pages_fts, rowid, title, abstract_l0, overview_l1, details_l2)
                    VALUES ('delete', old.rowid, old.title, old.abstract_l0, old.overview_l1, old.details_l2);
            END;

            CREATE TRIGGER context_pages_fts_au AFTER UPDATE ON context_pages BEGIN
                INSERT INTO context_pages_fts(context_pages_fts, rowid, title, abstract_l0, overview_l1, details_l2)
                    VALUES ('delete', old.rowid, old.title, old.abstract_l0, old.overview_l1, old.details_l2);
                INSERT INTO context_pages_fts(rowid, title, abstract_l0, overview_l1, details_l2)
                    VALUES (new.rowid, new.title, new.abstract_l0, new.overview_l1, new.details_l2);
            END;
            "#,
        ).unwrap();

        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            r#"
            INSERT INTO context_pages (
                id, scope, category, path, title, icon, abstract_l0, overview_l1, details_l2, pinned, created_at, updated_at
            ) VALUES ('custom-persona', 'global', 'persona', 'personas/custom', 'Custom', '🤖', 'Custom persona', 'Custom overview', '["quirks/*", "architecture/*"]', 0, ?1, ?1)
            "#,
            rusqlite::params![now],
        ).unwrap();

        // Now run initialize_schema which runs migrate
        initialize_schema(&conn).unwrap();

        let (attached_scopes, details_l2): (String, Option<String>) = conn
            .query_row(
                "SELECT attached_scopes_json, details_l2 FROM context_pages WHERE id = 'custom-persona'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();

        assert_eq!(attached_scopes, r#"["quirks/*", "architecture/*"]"#);
        assert_eq!(details_l2, None);
    }
}

