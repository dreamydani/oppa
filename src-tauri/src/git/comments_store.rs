// Minimal JSON-file store for diff comments keyed by worktree id; task 8 hardens validation polish.
#![allow(dead_code)]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub const MAX_COMMENT_BODY_CHARS: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiffCommentSource {
    Diff,
    Markdown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiffCommentScope {
    Unstaged,
    Staged,
    Branch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffComment {
    pub id: String,
    pub worktree_id: String,
    pub file_path: String,
    pub source: DiffCommentSource,
    pub selected_text: Option<String>,
    pub start_line: Option<u32>,
    pub line_number: u32,
    pub body: String,
    pub scope: DiffCommentScope,
    pub old_path: Option<String>,
    pub created_at_ms: u64,
    pub updated_at_ms: Option<u64>,
    pub sent_at: Option<u64>,
}

// Add-request payload; daemon assigns id/created_at_ms so clients never invent identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewDiffComment {
    pub worktree_id: String,
    pub file_path: String,
    pub source: DiffCommentSource,
    #[serde(default)]
    pub selected_text: Option<String>,
    #[serde(default)]
    pub start_line: Option<u32>,
    pub line_number: u32,
    pub body: String,
    pub scope: DiffCommentScope,
    #[serde(default)]
    pub old_path: Option<String>,
}

