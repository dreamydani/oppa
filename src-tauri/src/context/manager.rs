use std::collections::HashSet;
use std::path::{Path, PathBuf};
use rusqlite::Connection;

use crate::context::context_page_list::ContextPageList;
use crate::context::models::{AgentPersona, ContextPage, ContextSearchResult};
use crate::context::schema::initialize_schema;

#[derive(Debug, Clone, Default)]
pub struct ContextManager {
    global_db_path: Option<PathBuf>,
}

impl ContextManager {
    pub fn new() -> Self {
        Self {
            global_db_path: None,
        }
    }

    pub fn with_global_db_path(path: PathBuf) -> Self {
        Self {
            global_db_path: Some(path),
        }
    }

    pub fn get_global_db_path() -> PathBuf {
        if let Some(home) = dirs::home_dir() {
            home.join(".oppa").join("global_context.sqlite")
        } else if let Ok(user_profile) = std::env::var("USERPROFILE") {
            PathBuf::from(user_profile).join(".oppa").join("global_context.sqlite")
        } else if let Ok(home) = std::env::var("HOME") {
            PathBuf::from(home).join(".oppa").join("global_context.sqlite")
        } else {
            std::env::temp_dir().join(".oppa").join("global_context.sqlite")
        }
    }

    pub fn get_workspace_db_path(workspace_path: &str) -> PathBuf {
        PathBuf::from(workspace_path).join(".oppa").join("context.sqlite")
    }

    fn global_path(&self) -> PathBuf {
        self.global_db_path
            .clone()
            .unwrap_or_else(Self::get_global_db_path)
    }

    fn open_conn(path: &Path) -> rusqlite::Result<Connection> {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(path)?;
        conn.pragma_update_and_check(None, "journal_mode", "WAL", |_| Ok(()))?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        initialize_schema(&conn)?;
        Ok(conn)
    }

    fn open_conn_for_scope(
        scope: &str,
        workspace_path: Option<&str>,
        global_path: &Path,
    ) -> Result<Connection, String> {
        match scope {
            "global" => Self::open_conn(global_path).map_err(|e| e.to_string()),
            "workspace" => {
                let ws = workspace_path
                    .ok_or_else(|| "Workspace path required for workspace scope".to_string())?;
                let path = Self::get_workspace_db_path(ws);
                Self::open_conn(&path).map_err(|e| e.to_string())
            }
            other => Err(format!("Invalid scope: {}", other)),
        }
    }

