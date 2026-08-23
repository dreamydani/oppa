// Source-control service ops over argv-only git; reached via daemon git.* requests in a later task.
#![allow(dead_code)]

use crate::git::worktrees::{git_ok, run_git};
use serde::{Deserialize, Serialize};
use std::path::Path;

const STATUS_ENTRY_LIMIT: usize = 2000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GitArea {
    Staged,
    Unstaged,
    Untracked,
    Conflict,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusEntry {
    pub path: String,
    pub index_status: String,
    pub worktree_status: String,
    pub area: GitArea,
    pub old_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConflictState {
    None,
    Merge,
    Rebase,
    Revert,
    CherryPick,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpstreamStatus {
    pub has_upstream: bool,
    pub ahead: u32,
    pub behind: u32,
    pub remote_branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceControlStatus {
    pub entries: Vec<StatusEntry>,
    pub conflict_state: ConflictState,
    pub branch: String,
    pub upstream: UpstreamStatus,
    pub did_hit_limit: bool,
    pub status_length: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalBranches {
    pub branches: Vec<String>,
    pub current: Option<String>,
}

pub fn sc_status(cwd: &Path) -> Result<SourceControlStatus, String> {
    let output = git_ok(cwd, &["status", "--porcelain=v1", "-z", "-b", "-uall"])?;
    let mut fields = output.split('\0');
    let header = fields.next().unwrap_or_default();
    let (branch, upstream) = parse_branch_header(header);
    let entries = parse_status_z(fields);
    let conflict_state = detect_conflict_state(cwd)?;
    let status_length = entries.len();
    let did_hit_limit = status_length > STATUS_ENTRY_LIMIT;
    Ok(SourceControlStatus {
        entries: entries.into_iter().take(STATUS_ENTRY_LIMIT).collect(),
        conflict_state,
        branch,
        upstream,
        did_hit_limit,
        status_length,
    })
}

pub fn sc_stage(cwd: &Path, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut args: Vec<&str> = vec!["add", "--"];
    args.extend(paths.iter().map(String::as_str));
    git_ok(cwd, &args).map(|_| ())
}

pub fn sc_unstage(cwd: &Path, paths: &[String]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    // Unborn HEAD cannot reset; pull the paths back out of the index instead.
    let head_exists = run_git(cwd, &["rev-parse", "--verify", "--quiet", "HEAD"])?
        .status
        .success();
    let mut args: Vec<&str> = if head_exists {
        vec!["reset", "-q", "HEAD", "--"]
    } else {
        vec!["rm", "--cached", "-q", "--"]
    };
    args.extend(paths.iter().map(String::as_str));
    git_ok(cwd, &args).map(|_| ())
}

pub fn sc_discard(cwd: &Path, paths: &[String], include_untracked: bool) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut ls_args: Vec<&str> = vec!["ls-files", "-z", "--"];
    ls_args.extend(paths.iter().map(String::as_str));
    let tracked_out = git_ok(cwd, &ls_args)?;
    let tracked_set: std::collections::HashSet<&str> = tracked_out.split('\0').filter(|s| !s.is_empty()).collect();
    let tracked: Vec<&str> = paths.iter().map(String::as_str).filter(|p| tracked_set.contains(p)).collect();
    let untracked: Vec<&str> = paths.iter().map(String::as_str).filter(|p| !tracked_set.contains(p)).collect();

    if !untracked.is_empty() && !include_untracked {
        let listed = untracked.join(", ");
        return Err(format!(
            "refusing to discard untracked files without confirmation: {listed}"
        ));
    }
    if !tracked.is_empty() {
        git_ok(cwd, &["checkout", "-q", "HEAD", "--"].iter().copied()
            .chain(tracked.iter().copied())
            .collect::<Vec<_>>())?;
    }
    if include_untracked && !untracked.is_empty() {
        let mut clean_args: Vec<&str> = vec!["clean", "-q", "-f", "--"];
        clean_args.extend(untracked);
        git_ok(cwd, &clean_args)?;
    }
    Ok(())
}

pub fn sc_commit(cwd: &Path, message: &str) -> Result<String, String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("commit message required".into());
    }
    let staged_probe = run_git(cwd, &["diff", "--cached", "--quiet"])?;
    if staged_probe.status.success() {
        return Err("nothing to commit".into());
    }
    git_ok(cwd, &["commit", "-q", "-m", trimmed])?;
    Ok(git_ok(cwd, &["rev-parse", "--short", "HEAD"])?.trim().to_string())
}

pub fn sc_local_branches(cwd: &Path) -> Result<LocalBranches, String> {
    let output = git_ok(cwd, &["branch", "--format=%(HEAD)|%(refname:short)"])?;
    let mut branches = Vec::new();
    let mut current = None;
    for line in output.lines() {
        let Some((marker, name)) = line.split_once('|') else {
            continue;
        };
        if marker == "*" {
            current = Some(name.to_string());
        }
        branches.push(name.to_string());
    }
    Ok(LocalBranches { branches, current })
}

pub fn sc_checkout(cwd: &Path, branch: &str) -> Result<(), String> {
    validate_ref_name(branch)?;
    git_ok(cwd, &["checkout", "-q", branch]).map(|_| ())
}

// argv-only exec still option-parses leading dashes; whitespace/control refs never resolve.
fn validate_ref_name(name: &str) -> Result<(), String> {
    let invalid = name.is_empty()
        || name.starts_with('-')
        || name.chars().any(|c| c.is_whitespace() || c.is_control())
        || name.contains("..")
        || name.contains("@{");
    if invalid {
        Err(format!("invalid branch name: {name}"))
    } else {
        Ok(())
    }
}

// XY→area decision table (tasks 4/7 consume): "??"→Untracked; any U or AA or DD→Conflict;
// X≠' '→Staged (single entry per path even when worktree also dirty); else Y≠' '→Unstaged.
fn map_area(x: char, y: char) -> GitArea {
    if x == '?' && y == '?' {
        GitArea::Untracked
    } else if x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D') {
        GitArea::Conflict
    } else if x != ' ' {
        GitArea::Staged
    } else {
        GitArea::Unstaged
    }
}

fn no_upstream() -> UpstreamStatus {
    UpstreamStatus {
        has_upstream: false,
        ahead: 0,
        behind: 0,
        remote_branch: None,
    }
}

fn parse_branch_header(header: &str) -> (String, UpstreamStatus) {
    let raw = header.strip_prefix("## ").unwrap_or(header).trim();
    if raw.starts_with("HEAD") {
        return (String::new(), no_upstream());
    }
    let (ref_part, counts_part) = match raw.find(" [") {
        Some(i) => (&raw[..i], Some(raw[i + 2..].trim_end_matches(']'))),
        None => (raw, None),
    };
    let (local, remote) = match ref_part.split_once("...") {
        Some((l, r)) => (l.trim(), Some(r.trim())),
        None => (ref_part, None),
    };
    let branch = local
        .strip_prefix("Initial commit on ")
        .or_else(|| local.strip_prefix("No commits yet on "))
        .unwrap_or(local)
        .to_string();
    let upstream = match remote.filter(|r| !r.is_empty()) {
        Some(remote_branch) => {
            let (ahead, behind) = counts_part.map(parse_counts).unwrap_or((0, 0));
            UpstreamStatus {
                has_upstream: true,
                ahead,
                behind,
                remote_branch: Some(remote_branch.to_string()),
            }
        }
        None => no_upstream(),
    };
    (branch, upstream)
}

fn parse_counts(bracket: &str) -> (u32, u32) {
    let ahead = bracket.split("ahead ").nth(1).map(digit_prefix).unwrap_or(0);
    let behind = bracket.split("behind ").nth(1).map(digit_prefix).unwrap_or(0);
    (ahead, behind)
}

fn digit_prefix(text: &str) -> u32 {
    text.chars()
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .unwrap_or(0)
}

fn parse_status_z(mut fields: std::str::Split<'_, char>) -> Vec<StatusEntry> {
    let mut entries = Vec::new();
    while let Some(record) = fields.next() {
        if record.len() < 4 {
            continue;
        }
        let xy = record.as_bytes();
        let (x, y) = (xy[0] as char, xy[1] as char);
        let path = record[3..].to_string();
        // -z renames/copies carry the origin path as the very next NUL field.
        let renamed_copied = matches!((x, y), ('R' | 'C', _) | (_, 'R' | 'C'));
        let old_path = if renamed_copied {
            fields.next().map(str::to_string)
        } else {
            None
        };
        entries.push(StatusEntry {
            path,
            index_status: x.to_string(),
            worktree_status: y.to_string(),
            area: map_area(x, y),
            old_path,
        });
    }
    entries
}

fn detect_conflict_state(cwd: &Path) -> Result<ConflictState, String> {
    let git_dir_text = git_ok(cwd, &["rev-parse", "--absolute-git-dir"])?;
    let git_dir = Path::new(git_dir_text.trim());
    if git_dir.join("MERGE_HEAD").exists() {
        return Ok(ConflictState::Merge);
    }
    if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
        return Ok(ConflictState::Rebase);
    }
    if git_dir.join("REVERT_HEAD").exists() {
        return Ok(ConflictState::Revert);
    }
    if git_dir.join("CHERRY_PICK_HEAD").exists() {
        return Ok(ConflictState::CherryPick);
    }
    Ok(ConflictState::None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::{commit_file, git, sandbox, sandbox_without_commits, write_file};

    fn one_path(name: &str) -> Vec<String> {
        vec![name.to_string()]
    }

    fn entry_for<'a>(st: &'a SourceControlStatus, path: &str) -> &'a StatusEntry {
        st.entries
            .iter()
            .find(|e| e.path == path)
            .unwrap_or_else(|| panic!("no entry for {path} in {:?}", st.entries))
    }

    #[test]
    fn sc_status_clean_repo_reports_zero_entries_and_main() {
        let s = sandbox("sc-clean");
        let st = sc_status(&s.repo).unwrap();
        assert!(st.entries.is_empty());
        assert_eq!(st.status_length, 0);
        assert!(!st.did_hit_limit);
        assert_eq!(st.branch, "main");
        assert_eq!(st.conflict_state, ConflictState::None);
        assert_eq!(
            st.upstream,
            UpstreamStatus {
                has_upstream: false,
                ahead: 0,
                behind: 0,
                remote_branch: None
            }
        );
    }

    #[test]
    fn sc_status_untracked_file_maps_to_untracked_area() {
        let s = sandbox("sc-untracked");
        write_file(&s.repo, "new.txt", "x");
        let st = sc_status(&s.repo).unwrap();
        assert_eq!(st.status_length, 1);
        let e = entry_for(&st, "new.txt");
        assert_eq!(e.area, GitArea::Untracked);
        assert_eq!(e.index_status, "?");
        assert_eq!(e.worktree_status, "?");
        assert_eq!(e.old_path, None);
    }

    #[test]
    fn sc_status_staged_new_file_is_staged_with_index_a() {
        let s = sandbox("sc-staged-new");
        write_file(&s.repo, "added.txt", "x");
        sc_stage(&s.repo, &one_path("added.txt")).unwrap();
        let st = sc_status(&s.repo).unwrap();
        let e = entry_for(&st, "added.txt");
        assert_eq!(e.area, GitArea::Staged);
        assert_eq!(e.index_status, "A");
        assert_eq!(e.worktree_status, " ");
        assert_eq!(st.entries.len(), 1);
    }

    #[test]
    fn sc_status_modify_after_stage_is_single_entry_dual_codes() {
        let s = sandbox("sc-dual");
        commit_file(&s.repo, "t.txt", "v0", "seed");
        write_file(&s.repo, "t.txt", "v1");
        sc_stage(&s.repo, &one_path("t.txt")).unwrap();
        write_file(&s.repo, "t.txt", "v2");

        let st = sc_status(&s.repo).unwrap();
        assert_eq!(st.entries.len(), 1, "dual-state must stay one entry per path");
        let e = entry_for(&st, "t.txt");
        // Decision: area=Staged whenever X != ' ', even when worktree also dirty.
        assert_eq!(e.area, GitArea::Staged);
        assert_eq!(e.index_status, "M");
        assert_eq!(e.worktree_status, "M");
    }

    #[test]
    fn sc_status_rename_detection_sets_old_path() {
        let s = sandbox("sc-rename");
        commit_file(&s.repo, "before.txt", "r", "seed rename");
        git(&s.repo, &["mv", "before.txt", "after.txt"]);
        let st = sc_status(&s.repo).unwrap();
        assert_eq!(st.entries.len(), 1);
        let e = entry_for(&st, "after.txt");
        assert_eq!(e.old_path.as_deref(), Some("before.txt"));
        assert_eq!(e.index_status, "R");
        assert_eq!(e.area, GitArea::Staged);
    }

    #[test]
    fn sc_status_worktree_deleted_file_is_unstaged_d() {
        let s = sandbox("sc-deleted");
        std::fs::remove_file(s.repo.join("README.md")).unwrap();
        let st = sc_status(&s.repo).unwrap();
        let e = entry_for(&st, "README.md");
        assert_eq!(e.area, GitArea::Unstaged);
        assert_eq!(e.index_status, " ");
        assert_eq!(e.worktree_status, "D");
    }

    #[test]
    fn sc_status_merge_conflict_reports_state_and_conflict_area_then_abort_clears() {
        let s = sandbox("sc-conflict");
        commit_file(&s.repo, "c.txt", "base\n", "base c");
        git(&s.repo, &["checkout", "-b", "feature"]);
        commit_file(&s.repo, "c.txt", "feature side\n", "feature edit");
        git(&s.repo, &["checkout", "main"]);
        commit_file(&s.repo, "c.txt", "main side\n", "main edit");

        let merge = run_git(&s.repo, &["merge", "feature"]).unwrap();
        assert!(!merge.status.success(), "fixture merge must conflict");

        let st = sc_status(&s.repo).unwrap();
        assert_eq!(st.conflict_state, ConflictState::Merge);
        let e = entry_for(&st, "c.txt");
        assert_eq!(e.area, GitArea::Conflict);
        assert_eq!(e.index_status, "U");
        assert_eq!(e.worktree_status, "U");

        run_git(&s.repo, &["merge", "--abort"]).unwrap();
        let st = sc_status(&s.repo).unwrap();
        assert_eq!(st.conflict_state, ConflictState::None);
    }

    #[test]
    fn sc_status_detached_head_gives_empty_branch_and_no_upstream() {
        let s = sandbox("sc-detached");
        git(&s.repo, &["checkout", "--detach"]);
        let st = sc_status(&s.repo).unwrap();
        assert_eq!(st.branch, "");
        assert!(!st.upstream.has_upstream);
        assert_eq!(st.conflict_state, ConflictState::None);
    }

    #[test]
    fn sc_status_unborn_branch_reports_name_without_upstream() {
        let s = sandbox_without_commits("sc-unborn");
        write_file(&s.repo, "only.txt", "x");
        let st = sc_status(&s.repo).unwrap();
        assert_eq!(st.branch, "main");
        assert!(!st.upstream.has_upstream);
        let e = entry_for(&st, "only.txt");
        assert_eq!(e.area, GitArea::Untracked);
    }

    #[test]
    fn sc_status_no_remote_means_no_upstream() {
        let s = sandbox("sc-noremote");
        let st = sc_status(&s.repo).unwrap();
        assert!(!st.upstream.has_upstream);
        assert_eq!(st.upstream.remote_branch, None);
    }

    #[test]
    fn sc_status_diverged_local_and_bare_remote_reports_ahead_behind() {
        let s = sandbox("sc-upstream");
        let bare = s.root.join("origin.git");
        let bare_s = bare.to_string_lossy().into_owned();
        let repo_s = s.repo.to_string_lossy().into_owned();
        git(&s.root, &["clone", "--bare", &repo_s, &bare_s]);
        git(&s.repo, &["remote", "add", "origin", &bare_s]);
        git(&s.repo, &["push", "-u", "origin", "main"]);

        let twin = s.root.join("twin");
        git(&s.root, &["clone", &bare_s, &twin.to_string_lossy()]);
        git(&twin, &["config", "user.email", "test@oppa.dev"]);
        git(&twin, &["config", "user.name", "Oppa Test"]);
        commit_file(&twin, "twin.txt", "twin", "diverge remote");
        git(&twin, &["push", "origin", "main"]);

        commit_file(&s.repo, "local.txt", "local", "diverge local");
        git(&s.repo, &["fetch", "origin"]);

        let st = sc_status(&s.repo).unwrap();
        assert_eq!(st.branch, "main");
        assert!(st.upstream.has_upstream);
        assert_eq!(st.upstream.ahead, 1);
        assert_eq!(st.upstream.behind, 1);
        assert_eq!(st.upstream.remote_branch.as_deref(), Some("origin/main"));
    }

    #[test]
    fn sc_status_caps_entries_at_limit_and_flags_it() {
        let s = sandbox("sc-cap");
        for i in 0..2001 {
            write_file(&s.repo, &format!("bulk/f{i}.txt"), "x");
        }
        let st = sc_status(&s.repo).unwrap();
        assert_eq!(st.entries.len(), STATUS_ENTRY_LIMIT);
        assert_eq!(st.status_length, 2001);
        assert!(st.did_hit_limit);
    }

    #[test]
    fn sc_stage_then_unstage_roundtrip_changes_areas() {
        let s = sandbox("sc-roundtrip");
        commit_file(&s.repo, "r.txt", "v0", "seed r");
        write_file(&s.repo, "r.txt", "v1");

        let st = sc_status(&s.repo).unwrap();
        let e = entry_for(&st, "r.txt");
        assert_eq!(e.area, GitArea::Unstaged);

        sc_stage(&s.repo, &one_path("r.txt")).unwrap();
        let st = sc_status(&s.repo).unwrap();
        let e = entry_for(&st, "r.txt");
        assert_eq!(e.area, GitArea::Staged);
        assert_eq!(e.index_status, "M");
        assert_eq!(e.worktree_status, " ");

        sc_unstage(&s.repo, &one_path("r.txt")).unwrap();
        let st = sc_status(&s.repo).unwrap();
        let e = entry_for(&st, "r.txt");
        assert_eq!(e.area, GitArea::Unstaged);
        assert_eq!(e.index_status, " ");
        assert_eq!(e.worktree_status, "M");
    }

    #[test]
    fn sc_unstage_on_unborn_head_falls_back_to_rm_cached() {
        let s = sandbox_without_commits("sc-unstage-unborn");
        write_file(&s.repo, "first.txt", "x");
        sc_stage(&s.repo, &one_path("first.txt")).unwrap();
        sc_unstage(&s.repo, &one_path("first.txt")).unwrap();
        let st = sc_status(&s.repo).unwrap();
        assert_eq!(entry_for(&st, "first.txt").area, GitArea::Untracked);
    }

    #[test]
    fn sc_discard_restores_tracked_bytes_including_staged_changes() {
        let s = sandbox("sc-discard-tracked");
        commit_file(&s.repo, "d.txt", "original", "seed d");
        write_file(&s.repo, "d.txt", "modified");
        sc_stage(&s.repo, &one_path("d.txt")).unwrap();

        sc_discard(&s.repo, &one_path("d.txt"), false).unwrap();
        let on_disk = std::fs::read_to_string(s.repo.join("d.txt")).unwrap();
        assert_eq!(on_disk, "original");
        let st = sc_status(&s.repo).unwrap();
        assert!(st.entries.is_empty(), "discard must clear staged+worktree state");
    }

    #[test]
    fn sc_discard_mixed_list_requires_flag_for_untracked_and_lists_names() {
        let s = sandbox("sc-discard-mixed");
        commit_file(&s.repo, "keep.txt", "k0", "seed keep");
        write_file(&s.repo, "keep.txt", "k1");
        write_file(&s.repo, "fresh.txt", "brand new");

        let paths = vec!["keep.txt".to_string(), "fresh.txt".to_string()];
        let err = sc_discard(&s.repo, &paths, false).unwrap_err();
        assert!(err.contains("fresh.txt"), "must list untracked names: {err}");
        assert!(s.repo.join("fresh.txt").exists());
        // Refusal is atomic: tracked path must stay untouched too.
        assert_eq!(std::fs::read_to_string(s.repo.join("keep.txt")).unwrap(), "k1");

        sc_discard(&s.repo, &paths, true).unwrap();
        assert!(!s.repo.join("fresh.txt").exists());
        assert_eq!(std::fs::read_to_string(s.repo.join("keep.txt")).unwrap(), "k0");
    }

    #[test]
    fn sc_commit_rejects_blank_messages() {
        let s = sandbox("sc-commit-blank");
        assert_eq!(sc_commit(&s.repo, "").unwrap_err(), "commit message required");
        assert_eq!(sc_commit(&s.repo, "   \n\t ").unwrap_err(), "commit message required");
    }

    #[test]
    fn sc_commit_rejects_when_nothing_staged() {
        let s = sandbox("sc-commit-nothing");
        assert_eq!(sc_commit(&s.repo, "msg").unwrap_err(), "nothing to commit");
    }

    #[test]
    fn sc_commit_returns_short_head_and_preserves_multiline_message() {
        let s = sandbox("sc-commit-happy");
        write_file(&s.repo, "c.txt", "changed");
        sc_stage(&s.repo, &one_path("c.txt")).unwrap();

        let id = sc_commit(&s.repo, "feat: subject line\n\nbody detail here").unwrap();
        let head_short = git(&s.repo, &["rev-parse", "--short", "HEAD"]);
        assert_eq!(id.trim(), head_short.trim());

        let body = git(&s.repo, &["log", "-1", "--pretty=%B"]);
        assert!(body.contains("feat: subject line"));
        assert!(body.contains("body detail here"));
    }

    #[test]
    fn sc_local_branches_lists_all_and_marks_current() {
        let s = sandbox("sc-branches");
        git(&s.repo, &["branch", "feature"]);
        let lb = sc_local_branches(&s.repo).unwrap();
        assert!(lb.branches.contains(&"main".to_string()));
        assert!(lb.branches.contains(&"feature".to_string()));
        assert_eq!(lb.current.as_deref(), Some("main"));

        sc_checkout(&s.repo, "feature").unwrap();
        let lb = sc_local_branches(&s.repo).unwrap();
        assert_eq!(lb.current.as_deref(), Some("feature"));
        let st = sc_status(&s.repo).unwrap();
        assert_eq!(st.branch, "feature");
    }

    #[test]
    fn sc_checkout_unknown_branch_propagates_git_error() {
        let s = sandbox("sc-checkout-missing");
        let err = sc_checkout(&s.repo, "does-not-exist").unwrap_err();
        assert!(err.contains("does-not-exist"), "stderr must propagate: {err}");
    }

    #[test]
    fn sc_checkout_rejects_injection_attempts_before_spawning_git() {
        let s = sandbox("sc-checkout-inject");
        for bad in ["-rf", "a b", "", "a..b", "@{x}", "\tx"] {
            let err = sc_checkout(&s.repo, bad).unwrap_err();
            assert!(
                err.starts_with("invalid branch name"),
                "{bad:?} must be rejected by validator, got: {err}"
            );
        }
        let lb = sc_local_branches(&s.repo).unwrap();
        assert_eq!(lb.current.as_deref(), Some("main"));
    }
}
