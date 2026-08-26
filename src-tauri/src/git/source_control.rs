// Source-control service ops over argv-only git; reached via daemon git.* requests in a later task.
#![allow(dead_code)]

use crate::git::worktrees::{git_ok, run_git};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Output;

const STATUS_ENTRY_LIMIT: usize = 2000;
const DIFF_SIDE_CAP_BYTES: usize = 512 * 1024;
const BINARY_SNIFF_BYTES: usize = 8 * 1024;
const HISTORY_MAX_LIMIT: usize = 200;
const HISTORY_DEFAULT_LIMIT: usize = 50;

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiffKind {
    Text,
    Binary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffContent {
    pub kind: DiffKind,
    pub original_content: String,
    pub modified_content: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitStats {
    pub files: u32,
    pub insertions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryItem {
    pub id: String,
    pub parent_ids: Vec<String>,
    pub subject: String,
    pub message_body: String,
    pub author_name: String,
    pub author_email: String,
    pub timestamp_secs: u64,
    pub stats: CommitStats,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryResult {
    pub items: Vec<HistoryItem>,
    pub has_more: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompareEntry {
    pub path: String,
    pub change_kind: String,
    pub old_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BranchCompare {
    pub base_ref: String,
    pub ahead: u32,
    pub behind: u32,
    pub changed_files: Vec<CompareEntry>,
}

// Err prefix marking an interrupted merge so UI can offer resolution instead of retry.
pub(crate) const CONFLICT_PREFIX: &str = "conflict:";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PullStatus {
    FastForward,
    UpToDate,
    Merged,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PullOutcome {
    pub status: PullStatus,
    pub new_head: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PushOutcome {
    pub pushed_to: String,
    pub was_publish: bool,
}

// F10 guarded merge: how the agent branch lands in its base ref.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MergeMode {
    Squash,
    MergeCommit,
}

impl MergeMode {
    // Wire label mirrors the enum's kebab-case serde form.
    pub fn as_str(self) -> &'static str {
        match self {
            MergeMode::Squash => "squash",
            MergeMode::MergeCommit => "merge-commit",
        }
    }

    // Requests carry a plain string; accept both spellings of the merge commit.
    pub fn parse(raw: &str) -> Result<MergeMode, String> {
        match raw {
            "squash" => Ok(MergeMode::Squash),
            "merge" | "merge-commit" => Ok(MergeMode::MergeCommit),
            other => Err(format!("unknown merge mode '{other}' — use 'squash' or 'merge'")),
        }
    }
}

// mode is "squash" | "merge-commit" (owned: the payload deserializes over IPC).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MergeToBaseOutcome {
    pub merged_commit: String,
    pub mode: String,
    pub files_changed: usize,
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

pub fn sc_fetch(cwd: &Path) -> Result<(), String> {
    git_ok(cwd, &["fetch", "--quiet", "--all"]).map(|_| ())
}

pub fn sc_pull(cwd: &Path, ff_only: bool) -> Result<PullOutcome, String> {
    require_upstream(cwd)?;
    git_ok(cwd, &["fetch", "-q"])?;
    let (_, behind) = divergence_counts(cwd)?;
    if behind == 0 {
        return Ok(PullOutcome { status: PullStatus::UpToDate, new_head: None });
    }
    let args: &[&str] = if ff_only {
        &["pull", "-q", "--ff-only"]
    } else {
        &["pull", "-q", "--no-rebase"]
    };
    let output = run_git(cwd, args)?;
    if !output.status.success() {
        return Err(pull_failure_error(cwd, args, output));
    }
    Ok(PullOutcome {
        status: if ff_only { PullStatus::FastForward } else { PullStatus::Merged },
        new_head: Some(head_short(cwd)?),
    })
}

pub fn sc_fast_forward(cwd: &Path) -> Result<PullOutcome, String> {
    require_upstream(cwd)?;
    git_ok(cwd, &["fetch", "-q"])?;
    let before = head_short(cwd)?;
    git_ok(cwd, &["merge", "-q", "--ff-only", "@{upstream}"])?;
    let after = head_short(cwd)?;
    let moved = before != after;
    Ok(PullOutcome {
        status: if moved { PullStatus::FastForward } else { PullStatus::UpToDate },
        new_head: moved.then_some(after),
    })
}

pub fn sc_push(cwd: &Path, publish: bool, force_with_lease: bool) -> Result<PushOutcome, String> {
    if probe_upstream(cwd)?.is_none() {
        if !publish {
            return Err("no upstream — publish first".into());
        }
        let origin_exists = run_git(cwd, &["remote", "get-url", "origin"])?.status.success();
        if !origin_exists {
            return Err("no 'origin' remote — add one before publishing".into());
        }
        git_ok(cwd, &["push", "-q", "-u", "origin", "HEAD"])?;
        let pushed_to = format!("origin/{}", current_branch_name(cwd)?);
        return Ok(PushOutcome { pushed_to, was_publish: true });
    }
    let branch = current_branch_name(cwd)?;
    let remote = git_ok(cwd, &["config", &format!("branch.{branch}.remote")])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "origin".into());
    let mut args: Vec<&str> = vec!["push", "-q"];
    if force_with_lease {
        args.push("--force-with-lease");
    }
    git_ok(cwd, &args)?;
    Ok(PushOutcome { pushed_to: format!("{remote}/{branch}"), was_publish: false })
}

const MERGE_CONFLICT_LIST_CAP: usize = 20;

// F10 guarded merge of an agent branch into its base ref, executed in the MAIN
// checkout (registry resolves worktree branch/base_ref and the repo path).
// Every guard hard-blocks with a plain-language reason; the agent worktree's
// own HEAD is never touched and no branches are switched programmatically.
pub fn sc_merge_to_base(
    registry_path: &Path,
    cwd_of_worktree: &Path,
    mode: MergeMode,
) -> Result<MergeToBaseOutcome, String> {
    let record = crate::git::worktrees::worktree_current(registry_path, cwd_of_worktree)
        .ok_or_else(|| "not inside a registered agent worktree".to_string())?;
    let main = crate::git::worktree_registry::WorktreeRegistry::load(registry_path)
        .repos
        .get(&record.repo_id)
        .map(|repo| repo.path.clone())
        .ok_or_else(|| format!("registry has no repo {} for worktree", record.repo_id))?;
    validate_ref_name(&record.branch)?;
    validate_ref_name(&record.base_ref)?;

    // Guard 1: main checkout must be clean; we never stash or discard there.
    if !run_git(&main, &["status", "--porcelain"])?.stdout.is_empty() {
        return Err("main checkout has uncommitted changes — commit or stash there first".into());
    }
    // Guard 2: main must already sit on the base ref.
    let on_branch = git_ok(&main, &["symbolic-ref", "--short", "HEAD"])?
        .trim()
        .to_string();
    if on_branch != record.base_ref {
        return Err(format!(
            "main checkout is on '{on_branch}' — switch it to '{}' yourself first",
            record.base_ref
        ));
    }

    // Guard 3: probe a real merge without touching anything. Exit 1 = conflicts;
    // stdout then lists "<mode> <oid> <stage>\t<path>" records per conflicted file.
    let probe = run_git(&main, &["merge-tree", "--write-tree", "HEAD", &record.branch])?;
    match probe.status.code() {
        Some(0) => {}
        Some(1) => {
            let conflicted = conflicted_paths_from_merge_tree(&String::from_utf8_lossy(
                &probe.stdout,
            ));
            let mut listed: Vec<String> =
                conflicted.iter().take(MERGE_CONFLICT_LIST_CAP).cloned().collect();
            if conflicted.len() > MERGE_CONFLICT_LIST_CAP {
                listed.push(format!("… and {} more", conflicted.len() - MERGE_CONFLICT_LIST_CAP));
            }
            return Err(format!("merge conflicts: {}", listed.join(", ")));
        }
        code => {
            return Err(format!(
                "merge probe failed (exit {code:?}): {}",
                String::from_utf8_lossy(&probe.stderr).trim()
            ));
        }
    }

    // An empty diff would leave squash's follow-up commit with nothing to commit.
    let ahead = git_ok(&main, &["rev-list", "--count", &format!("HEAD..{}", record.branch)])?;
    if ahead.trim() == "0" {
        return Err(format!(
            "nothing to merge — {} has no commits beyond {}",
            record.branch, record.base_ref
        ));
    }

    let pre_head = head_short(&main)?;
    if let Err(err) = perform_merge_to_base(&main, &record.branch, &record.base_ref, mode) {
        // Raced-in conflict or failed squash commit: restore exactly, since
        // Guard 1 proved the checkout clean moments ago.
        let _ = run_git(&main, &["merge", "--abort"]);
        let _ = run_git(&main, &["reset", "-q", "--hard"]);
        return Err(format!("merge rolled back: {err}"));
    }
    let merged_commit = head_short(&main)?;
    let numstat = git_ok(&main, &["diff", "--numstat", &format!("{pre_head}..HEAD")])?;
    Ok(MergeToBaseOutcome {
        merged_commit,
        mode: mode.as_str().to_string(),
        files_changed: numstat.lines().filter(|l| !l.trim().is_empty()).count(),
    })
}

fn perform_merge_to_base(
    main: &Path,
    feature: &str,
    base: &str,
    mode: MergeMode,
) -> Result<(), String> {
    match mode {
        MergeMode::Squash => {
            git_ok(main, &["merge", "--squash", feature])?;
            git_ok(
                main,
                &["commit", "-q", "-m", &format!("squash: merge {feature} into {base}")],
            )
            .map(|_| ())
        }
        MergeMode::MergeCommit => git_ok(
            main,
            &[
                "merge",
                "--no-ff",
                "-m",
                &format!("merge: {feature} into {base}"),
                feature,
            ],
        )
        .map(|_| ()),
    }
}

// merge-tree --write-tree stdout on conflicts carries one stage line per
// stage per file ("<mode> <oid> <stage>\t<path>"); dedupe down to paths.
fn conflicted_paths_from_merge_tree(stdout: &str) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    for line in stdout.lines() {
        let Some((meta, path)) = line.split_once('\t') else { continue };
        let fields: Vec<&str> = meta.split_whitespace().collect();
        let is_stage_record = fields.len() == 3
            && fields[0].len() == 6
            && fields[2].chars().all(|c| c.is_ascii_digit());
        if is_stage_record && !path.is_empty() && !paths.iter().any(|p| p == path) {
            paths.push(path.to_string());
        }
    }
    paths
}

// Cheap ahead/behind refresh: three ref queries instead of sc_status's full porcelain walk.
pub fn sc_upstream_refresh(cwd: &Path) -> UpstreamStatus {
    let Some(remote_branch) = probe_upstream(cwd).ok().flatten() else {
        return no_upstream();
    };
    UpstreamStatus {
        has_upstream: true,
        ahead: rev_list_count(cwd, "@{upstream}..HEAD"),
        behind: rev_list_count(cwd, "HEAD..@{upstream}"),
        remote_branch: Some(remote_branch),
    }
}

// None ⇔ branch has no upstream configured.
fn probe_upstream(cwd: &Path) -> Result<Option<String>, String> {
    let probe = run_git(
        cwd,
        &["rev-parse", "--quiet", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
    )?;
    if !probe.status.success() {
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(&probe.stdout).trim().to_string()))
}

fn require_upstream(cwd: &Path) -> Result<String, String> {
    probe_upstream(cwd)?.ok_or_else(|| "no upstream configured for this branch".to_string())
}

fn divergence_counts(cwd: &Path) -> Result<(u32, u32), String> {
    let ahead = git_ok(cwd, &["rev-list", "--count", "@{upstream}..HEAD"])?
        .trim()
        .parse()
        .unwrap_or(0);
    let behind = git_ok(cwd, &["rev-list", "--count", "HEAD..@{upstream}"])?
        .trim()
        .parse()
        .unwrap_or(0);
    Ok((ahead, behind))
}

fn rev_list_count(cwd: &Path, range: &str) -> u32 {
    git_ok(cwd, &["rev-list", "--count", range])
        .ok()
        .and_then(|out| out.trim().parse().ok())
        .unwrap_or(0)
}

fn head_short(cwd: &Path) -> Result<String, String> {
    Ok(git_ok(cwd, &["rev-parse", "--short", "HEAD"])?.trim().to_string())
}

fn current_branch_name(cwd: &Path) -> Result<String, String> {
    Ok(git_ok(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])?.trim().to_string())
}

fn pull_failure_error(cwd: &Path, args: &[&str], output: Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    // Merge state left on disk is the conflict signal; prefix lets UI route to resolution.
    if matches!(detect_conflict_state(cwd), Ok(ConflictState::Merge)) {
        return format!("{CONFLICT_PREFIX}{stderr}");
    }
    format!(
        "git {} in {}: failed: {stderr}",
        args.join(" "),
        cwd.display()
    )
}

// Side-resolution table (task 7 UI wires buttons to this):
//   unstaged (staged=false, head=false): original=index (:0:), modified=worktree disk
//   staged   (staged=true,  head=false): original=HEAD ("" on unborn/added), modified=index
//   vs-head  (compare_against_head=true): original=HEAD, modified=worktree — overrides staged
// Deleted side ⇒ empty string; path absent from index+HEAD+disk ⇒ Err.
pub fn sc_file_diff(
    cwd: &Path,
    path: &str,
    staged: bool,
    compare_against_head: bool,
) -> Result<DiffContent, String> {
    let head_exists = run_git(cwd, &["rev-parse", "--verify", "--quiet", "HEAD"])?
        .status
        .success();
    let index_bytes = git_blob(cwd, format!(":0:{path}"));
    let head_bytes = if head_exists {
        git_blob(cwd, format!("HEAD:{path}"))
    } else {
        None
    };
    let disk_bytes = std::fs::read(cwd.join(path)).ok();
    if index_bytes.is_none() && head_bytes.is_none() && disk_bytes.is_none() {
        return Err("path not found in git".into());
    }

    let (original, modified) = if compare_against_head {
        (head_bytes.clone(), disk_bytes)
    } else if staged {
        (head_bytes, index_bytes)
    } else {
        (index_bytes, disk_bytes)
    };

    // NUL in the first sniff window of EITHER side makes the whole pair binary.
    let side_is_binary =
        |side: &Option<Vec<u8>>| side.as_deref().is_some_and(is_binary_sniff);
    let kind = if side_is_binary(&original) || side_is_binary(&modified) {
        DiffKind::Binary
    } else {
        DiffKind::Text
    };
    let (original_content, modified_content, truncated) = if kind == DiffKind::Binary {
        (String::new(), String::new(), false)
    } else {
        let (oc, ot) = capped_text(original.as_deref().unwrap_or(b""));
        let (mc, mt) = capped_text(modified.as_deref().unwrap_or(b""));
        (oc, mc, ot || mt)
    };
    Ok(DiffContent {
        kind,
        original_content,
        modified_content,
        truncated,
    })
}

fn git_blob(cwd: &Path, rev_path: String) -> Option<Vec<u8>> {
    let output = run_git(cwd, &["show", &rev_path]).ok()?;
    output.status.success().then_some(output.stdout)
}

fn is_binary_sniff(bytes: &[u8]) -> bool {
    bytes.iter().take(BINARY_SNIFF_BYTES).any(|&b| b == 0)
}

// Cut at a char boundary so lossy decoding never emits U+FFFD for valid UTF-8 input.
fn capped_text(bytes: &[u8]) -> (String, bool) {
    let truncated = bytes.len() > DIFF_SIDE_CAP_BYTES;
    let mut end = DIFF_SIDE_CAP_BYTES.min(bytes.len());
    // Boundary at `end` is valid unless bytes[end] continues a multi-byte char.
    while end > 0 && end < bytes.len() && (bytes[end] & 0xC0) == 0x80 {
        end -= 1;
    }
    (
        String::from_utf8_lossy(&bytes[..end]).into_owned(),
        truncated,
    )
}

pub fn sc_history(cwd: &Path, limit: usize) -> Result<HistoryResult, String> {
    let limit = if limit == 0 {
        HISTORY_DEFAULT_LIMIT
    } else {
        limit.clamp(1, HISTORY_MAX_LIMIT)
    };
    // Fetch one extra commit so has_more is knowable without a second walk.
    let fetch_count = limit + 1;
    // Single walk feeds both items and per-commit numstat stats; NUL/NUL/\x01 framing survives arbitrary bodies.
    let output = git_ok(
        cwd,
        &[
            "log",
            &format!("--max-count={fetch_count}"),
            "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%b%x01",
            "--numstat",
        ],
    )?;
    let mut items = parse_log_records(&output);
    let has_more = items.len() > limit;
    items.truncate(limit);
    Ok(HistoryResult { items, has_more })
}

fn parse_log_records(output: &str) -> Vec<HistoryItem> {
    let mut items = Vec::new();
    let mut rest = output;
    while !rest.is_empty() {
        let Some((id, after_id)) = rest.split_once('\0') else {
            break;
        };
        let Some((parents_raw, after_parents)) = after_id.split_once('\0') else {
            break;
        };
        let Some((author_name, after_name)) = after_parents.split_once('\0') else {
            break;
        };
        let Some((author_email, after_email)) = after_name.split_once('\0') else {
            break;
        };
        let Some((timestamp, after_time)) = after_email.split_once('\0') else {
            break;
        };
        let Some((subject, after_subject)) = after_time.split_once('\0') else {
            break;
        };
        let Some(body_end) = after_subject.find('\x01') else {
            break;
        };
        let message_body = after_subject[..body_end].trim_end().to_string();
        let mut tail = &after_subject[body_end + 1..];
        let mut numstat_lines = Vec::new();
        while !tail.is_empty() {
            let (line, remainder) = match tail.split_once('\n') {
                Some((l, r)) => (l, r),
                None => (tail, ""),
            };
            if is_log_record_start(line) {
                break;
            }
            numstat_lines.push(line);
            tail = remainder;
        }
        rest = tail;

        let parent_ids = parents_raw.split_whitespace().map(str::to_string).collect();
        let mut stats = CommitStats {
            files: 0,
            insertions: 0,
            deletions: 0,
        };
        for line in numstat_lines {
            let mut fields = line.split('\t');
            let (Some(inserted), Some(deleted), Some(_path)) =
                (fields.next(), fields.next(), fields.next())
            else {
                continue;
            };
            // "-\t-" marks a binary file: counts toward files only.
            stats.files += 1;
            if inserted != "-" {
                stats.insertions += inserted.parse().unwrap_or(0);
            }
            if deleted != "-" {
                stats.deletions += deleted.parse().unwrap_or(0);
            }
        }
        items.push(HistoryItem {
            id: id.to_string(),
            parent_ids,
            subject: subject.to_string(),
            message_body,
            author_name: author_name.to_string(),
            author_email: author_email.to_string(),
            timestamp_secs: timestamp.parse().unwrap_or(0),
            stats,
        });
    }
    items
}

fn is_log_record_start(line: &str) -> bool {
    let bytes = line.as_bytes();
    bytes.len() > 40 && bytes[..40].iter().all(|b| b.is_ascii_hexdigit()) && bytes[40] == b'\0'
}

// ahead = HEAD-only commits, behind = base-only; file list is merge-base→HEAD.
pub fn sc_branch_compare(cwd: &Path, base_ref: &str) -> Result<BranchCompare, String> {
    validate_ref_name(base_ref)?;
    let merge_base = git_ok(cwd, &["merge-base", "HEAD", base_ref])?.trim().to_string();
    let ahead_out = git_ok(cwd, &["rev-list", "--count", &format!("{base_ref}..HEAD")])?;
    let behind_out = git_ok(cwd, &["rev-list", "--count", &format!("HEAD..{base_ref}")])?;
    let name_status = git_ok(cwd, &[
        "diff",
        "--name-status",
        "-z",
        &format!("{merge_base}..HEAD"),
    ])?;
    Ok(BranchCompare {
        base_ref: base_ref.to_string(),
        ahead: name_status_count(&ahead_out),
        behind: name_status_count(&behind_out),
        changed_files: parse_name_status_z(&name_status),
    })
}

fn name_status_count(out: &str) -> u32 {
    out.trim().parse().unwrap_or(0)
}

// -z keeps paths verbatim; R/C entries carry TWO paths: origPath then newPath.
fn parse_name_status_z(output: &str) -> Vec<CompareEntry> {
    let mut fields = output.split('\0');
    let mut entries = Vec::new();
    while let Some(status) = fields.next() {
        if status.is_empty() {
            continue;
        }
        let Some(first_path) = fields.next() else {
            break;
        };
        // Score digits ride along in -z ("R100"); keep only the letter.
        let change_kind = status.chars().next().unwrap_or('M').to_string();
        let renamed_copied = change_kind == "R" || change_kind == "C";
        let (path, old_path) = if renamed_copied {
            match fields.next() {
                Some(new_path) => (new_path, Some(first_path.to_string())),
                None => break,
            }
        } else {
            (first_path, None)
        };
        entries.push(CompareEntry {
            path: path.to_string(),
            change_kind,
            old_path,
        });
    }
    entries
}

// argv-only exec still option-parses leading dashes; whitespace/control refs never resolve.
pub(crate) fn validate_ref_name(name: &str) -> Result<(), String> {
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
    use crate::git::test_support::{
        clone_repo, commit_file, git, sandbox, sandbox_with_origin, sandbox_without_commits,
        write_file, Sandbox,
    };
    use crate::git::worktree_registry::WorktreeRecord;
    use crate::git::worktrees::{repo_add, worktree_create, WorktreeCreateRequest};

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

    #[test]
    fn diff_kind_serializes_kebab_case_for_ipc() {
        assert_eq!(
            serde_json::to_string(&DiffKind::Text).unwrap(),
            "\"text\""
        );
        assert_eq!(
            serde_json::to_string(&DiffKind::Binary).unwrap(),
            "\"binary\""
        );
    }

    fn binary_file(repo: &Path, name: &str, bytes: &[u8]) {
        std::fs::write(repo.join(name), bytes).unwrap();
    }

    #[test]
    fn file_diff_unstaged_pairs_index_original_with_worktree_modified() {
        let s = sandbox("diff-unstaged");
        commit_file(&s.repo, "t.txt", "v0", "seed t");
        write_file(&s.repo, "t.txt", "v1");

        let d = sc_file_diff(&s.repo, "t.txt", false, false).unwrap();
        assert_eq!(d.kind, DiffKind::Text);
        assert_eq!(d.original_content, "v0");
        assert_eq!(d.modified_content, "v1");
        assert!(!d.truncated);
    }

    #[test]
    fn file_diff_staged_pairs_head_original_with_index_modified() {
        let s = sandbox("diff-staged");
        commit_file(&s.repo, "t.txt", "v0", "seed t");
        write_file(&s.repo, "t.txt", "v1");
        sc_stage(&s.repo, &one_path("t.txt")).unwrap();

        let d = sc_file_diff(&s.repo, "t.txt", true, false).unwrap();
        assert_eq!(d.kind, DiffKind::Text);
        assert_eq!(d.original_content, "v0");
        assert_eq!(d.modified_content, "v1");
    }

    #[test]
    fn file_diff_added_file_staged_has_empty_original_even_on_unborn_head() {
        let s = sandbox_without_commits("diff-added-unborn");
        write_file(&s.repo, "new.txt", "fresh");
        sc_stage(&s.repo, &one_path("new.txt")).unwrap();

        let d = sc_file_diff(&s.repo, "new.txt", true, false).unwrap();
        assert_eq!(d.original_content, "");
        assert_eq!(d.modified_content, "fresh");
    }

    #[test]
    fn file_diff_compare_against_head_uses_worktree_as_modified_side() {
        let s = sandbox("diff-vs-head");
        commit_file(&s.repo, "t.txt", "v0", "seed t");
        write_file(&s.repo, "t.txt", "v1");
        sc_stage(&s.repo, &one_path("t.txt")).unwrap();
        write_file(&s.repo, "t.txt", "v2");

        let d = sc_file_diff(&s.repo, "t.txt", false, true).unwrap();
        assert_eq!(d.original_content, "v0");
        assert_eq!(d.modified_content, "v2");
    }

    #[test]
    fn file_diff_untracked_file_gets_empty_original_and_disk_modified() {
        let s = sandbox("diff-untracked");
        write_file(&s.repo, "brand.txt", "untracked bytes");

        let d = sc_file_diff(&s.repo, "brand.txt", false, false).unwrap();
        assert_eq!(d.original_content, "");
        assert_eq!(d.modified_content, "untracked bytes");
    }

    #[test]
    fn file_diff_deleted_worktree_file_has_empty_modified_side() {
        let s = sandbox("diff-deleted");
        commit_file(&s.repo, "gone.txt", "was here", "seed gone");
        std::fs::remove_file(s.repo.join("gone.txt")).unwrap();

        let d = sc_file_diff(&s.repo, "gone.txt", false, false).unwrap();
        assert_eq!(d.original_content, "was here");
        assert_eq!(d.modified_content, "");
    }

    #[test]
    fn file_diff_binary_when_only_modified_side_has_nul() {
        let s = sandbox("diff-binary-modified");
        commit_file(&s.repo, "mix.bin", "plain text seed", "seed mix");
        binary_file(&s.repo, "mix.bin", b"text then \x00 nul");

        let d = sc_file_diff(&s.repo, "mix.bin", false, false).unwrap();
        assert_eq!(d.kind, DiffKind::Binary);
        assert_eq!(d.original_content, "");
        assert_eq!(d.modified_content, "");
    }

    #[test]
    fn file_diff_binary_when_only_original_side_has_nul() {
        let s = sandbox("diff-binary-original");
        binary_file(&s.repo, "o.dat", b"\x00OLD");
        git(&s.repo, &["add", "-A"]);
        git(&s.repo, &["commit", "-m", "seed binary original"]);
        write_file(&s.repo, "o.dat", "now plain text");

        let d = sc_file_diff(&s.repo, "o.dat", false, false).unwrap();
        assert_eq!(d.kind, DiffKind::Binary);
        assert_eq!(d.original_content, "");
        assert_eq!(d.modified_content, "");
    }

    #[test]
    fn file_diff_truncates_oversized_text_at_char_boundary() {
        let s = sandbox("diff-truncate");
        // 3-byte cycle guarantees the 512KB cap lands mid-char.
        let big: String = "aé".repeat(200_001);
        assert_eq!(big.len(), 600_003);
        commit_file(&s.repo, "big.txt", &big, "seed big");

        let d = sc_file_diff(&s.repo, "big.txt", false, false).unwrap();
        let cap_bytes = 512 * 1024;
        assert!(d.truncated);
        assert!(d.original_content.len() <= cap_bytes);
        assert!(!d.original_content.contains('\u{FFFD}'));
        assert!(d.original_content.starts_with("aé"));
        // Modified side equals committed content and must also be capped.
        assert!(d.modified_content.len() <= cap_bytes);
        assert!(!d.modified_content.contains('\u{FFFD}'));
        let last = d.original_content.chars().last().unwrap();
        assert!(last == 'a' || last == 'é', "cut must land on a whole char, got {last:?}");
    }

    #[test]
    fn file_diff_unknown_path_errors_with_not_found_message() {
        let s = sandbox("diff-unknown");
        let err = sc_file_diff(&s.repo, "never/known.txt", false, false).unwrap_err();
        assert!(err.contains("path not found in git"), "got: {err}");
    }

    #[test]
    fn history_walks_newest_first_with_parent_chain_stats_and_body_split() {
        let s = sandbox("history-chain");
        commit_file(&s.repo, "a.txt", "l1\nl2\nl3\n", "second subject\n\nbody detail here");
        binary_file(&s.repo, "blob.dat", b"\x00\x01BIN");
        git(&s.repo, &["add", "-A"]);
        git(&s.repo, &["commit", "-m", "third adds binary"]);

        let result = sc_history(&s.repo, 10).unwrap();
        assert!(!result.has_more);
        assert_eq!(result.items.len(), 3);

        let third = &result.items[0];
        let second = &result.items[1];
        let first = &result.items[2];
        assert_eq!(third.subject, "third adds binary");
        assert_eq!(second.subject, "second subject");
        assert_eq!(second.message_body.trim(), "body detail here");
        assert_eq!(first.subject, "initial");

        assert_eq!(second.parent_ids, vec![first.id.clone()]);
        assert_eq!(third.parent_ids, vec![second.id.clone()]);
        assert!(first.parent_ids.is_empty());
        assert!(first.timestamp_secs > 0);
        assert_eq!(first.author_email, "test@oppa.dev");
        assert_eq!(first.author_name, "Oppa Test");

        assert_eq!(first.stats.files, 1);
        assert_eq!(first.stats.insertions, 1);
        assert_eq!(second.stats.files, 1);
        assert_eq!(second.stats.insertions, 3);
        assert_eq!(second.stats.deletions, 0);
        assert_eq!(third.stats.files, 1, "binary file counts as file only");
        assert_eq!(third.stats.insertions, 0);
        assert_eq!(third.stats.deletions, 0);
    }

    #[test]
    fn history_counts_deletions_from_numstat() {
        let s = sandbox("history-deletes");
        commit_file(&s.repo, "README.md", "replaced line\n", "edit rewrites readme");
        let result = sc_history(&s.repo, 10).unwrap();
        let newest = &result.items[0];
        assert_eq!(newest.stats.files, 1);
        assert_eq!(newest.stats.insertions, 1);
        assert_eq!(newest.stats.deletions, 1, "1-line file fully rewritten");
    }

    #[test]
    fn history_has_more_true_when_extra_commits_exist_beyond_limit() {
        let s = sandbox("history-more");
        commit_file(&s.repo, "two.txt", "2", "second");
        commit_file(&s.repo, "three.txt", "3", "third");

        let limited = sc_history(&s.repo, 1).unwrap();
        assert!(limited.has_more);
        assert_eq!(limited.items.len(), 1);
        assert_eq!(limited.items[0].subject, "third");

        let full = sc_history(&s.repo, 10).unwrap();
        assert_eq!(limited.items[0].id, full.items[0].id);

        assert_eq!(sc_history(&s.repo, 0).unwrap().items.len(), 3, "limit 0 falls back to default 50");
    }

    #[test]
    fn branch_compare_reports_ahead_changed_files_and_rename_old_path() {
        let s = sandbox("compare-feature");
        commit_file(&s.repo, "extra.txt", "stable content here", "seed extra");
        git(&s.repo, &["checkout", "-b", "feature"]);
        commit_file(&s.repo, "README.md", "# init changed", "edit readme");
        commit_file(&s.repo, "new.txt", "brand new", "add new file");
        git(&s.repo, &["mv", "extra.txt", "moved.txt"]);
        git(&s.repo, &["commit", "-m", "move extra"]);

        let cmp = sc_branch_compare(&s.repo, "main").unwrap();
        assert_eq!(cmp.base_ref, "main");
        assert_eq!(cmp.ahead, 3);
        assert_eq!(cmp.behind, 0);
        assert_eq!(cmp.changed_files.len(), 3);

        let readme = cmp
            .changed_files
            .iter()
            .find(|e| e.path == "README.md")
            .expect("readme entry");
        assert_eq!(readme.change_kind, "M");
        assert_eq!(readme.old_path, None);
        let added = cmp
            .changed_files
            .iter()
            .find(|e| e.path == "new.txt")
            .expect("added entry");
        assert_eq!(added.change_kind, "A");
        let renamed = cmp
            .changed_files
            .iter()
            .find(|e| e.path == "moved.txt")
            .expect("renamed entry");
        assert_eq!(renamed.change_kind, "R");
        assert_eq!(renamed.old_path.as_deref(), Some("extra.txt"));
    }

    #[test]
    fn branch_compare_is_symmetric_from_the_other_direction() {
        let s = sandbox("compare-main-view");
        commit_file(&s.repo, "extra.txt", "stable content here", "seed extra");
        git(&s.repo, &["checkout", "-b", "feature"]);
        commit_file(&s.repo, "README.md", "# init changed", "edit readme");
        commit_file(&s.repo, "new.txt", "brand new", "add new file");
        git(&s.repo, &["checkout", "main"]);

        let cmp = sc_branch_compare(&s.repo, "feature").unwrap();
        assert_eq!(cmp.ahead, 0);
        assert_eq!(cmp.behind, 2);
        assert!(cmp.changed_files.is_empty());
    }

    #[test]
    fn branch_compare_rejects_invalid_base_before_spawning_git() {
        let s = sandbox("compare-invalid-base");
        for bad in ["-evil", "a..b"] {
            let err = sc_branch_compare(&s.repo, bad).unwrap_err();
            assert!(
                err.starts_with("invalid branch name"),
                "{bad:?} must hit validator, got: {err}"
            );
        }
    }

    #[test]
    fn branch_compare_unknown_base_propagates_git_error() {
        let s = sandbox("compare-ghost-base");
        let err = sc_branch_compare(&s.repo, "no-such-ref").unwrap_err();
        assert!(err.contains("no-such-ref"), "stderr must surface base name: {err}");
    }

    // ---------- remote sync (task 5) ----------

    fn short_head(repo: &Path) -> String {
        git(repo, &["rev-parse", "--short", "HEAD"]).trim().to_string()
    }

    fn push_main(repo: &Path) {
        git(repo, &["push", "origin", "main"]);
    }

    #[test]
    fn pull_status_serializes_kebab_case_for_ipc() {
        assert_eq!(serde_json::to_string(&PullStatus::FastForward).unwrap(), "\"fast-forward\"");
        assert_eq!(serde_json::to_string(&PullStatus::UpToDate).unwrap(), "\"up-to-date\"");
        assert_eq!(serde_json::to_string(&PullStatus::Merged).unwrap(), "\"merged\"");
    }

    #[test]
    fn fetch_is_noop_success_without_remotes() {
        let s = sandbox("fetch-noop");
        sc_fetch(&s.repo).unwrap();
        assert!(!sc_upstream_refresh(&s.repo).has_upstream);
    }

    #[test]
    fn fetch_updates_remote_refs_visible_in_refresh() {
        let (s, bare) = sandbox_with_origin("fetch-refresh");
        let twin = s.root.join("twin");
        clone_repo(&bare, &twin);
        commit_file(&twin, "twin.txt", "twin", "twin adds");
        push_main(&twin);

        assert_eq!(sc_upstream_refresh(&s.repo).behind, 0);
        sc_fetch(&s.repo).unwrap();
        let up = sc_upstream_refresh(&s.repo);
        assert_eq!(up.behind, 1);
        assert_eq!(up.ahead, 0);
        assert_eq!(up.remote_branch.as_deref(), Some("origin/main"));
    }

    #[test]
    fn pull_reports_up_to_date_when_nothing_behind() {
        let (s, _bare) = sandbox_with_origin("pull-current");
        for ff_only in [true, false] {
            let out = sc_pull(&s.repo, ff_only).unwrap();
            assert_eq!(out.status, PullStatus::UpToDate);
            assert_eq!(out.new_head, None);
        }
    }

    #[test]
    fn pull_ff_only_fast_forwards_to_remote_head() {
        let (s, bare) = sandbox_with_origin("pull-ff");
        let twin = s.root.join("twin");
        clone_repo(&bare, &twin);
        commit_file(&twin, "twin.txt", "twin", "twin adds");
        push_main(&twin);

        let out = sc_pull(&s.repo, true).unwrap();
        assert_eq!(out.status, PullStatus::FastForward);
        assert_eq!(out.new_head.as_deref(), Some(short_head(&twin).as_str()));
        let up = sc_upstream_refresh(&s.repo);
        assert_eq!((up.ahead, up.behind), (0, 0));
    }

    #[test]
    fn pull_ff_only_diverged_errors_without_merge_state_or_conflict_prefix() {
        let (s, bare) = sandbox_with_origin("pull-ff-diverged");
        let twin = s.root.join("twin");
        clone_repo(&bare, &twin);
        commit_file(&twin, "twin.txt", "twin", "twin adds");
        push_main(&twin);
        commit_file(&s.repo, "local.txt", "local", "local adds");

        let err = sc_pull(&s.repo, true).unwrap_err();
        assert!(err.contains("fast-forward"), "{err}");
        assert!(!err.starts_with(CONFLICT_PREFIX));
        assert_eq!(sc_status(&s.repo).unwrap().conflict_state, ConflictState::None);
    }

    #[test]
    fn pull_merge_combines_divergent_history_and_reports_merged() {
        let (s, bare) = sandbox_with_origin("pull-merge");
        let twin = s.root.join("twin");
        clone_repo(&bare, &twin);
        commit_file(&twin, "twin.txt", "twin", "twin adds");
        push_main(&twin);
        commit_file(&s.repo, "local.txt", "local", "local adds");

        let out = sc_pull(&s.repo, false).unwrap();
        assert_eq!(out.status, PullStatus::Merged);
        assert_eq!(out.new_head.as_deref(), Some(short_head(&s.repo).as_str()));
        assert_eq!(sc_status(&s.repo).unwrap().conflict_state, ConflictState::None);
        let up = sc_upstream_refresh(&s.repo);
        assert_eq!((up.ahead, up.behind), (2, 0));
    }

    #[test]
    fn pull_conflict_surfaces_conflict_prefix_and_merge_state() {
        let (s, bare) = sandbox_with_origin("pull-conflict");
        let twin = s.root.join("twin");
        clone_repo(&bare, &twin);
        commit_file(&twin, "README.md", "twin line\n", "twin edit");
        push_main(&twin);
        commit_file(&s.repo, "README.md", "primary line\n", "primary edit");

        let err = sc_pull(&s.repo, false).unwrap_err();
        assert!(
            err.starts_with(CONFLICT_PREFIX),
            "UI branches on this prefix, got: {err}"
        );
        let st = sc_status(&s.repo).unwrap();
        assert_eq!(st.conflict_state, ConflictState::Merge);
        assert_eq!(entry_for(&st, "README.md").area, GitArea::Conflict);

        git(&s.repo, &["merge", "--abort"]);
        assert_eq!(sc_status(&s.repo).unwrap().conflict_state, ConflictState::None);
    }

    #[test]
    fn fast_forward_applies_remote_commits_then_is_up_to_date() {
        let (s, bare) = sandbox_with_origin("ff-applies");
        let twin = s.root.join("twin");
        clone_repo(&bare, &twin);
        commit_file(&twin, "twin.txt", "twin", "twin adds");
        push_main(&twin);

        let moved = sc_fast_forward(&s.repo).unwrap();
        assert_eq!(moved.status, PullStatus::FastForward);
        assert_eq!(moved.new_head.as_deref(), Some(short_head(&twin).as_str()));

        let settled = sc_fast_forward(&s.repo).unwrap();
        assert_eq!(settled.status, PullStatus::UpToDate);
        assert_eq!(settled.new_head, None);
    }

    #[test]
    fn fast_forward_requires_upstream() {
        let s = sandbox("ff-no-upstream");
        commit_file(&s.repo, "more.txt", "m", "second");
        let err = sc_fast_forward(&s.repo).unwrap_err();
        assert!(err.contains("no upstream"), "{err}");
    }

    #[test]
    fn push_publish_sets_upstream_and_plain_push_requires_it() {
        let (s, _bare) = sandbox_with_origin("push-publish");
        git(&s.repo, &["checkout", "-b", "feature"]);
        commit_file(&s.repo, "f.txt", "f", "feature work");

        let refused = sc_push(&s.repo, false, false).unwrap_err();
        assert!(refused.contains("publish first"), "{refused}");

        let out = sc_push(&s.repo, true, false).unwrap();
        assert!(out.was_publish);
        assert_eq!(out.pushed_to, "origin/feature");
        let up = sc_upstream_refresh(&s.repo);
        assert!(up.has_upstream);
        assert_eq!(up.remote_branch.as_deref(), Some("origin/feature"));
        assert_eq!((up.ahead, up.behind), (0, 0));
    }

    #[test]
    fn push_publish_without_origin_remote_lists_hint() {
        let s = sandbox("push-publish-no-origin");
        let err = sc_push(&s.repo, true, false).unwrap_err();
        assert!(err.contains("'origin' remote"), "{err}");
    }

    #[test]
    fn push_after_new_commit_clears_ahead_and_reports_destination() {
        let (s, _bare) = sandbox_with_origin("push-ahead");
        assert_eq!(sc_upstream_refresh(&s.repo).ahead, 0);
        commit_file(&s.repo, "next.txt", "n", "second");

        assert_eq!(sc_upstream_refresh(&s.repo).ahead, 1);
        let out = sc_push(&s.repo, false, false).unwrap();
        assert!(!out.was_publish);
        assert_eq!(out.pushed_to, "origin/main");
        assert_eq!(sc_upstream_refresh(&s.repo).ahead, 0);
    }

    #[test]
    fn push_force_with_lease_succeeds_on_synced_clean_repo() {
        let (s, _bare) = sandbox_with_origin("push-fw-lease");
        let out = sc_push(&s.repo, false, true).unwrap();
        assert!(!out.was_publish);
        assert_eq!(out.pushed_to, "origin/main");
        assert_eq!(sc_upstream_refresh(&s.repo).ahead, 0);
    }

    #[test]
    fn push_rejected_when_remote_moved_and_local_stale() {
        let (s, bare) = sandbox_with_origin("push-rejected");
        let twin = s.root.join("twin");
        clone_repo(&bare, &twin);
        commit_file(&s.repo, "a.txt", "a", "primary moves");
        sc_push(&s.repo, false, false).unwrap();
        commit_file(&twin, "b.txt", "b", "twin moves stale");

        let err = sc_push(&twin, false, false).unwrap_err();
        assert!(err.contains("rejected"), "{err}");
        assert_eq!(sc_upstream_refresh(&twin).ahead, 1);
    }

    #[test]
    fn upstream_refresh_matches_sc_status_upstream_values() {
        let (s, bare) = sandbox_with_origin("refresh-parity");
        let twin = s.root.join("twin");
        clone_repo(&bare, &twin);
        commit_file(&twin, "twin.txt", "twin", "twin adds");
        push_main(&twin);
        commit_file(&s.repo, "local.txt", "local", "local adds");

        sc_fetch(&s.repo).unwrap();
        assert_eq!(sc_upstream_refresh(&s.repo), sc_status(&s.repo).unwrap().upstream);
    }

    // ---------- guarded merge-to-base (fleets F10 / T8) ----------

    // Sandbox main checkout + one registered agent worktree branched off main.
    fn agent_worktree(tag: &str) -> (Sandbox, WorktreeRecord) {
        let s = sandbox(tag);
        repo_add(&s.registry_path, &s.repo).unwrap();
        let req = WorktreeCreateRequest {
            repo_path: s.repo.clone(),
            name: Some("agent-one".into()),
            branch: None,
            base_ref: Some("main".into()),
            parent_worktree_id: None,
            workspace_dir_override: None,
            nest_workspaces: false,
        };
        let (record, _) = worktree_create(&s.registry_path, req).unwrap();
        (s, record)
    }

    fn head_parents(repo: &Path) -> usize {
        git(repo, &["rev-list", "--parents", "-n", "1", "HEAD"])
            .split_whitespace()
            .count()
            - 1
    }

    #[test]
    fn merge_to_base_rejects_cwd_outside_any_registered_worktree() {
        let s = sandbox("mtb-unknown-cwd");
        repo_add(&s.registry_path, &s.repo).unwrap();
        let err =
            sc_merge_to_base(&s.registry_path, &s.root.join("elsewhere"), MergeMode::Squash)
                .unwrap_err();
        assert!(err.contains("not inside a registered agent worktree"), "got: {err}");
    }

    #[test]
    fn merge_to_base_guard_blocks_when_main_checkout_is_dirty() {
        let (s, wt) = agent_worktree("mtb-dirty-main");
        commit_file(&wt.path, "feat.txt", "feature work\n", "feat adds");
        write_file(&s.repo, "dirty.txt", "uncommitted");

        let err = sc_merge_to_base(&s.registry_path, &wt.path, MergeMode::Squash).unwrap_err();
        assert!(
            err.contains("main checkout has uncommitted changes — commit or stash there first"),
            "got: {err}"
        );
        assert!(!s.repo.join("feat.txt").exists(), "blocked merge must mutate nothing");
    }

    #[test]
    fn merge_to_base_guard_never_switches_branches_for_base_mismatch() {
        let (s, wt) = agent_worktree("mtb-wrong-branch");
        commit_file(&wt.path, "feat.txt", "feature work\n", "feat adds");
        git(&s.repo, &["checkout", "-b", "elsewhere"]);

        let err = sc_merge_to_base(&s.registry_path, &wt.path, MergeMode::Squash).unwrap_err();
        assert!(
            err.contains("main checkout is on 'elsewhere' — switch it to 'main' yourself first"),
            "got: {err}"
        );
        assert_eq!(current_branch_name_public(&s.repo), "elsewhere");
    }

    fn current_branch_name_public(repo: &Path) -> String {
        git(repo, &["symbolic-ref", "--short", "HEAD"]).trim().to_string()
    }

    #[test]
    fn merge_to_base_probe_reports_conflicts_without_touching_either_side() {
        let (s, wt) = agent_worktree("mtb-conflict");
        commit_file(&wt.path, "shared.txt", "feature line\n", "feature edit");
        commit_file(&s.repo, "shared.txt", "main line\n", "main edit");

        let err = sc_merge_to_base(&s.registry_path, &wt.path, MergeMode::Squash).unwrap_err();
        assert!(err.starts_with("merge conflicts:"), "got: {err}");
        assert!(err.contains("shared.txt"), "conflicted file list must name files: {err}");

        // The probe is read-only: no merge state, no content change on either side.
        let st = sc_status(&s.repo).unwrap();
        assert!(st.entries.is_empty(), "probe must leave main clean: {:?}", st.entries);
        assert_eq!(st.conflict_state, ConflictState::None);
        assert_eq!(
            std::fs::read_to_string(s.repo.join("shared.txt")).unwrap(),
            "main line\n"
        );
        assert_eq!(
            std::fs::read_to_string(wt.path.join("shared.txt")).unwrap(),
            "feature line\n"
        );
    }

    #[test]
    fn merge_to_base_squash_lands_one_parent_commit_with_feature_content() {
        let (s, wt) = agent_worktree("mtb-squash");
        commit_file(&wt.path, "feat.txt", "feature work\n", "feat adds");
        let wt_head_before = git(&wt.path, &["rev-parse", "HEAD"]);

        let out = sc_merge_to_base(&s.registry_path, &wt.path, MergeMode::Squash).unwrap();

        assert_eq!(out.mode, "squash");
        assert_eq!(out.files_changed, 1);
        assert_eq!(
            out.merged_commit,
            git(&s.repo, &["rev-parse", "--short", "HEAD"]).trim()
        );
        assert_eq!(
            std::fs::read_to_string(s.repo.join("feat.txt")).unwrap().replace("\r\n", "\n"),
            "feature work\n"
        );
        assert!(
            git(&s.repo, &["log", "-1", "--pretty=%s"])
                .contains("squash: merge agent-one into main"),
            "squash subject expected: {}",
            git(&s.repo, &["log", "-1", "--pretty=%s"])
        );
        assert_eq!(head_parents(&s.repo), 1, "squash must not create a merge commit");
        assert_eq!(
            git(&wt.path, &["rev-parse", "HEAD"]),
            wt_head_before,
            "agent worktree HEAD must stay untouched"
        );
    }

    #[test]
    fn merge_to_base_merge_commit_mode_creates_second_parent() {
        let (s, wt) = agent_worktree("mtb-noff");
        commit_file(&wt.path, "feat.txt", "feature work\n", "feat adds");

        let out = sc_merge_to_base(&s.registry_path, &wt.path, MergeMode::MergeCommit).unwrap();

        assert_eq!(out.mode, "merge-commit");
        assert_eq!(out.files_changed, 1);
        assert_eq!(head_parents(&s.repo), 2, "--no-ff merge must have two parents");
        assert!(
            git(&s.repo, &["log", "-1", "--pretty=%s"]).contains("merge: agent-one into main"),
            "merge-commit subject expected: {}",
            git(&s.repo, &["log", "-1", "--pretty=%s"])
        );
        assert_eq!(
            std::fs::read_to_string(s.repo.join("feat.txt")).unwrap().replace("\r\n", "\n"),
            "feature work\n"
        );
    }

    #[test]
    fn merge_to_base_rejects_merge_mode_serializes_kebab_case() {
        assert_eq!(serde_json::to_string(&MergeMode::Squash).unwrap(), "\"squash\"");
        assert_eq!(
            serde_json::to_string(&MergeMode::MergeCommit).unwrap(),
            "\"merge-commit\""
        );
        assert!(MergeMode::parse("nope").is_err());
        assert_eq!(MergeMode::parse("merge").unwrap(), MergeMode::MergeCommit);
    }
}
