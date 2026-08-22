// Teardown-proof gate: removal must be proven safe against live sessions before any git mutation.
#![allow(dead_code)]

use crate::git::worktree_registry::WorktreeRecord;
use crate::git::worktrees::{contains_path, normalize_path_string, normalize_slashes, to_regular_path};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeardownBlocker {
    pub session_id: String,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveSession {
    pub session_id: String,
    pub cwd: Option<String>,
    pub worktree_id: Option<String>,
}

pub fn prove_no_live_sessions(
    live: &[LiveSession],
    worktree: &WorktreeRecord,
) -> Result<(), Vec<TeardownBlocker>> {
    let mut blockers = Vec::new();
    for session in live {
        if session.worktree_id.as_deref() == Some(worktree.id.as_str()) {
            blockers.push(TeardownBlocker {
                session_id: session.session_id.clone(),
                detail: format!("attached to worktree {}", worktree.id),
            });
            continue;
        }
        let Some(cwd) = session.cwd.as_deref() else {
            continue;
        };
        if session_cwd_inside(cwd, worktree) {
            blockers.push(TeardownBlocker {
                session_id: session.session_id.clone(),
                detail: format!("cwd {cwd} inside {}", worktree.path.display()),
            });
        }
    }
    if blockers.is_empty() {
        Ok(())
    } else {
        Err(blockers)
    }
}

// Canonicalize when the path exists; fall back to lexical comparison after slash/case normalization.
fn session_cwd_inside(cwd: &str, worktree: &WorktreeRecord) -> bool {
    let resolved = match std::fs::canonicalize(cwd) {
        Ok(canonical) => normalize_path_string(&to_regular_path(canonical)),
        Err(_) => normalize_slashes(cwd),
    };
    let base = normalize_path_string(&worktree.path);
    contains_path(&base, &resolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn worktree(id: &str, path: &str) -> WorktreeRecord {
        WorktreeRecord {
            id: id.to_string(),
            repo_id: "sample".into(),
            name: id.to_string(),
            display_name: None,
            branch: "br".into(),
            path: PathBuf::from(path),
            base_ref: "main".into(),
            parent_worktree_id: None,
            child_worktree_ids: Vec::new(),
            workspace_status: Default::default(),
            retired: false,
            created_at_ms: 1,
            linked_pr_url: None,
        }
    }

    fn session(id: &str, cwd: Option<&str>, worktree_id: Option<&str>) -> LiveSession {
        LiveSession {
            session_id: id.to_string(),
            cwd: cwd.map(str::to_string),
            worktree_id: worktree_id.map(str::to_string),
        }
    }

    #[test]
    fn blocks_when_session_is_attached_by_worktree_id() {
        let target = worktree("sample::C:/ws/alpha", "C:\\ws\\alpha");
        let live = vec![
            session("s1", None, Some("sample::C:/ws/alpha")),
            session("s2", Some("C:\\elsewhere"), Some("other")),
        ];
        let err = prove_no_live_sessions(&live, &target).unwrap_err();
        assert_eq!(err.len(), 1);
        assert_eq!(err[0].session_id, "s1");
        assert_eq!(
            prove_no_live_sessions(
                &[session("s3", None, Some("unrelated"))],
                &target
            ),
            Ok(())
        );
    }

    #[test]
    fn none_cwd_and_none_worktree_id_never_blocks() {
        let target = worktree("wt", "C:\\ws\\alpha");
        assert_eq!(
            prove_no_live_sessions(&[session("idle", None, None)], &target),
            Ok(())
        );
    }

    #[test]
    fn blocks_when_cwd_normalizes_under_worktree_path() {
        let target = worktree("wt-alpha", "C:\\ws\\feat-x");
        let live = vec![session("sh", Some("C:\\ws\\feat-x\\src\\deep"), None)];
        let err = prove_no_live_sessions(&live, &target).unwrap_err();
        assert_eq!(err.len(), 1);
        assert_eq!(err[0].session_id, "sh");
        assert!(err[0].detail.contains("cwd"));
    }

    #[test]
    fn sibling_directory_cwd_does_not_block() {
        let target = worktree("wt-alpha", "C:\\ws\\feat-x");
        let siblings = vec![
            session("sib", Some("C:\\ws\\feat-x-other"), None),
            session("glued", Some("C:\\ws\\feat-xtra"), None),
            session("parent", Some("C:\\ws"), None),
        ];
        assert_eq!(prove_no_live_sessions(&siblings, &target), Ok(()));
    }

    #[test]
    fn existing_cwd_canonicalizes_before_containment_check() {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("oppa-teardown-{}-{nanos}", std::process::id()));
        let ws = root.join("alpha");
        std::fs::create_dir_all(ws.join("sub")).unwrap();
        let sibling = root.join("beta");
        std::fs::create_dir_all(&sibling).unwrap();

        // Records never store verbatim \\?\ paths, so mirror production representation.
        let target = worktree(
            "wt-real",
            &to_regular_path(ws.canonicalize().unwrap()).to_string_lossy(),
        );
        let inside = LiveSession {
            session_id: "inside".into(),
            cwd: Some(ws.join("sub").to_string_lossy().into_owned()),
            worktree_id: None,
        };
        let outside = LiveSession {
            session_id: "outside".into(),
            cwd: Some(sibling.canonicalize().unwrap().to_string_lossy().into_owned()),
            worktree_id: None,
        };
        assert_eq!(prove_no_live_sessions(&[outside], &target), Ok(()));
        assert_eq!(prove_no_live_sessions(&[inside], &target).unwrap_err().len(), 1);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn all_blockers_reported_not_just_first() {
        let target = worktree("wt-multi", "C:\\ws\\multi");
        let live = vec![
            session("by-id", None, Some("wt-multi")),
            session("by-cwd", Some("C:\\ws\\multi\\nested"), None),
            session("clean", Some("C:\\elsewhere"), None),
        ];
        let err = prove_no_live_sessions(&live, &target).unwrap_err();
        assert_eq!(err.len(), 2);
        assert!(err.iter().any(|b| b.session_id == "by-id"));
        assert!(err.iter().any(|b| b.session_id == "by-cwd"));
    }
}
