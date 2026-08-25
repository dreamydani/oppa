// Registry persistence for repo/worktree records backing the worktree engine; wired into commands in a later task.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum WorktreeStatus {
    #[default]
    #[serde(rename = "todo")]
    Todo,
    #[serde(rename = "in-progress")]
    InProgress,
    #[serde(rename = "in-review")]
    InReview,
    #[serde(rename = "completed")]
    Completed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RepoRecord {
    pub repo_id: String,
    pub path: PathBuf,
    pub default_base_ref: Option<String>,
    pub worktree_base_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreeRecord {
    pub id: String,
    pub repo_id: String,
    pub name: String,
    pub display_name: Option<String>,
    pub branch: String,
    pub path: PathBuf,
    pub base_ref: String,
    pub parent_worktree_id: Option<String>,
    pub child_worktree_ids: Vec<String>,
    pub workspace_status: WorktreeStatus,
    pub retired: bool,
    pub created_at_ms: u64,
    pub linked_pr_url: Option<String>,
}

// Forward slashes keep ids stable across Windows/POSIX representations of the same path.
pub fn worktree_record_id(repo_id: &str, path: &Path) -> String {
    format!("{repo_id}::{}", path.to_string_lossy().replace('\\', "/"))
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WorktreeRegistry {
    pub repos: HashMap<String, RepoRecord>,
    pub worktrees: HashMap<String, WorktreeRecord>,
}

impl WorktreeRegistry {
    // Unreadable or corrupt files degrade to empty; save rewrites atomically on next mutation.
    pub fn load(path: &Path) -> WorktreeRegistry {
        let Ok(text) = std::fs::read_to_string(path) else {
            return WorktreeRegistry::default();
        };
        serde_json::from_str(&text).unwrap_or_default()
    }

    // Atomic via tmp+rename so a crash never leaves a truncated registry.
    pub fn save(&self, path: &Path) -> Result<(), String> {
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        crate::atomic_file::write_atomic(path, &json).map_err(|e| e.to_string())
    }

    pub fn upsert_repo(&mut self, record: RepoRecord) {
        self.repos.insert(record.repo_id.clone(), record);
    }

    pub fn get_repo(&self, repo_id: &str) -> Option<&RepoRecord> {
        self.repos.get(repo_id)
    }

    pub fn remove_repo(&mut self, repo_id: &str) -> Option<RepoRecord> {
        self.repos.remove(repo_id)
    }

    pub fn upsert_worktree(&mut self, record: WorktreeRecord) {
        self.worktrees.insert(record.id.clone(), record);
    }

    pub fn get_worktree(&self, id: &str) -> Option<&WorktreeRecord> {
        self.worktrees.get(id)
    }

    pub fn remove_worktree(&mut self, id: &str) -> Option<WorktreeRecord> {
        self.worktrees.remove(id)
    }

    pub fn find_by_name(&self, repo_id: &str, name: &str) -> Option<WorktreeRecord> {
        self.worktrees
            .values()
            .find(|w| w.repo_id == repo_id && !w.retired && w.name == name)
            .cloned()
    }

    // Retired tombstones still reserve their name so ids/paths are never reused.
    pub fn name_reserved(&self, repo_id: &str, name: &str) -> bool {
        self.worktrees
            .values()
            .any(|w| w.repo_id == repo_id && w.name == name)
    }

    pub fn children_of(&self, id: &str) -> Vec<WorktreeRecord> {
        let mut children: Vec<WorktreeRecord> = self
            .worktrees
            .values()
            .filter(|w| w.parent_worktree_id.as_deref() == Some(id))
            .cloned()
            .collect();
        children.sort_by_key(|w| w.created_at_ms);
        children
    }

    pub fn lineage_root_of(&self, id: &str) -> Option<String> {
        let mut current = self.worktrees.get(id)?;
        while let Some(parent_id) = current.parent_worktree_id.as_deref() {
            current = self.worktrees.get(parent_id)?;
        }
        Some(current.id.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_repo(repo_id: &str) -> RepoRecord {
        RepoRecord {
            repo_id: repo_id.to_string(),
            path: PathBuf::from("/tmp/sample-repo"),
            default_base_ref: Some("main".into()),
            worktree_base_path: None,
        }
    }

    fn sample_worktree(id: &str, name: &str) -> WorktreeRecord {
        WorktreeRecord {
            id: id.to_string(),
            repo_id: "sample".into(),
            name: name.to_string(),
            display_name: Some("Sample 工作区 café 🚀".into()),
            branch: "sample-branch".into(),
            path: PathBuf::from("C:\\ws\\sample"),
            base_ref: "main".into(),
            parent_worktree_id: None,
            child_worktree_ids: vec!["child-1".into()],
            workspace_status: WorktreeStatus::InProgress,
            retired: false,
            created_at_ms: 1723900000000,
            linked_pr_url: Some("https://example.com/pr/1".into()),
        }
    }

    #[test]
    fn status_serializes_with_lowercase_hyphenated_values() {
        assert_eq!(
            serde_json::to_value(WorktreeStatus::Todo).unwrap(),
            serde_json::json!("todo")
        );
        assert_eq!(
            serde_json::to_value(WorktreeStatus::InProgress).unwrap(),
            serde_json::json!("in-progress")
        );
        assert_eq!(
            serde_json::to_value(WorktreeStatus::InReview).unwrap(),
            serde_json::json!("in-review")
        );
        assert_eq!(
            serde_json::to_value(WorktreeStatus::Completed).unwrap(),
            serde_json::json!("completed")
        );
        assert_eq!(WorktreeStatus::default(), WorktreeStatus::Todo);
    }

    #[test]
    fn registry_roundtrip_preserves_all_fields_including_unicode() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("oppa-reg-rt-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("registry.json");

        let mut registry = WorktreeRegistry::default();
        registry.upsert_repo(sample_repo("sample"));
        let mut wt = sample_worktree("sample::C:/ws/工作区-café", "工作区-café");
        wt.path = PathBuf::from("C:\\ws\\工作区-café");
        registry.upsert_worktree(wt);

        registry.save(&file).unwrap();
        let loaded = WorktreeRegistry::load(&file);

        assert_eq!(loaded, registry);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn load_missing_file_returns_empty_registry() {
        let missing = std::env::temp_dir().join(format!("oppa-reg-missing-{}-{:?}.json", std::process::id(), std::time::SystemTime::now()));
        let loaded = WorktreeRegistry::load(&missing);
        assert!(loaded.repos.is_empty());
        assert!(loaded.worktrees.is_empty());
    }

    #[test]
    fn name_reservation_includes_retired_tombstones_but_find_by_name_skips_them() {
        let mut registry = WorktreeRegistry::default();
        let mut wt = sample_worktree("sample::C:/ws/gone", "gone");
        wt.retired = true;
        registry.upsert_worktree(wt);

        assert!(registry.name_reserved("sample", "gone"));
        assert!(!registry.name_reserved("other", "gone"));
        assert!(registry.find_by_name("sample", "gone").is_none());
    }

    #[test]
    fn lineage_walks_parents_to_root_and_children_lookup_matches() {
        let mut registry = WorktreeRegistry::default();
        let mut root = sample_worktree("root", "root");
        root.parent_worktree_id = None;
        let mut mid = sample_worktree("mid", "mid");
        mid.parent_worktree_id = Some("root".into());
        let mut leaf = sample_worktree("leaf", "leaf");
        leaf.parent_worktree_id = Some("mid".into());
        registry.upsert_worktree(root);
        registry.upsert_worktree(mid);
        registry.upsert_worktree(leaf);

        assert_eq!(registry.lineage_root_of("leaf").as_deref(), Some("root"));
        assert_eq!(registry.lineage_root_of("mid").as_deref(), Some("root"));
        assert_eq!(registry.children_of("root").len(), 1);
        assert_eq!(registry.children_of("mid")[0].id, "leaf");
        assert_eq!(registry.children_of("missing"), Vec::<WorktreeRecord>::new());
    }

    #[test]
    fn record_id_normalizes_backslashes_to_forward_slashes() {
        let id = worktree_record_id("myrepo", &PathBuf::from("C:\\ws\\feat-x"));
        assert_eq!(id, "myrepo::C:/ws/feat-x");
    }
}
