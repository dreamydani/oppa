// CLI-owned DTOs + deterministic human/json rendering; internal daemon enum names never leak past this module.
use crate::cli::vocabulary::AgentContextDocument;
use crate::git::worktree_registry::{RepoRecord, WorktreeRecord, WorktreeStatus};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CliRepoRecord {
    pub repo_id: String,
    pub path: String,
    pub default_base_ref: Option<String>,
    pub worktree_base_path: Option<String>,
}

impl From<&RepoRecord> for CliRepoRecord {
    fn from(r: &RepoRecord) -> Self {
        Self {
            repo_id: r.repo_id.clone(),
            path: r.path.to_string_lossy().into_owned(),
            default_base_ref: r.default_base_ref.clone(),
            worktree_base_path: r.worktree_base_path.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CliWorktreeRecord {
    pub id: String,
    pub repo_id: String,
    pub name: String,
    pub display_name: Option<String>,
    pub branch: String,
    pub path: String,
    pub base_ref: String,
    pub parent_worktree_id: Option<String>,
    pub child_worktree_ids: Vec<String>,
    pub status: String,
    pub retired: bool,
    pub created_at_ms: u64,
    pub linked_pr_url: Option<String>,
}

// Status goes through serde so the CLI word always matches the daemon wire value.
fn status_word(status: WorktreeStatus) -> String {
    serde_json::to_value(status)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

impl From<&WorktreeRecord> for CliWorktreeRecord {
    fn from(w: &WorktreeRecord) -> Self {
        Self {
            id: w.id.clone(),
            repo_id: w.repo_id.clone(),
            name: w.name.clone(),
            display_name: w.display_name.clone(),
            branch: w.branch.clone(),
            path: w.path.to_string_lossy().into_owned(),
            base_ref: w.base_ref.clone(),
            parent_worktree_id: w.parent_worktree_id.clone(),
            child_worktree_ids: w.child_worktree_ids.clone(),
            status: status_word(w.workspace_status),
            retired: w.retired,
            created_at_ms: w.created_at_ms,
            linked_pr_url: w.linked_pr_url.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CliWorktreeListEntry {
    pub record: CliWorktreeRecord,
    pub missing_on_disk: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CliWorktreePsEntry {
    pub record: CliWorktreeRecord,
    pub live_sessions: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct OkPayload {
    pub ok: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CliScreenText {
    pub text: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CliWaitResult {
    pub satisfied: bool,
    pub exit_code: Option<i32>,
    pub waited_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CliSessionDetail {
    pub id: String,
    pub pid: u32,
    pub cols: u16,
    pub rows: u16,
    pub cwd: Option<String>,
    pub worktree_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CliRenameResult {
    pub ok: bool,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CliSessionHandle {
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CliSplitHandles {
    pub primary: String,
    pub secondary: String,
}

// Flattened so JSON keeps the record payload at the top level with session_id alongside it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CliAgentHandoff {
    #[serde(flatten)]
    pub record: CliWorktreeRecord,
    pub session_id: String,
}

pub fn render_json<T: Serialize + ?Sized>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "{}".into())
}

fn render_table(headers: &[&str], rows: &[Vec<String>]) -> String {
    let widths: Vec<usize> = (0..headers.len())
        .map(|col| {
            headers[col]
                .len()
                .max(rows.iter().map(|r| r[col].len()).max().unwrap_or(0))
        })
        .collect();
    let fmt = |cells: &[String]| {
        cells
            .iter()
            .enumerate()
            .map(|(i, cell)| format!("{:<width$}", cell, width = widths[i]))
            .collect::<Vec<_>>()
            .join("  ")
    };
    let mut lines = vec![fmt(
        &headers.iter().map(|h| (*h).to_string()).collect::<Vec<_>>(),
    )];
    lines.extend(rows.iter().map(|row| fmt(row)));
    lines
        .iter()
        .map(|line| line.trim_end().to_string())
        .collect::<Vec<_>>()
        .join("\n")
}

fn flag(on: bool) -> String {
    if on { "yes".into() } else { "-".into() }
}

pub fn render_repo_table(repos: &[CliRepoRecord]) -> String {
    if repos.is_empty() {
        return "no repos registered".into();
    }
    let rows: Vec<Vec<String>> = repos
        .iter()
        .map(|r| {
            vec![
                r.repo_id.clone(),
                r.path.clone(),
                r.default_base_ref.clone().unwrap_or_else(|| "-".into()),
            ]
        })
        .collect();
    render_table(&["REPO", "PATH", "BASE"], &rows)
}

fn render_kv(lines: Vec<(String, String)>) -> String {
    let width = lines.iter().map(|(l, _)| l.len()).max().unwrap_or(0) + 1;
    lines
        .iter()
        .map(|(label, value)| format!("{:<width$} {}", format!("{label}:"), value, width = width))
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn render_repo_detail(record: &CliRepoRecord) -> String {
    let mut lines = vec![
        ("repo".to_string(), record.repo_id.clone()),
        ("path".to_string(), record.path.clone()),
        (
            "base".to_string(),
            record
                .default_base_ref
                .clone()
                .unwrap_or_else(|| "-".into()),
        ),
    ];
    if let Some(base) = &record.worktree_base_path {
        lines.push(("worktree-base".to_string(), base.clone()));
    }
    render_kv(lines)
}

// Repo id prefix keeps the id column readable; full ids stay in show/JSON output.
fn short_id(id: &str) -> &str {
    id.split("::").next().unwrap_or(id)
}

pub fn render_worktree_list(entries: &[CliWorktreeListEntry]) -> String {
    if entries.is_empty() {
        return "no worktrees".into();
    }
    let rows: Vec<Vec<String>> = entries
        .iter()
        .map(|e| {
            vec![
                short_id(&e.record.id).to_string(),
                e.record.name.clone(),
                e.record.branch.clone(),
                e.record.status.clone(),
                // Tombstones read as dead even though --all still surfaces them.
                flag(!e.record.retired),
                flag(e.missing_on_disk),
            ]
        })
        .collect();
    render_table(
        &["ID", "NAME", "BRANCH", "STATUS", "LIVE", "MISSING"],
        &rows,
    )
}

fn render_timestamp(ms: u64) -> String {
    chrono::DateTime::from_timestamp_millis(ms.min(i64::MAX as u64) as i64)
        .map(|ts| ts.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_else(|| ms.to_string())
}

pub fn render_worktree_show(record: &CliWorktreeRecord) -> String {
    let mut lines = vec![
        ("id".to_string(), record.id.clone()),
        ("repo".to_string(), record.repo_id.clone()),
        ("name".to_string(), record.name.clone()),
    ];
    if let Some(display) = &record.display_name {
        lines.push(("display".to_string(), display.clone()));
    }
    lines.push(("branch".to_string(), record.branch.clone()));
    lines.push(("status".to_string(), record.status.clone()));
    lines.push(("path".to_string(), record.path.clone()));
    lines.push(("base".to_string(), record.base_ref.clone()));
    lines.push((
        "parent".to_string(),
        record
            .parent_worktree_id
            .clone()
            .unwrap_or_else(|| "-".into()),
    ));
    lines.push((
        "children".to_string(),
        if record.child_worktree_ids.is_empty() {
            "-".into()
        } else {
            record.child_worktree_ids.join(", ")
        },
    ));
    lines.push(("retired".to_string(), if record.retired { "yes".into() } else { "no".into() }));
    lines.push((
        "created".to_string(),
        render_timestamp(record.created_at_ms),
    ));
    if let Some(pr) = &record.linked_pr_url {
        lines.push(("pr".to_string(), pr.clone()));
    }
    render_kv(lines)
}

// M1 ships no screen preview, so the skipped-output counters render as placeholders.
pub fn render_ps_rows(entries: &[CliWorktreePsEntry]) -> String {
    if entries.is_empty() {
        return "no worktrees".into();
    }
    entries
        .iter()
        .map(|e| {
            format!(
                "{} {} pty:{} unread-skipped:- last-screen-skipped:-",
                e.record.branch, e.record.name, e.live_sessions
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn render_agent_handoff(handoff: &CliAgentHandoff) -> String {
    format!(
        "{}\nagent terminal: {}",
        render_worktree_show(&handoff.record),
        handoff.session_id
    )
}

// BFS order from the daemon guarantees a parent precedes each child, so depths resolve in one pass.
pub fn render_lineage_tree(records: &[CliWorktreeRecord]) -> String {
    use std::collections::HashMap;
    let mut depths: HashMap<String, usize> = HashMap::new();
    let mut lines: Vec<String> = Vec::with_capacity(records.len());
    for record in records {
        let depth = record
            .parent_worktree_id
            .as_deref()
            .and_then(|parent| depths.get(parent).copied())
            .map(|parent_depth| parent_depth + 1)
            .unwrap_or(0);
        depths.insert(record.id.clone(), depth);
        lines.push(format!(
            "{}{} ({}){}",
            "  ".repeat(depth),
            record.name,
            record.branch,
            if record.retired { " [retired]" } else { "" }
        ));
    }
    lines.join("\n")
}

// ---- terminal verb renderers ----

pub fn render_session_list(ids: &[String]) -> String {
    if ids.is_empty() {
        return "no sessions".into();
    }
    ids.join("\n")
}

pub fn render_screen_text(text: &str) -> String {
    // Normalize CR line endings so pipes/grep see clean LF text
    let normalized = text.replace("\r\n", "\n");
    let trimmed = normalized.trim_end_matches(['\n', '\r']);
    format!("{trimmed}\n")
}

pub fn render_session_detail(detail: &CliSessionDetail) -> String {
    let mut lines = vec![
        ("id".to_string(), detail.id.clone()),
        ("pid".to_string(), detail.pid.to_string()),
        ("size".to_string(), format!("{}x{}", detail.cols, detail.rows)),
    ];
    lines.push((
        "cwd".to_string(),
        detail.cwd.clone().unwrap_or_else(|| "-".into()),
    ));
    lines.push((
        "worktree".to_string(),
        detail.worktree_id.clone().unwrap_or_else(|| "-".into()),
    ));
    render_kv(lines)
}

pub fn render_wait_result(result: &CliWaitResult) -> String {
    let status = if result.satisfied { "satisfied" } else { "not satisfied" };
    match result.exit_code {
        Some(code) => format!("{status} · exit {code} · {}ms", result.waited_ms),
        None => format!("{status} · {}ms", result.waited_ms),
    }
}

// ---- git source-control renderers (internal serde types ARE the wire contract) ----

use crate::git::source_control::{
    BranchCompare, DiffContent, DiffKind, HistoryResult, LocalBranches, PullOutcome, PullStatus,
    PushOutcome, SourceControlStatus,
};

fn sc_area_counts(status: &SourceControlStatus) -> (usize, usize, usize, usize) {
    let mut staged = 0;
    let mut unstaged = 0;
    let mut untracked = 0;
    let mut conflicts = 0;
    for entry in &status.entries {
        match entry.area {
            crate::git::source_control::GitArea::Staged => staged += 1,
            crate::git::source_control::GitArea::Unstaged => unstaged += 1,
            crate::git::source_control::GitArea::Untracked => untracked += 1,
            crate::git::source_control::GitArea::Conflict => conflicts += 1,
        }
    }
    (staged, unstaged, untracked, conflicts)
}

fn sc_conflict_word(state: &crate::git::source_control::ConflictState) -> Option<&'static str> {
    use crate::git::source_control::ConflictState;
    match state {
        ConflictState::None => None,
        ConflictState::Merge => Some("merging"),
        ConflictState::Rebase => Some("rebasing"),
        ConflictState::Revert => Some("reverting"),
        ConflictState::CherryPick => Some("cherry-picking"),
    }
}

pub fn render_sc_status(status: &SourceControlStatus) -> String {
    let (staged, unstaged, untracked, conflicts) = sc_area_counts(status);
    let mut summary = format!(
        "{} · staged {} · unstaged {} · untracked {} · conflicts {}",
        if status.branch.is_empty() {
            "(detached)"
        } else {
            &status.branch
        },
        staged,
        unstaged,
        untracked,
        conflicts
    );
    if let Some(word) = sc_conflict_word(&status.conflict_state) {
        summary.push_str(&format!(" · {word}"));
    }
    if status.upstream.has_upstream {
        summary.push_str(&format!(
            " · ↑{} ↓{}",
            status.upstream.ahead, status.upstream.behind
        ));
    } else {
        summary.push_str(" · no upstream");
    }

    let section = |lines: &mut Vec<String>, title: &str, area| {
        let entries: Vec<&_> = status
            .entries
            .iter()
            .filter(|e| e.area == area)
            .collect();
        if entries.is_empty() {
            return;
        }
        lines.push(title.to_string());
        for entry in entries {
            let old = entry
                .old_path
                .as_deref()
                .map(|o| format!(" <- {o}"))
                .unwrap_or_default();
            lines.push(format!(
                "{}{} {}{}",
                entry.index_status, entry.worktree_status, entry.path, old
            ));
        }
    };

    use crate::git::source_control::GitArea;
    let mut lines = vec![summary];
    section(&mut lines, "STAGED", GitArea::Staged);
    section(&mut lines, "UNSTAGED", GitArea::Unstaged);
    section(&mut lines, "CONFLICTS", GitArea::Conflict);
    section(&mut lines, "UNTRACKED", GitArea::Untracked);
    lines.join("\n")
}

pub fn render_sc_branches(branches: &LocalBranches) -> String {
    branches
        .branches
        .iter()
        .map(|name| {
            let marker = if branches.current.as_deref() == Some(name.as_str()) {
                "* "
            } else {
                "  "
            };
            format!("{marker}{name}")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn render_sc_diff(diff: &DiffContent) -> String {
    let truncated_note = diff.truncated.then_some(" (truncated)").unwrap_or("");
    if diff.kind == DiffKind::Binary {
        return format!("binary{truncated_note}");
    }
    format!(
        "--- original{}{}\n+++ modified{}",
        truncated_note, diff.original_content, diff.modified_content
    )
}

pub fn render_sc_history(history: &HistoryResult) -> String {
    if history.items.is_empty() {
        return "no commits".into();
    }
    history
        .items
        .iter()
        .map(|item| {
            format!(
                "{} {} (+{} -{}, {} files)",
                &item.id[..item.id.len().min(8)],
                item.subject,
                item.stats.insertions,
                item.stats.deletions,
                item.stats.files
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn render_sc_compare(compare: &BranchCompare) -> String {
    let mut lines = vec![format!(
        "ahead {} · behind {} vs {}",
        compare.ahead, compare.behind, compare.base_ref
    )];
    for file in &compare.changed_files {
        let old = file
            .old_path
            .as_deref()
            .map(|o| format!(" <- {o}"))
            .unwrap_or_default();
        lines.push(format!("{} {}{}", file.change_kind, file.path, old));
    }
    lines.join("\n")
}

pub fn render_sc_pull(outcome: &PullOutcome) -> String {
    let head_suffix = outcome
        .new_head
        .as_deref()
        .map(|h| h.to_string())
        .unwrap_or_default();
    match outcome.status {
        PullStatus::UpToDate => "already up to date".into(),
        PullStatus::FastForward => {
            if head_suffix.is_empty() {
                "fast-forwarded".into()
            } else {
                format!("fast-forwarded to {head_suffix}")
            }
        }
        PullStatus::Merged => {
            if head_suffix.is_empty() {
                "merged".into()
            } else {
                format!("merged at {head_suffix}")
            }
        }
    }
}

pub fn render_sc_push(outcome: &PushOutcome) -> String {
    if outcome.was_publish {
        format!("pushed {} · published", outcome.pushed_to)
    } else {
        format!("pushed {}", outcome.pushed_to)
    }
}

// ---- agent-context renderers ----
pub fn render_agent_context(doc: &AgentContextDocument) -> String {
    let mut lines = vec![format!(
        "OPPA CLI {} · protocol {}",
        doc.version, doc.protocol
    )];
    let mut index = 0;
    while index < doc.commands.len() {
        let family = doc.commands[index].family.clone();
        let group_end = doc.commands[index..]
            .iter()
            .take_while(|cmd| cmd.family == family)
            .count();
        lines.push(family.to_uppercase());
        let group = &doc.commands[index..index + group_end];
        // Standalone families (status/open/agent-context) have no verb column to align.
        let verb_width = group.iter().map(|c| c.verb.len()).max().unwrap_or(0);
        for cmd in group {
            if cmd.verb.is_empty() {
                push_catalog_entry(&mut lines, cmd, "  ", "  ");
            } else {
                let head =
                    format!("  {}  ", format!("{:<width$}", cmd.verb, width = verb_width));
                push_catalog_entry(&mut lines, cmd, &head, &" ".repeat(head.len()));
            }
        }
        index += group_end;
    }
    lines.push("NOTES".to_string());
    lines.extend(doc.notes.iter().map(|note| format!("- {note}")));
    lines.join("\n")
}

fn push_catalog_entry(
    lines: &mut Vec<String>,
    cmd: &crate::cli::vocabulary::CatalogCommand,
    head: &str,
    cont: &str,
) {
    lines.push(format!("{head}{}", cmd.summary));
    lines.push(format!("{cont}usage: {}", cmd.example));
    if !cmd.flags.is_empty() {
        let names: Vec<&str> = cmd.flags.iter().map(|f| f.name.as_str()).collect();
        lines.push(format!("{cont}flags: {}", names.join(" ")));
    }
}

