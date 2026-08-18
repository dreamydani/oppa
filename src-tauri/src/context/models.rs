use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ContextPage {
    pub id: String,
    pub scope: String,       // "global" | "workspace"
    pub category: String,    // "architecture" | "quirk" | "runbook" | "preference" | "persona"
    pub path: String,        // e.g. "quirks/pty-ack", "personas/debugger"
    pub title: String,
    pub icon: String,
    pub abstract_l0: String, // ~100 tokens
    pub overview_l1: String, // ~1-2k tokens
    pub details_l2: Option<String>,
    pub pinned: bool,
    pub created_at: i64,
    pub updated_at: i64,
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
        let is_built_in = matches!(
            page.id.as_str(),
            "debugger" | "optimizer" | "researcher" | "test_architect"
        );
        let attached_scopes: Vec<String> = page
            .details_l2
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();

        Self {
            id: page.id.clone(),
            name: page.title.clone(),
            icon: page.icon.clone(),
            tagline: page.abstract_l0.clone(),
            system_prompt: page.overview_l1.clone(),
            attached_scopes,
            is_built_in,
        }
    }

    pub fn to_context_page(&self, scope: &str, now: i64) -> ContextPage {
        let details_l2 = serde_json::to_string(&self.attached_scopes).ok();
        ContextPage {
            id: self.id.clone(),
            scope: scope.to_string(),
            category: "persona".to_string(),
            path: format!("personas/{}", self.id),
            title: self.name.clone(),
            icon: self.icon.clone(),
            abstract_l0: self.tagline.clone(),
            overview_l1: self.system_prompt.clone(),
            details_l2,
            pinned: false,
            created_at: now,
            updated_at: now,
        }
    }
}
