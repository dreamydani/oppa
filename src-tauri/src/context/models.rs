use std::str::FromStr;
use serde::{Deserialize, Serialize};

pub use crate::context::context_page_list::ContextPageList;
use crate::context::enums::{ContextCategory, ContextScope};

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
        let attached_scopes: Vec<String> =
            serde_json::from_str(&page.attached_scopes_json).unwrap_or_default();
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
        let attached_scopes_json =
            serde_json::to_string(&self.attached_scopes).unwrap_or_else(|_| "[]".into());
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
        let err = p.validate().unwrap_err();
        assert_eq!(err, "id is required");
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
        let err = p.validate().unwrap_err();
        assert!(err.contains("category"));
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
        p.is_built_in = true;
        let persona = AgentPersona::from_context_page(&p);
        assert_eq!(persona.attached_scopes, vec!["quirks", "architecture"]);
        assert!(persona.is_built_in);

        let roundtrip = persona.to_context_page("global", 12345);
        assert_eq!(roundtrip.attached_scopes_json, r#"["quirks","architecture"]"#);
        assert_eq!(roundtrip.details_l2, None);
        assert!(roundtrip.is_built_in);
        assert_eq!(roundtrip.deleted_at, None);
    }
}

