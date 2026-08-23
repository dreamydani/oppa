// CLI-owned DTOs + deterministic human/json rendering; internal daemon enum names never leak past this module.
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