    #[tracing::instrument(skip(self))]
    pub fn upsert_page(&self, page: &ContextPage, workspace_path: Option<&str>) -> Result<(), String> {
        page.validate()?;
        let conn = Self::open_conn_for_scope(&page.scope, workspace_path, &self.global_path())?;
        let now = chrono::Utc::now().timestamp_millis();
        let existing = Self::query_single_page_all(&conn, &page.id).map_err(|e| e.to_string())?;
        let created_at = existing.as_ref().map(|p| p.created_at).unwrap_or(now);
        let is_built_in = if page.is_built_in {
            true
        } else {
            existing.as_ref().map(|p| p.is_built_in).unwrap_or(false)
        };
        let attached_scopes_json = if !page.attached_scopes_json.is_empty() && page.attached_scopes_json != "[]" {
            page.attached_scopes_json.clone()
        } else {
            existing
                .as_ref()
                .map(|p| p.attached_scopes_json.clone())
                .unwrap_or_else(|| "[]".into())
        };
        let deleted_at = page.deleted_at.or_else(|| existing.as_ref().and_then(|p| p.deleted_at));

        let pinned_int: i32 = if page.pinned { 1 } else { 0 };
        let is_built_in_int: i32 = if is_built_in { 1 } else { 0 };

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
                    is_built_in = excluded.is_built_in,
                    attached_scopes_json = excluded.attached_scopes_json,
                    created_at = excluded.created_at,
                    updated_at = excluded.updated_at,
                    deleted_at = excluded.deleted_at
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
            attached_scopes_json,
            created_at,
            now,
            deleted_at,
        ])
        .map_err(|e| e.to_string())?;

        Ok(())
    }

    #[tracing::instrument(skip(self))]
    pub fn get_page(&self, id: &str, workspace_path: Option<&str>) -> Result<Option<ContextPage>, String> {
        if let Some(ws) = workspace_path {
            let ws_path = Self::get_workspace_db_path(ws);
            if ws_path.exists() {
                let conn = Self::open_conn(&ws_path).map_err(|e| e.to_string())?;
                if let Some(page) = Self::query_single_page(&conn, id).map_err(|e| e.to_string())? {
                    return Ok(Some(page));
                }
            }
        }

        let global_path = self.global_path();
        let conn = Self::open_conn(&global_path).map_err(|e| e.to_string())?;
        Self::query_single_page(&conn, id).map_err(|e| e.to_string())
    }

    #[tracing::instrument(skip(self))]
    pub fn get_page_by_path(
        &self,
        scope: &str,
        path: &str,
        workspace_path: Option<&str>,
    ) -> Result<Option<ContextPage>, String> {
        let conn = Self::open_conn_for_scope(scope, workspace_path, &self.global_path())?;
        let mut stmt = conn
            .prepare_cached(
                r#"
                SELECT id, scope, category, path, title, icon, abstract_l0, overview_l1, details_l2,
                       pinned, is_built_in, attached_scopes_json, created_at, updated_at, deleted_at
                FROM context_pages
                WHERE scope = ?1 AND path = ?2 AND deleted_at IS NULL
                "#,
            )
            .map_err(|e| e.to_string())?;

        let mut rows = stmt.query(rusqlite::params![scope, path]).map_err(|e| e.to_string())?;
        if let Some(row) = rows.next().map_err(|e| e.to_string())? {
            Ok(Some(Self::row_to_page(row).map_err(|e| e.to_string())?))
        } else {
            Ok(None)
        }
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

        if let Some(ws) = workspace_path {
            let ws_path = Self::get_workspace_db_path(ws);
            if ws_path.exists() {
                let conn = Self::open_conn(&ws_path).map_err(|e| e.to_string())?;
                let ws_pages = Self::query_pages_visible(&conn, category).map_err(|e| e.to_string())?;
                for p in ws_pages {
                    if seen.insert(p.id.clone()) {
                        items.push(p);
                    }
                }
            }
        }

        let global_path = self.global_path();
        let global_conn = Self::open_conn(&global_path).map_err(|e| e.to_string())?;
        let global_pages = Self::query_pages_visible(&global_conn, category).map_err(|e| e.to_string())?;
        for p in global_pages {
            if seen.insert(p.id.clone()) {
                items.push(p);
            }
        }

        items.sort_by(|a, b| b.pinned.cmp(&a.pinned).then_with(|| b.updated_at.cmp(&a.updated_at)));

        let total = items.len() as i64;
        let offset = offset.unwrap_or(0);
        let paginated_items = if offset >= items.len() {
            Vec::new()
        } else {
            let mut sliced = items[offset..].to_vec();
            if let Some(lim) = limit {
                sliced.truncate(lim);
            }
            sliced
        };

        Ok(ContextPageList {
            items: paginated_items,
            total,
        })
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

        let global_path = self.global_path();
        if global_path.exists() || self.global_db_path.is_none() {
            let global_conn = Self::open_conn(&global_path).map_err(|e| e.to_string())?;
            let (mut g_results, g_total) = Self::query_fts(&global_conn, &sanitized, limit).map_err(|e| e.to_string())?;
            total += g_total;
            for r in g_results.drain(..) {
                if seen.insert(r.id.clone()) {
                    results.push(r);
                }
            }
        }

        results.truncate(limit);
        for r in results.iter_mut() {
            r.total = total;
        }

        Ok(results)
    }

    #[tracing::instrument(skip(self))]
    pub fn delete_page(&self, id: &str, scope: &str, workspace_path: Option<&str>) -> Result<(), String> {
        let conn = Self::open_conn_for_scope(scope, workspace_path, &self.global_path())?;
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "UPDATE context_pages SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
            rusqlite::params![now, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[tracing::instrument(skip(self))]
    pub fn restore_page(&self, id: &str, scope: &str, workspace_path: Option<&str>) -> Result<(), String> {
        let conn = Self::open_conn_for_scope(scope, workspace_path, &self.global_path())?;
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "UPDATE context_pages SET deleted_at = NULL, updated_at = ?1 WHERE id = ?2",
            rusqlite::params![now, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[tracing::instrument(skip(self))]
    pub fn list_personas(&self, workspace_path: Option<&str>) -> Result<Vec<AgentPersona>, String> {
        let pages = self.list_pages(workspace_path, Some("persona"), None, None)?;
        Ok(pages.items.into_iter().map(|p| AgentPersona::from_context_page(&p)).collect())
    }

    #[tracing::instrument(skip(self))]
    pub fn upsert_persona(&self, persona: &AgentPersona, workspace_path: Option<&str>) -> Result<(), String> {
        let now = chrono::Utc::now().timestamp_millis();
        let existing = self.get_page(&persona.id, workspace_path)?;
        let created_at = existing.map(|p| p.created_at).unwrap_or(now);
        let scope = if workspace_path.is_some() { "workspace" } else { "global" };
        let mut page = persona.to_context_page(scope, now);
        page.created_at = created_at;
        self.upsert_page(&page, workspace_path)
    }

    #[tracing::instrument(skip(self))]
    pub fn list_pages_for_scope_token(
        &self,
        token: &str,
        workspace_path: Option<&str>,
    ) -> Result<Vec<ContextPage>, String> {
        let token = token.trim();
        if token.is_empty() {
            return Ok(Vec::new());
        }

        if token.eq_ignore_ascii_case("global") || token.eq_ignore_ascii_case("workspace") {
            let target_scope = if token.eq_ignore_ascii_case("global") {
                "global"
            } else {
                "workspace"
            };
            return self.list_pages_by_scope(target_scope, workspace_path);
        }

        let category = match token.to_ascii_lowercase().as_str() {
            "architecture" => Some("architecture"),
            "quirks" | "quirk" => Some("quirk"),
            "runbooks" | "runbook" => Some("runbook"),
            "preferences" | "preference" => Some("preference"),
            "personas" | "persona" => Some("persona"),
            _ => None,
        };

        if let Some(cat) = category {
            let list = self.list_pages(workspace_path, Some(cat), None, None)?;
            return Ok(list.items);
        }

        // Path prefix matching (e.g. quirks/*, architecture/core)
        let clean_token = token.trim_end_matches("/*").trim_end_matches('*');
        let pattern = format!("{}%", clean_token);
        let mut items = Vec::new();
        let mut seen = HashSet::new();

        if let Some(ws) = workspace_path {
            let ws_path = Self::get_workspace_db_path(ws);
            if ws_path.exists() {
                let conn = Self::open_conn(&ws_path).map_err(|e| e.to_string())?;
                let mut stmt = conn
                    .prepare_cached(
                        r#"
                        SELECT id, scope, category, path, title, icon, abstract_l0, overview_l1, details_l2,
                               pinned, is_built_in, attached_scopes_json, created_at, updated_at, deleted_at
                        FROM context_pages
                        WHERE path LIKE ?1 AND deleted_at IS NULL
                        ORDER BY pinned DESC, updated_at DESC
                        "#,
                    )
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map(rusqlite::params![pattern], Self::row_to_page)
                    .map_err(|e| e.to_string())?;
                for r in rows {
                    let p = r.map_err(|e| e.to_string())?;
                    if seen.insert(p.id.clone()) {
                        items.push(p);
                    }
                }
            }
        }

        let global_path = self.global_path();
        if global_path.exists() || self.global_db_path.is_none() {
            let global_conn = Self::open_conn(&global_path).map_err(|e| e.to_string())?;
            let mut stmt = global_conn
                .prepare_cached(
                    r#"
                    SELECT id, scope, category, path, title, icon, abstract_l0, overview_l1, details_l2,
                           pinned, is_built_in, attached_scopes_json, created_at, updated_at, deleted_at
                    FROM context_pages
                    WHERE path LIKE ?1 AND deleted_at IS NULL
                    ORDER BY pinned DESC, updated_at DESC
                    "#,
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params![pattern], Self::row_to_page)
                .map_err(|e| e.to_string())?;
            for r in rows {
                let p = r.map_err(|e| e.to_string())?;
                if seen.insert(p.id.clone()) {
                    items.push(p);
                }
            }
        }

        items.sort_by(|a, b| b.pinned.cmp(&a.pinned).then_with(|| b.updated_at.cmp(&a.updated_at)));
        Ok(items)
    }

    fn list_pages_by_scope(&self, scope: &str, workspace_path: Option<&str>) -> Result<Vec<ContextPage>, String> {
        if scope == "workspace" && workspace_path.is_none() {
            return Ok(Vec::new());
        }
        let conn = Self::open_conn_for_scope(scope, workspace_path, &self.global_path())?;
        let mut stmt = conn
            .prepare_cached(
                r#"
                SELECT id, scope, category, path, title, icon, abstract_l0, overview_l1, details_l2,
                       pinned, is_built_in, attached_scopes_json, created_at, updated_at, deleted_at
                FROM context_pages
                WHERE deleted_at IS NULL
                ORDER BY pinned DESC, updated_at DESC
                "#,
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

    fn query_single_page(conn: &Connection, id: &str) -> rusqlite::Result<Option<ContextPage>> {
        let mut stmt = conn.prepare_cached(
            r#"
            SELECT id, scope, category, path, title, icon, abstract_l0, overview_l1, details_l2,
                   pinned, is_built_in, attached_scopes_json, created_at, updated_at, deleted_at
            FROM context_pages
            WHERE id = ?1 AND deleted_at IS NULL
            "#,
        )?;

        let mut rows = stmt.query(rusqlite::params![id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(Self::row_to_page(row)?))
        } else {
            Ok(None)
        }
    }

    fn query_single_page_all(conn: &Connection, id: &str) -> rusqlite::Result<Option<ContextPage>> {
        let mut stmt = conn.prepare_cached(
            r#"
            SELECT id, scope, category, path, title, icon, abstract_l0, overview_l1, details_l2,
                   pinned, is_built_in, attached_scopes_json, created_at, updated_at, deleted_at
            FROM context_pages
            WHERE id = ?1
            "#,
        )?;

        let mut rows = stmt.query(rusqlite::params![id])?;
        if let Some(row) = rows.next()? {
            Ok(Some(Self::row_to_page(row)?))
        } else {
            Ok(None)
        }
    }

    fn query_pages_visible(conn: &Connection, category: Option<&str>) -> rusqlite::Result<Vec<ContextPage>> {
        let mut sql = String::from(
            r#"
            SELECT id, scope, category, path, title, icon, abstract_l0, overview_l1, details_l2,
                   pinned, is_built_in, attached_scopes_json, created_at, updated_at, deleted_at
            FROM context_pages
            WHERE deleted_at IS NULL
            "#,
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

        let mut pages = Vec::new();
        for row in rows {
            pages.push(row?);
        }
        Ok(pages)
    }

    fn query_fts(
        conn: &Connection,
        sanitized_query: &str,
        limit: usize,
    ) -> rusqlite::Result<(Vec<ContextSearchResult>, i64)> {
        let mut stmt = conn.prepare_cached(
            r#"
            SELECT p.id, p.scope, p.category, p.path, p.title, p.icon, p.abstract_l0, p.overview_l1,
                   snippet(context_pages_fts, 1, '<b>', '</b>', '...', 10) as snippet
            FROM context_pages_fts fts
            JOIN context_pages p ON fts.rowid = p.rowid
            WHERE context_pages_fts MATCH ?1 AND p.deleted_at IS NULL
            ORDER BY rank
            LIMIT ?2
            "#,
        )?;

        let rows = stmt.query_map(rusqlite::params![sanitized_query, limit as i64], Self::row_to_search_result)?;
        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }

        let total: i64 = conn.query_row(
            r#"
            SELECT count(*)
            FROM context_pages_fts fts
            JOIN context_pages p ON fts.rowid = p.rowid
            WHERE context_pages_fts MATCH ?1 AND p.deleted_at IS NULL
            "#,
            rusqlite::params![sanitized_query],
            |r| r.get(0),
        )?;

        Ok((results, total))
    }

    fn row_to_page(row: &rusqlite::Row) -> rusqlite::Result<ContextPage> {
        let pinned_int: i32 = row.get(9)?;
        let is_built_in_int: i32 = row.get(10)?;
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
            pinned: pinned_int != 0,
            is_built_in: is_built_in_int != 0,
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
}

pub fn sanitize_fts5_query(query: &str) -> String {
    let mut tokens = Vec::new();
    for part in query.split(|c: char| c.is_whitespace() || c == '"' || c == '(' || c == ')' || c == ':' || c == '*' || c == '^' || c == '+' || c == '~') {
        let trimmed = part.trim_matches(|c: char| c == '/' || c == '-' || c == '_' || !c.is_alphanumeric());
        if !trimmed.is_empty() {
            let escaped = trimmed.replace('"', "\"\"");
            tokens.push(format!("\"{}\"*", escaped));
        }
    }
    tokens.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn create_test_manager(temp_dir: &tempfile::TempDir) -> (ContextManager, String) {
        let global_path = temp_dir.path().join("global").join("global_context.sqlite");
        let ws_path = temp_dir.path().join("workspace");
        let manager = ContextManager::with_global_db_path(global_path);
        (manager, ws_path.to_str().unwrap().to_string())
    }

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
        let list = m.list_pages(Some(&ws), None, None, None).unwrap();
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

    #[test]
    fn test_restore_page() {
        let dir = tempdir().unwrap();
        let (m, ws) = create_test_manager(&dir);
        m.upsert_page(&ContextPage {
            id: "p1".into(), scope: "workspace".into(), category: "quirk".into(),
            path: "quirks/foo".into(), title: "Foo".into(), icon: "bug".into(),
            abstract_l0: "a".into(), overview_l1: "b".into(), details_l2: None,
            pinned: false, is_built_in: false, attached_scopes_json: "[]".into(),
            created_at: 0, updated_at: 0, deleted_at: None,
        }, Some(&ws)).unwrap();
        m.delete_page("p1", "workspace", Some(&ws)).unwrap();
        assert!(m.get_page("p1", Some(&ws)).unwrap().is_none());
        m.restore_page("p1", "workspace", Some(&ws)).unwrap();
        assert!(m.get_page("p1", Some(&ws)).unwrap().is_some());
    }

    #[test]
    fn test_list_pages_for_scope_token() {
        let dir = tempdir().unwrap();
        let (m, ws) = create_test_manager(&dir);
        m.upsert_page(&ContextPage {
            id: "p1".into(), scope: "workspace".into(), category: "quirk".into(),
            path: "quirks/pty-ack".into(), title: "PTY ACK".into(), icon: "bug".into(),
            abstract_l0: "a".into(), overview_l1: "b".into(), details_l2: None,
            pinned: false, is_built_in: false, attached_scopes_json: "[]".into(),
            created_at: 0, updated_at: 0, deleted_at: None,
        }, Some(&ws)).unwrap();

        let quirk_token_res = m.list_pages_for_scope_token("quirks", Some(&ws)).unwrap();
        assert_eq!(quirk_token_res.len(), 1);
        assert_eq!(quirk_token_res[0].id, "p1");

        let path_token_res = m.list_pages_for_scope_token("quirks/*", Some(&ws)).unwrap();
        assert_eq!(path_token_res.len(), 1);
        assert_eq!(path_token_res[0].id, "p1");

        let global_token_res = m.list_pages_for_scope_token("global", Some(&ws)).unwrap();
        // 4 built-in personas in global
        assert_eq!(global_token_res.len(), 4);
    }

    #[test]
    fn test_context_manager_crud_and_fts5_search() {
        let temp_dir = tempdir().unwrap();
        let (manager, ws_path) = create_test_manager(&temp_dir);

        let page = ContextPage {
            id: "quirk-1".to_string(),
            scope: "workspace".to_string(),
            category: "quirk".to_string(),
            path: "quirks/pty-ack".to_string(),
            title: "PTY ACK Flow Control".to_string(),
            icon: "🐛".to_string(),
            abstract_l0: "High watermark backpressure fix using ACK channel.".to_string(),
            overview_l1: "Rust pauses PTY read loop at 256KB and resumes at 32KB.".to_string(),
            details_l2: Some("Full stack trace and ACK implementation log.".to_string()),
            pinned: true,
            is_built_in: false,
            attached_scopes_json: "[]".to_string(),
            created_at: 1000,
            updated_at: 1000,
            deleted_at: None,
        };

        manager.upsert_page(&page, Some(&ws_path)).unwrap();

        let retrieved = manager.get_page("quirk-1", Some(&ws_path)).unwrap().unwrap();
        assert_eq!(retrieved.title, "PTY ACK Flow Control");
        assert_eq!(retrieved.pinned, true);

        let results = manager.search_fts("backpressure", Some(&ws_path), None).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "quirk-1");
        assert!(results[0].snippet.contains("backpressure"));
    }

    #[test]
    fn test_dual_scope_isolation_and_fallback() {
        let temp_dir = tempdir().unwrap();
        let (manager, ws_path) = create_test_manager(&temp_dir);

        let global_page = ContextPage {
            id: "pref-editor".to_string(),
            scope: "global".to_string(),
            category: "preference".to_string(),
            path: "prefs/editor".to_string(),
            title: "Editor Preferences".to_string(),
            icon: "⚙️".to_string(),
            abstract_l0: "Global editor vim keybindings.".to_string(),
            overview_l1: "Vim modal editing configuration.".to_string(),
            details_l2: None,
            pinned: false,
            is_built_in: false,
            attached_scopes_json: "[]".to_string(),
            created_at: 100,
            updated_at: 100,
            deleted_at: None,
        };

        manager.upsert_page(&global_page, None).unwrap();

        let fallback = manager.get_page("pref-editor", Some(&ws_path)).unwrap().unwrap();
        assert_eq!(fallback.title, "Editor Preferences");
        assert_eq!(fallback.scope, "global");

        let ws_override = ContextPage {
            id: "pref-editor".to_string(),
            scope: "workspace".to_string(),
            category: "preference".to_string(),
            path: "prefs/editor".to_string(),
            title: "Workspace Custom Editor".to_string(),
            icon: "⚙️".to_string(),
            abstract_l0: "Workspace override editor settings.".to_string(),
            overview_l1: "Custom tab sizes for this repo.".to_string(),
            details_l2: None,
            pinned: false,
            is_built_in: false,
            attached_scopes_json: "[]".to_string(),
            created_at: 200,
            updated_at: 200,
            deleted_at: None,
        };
        manager.upsert_page(&ws_override, Some(&ws_path)).unwrap();

        let retrieved_ws = manager.get_page("pref-editor", Some(&ws_path)).unwrap().unwrap();
        assert_eq!(retrieved_ws.title, "Workspace Custom Editor");
        assert_eq!(retrieved_ws.scope, "workspace");

        let retrieved_global = manager.get_page("pref-editor", None).unwrap().unwrap();
        assert_eq!(retrieved_global.title, "Editor Preferences");
        assert_eq!(retrieved_global.scope, "global");
    }

    #[test]
    fn test_list_pages_filtering_and_deduplication() {
        let temp_dir = tempdir().unwrap();
        let (manager, ws_path) = create_test_manager(&temp_dir);

        let ws_page = ContextPage {
            id: "arch-1".to_string(),
            scope: "workspace".to_string(),
            category: "architecture".to_string(),
            path: "arch/core".to_string(),
            title: "Core Architecture".to_string(),
            icon: "🏗️".to_string(),
            abstract_l0: "Tauri + Rust core.".to_string(),
            overview_l1: "Architecture overview.".to_string(),
            details_l2: None,
            pinned: true,
            is_built_in: false,
            attached_scopes_json: "[]".to_string(),
            created_at: 300,
            updated_at: 300,
            deleted_at: None,
        };
        manager.upsert_page(&ws_page, Some(&ws_path)).unwrap();

        let personas = manager.list_pages(Some(&ws_path), Some("persona"), None, None).unwrap();
        assert_eq!(personas.total, 4);

        let arch_pages = manager.list_pages(Some(&ws_path), Some("architecture"), None, None).unwrap();
        assert_eq!(arch_pages.items.len(), 1);
        assert_eq!(arch_pages.items[0].id, "arch-1");

        let all_pages = manager.list_pages(Some(&ws_path), None, None, None).unwrap();
        assert_eq!(all_pages.total, 5);
    }

    #[test]
    fn test_delete_page_scope_specific() {
        let temp_dir = tempdir().unwrap();
        let (manager, ws_path) = create_test_manager(&temp_dir);

        let ws_page = ContextPage {
            id: "runbook-1".to_string(),
            scope: "workspace".to_string(),
            category: "runbook".to_string(),
            path: "runbooks/deploy".to_string(),
            title: "Deployment Guide".to_string(),
            icon: "🚀".to_string(),
            abstract_l0: "Deploy steps.".to_string(),
            overview_l1: "Deploy details.".to_string(),
            details_l2: None,
            pinned: false,
            is_built_in: false,
            attached_scopes_json: "[]".to_string(),
            created_at: 400,
            updated_at: 400,
            deleted_at: None,
        };
        manager.upsert_page(&ws_page, Some(&ws_path)).unwrap();

        assert!(manager.get_page("runbook-1", Some(&ws_path)).unwrap().is_some());

        manager.delete_page("runbook-1", "workspace", Some(&ws_path)).unwrap();

        assert!(manager.get_page("runbook-1", Some(&ws_path)).unwrap().is_none());
    }

    #[test]
    fn test_persona_conversion_and_crud() {
        let temp_dir = tempdir().unwrap();
        let (manager, ws_path) = create_test_manager(&temp_dir);

        let persona = AgentPersona {
            id: "security_auditor".to_string(),
            name: "Security Auditor".to_string(),
            icon: "🛡️".to_string(),
            tagline: "Vulnerability analysis and penetration testing".to_string(),
            system_prompt: "You are an elite application security auditor.".to_string(),
            attached_scopes: vec!["quirks/*".to_string(), "architecture/*".to_string()],
            is_built_in: false,
        };

        manager.upsert_persona(&persona, Some(&ws_path)).unwrap();

        let personas = manager.list_personas(Some(&ws_path)).unwrap();
        assert!(personas.iter().any(|p| p.id == "security_auditor" && p.name == "Security Auditor" && p.attached_scopes.len() == 2));
    }

    #[test]
    fn test_fts5_query_sanitization_special_characters() {
        let temp_dir = tempdir().unwrap();
        let (manager, ws_path) = create_test_manager(&temp_dir);

        let page = ContextPage {
            id: "special-1".to_string(),
            scope: "workspace".to_string(),
            category: "quirk".to_string(),
            path: "quirks/async-await".to_string(),
            title: "Tokio Async/Await Pitfalls (v2)".to_string(),
            icon: "⚠️".to_string(),
            abstract_l0: "Avoid blocking calls inside async tasks!".to_string(),
            overview_l1: "Use spawn_blocking for CPU-bound tasks.".to_string(),
            details_l2: None,
            pinned: false,
            is_built_in: false,
            attached_scopes_json: "[]".to_string(),
            created_at: 500,
            updated_at: 500,
            deleted_at: None,
        };
        manager.upsert_page(&page, Some(&ws_path)).unwrap();

        let res1 = manager.search_fts("async/await", Some(&ws_path), None).unwrap();
        assert_eq!(res1.len(), 1);

        let res2 = manager.search_fts("\"blocking calls\"*", Some(&ws_path), None).unwrap();
        assert_eq!(res2.len(), 1);

        let res3 = manager.search_fts("***", Some(&ws_path), None).unwrap();
        assert_eq!(res3.len(), 0);
    }
}

