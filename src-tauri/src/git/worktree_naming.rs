// Pure naming helpers consumed by worktree commands in a later task.
#![allow(dead_code)]

use std::ffi::OsString;
use std::path::{Component, Path, PathBuf};

const INVALID_NAME: &str = "Invalid worktree name";
const INVALID_PATH: &str = "Invalid worktree path";
// Approximation of unicode Emoji_Presentation sufficient for fallback detection.
fn has_emoji(input: &str) -> bool {
    input.chars().any(|c| {
        let cp = c as u32;
        (0x1F300..=0x1FAFF).contains(&cp) || (0x2600..=0x27BF).contains(&cp)
    })
}

// Sanitizing cannot make ".." segments safe, so traversal attempts are rejected outright.
fn is_path_traversal(input: &str) -> bool {
    input.split(['/', '\\']).any(|seg| seg == "..")
}

pub(crate) fn sanitize_name(input: &str) -> Result<String, String> {
    let trimmed = input.trim();
    if is_path_traversal(trimmed) {
        return Err(INVALID_NAME.into());
    }

    let mut replaced = String::new();
    let mut prev_invalid = false;
    for c in trimmed.chars() {
        let allowed =
            c.is_alphabetic() || c.is_numeric() || c == '.' || c == '_' || c == '-';
        if allowed {
            replaced.push(c);
            prev_invalid = false;
        } else if !prev_invalid {
            replaced.push('-');
            prev_invalid = true;
        }
    }

    let mut collapsed = String::new();
    let mut dot_run = 0usize;
    for c in replaced.chars() {
        if c == '.' {
            dot_run += 1;
            if dot_run == 1 {
                collapsed.push('.');
            }
        } else {
            dot_run = 0;
            collapsed.push(c);
        }
    }

    let result = collapsed.trim_matches(|c| c == '.' || c == '-');
    if result.is_empty() {
        if has_emoji(trimmed) {
            return Ok("workspace".to_string());
        }
        return Err(INVALID_NAME.into());
    }
    if result == "." || result == ".." {
        return Err(INVALID_NAME.into());
    }
    Ok(result.to_string())
}

pub(crate) fn normalize_branch_prefix(raw: &str) -> String {
    raw.trim()
        .split('/')
        .filter(|seg| !seg.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

pub(crate) fn branch_prefix_issue(prefix: &str) -> Option<&'static str> {
    let p = normalize_branch_prefix(prefix);
    if p.is_empty() {
        return None;
    }

    let bad_char = p.chars().any(|c| {
        let cp = c as u32;
        cp < 0x20
            || c == ' '
            || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\')
    });
    if bad_char
        || p.contains("..")
        || p.contains("@{")
        || p.starts_with('-')
        || p.ends_with('.')
        || p.split('/').any(|seg| seg.starts_with('.') || seg.ends_with(".lock"))
    {
        return Some("invalid-characters");
    }
    None
}

pub(crate) fn compute_branch_name(sanitized: &str, prefix: Option<&str>) -> String {
    match prefix.map(normalize_branch_prefix) {
        Some(p) if !p.is_empty() => format!("{p}/{sanitized}"),
        _ => sanitized.to_string(),
    }
}

pub(crate) fn compute_validated_branch_name(
    sanitized: &str,
    prefix: Option<&str>,
) -> Result<String, String> {
    if let Some(raw) = prefix {
        if !normalize_branch_prefix(raw).is_empty()
            && branch_prefix_issue(raw).is_some()
        {
            return Err(format!(
                "Branch prefix \"{raw}\" contains characters git rejects"
            ));
        }
    }
    Ok(compute_branch_name(sanitized, prefix))
}

// Case-insensitive so Windows-cased ".GIT" remotes resolve to the same repo name.
fn strip_git_suffix(name: &str) -> Option<&str> {
    let cut = name.len().checked_sub(4)?;
    (name.is_char_boundary(cut) && name[cut..].eq_ignore_ascii_case(".git")).then_some(&name[..cut])
}

fn repo_dir_name(repo_path: &Path) -> String {
    let name = repo_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    strip_git_suffix(&name).unwrap_or(&name).to_string()
}

pub(crate) fn compute_worktree_path(
    sanitized_name: &str,
    repo_path: &Path,
    workspace_dir: &Path,
    nest_workspaces: bool,
) -> PathBuf {
    let root = if workspace_dir.is_absolute() {
        workspace_dir.to_path_buf()
    } else {
        repo_path.join(workspace_dir)
    };
    if nest_workspaces {
        root.join(repo_dir_name(repo_path)).join(sanitized_name)
    } else {
        root.join(sanitized_name)
    }
}

// Canonicalize the nearest existing ancestor so not-yet-created leaves resolve deterministically.
fn resolve_best_effort(path: &Path) -> PathBuf {
    let mut missing: Vec<OsString> = Vec::new();
    let mut cur = path.to_path_buf();
    loop {
        match cur.canonicalize() {
            Ok(canon) => {
                let mut resolved = canon;
                for comp in missing.iter().rev() {
                    resolved.push(comp);
                }
                return resolved;
            }
            Err(_) => match (cur.file_name(), cur.parent()) {
                (Some(_), Some(parent)) if parent != cur => {
                    let last = cur.components().next_back().unwrap();
                    missing.push(last.as_os_str().to_os_string());
                    cur = parent.to_path_buf();
                }
                _ => break,
            },
        }
    }

    let mut parts: Vec<Component> = Vec::new();
    for comp in path.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(parts.last(), Some(Component::Normal(_))) {
                    parts.pop();
                }
            }
            other => parts.push(other),
        }
    }
    let mut out = PathBuf::new();
    for comp in parts {
        out.push(comp.as_os_str());
    }
    out
}