pub type CommentsFile = HashMap<String, Vec<DiffComment>>;

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn load(path: &Path) -> CommentsFile {
    let Ok(text) = std::fs::read_to_string(path) else {
        return CommentsFile::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

// Atomic via tmp+rename so a crash never leaves a truncated comment file.
fn save(path: &Path, comments: &CommentsFile) -> Result<(), String> {
    let json = serde_json::to_string_pretty(comments).map_err(|e| e.to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut tmp_name = path.as_os_str().to_os_string();
    tmp_name.push(".tmp");
    let tmp_path = PathBuf::from(tmp_name);
    std::fs::write(&tmp_path, json).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp_path, path).map_err(|e| e.to_string())
}

fn validate_new(comment: &NewDiffComment) -> Result<(), String> {
    if comment.worktree_id.trim().is_empty() {
        return Err("worktree_id required".into());
    }
    if comment.line_number < 1 {
        return Err("line_number must be >= 1".into());
    }
    validate_body(&comment.body)
}

fn validate_body(body: &str) -> Result<(), String> {
    if body.trim().is_empty() {
        return Err("comment body required".into());
    }
    if body.chars().count() > MAX_COMMENT_BODY_CHARS {
        return Err(format!(
            "comment body exceeds {MAX_COMMENT_BODY_CHARS} chars"
        ));
    }
    Ok(())
}

pub fn comment_add(store_path: &Path, new: NewDiffComment) -> Result<DiffComment, String> {
    validate_new(&new)?;
    let mut comments = load(store_path);
    let comment = DiffComment {
        id: uuid::Uuid::new_v4().to_string(),
        worktree_id: new.worktree_id,
        file_path: new.file_path,
        source: new.source,
        selected_text: new.selected_text,
        start_line: new.start_line,
        line_number: new.line_number,
        body: new.body,
        scope: new.scope,
        old_path: new.old_path,
        created_at_ms: now_ms(),
        updated_at_ms: None,
        sent_at: None,
    };
    comments
        .entry(comment.worktree_id.clone())
        .or_default()
        .push(comment.clone());
    save(store_path, &comments)?;
    Ok(comment)
}

pub fn comment_update(store_path: &Path, id: &str, body: &str) -> Result<DiffComment, String> {
    validate_body(body)?;
    let mut comments = load(store_path);
    let mut updated = None;
    for list in comments.values_mut() {
        for comment in list.iter_mut() {
            if comment.id == id {
                comment.body = body.to_string();
                comment.updated_at_ms = Some(now_ms());
                updated = Some(comment.clone());
            }
        }
    }
    let updated = updated.ok_or_else(|| format!("comment not found: {id}"))?;
    save(store_path, &comments)?;
    Ok(updated)
}

pub fn comment_delete(store_path: &Path, id: &str) -> Result<(), String> {
    let mut comments = load(store_path);
    let before = comments
        .values()
        .map(Vec::len)
        .sum::<usize>();
    for list in comments.values_mut() {
        list.retain(|comment| comment.id != id);
    }
    let after = comments
        .values()
        .map(Vec::len)
        .sum::<usize>();
    if before == after {
        return Err(format!("comment not found: {id}"));
    }
    save(store_path, &comments)
}

pub fn comments_list(store_path: &Path, worktree_id: &str) -> Result<Vec<DiffComment>, String> {
    Ok(load(store_path)
        .get(worktree_id)
        .cloned()
        .unwrap_or_default())
}

// Only listed ids that exist get stamped; the stamped set comes back so callers can re-render.
pub fn comments_mark_sent(
    store_path: &Path,
    ids: &[String],
) -> Result<Vec<DiffComment>, String> {
    let stamp = now_ms();
    let mut comments = load(store_path);
    let mut stamped = Vec::new();
    for list in comments.values_mut() {
        for comment in list.iter_mut() {
            if ids.contains(&comment.id) && comment.sent_at.is_none() {
                comment.sent_at = Some(stamp);
                stamped.push(comment.clone());
            }
        }
    }
    if !stamped.is_empty() || ids.iter().any(|id| contains_comment(&comments, id)) {
        save(store_path, &comments)?;
    }
    Ok(stamped)
}

fn contains_comment(comments: &CommentsFile, id: &str) -> bool {
    comments
        .values()
        .any(|list| list.iter().any(|c| c.id == id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("oppa-comments-{tag}-{}-{nanos}.json", std::process::id()))
    }

    fn sample_new(worktree_id: &str) -> NewDiffComment {
        NewDiffComment {
            worktree_id: worktree_id.into(),
            file_path: "src/lib.rs".into(),
            source: DiffCommentSource::Diff,
            selected_text: Some("let x = 1;".into()),
            start_line: Some(10),
            line_number: 12,
            body: "why here?".into(),
            scope: DiffCommentScope::Unstaged,
            old_path: None,
        }
    }

    #[test]
    fn add_assigns_uuid_and_created_and_persists_across_reload() {
        let path = temp_store("add-reload");
        let added = comment_add(&path, sample_new("wt-a")).unwrap();
        assert_eq!(added.line_number, 12);
        assert!(!added.id.is_empty());
        assert!(added.created_at_ms > 0);
        assert_eq!(added.updated_at_ms, None);
        assert_eq!(added.sent_at, None);

        // Same file read back by a "fresh process" sees the record
        let listed = comments_list(&path, "wt-a").unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, added.id);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn add_rejects_empty_worktree_zero_line_and_blank_body() {
        let path = temp_store("validate");
        let mut bad = sample_new("");
        assert!(matches!(
            comment_add(&path, bad.clone()),
            Err(msg) if msg.contains("worktree_id")
        ));
        bad.worktree_id = "wt".into();
        bad.line_number = 0;
        assert!(matches!(
            comment_add(&path, bad.clone()),
            Err(msg) if msg.contains("line_number")
        ));
        bad.line_number = 1;
        bad.body = "   ".into();
        assert!(matches!(
            comment_add(&path, bad),
            Err(msg) if msg.contains("body")
        ));
        assert!(!path.exists(), "failed adds must not create the store");
    }

    #[test]
    fn add_rejects_oversized_body() {
        let path = temp_store("oversize");
        let mut big = sample_new("wt-big");
        big.body = "x".repeat(MAX_COMMENT_BODY_CHARS + 1);
        let err = comment_add(&path, big).unwrap_err();
        assert!(err.contains("exceeds"), "{err}");
    }

    #[test]
    fn update_changes_body_stamps_updated_and_errors_on_unknown_id() {
        let path = temp_store("update");
        let added = comment_add(&path, sample_new("wt-u")).unwrap();
        let updated = comment_update(&path, &added.id, "new body").unwrap();
        assert_eq!(updated.body, "new body");
        assert!(updated.updated_at_ms.unwrap_or(0) >= added.created_at_ms);

        assert!(comment_update(&path, "ghost", "x").is_err());
        assert!(comment_update(&path, &added.id, " ").is_err());

        let listed = comments_list(&path, "wt-u").unwrap();
        assert_eq!(listed[0].body, "new body");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn delete_removes_only_target_and_errors_when_absent() {
        let path = temp_store("delete");
        let keep = comment_add(&path, sample_new("wt-d")).unwrap();
        let mut other = sample_new("wt-d");
        other.file_path = "other.txt".into();
        let gone = comment_add(&path, other).unwrap();

        comment_delete(&path, &gone.id).unwrap();
        assert!(comment_delete(&path, &gone.id).is_err());
        let listed = comments_list(&path, "wt-d").unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, keep.id);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn mark_sent_stamps_existing_ids_once_and_skips_unknowns() {
        let path = temp_store("mark-sent");
        let a = comment_add(&path, sample_new("wt-m")).unwrap();
        let b = comment_add(&path, sample_new("wt-m")).unwrap();

        let stamped = comments_mark_sent(&path, &[a.id.clone(), "ghost".into()]).unwrap();
        assert_eq!(stamped.len(), 1);
        assert_eq!(stamped[0].id, a.id);
        assert!(stamped[0].sent_at.unwrap_or(0) > 0);

        // Already-stamped ids stay untouched on repeat
        let again = comments_mark_sent(&path, &[a.id.clone(), b.id.clone()]).unwrap();
        assert_eq!(again.len(), 1);
        assert_eq!(again[0].id, b.id);

        let listed = comments_list(&path, "wt-m").unwrap();
        assert!(listed.iter().find(|c| c.id == a.id).unwrap().sent_at.is_some());
        assert!(listed.iter().find(|c| c.id == b.id).unwrap().sent_at.is_some());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn list_isolates_worktrees_and_defaults_empty_for_unknown() {
        let path = temp_store("isolate");
        comment_add(&path, sample_new("wt-1")).unwrap();
        comment_add(&path, sample_new("wt-2")).unwrap();
        assert_eq!(comments_list(&path, "wt-1").unwrap().len(), 1);
        assert_eq!(comments_list(&path, "wt-2").unwrap().len(), 1);
        assert!(comments_list(&path, "missing").unwrap().is_empty());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn corrupt_or_missing_store_degrades_to_empty() {
        let path = temp_store("corrupt");
        std::fs::write(&path, "{not json").unwrap();
        assert!(comments_list(&path, "wt").unwrap().is_empty());
        std::fs::remove_file(&path).ok();
        assert!(comments_list(&temp_store("never-written"), "wt").unwrap().is_empty());
    }

    #[test]
    fn wire_values_are_kebab_case_snake_keys() {
        let json = serde_json::to_value(sample_new("wt")).unwrap();
        assert_eq!(json["source"], "diff");
        assert_eq!(json["scope"], "unstaged");
        assert_eq!(json["line_number"], 12);
        assert_eq!(json["start_line"], 10);
        let roundtrip: NewDiffComment =
            serde_json::from_str(r#"{"worktree_id":"w","file_path":"f","source":"markdown","line_number":3,"body":"b","scope":"branch"}"#).unwrap();
        assert_eq!(roundtrip.source, DiffCommentSource::Markdown);
        assert_eq!(roundtrip.scope, DiffCommentScope::Branch);
        assert_eq!(roundtrip.selected_text, None);
    }
}
