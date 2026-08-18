use std::sync::Arc;
use tauri::State;

use crate::context::manager::ContextManager;
use crate::context::models::{AgentPersona, ContextPage, ContextSearchResult};

#[tauri::command]
pub fn context_list(
    manager: State<'_, Arc<ContextManager>>,
    workspace_path: Option<String>,
    category: Option<String>,
) -> Result<Vec<ContextPage>, String> {
    manager.list_pages(workspace_path.as_deref(), category.as_deref())
}

#[tauri::command]
pub fn context_get(
    manager: State<'_, Arc<ContextManager>>,
    id: String,
    workspace_path: Option<String>,
) -> Result<Option<ContextPage>, String> {
    manager.get_page(&id, workspace_path.as_deref())
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
pub fn context_search(
    manager: State<'_, Arc<ContextManager>>,
    query: String,
    workspace_path: Option<String>,
) -> Result<Vec<ContextSearchResult>, String> {
    manager.search_fts(&query, workspace_path.as_deref())
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
    fn test_context_list_and_upsert_delegation() {
        let (manager, _dir) = make_test_manager();
        let page = ContextPage {
            id: "page-1".to_string(),
            scope: "global".to_string(),
            category: "architecture".to_string(),
            path: "architecture/core".to_string(),
            title: "Core Architecture".to_string(),
            icon: "box".to_string(),
            abstract_l0: "Abstract 0".to_string(),
            overview_l1: "Overview 1".to_string(),
            details_l2: Some("Details 2".to_string()),
            pinned: true,
            created_at: 1000,
            updated_at: 2000,
        };

        // Manager method direct check
        manager.upsert_page(&page, None).unwrap();
        let list = manager.list_pages(None, Some("architecture")).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "page-1");

        // Now test command logic directly
        let res = manager.get_page("page-1", None).unwrap();
        assert!(res.is_some());
        assert_eq!(res.unwrap().title, "Core Architecture");
    }

    #[test]
    fn test_context_delete_and_search_delegation() {
        let (manager, _dir) = make_test_manager();
        let page = ContextPage {
            id: "search-1".to_string(),
            scope: "global".to_string(),
            category: "runbook".to_string(),
            path: "runbooks/deploy".to_string(),
            title: "Deployment Guide".to_string(),
            icon: "rocket".to_string(),
            abstract_l0: "How to deploy Kubernetes".to_string(),
            overview_l1: "Step by step Kubernetes deployment".to_string(),
            details_l2: None,
            pinned: false,
            created_at: 1000,
            updated_at: 2000,
        };

        manager.upsert_page(&page, None).unwrap();
        let search_res = manager.search_fts("Kubernetes", None).unwrap();
        assert_eq!(search_res.len(), 1);
        assert_eq!(search_res[0].id, "search-1");

        manager.delete_page("search-1", "global", None).unwrap();
        let after_delete = manager.get_page("search-1", None).unwrap();
        assert!(after_delete.is_none());
    }

    #[test]
    fn test_persona_list_and_upsert_delegation() {
        let (manager, _dir) = make_test_manager();
        let personas = manager.list_personas(None).unwrap();
        // 4 built-in personas seeded by schema
        assert_eq!(personas.len(), 4);

        let custom_persona = AgentPersona {
            id: "custom-bot".to_string(),
            name: "Custom Bot".to_string(),
            icon: "bot".to_string(),
            tagline: "Custom helper".to_string(),
            system_prompt: "You are a custom helper".to_string(),
            attached_scopes: vec!["global".to_string()],
            is_built_in: false,
        };

        manager.upsert_persona(&custom_persona, None).unwrap();
        let updated_personas = manager.list_personas(None).unwrap();
        assert_eq!(updated_personas.len(), 5);
        assert!(updated_personas.iter().any(|p| p.id == "custom-bot"));
    }

    #[test]
    fn test_context_command_payload_serialization() {
        let page = ContextPage {
            id: "p1".to_string(),
            scope: "workspace".to_string(),
            category: "quirk".to_string(),
            path: "quirks/windows".to_string(),
            title: "Windows Quirk".to_string(),
            icon: "alert-triangle".to_string(),
            abstract_l0: "PTY handles CR-LF".to_string(),
            overview_l1: "Detailed PTY explanation".to_string(),
            details_l2: Some("{\"key\":\"val\"}".to_string()),
            pinned: false,
            created_at: 100,
            updated_at: 200,
        };

        let json = serde_json::to_string(&page).unwrap();
        let deserialized: ContextPage = serde_json::from_str(&json).unwrap();
        assert_eq!(page, deserialized);

        let search_res = ContextSearchResult {
            id: "p1".to_string(),
            scope: "workspace".to_string(),
            category: "quirk".to_string(),
            path: "quirks/windows".to_string(),
            title: "Windows Quirk".to_string(),
            icon: "alert-triangle".to_string(),
            abstract_l0: "PTY handles CR-LF".to_string(),
            overview_l1: "Detailed PTY explanation".to_string(),
            snippet: "PTY handles <b>CR-LF</b>".to_string(),
        };
        let search_json = serde_json::to_string(&search_res).unwrap();
        let search_deserialized: ContextSearchResult = serde_json::from_str(&search_json).unwrap();
        assert_eq!(search_res, search_deserialized);

        let persona = AgentPersona {
            id: "debugger".to_string(),
            name: "Debugger".to_string(),
            icon: "bug".to_string(),
            tagline: "Pinpoint root causes".to_string(),
            system_prompt: "You are an elite debugger.".to_string(),
            attached_scopes: vec!["global".to_string(), "workspace".to_string()],
            is_built_in: true,
        };
        let persona_json = serde_json::to_string(&persona).unwrap();
        let persona_deserialized: AgentPersona = serde_json::from_str(&persona_json).unwrap();
        assert_eq!(persona, persona_deserialized);
    }
}