pub(crate) fn ensure_path_within_workspace(
    target: &Path,
    workspace_dir: &Path,
) -> Result<PathBuf, String> {
    let ws = resolve_best_effort(workspace_dir);
    let resolved = resolve_best_effort(target);
    let rel = resolved.strip_prefix(&ws).map_err(|_| INVALID_PATH.to_string())?;
    if matches!(rel.components().next(), Some(Component::ParentDir)) {
        return Err(INVALID_PATH.into());
    }
    Ok(resolved)
}

pub(crate) fn sanitize_display_name(input: &str) -> Option<String> {
    let cleaned: String = input
        .chars()
        .filter(|c| {
            let cp = *c as u32;
            !(0x202A..=0x202E).contains(&cp) && !(0x2066..=0x2069).contains(&cp)
        })
        .map(|c| {
            let cp = c as u32;
            if cp <= 0x1F || (0x7F..=0x9F).contains(&cp) { ' ' } else { c }
        })
        .collect();

    let mut collapsed = String::new();
    let mut in_space = false;
    for c in cleaned.chars() {
        if c.is_whitespace() {
            in_space = true;
        } else {
            if in_space && !collapsed.is_empty() {
                collapsed.push(' ');
            }
            collapsed.push(c);
            in_space = false;
        }
    }

    let truncated: String = collapsed.chars().take(120).collect();
    let trimmed = truncated.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub(crate) fn should_set_display_name(
    requested: &str,
    branch_name: &str,
    sanitized: &str,
) -> bool {
    !(branch_name == requested && sanitized == requested)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_rejects_dotdot_traversal() {
        assert_eq!(sanitize_name("../.."), Err("Invalid worktree name".into()));
    }

    #[test]
    fn sanitize_rejects_parent_escape_with_leaf() {
        assert_eq!(sanitize_name("../../foo"), Err("Invalid worktree name".into()));
    }

    #[test]
    fn sanitize_basic_replacement() {
        assert_eq!(sanitize_name("My Feature!").unwrap(), "My-Feature");
    }

    #[test]
    fn sanitize_collapses_separators_and_punctuation() {
        assert_eq!(sanitize_name("  weird///name??  ").unwrap(), "weird-name");
    }

    #[test]
    fn sanitize_collapses_dotted_run() {
        assert_eq!(sanitize_name("a...b").unwrap(), "a.b");
    }

    #[test]
    fn sanitize_trims_edge_dots_and_dashes() {
        assert_eq!(sanitize_name("-leading-").unwrap(), "leading");
    }

    #[test]
    fn sanitize_preserves_accented_latin() {
        assert_eq!(sanitize_name("café").unwrap(), "café");
    }

    #[test]
    fn sanitize_preserves_cjk() {
        assert_eq!(sanitize_name("工作区 2").unwrap(), "工作区-2");
    }

    #[test]
    fn sanitize_emoji_only_becomes_workspace() {
        assert_eq!(sanitize_name("🚀").unwrap(), "workspace");
    }

    #[test]
    fn sanitize_single_dot_is_error() {
        assert_eq!(sanitize_name("."), Err("Invalid worktree name".into()));
    }

    #[test]
    fn sanitize_empty_is_error() {
        assert_eq!(sanitize_name(""), Err("Invalid worktree name".into()));
    }

    #[test]
    fn sanitize_lock_like_name_passes_through() {
        assert_eq!(sanitize_name("feature.lock-name").unwrap(), "feature.lock-name");
    }

    #[test]
    fn normalize_trims_and_strips_edges() {
        assert_eq!(normalize_branch_prefix(" team/ "), "team");
    }

    #[test]
    fn normalize_collapses_internal_slashes() {
        assert_eq!(normalize_branch_prefix("team//frontend"), "team/frontend");
    }

    #[test]
    fn normalize_keeps_multi_segment() {
        assert_eq!(normalize_branch_prefix(" team/frontend "), "team/frontend");
    }

    #[test]
    fn normalize_empty_and_slash_only_become_empty() {
        assert_eq!(normalize_branch_prefix(""), "");
        assert_eq!(normalize_branch_prefix("///"), "");
        assert_eq!(normalize_branch_prefix("a///b"), "a/b");
        assert_eq!(normalize_branch_prefix("////team////x"), "team/x");
    }

    #[test]
    fn prefix_issue_none_cases() {
        assert_eq!(branch_prefix_issue(""), None);
        assert_eq!(branch_prefix_issue("team"), None);
        assert_eq!(branch_prefix_issue("team.frontend/x-y"), None);
        assert_eq!(branch_prefix_issue("comma,name"), None);
        assert_eq!(branch_prefix_issue("///"), None);
    }

    #[test]
    fn prefix_issue_some_cases() {
        assert_eq!(branch_prefix_issue("bad~name"), Some("invalid-characters"));
        assert_eq!(branch_prefix_issue("x..y"), Some("invalid-characters"));
        assert_eq!(branch_prefix_issue("@{z"), Some("invalid-characters"));
        assert_eq!(branch_prefix_issue("-lead"), Some("invalid-characters"));
        assert_eq!(branch_prefix_issue("trail."), Some("invalid-characters"));
        assert_eq!(branch_prefix_issue("seg/.start"), Some("invalid-characters"));
        assert_eq!(branch_prefix_issue("seg/end.lock"), Some("invalid-characters"));
        assert_eq!(branch_prefix_issue("has space"), Some("invalid-characters"));
    }

    #[test]
    fn validated_branch_name_with_clean_prefix() {
        assert_eq!(
            compute_validated_branch_name("feature-x", Some("danial")).unwrap(),
            "danial/feature-x"
        );
    }

    #[test]
    fn validated_branch_name_with_dirty_prefix_errors() {
        let err = compute_validated_branch_name("f", Some("bad~")).unwrap_err();
        assert!(err.contains("contains characters git rejects"));
    }

    #[test]
    fn validated_branch_name_without_prefix() {
        assert_eq!(compute_validated_branch_name("f", None).unwrap(), "f");
    }

    #[test]
    fn branch_name_formats_normalized_prefix() {
        assert_eq!(compute_branch_name("feat", Some(" team// ")), "team/feat");
        assert_eq!(compute_branch_name("feat", None), "feat");
    }

    #[test]
    fn worktree_path_nests_repo_dir_when_requested() {
        let repo = std::env::temp_dir().join("oppa-wtn-repo-nest");
        let ws = std::env::temp_dir().join("oppa-wtn-ws-abs");
        let path = compute_worktree_path("feat-a", &repo, &ws, true);
        assert_eq!(path, ws.join("oppa-wtn-repo-nest").join("feat-a"));
    }

    #[test]
    fn worktree_path_flat_when_not_nested() {
        let repo = std::env::temp_dir().join("oppa-wtn-repo-flat");
        let ws = std::env::temp_dir().join("oppa-wtn-ws-flat");
        let path = compute_worktree_path("feat-a", &repo, &ws, false);
        assert_eq!(path, ws.join("feat-a"));
    }

    #[test]
    fn worktree_path_strips_git_suffix_from_repo_name() {
        let repo = std::env::temp_dir().join("myproj.git");
        let ws = std::env::temp_dir().join("oppa-wtn-ws-git");
        let path = compute_worktree_path("w1", &repo, &ws, true);
        assert_eq!(path, ws.join("myproj").join("w1"));
    }

    #[test]
    fn worktree_path_resolves_relative_workspace_against_repo() {
        let repo = std::env::temp_dir().join("oppa-wtn-repo-rel");
        let rel_ws = Path::new(".worktrees");
        let nested = compute_worktree_path("w2", &repo, rel_ws, true);
        assert_eq!(nested, repo.join(".worktrees").join("oppa-wtn-repo-rel").join("w2"));
        let flat = compute_worktree_path("w2", &repo, rel_ws, false);
        assert_eq!(flat, repo.join(".worktrees").join("w2"));
    }

    fn temp_workspace(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("oppa-wtn-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("inner")).unwrap();
        dir
    }

    #[test]
    fn within_workspace_accepts_nested_new_leaf() {
        let ws = temp_workspace("ok");
        let target = ws.join("inner").join("new-worktree");
        let resolved = ensure_path_within_workspace(&target, &ws).unwrap();
        assert_eq!(
            resolved,
            std::fs::canonicalize(ws.join("inner")).unwrap().join("new-worktree")
        );
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn within_workspace_accepts_existing_target() {
        let ws = temp_workspace("exist");
        std::fs::create_dir_all(ws.join("existing")).unwrap();
        ensure_path_within_workspace(&ws.join("existing"), &ws).unwrap();
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn within_workspace_rejects_sibling_escape() {
        let ws = temp_workspace("sib");
        let target = ws.join("..").join(format!("escape-{}", std::process::id()));
        assert_eq!(
            ensure_path_within_workspace(&target, &ws),
            Err("Invalid worktree path".into())
        );
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn within_workspace_rejects_double_traversal() {
        let ws = temp_workspace("trav");
        let target = ws.join("..").join("..").join("etc-ish");
        assert_eq!(
            ensure_path_within_workspace(&target, &ws),
            Err("Invalid worktree path".into())
        );
        std::fs::remove_dir_all(&ws).ok();
    }

    #[test]
    fn display_name_strips_control_and_bidi_chars() {
        assert_eq!(sanitize_display_name("a\u{1}b\u{7f}c").as_deref(), Some("a b c"));
        assert_eq!(
            sanitize_display_name("abc\u{202E}def\u{2066}ghi").as_deref(),
            Some("abcdefghi")
        );
    }

    #[test]
    fn display_name_collapses_whitespace_and_trims() {
        assert_eq!(sanitize_display_name("  x\n\t y  ").as_deref(), Some("x y"));
    }

    #[test]
    fn display_name_truncates_multibyte_at_120_chars() {
        let input: String = "é".repeat(130);
        let out = sanitize_display_name(&input).unwrap();
        assert_eq!(out.chars().count(), 120);
    }

    #[test]
    fn display_name_empty_after_cleanup_is_none() {
        assert_eq!(sanitize_display_name(""), None);
        assert_eq!(sanitize_display_name("\u{202E}\u{0}"), None);
    }

    #[test]
    fn display_name_flag_truth_table() {
        assert!(!should_set_display_name("main", "main", "main"));
        assert!(should_set_display_name("main", "main", "Main"));
        assert!(should_set_display_name("main", "origin/main", "main"));
        assert!(should_set_display_name("main", "other", "other"));
    }
}
