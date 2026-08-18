use std::collections::HashSet;
use std::path::{Path, PathBuf};
use rusqlite::Connection;

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
        initialize_schema(&conn)?;
        Ok(conn)
    }

    pub fn upsert_page(&self, page: &ContextPage, workspace_path: Option<&str>) -> Result<(), String> {
        let conn = match page.scope.as_str() {
            "global" => Self::open_conn(&self.global_path()).map_err(|e| e.to_string())?,
            "workspace" => {
                let ws = workspace_path
                    .ok_or_else(|| "Workspace path required for workspace scope".to_string())?;
                let path = Self::get_workspace_db_path(ws);
                Self::open_conn(&path).map_err(|e| e.to_string())?
            }
            other => return Err(format!("Invalid scope: {}", other)),
        };

        let mut stmt = conn
            .prepare_cached(
                r#"
                INSERT INTO context_pages (
                    id, scope, category, path, title, icon, abstract_l0, overview_l1, details_l2, pinned, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
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
                    updated_at = excluded.updated_at
                "#,
            )
            .map_err(|e| e.to_string())?;

        let pinned_int: i32 = if page.pinned { 1 } else { 0 };

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
            page.created_at,
            page.updated_at,
        ])
        .map_err(|e| e.to_string())?;

        Ok(())
    }

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

    pub fn list_pages(&self, workspace_path: Option<&str>, category: Option<&str>) -> Result<Vec<ContextPage>, String> {
        let mut results = Vec::new();
        let mut seen_ids = HashSet::new();

        if let Some(ws) = workspace_path {
            let ws_path = Self::get_workspace_db_path(ws);
            if ws_path.exists() {
                let conn = Self::open_conn(&ws_path).map_err(|e| e.to_string())?;
                let ws_pages = Self::query_pages(&conn, category).map_err(|e| e.to_string())?;
                for page in ws_pages {
                    seen_ids.insert(page.id.clone());
                    results.push(page);
                }
            }
        }

        let global_path = self.global_path();
        let conn = Self::open_conn(&global_path).map_err(|e| e.to_string())?;
        let global_pages = Self::query_pages(&conn, category).map_err(|e| e.to_string())?;
        for page in global_pages {
            if !seen_ids.contains(&page.id) {
                seen_ids.insert(page.id.clone());
                results.push(page);
            }
        }

        Ok(results)
    }

    pub fn search_fts(&self, query: &str, workspace_path: Option<&str>) -> Result<Vec<ContextSearchResult>, String> {
        let sanitized = sanitize_fts5_query(query);
        if sanitized.is_empty() {
            return Ok(Vec::new());
        }

        let mut results = Vec::new();
        let mut seen_ids = HashSet::new();

        if let Some(ws) = workspace_path {
            let ws_path = Self::get_workspace_db_path(ws);
            if ws_path.exists() {
                let conn = Self::open_conn(&ws_path).map_err(|e| e.to_string())?;
                let ws_results = Self::query_fts(&conn, &sanitized).map_err(|e| e.to_string())?;
                for item in ws_results {
                    seen_ids.insert(item.id.clone());
                    results.push(item);
                }
            }
        }

        let global_path = self.global_path();
        if global_path.exists() || self.global_db_path.is_none() {
            let conn = Self::open_conn(&global_path).map_err(|e| e.to_string())?;
            let global_results = Self::query_fts(&conn, &sanitized).map_err(|e| e.to_string())?;
            for item in global_results {
                if !seen_ids.contains(&item.id) {
                    seen_ids.insert(item.id.clone());
                    results.push(item);
                }
            }
        }

        results.truncate(25);
        Ok(results)
    }

    pub fn delete_page(&self, id: &str, scope: &str, workspace_path: Option<&str>) -> Result<(), String> {
        match scope {
            "workspace" => {
                let ws = workspace_path
                    .ok_or_else(|| "Workspace path required for workspace scope".to_string())?;
                let path = Self::get_workspace_db_path(ws);
                if path.exists() {
                    let conn = Self::open_conn(&path).map_err(|e| e.to_string())?;
                    conn.execute("DELETE FROM context_pages WHERE id = ?1", rusqlite::params![id])
                        .map_err(|e| e.to_string())?;
                }
            }
            "global" => {
                let path = self.global_path();
                if path.exists() {
                    let conn = Self::open_conn(&path).map_err(|e| e.to_string())?;
                    conn.execute("DELETE FROM context_pages WHERE id = ?1", rusqlite::params![id])
                        .map_err(|e| e.to_string())?;
                }
            }
            other => return Err(format!("Invalid scope: {}", other)),
        }
        Ok(())
    }

    pub fn list_personas(&self, workspace_path: Option<&str>) -> Result<Vec<AgentPersona>, String> {
        let pages = self.list_pages(workspace_path, Some("persona"))?;
        Ok(pages.into_iter().map(|p| AgentPersona::from_context_page(&p)).collect())
    }

    pub fn upsert_persona(&self, persona: &AgentPersona, workspace_path: Option<&str>) -> Result<(), String> {
        let now = chrono::Utc::now().timestamp_millis();
        let existing = self.get_page(&persona.id, workspace_path)?;
        let created_at = existing.map(|p| p.created_at).unwrap_or(now);
        let scope = if workspace_path.is_some() { "workspace" } else { "global" };
        let mut page = persona.to_context_page(scope, now);
        page.created_at = created_at;
        self.upsert_page(&page, workspace_path)
    }

    fn query_single_page(conn: &Connection, id: &str) -> rusqlite::Result<Option<ContextPage>> {
        let mut stmt = conn.prepare_cached(
            r#"
            SELECT id, scope, category, path, title, icon, abstract_l0, overview_l1, details_l2, pinned, created_at, updated_at
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

    fn query_pages(conn: &Connection, category: Option<&str>) -> rusqlite::Result<Vec<ContextPage>> {
        let mut sql = "SELECT id, scope, category, path, title, icon, abstract_l0, overview_l1, details_l2, pinned, created_at, updated_at FROM context_pages".to_string();
        if category.is_some() {
            sql.push_str(" WHERE category = ?1");
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

    fn query_fts(conn: &Connection, sanitized_query: &str) -> rusqlite::Result<Vec<ContextSearchResult>> {
        let mut stmt = conn.prepare_cached(
            r#"
            SELECT p.id, p.scope, p.category, p.path, p.title, p.icon, p.abstract_l0, p.overview_l1,
                   snippet(context_pages_fts, 1, '<b>', '</b>', '...', 10) as snippet
            FROM context_pages_fts fts
            JOIN context_pages p ON fts.rowid = p.rowid
            WHERE context_pages_fts MATCH ?1
            ORDER BY rank
            LIMIT 25
            "#,
        )?;

        let rows = stmt.query_map(rusqlite::params![sanitized_query], Self::row_to_search_result)?;
        let mut results = Vec::new();
        for row in rows {
            results.push(row?);
        }
        Ok(results)
    }

    fn row_to_page(row: &rusqlite::Row) -> rusqlite::Result<ContextPage> {
        let pinned_int: i32 = row.get(9)?;
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
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
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
            created_at: 1000,
            updated_at: 1000,
        };

        manager.upsert_page(&page, Some(&ws_path)).unwrap();

        // Test exact retrieval
        let retrieved = manager.get_page("quirk-1", Some(&ws_path)).unwrap().unwrap();
        assert_eq!(retrieved.title, "PTY ACK Flow Control");
        assert_eq!(retrieved.pinned, true);

        // Test FTS5 search
        let results = manager.search_fts("backpressure", Some(&ws_path)).unwrap();
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
            created_at: 100,
            updated_at: 100,
        };

        // Write to global scope
        manager.upsert_page(&global_page, None).unwrap();

        // Get from workspace with fallback to global
        let fallback = manager.get_page("pref-editor", Some(&ws_path)).unwrap().unwrap();
        assert_eq!(fallback.title, "Editor Preferences");
        assert_eq!(fallback.scope, "global");

        // Workspace override
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
            created_at: 200,
            updated_at: 200,
        };
        manager.upsert_page(&ws_override, Some(&ws_path)).unwrap();

        let retrieved_ws = manager.get_page("pref-editor", Some(&ws_path)).unwrap().unwrap();
        assert_eq!(retrieved_ws.title, "Workspace Custom Editor");
        assert_eq!(retrieved_ws.scope, "workspace");

        // Querying with no workspace path returns global page
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
            created_at: 300,
            updated_at: 300,
        };
        manager.upsert_page(&ws_page, Some(&ws_path)).unwrap();

        // Built-in personas are in global scope by default when initialized
        let personas = manager.list_pages(Some(&ws_path), Some("persona")).unwrap();
        assert_eq!(personas.len(), 4);

        let arch_pages = manager.list_pages(Some(&ws_path), Some("architecture")).unwrap();
        assert_eq!(arch_pages.len(), 1);
        assert_eq!(arch_pages[0].id, "arch-1");

        let all_pages = manager.list_pages(Some(&ws_path), None).unwrap();
        assert_eq!(all_pages.len(), 5); // 4 personas + 1 arch
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
            created_at: 400,
            updated_at: 400,
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
            created_at: 500,
            updated_at: 500,
        };
        manager.upsert_page(&page, Some(&ws_path)).unwrap();

        // Test with special FTS characters like quotes, asterisks, parens, colons
        let res1 = manager.search_fts("async/await", Some(&ws_path)).unwrap();
        assert_eq!(res1.len(), 1);

        let res2 = manager.search_fts("\"blocking calls\"*", Some(&ws_path)).unwrap();
        assert_eq!(res2.len(), 1);

        let res3 = manager.search_fts("***", Some(&ws_path)).unwrap();
        assert_eq!(res3.len(), 0);
    }
}
