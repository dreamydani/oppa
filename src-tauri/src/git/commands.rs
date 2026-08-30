use crate::git::commit_message::CommitMessage;
use crate::git::comments_store::{DiffComment, NewDiffComment};
use crate::git::hosted_reviews::{CreatedReview, Eligibility, PrStatus};
use crate::git::pr_message::PrMessage;
use crate::git::source_control::{
    BranchCompare, DiffContent, HistoryResult, LocalBranches, MergeToBaseOutcome, PullOutcome,
    PushOutcome, SourceControlStatus, UpstreamStatus,
};
use crate::pty::manager::PtyManager;
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

pub fn git_changed_forwarder(app: &AppHandle) -> Arc<dyn Fn() + Send + Sync> {
    let emitter = app.clone();
    Arc::new(move || {
        let _ = emitter.emit("git-changed", ());
    })
}

/// Payload emitted on `pr-changed` when any linked PR status refreshes.
#[derive(Clone, Serialize)]
pub struct PrChangedPayload {
    pub worktree_id: Option<String>,
}

pub fn pr_changed_forwarder(app: &AppHandle) -> Arc<dyn Fn(Option<&str>) + Send + Sync> {
    let emitter = app.clone();
    Arc::new(move |id| {
        let _ = emitter.emit(
            "pr-changed",
            PrChangedPayload {
                worktree_id: id.map(str::to_string),
            },
        );
    })
}

// Source-control commands: sc_* prefix avoids the legacy in-process git_status;
// every one is a daemon forwarder so the daemon stays the single git owner.

#[tauri::command(async)]
pub fn sc_status(
    manager: State<'_, PtyManager>,
    cwd: String,
) -> Result<SourceControlStatus, String> {
    manager.get_client()?.sc_status(&cwd)
}

#[tauri::command(async)]
pub fn sc_stage(
    manager: State<'_, PtyManager>,
    cwd: String,
    paths: Vec<String>,
) -> Result<(), String> {
    manager.get_client()?.sc_stage(&cwd, &paths)
}

#[tauri::command(async)]
pub fn sc_unstage(
    manager: State<'_, PtyManager>,
    cwd: String,
    paths: Vec<String>,
) -> Result<(), String> {
    manager.get_client()?.sc_unstage(&cwd, &paths)
}

#[tauri::command(async)]
pub fn sc_discard(
    manager: State<'_, PtyManager>,
    cwd: String,
    paths: Vec<String>,
    include_untracked: bool,
) -> Result<(), String> {
    manager
        .get_client()?
        .sc_discard(&cwd, &paths, include_untracked)
}

#[tauri::command(async)]
pub fn sc_commit(
    manager: State<'_, PtyManager>,
    cwd: String,
    message: String,
) -> Result<String, String> {
    manager.get_client()?.sc_commit(&cwd, &message)
}

#[tauri::command(async)]
pub fn sc_local_branches(
    manager: State<'_, PtyManager>,
    cwd: String,
) -> Result<LocalBranches, String> {
    manager.get_client()?.sc_local_branches(&cwd)
}

#[tauri::command(async)]
pub fn sc_checkout(
    manager: State<'_, PtyManager>,
    cwd: String,
    branch: String,
) -> Result<(), String> {
    manager.get_client()?.sc_checkout(&cwd, &branch)
}

#[tauri::command(async)]
pub fn sc_file_diff(
    manager: State<'_, PtyManager>,
    cwd: String,
    path: String,
    staged: bool,
    compare_against_head: bool,
) -> Result<DiffContent, String> {
    manager
        .get_client()?
        .sc_file_diff(&cwd, &path, staged, compare_against_head)
}

#[tauri::command(async)]
pub fn sc_history(
    manager: State<'_, PtyManager>,
    cwd: String,
    limit: Option<u32>,
) -> Result<HistoryResult, String> {
    manager.get_client()?.sc_history(&cwd, limit)
}

#[tauri::command(async)]
pub fn sc_branch_compare(
    manager: State<'_, PtyManager>,
    cwd: String,
    base_ref: String,
) -> Result<BranchCompare, String> {
    manager.get_client()?.sc_branch_compare(&cwd, &base_ref)
}

#[tauri::command(async)]
pub fn sc_fetch(manager: State<'_, PtyManager>, cwd: String) -> Result<(), String> {
    manager.get_client()?.sc_fetch(&cwd)
}

#[tauri::command(async)]
pub fn sc_pull(
    manager: State<'_, PtyManager>,
    cwd: String,
    ff_only: bool,
) -> Result<PullOutcome, String> {
    manager.get_client()?.sc_pull(&cwd, ff_only)
}

#[tauri::command(async)]
pub fn sc_fast_forward(
    manager: State<'_, PtyManager>,
    cwd: String,
) -> Result<PullOutcome, String> {
    manager.get_client()?.sc_fast_forward(&cwd)
}

#[tauri::command(async)]
pub fn sc_push(
    manager: State<'_, PtyManager>,
    cwd: String,
    publish: bool,
    force_with_lease: bool,
) -> Result<PushOutcome, String> {
    manager
        .get_client()?
        .sc_push(&cwd, publish, force_with_lease)
}

#[tauri::command(async)]
pub fn sc_upstream_refresh(
    manager: State<'_, PtyManager>,
    cwd: String,
) -> Result<UpstreamStatus, String> {
    manager.get_client()?.sc_upstream_refresh(&cwd)
}

#[tauri::command(async)]
pub fn sc_merge_to_base(
    manager: State<'_, PtyManager>,
    cwd: String,
    mode: String,
) -> Result<MergeToBaseOutcome, String> {
    manager.get_client()?.sc_merge_to_base(&cwd, &mode)
}

#[tauri::command(async)]
pub fn sc_generate_commit_message(
    manager: State<'_, PtyManager>,
    cwd: String,
) -> Result<CommitMessage, String> {
    manager.get_client()?.sc_generate_commit_message(&cwd)
}

#[tauri::command(async)]
pub fn sc_generate_pr_message(
    manager: State<'_, PtyManager>,
    cwd: String,
) -> Result<PrMessage, String> {
    manager.get_client()?.sc_generate_pr_message(&cwd)
}

#[tauri::command(async)]
pub fn diff_comments_list(
    manager: State<'_, PtyManager>,
    worktree_id: String,
) -> Result<Vec<DiffComment>, String> {
    manager.get_client()?.diff_comments_list(&worktree_id)
}

#[tauri::command(async)]
pub fn diff_comment_add(
    manager: State<'_, PtyManager>,
    comment: NewDiffComment,
) -> Result<DiffComment, String> {
    manager.get_client()?.diff_comment_add(comment)
}

#[tauri::command(async)]
pub fn diff_comment_update(
    manager: State<'_, PtyManager>,
    id: String,
    body: String,
) -> Result<DiffComment, String> {
    manager.get_client()?.diff_comment_update(&id, &body)
}

#[tauri::command(async)]
pub fn diff_comment_delete(manager: State<'_, PtyManager>, id: String) -> Result<(), String> {
    manager.get_client()?.diff_comment_delete(&id)
}

#[tauri::command(async)]
pub fn diff_comments_mark_sent(
    manager: State<'_, PtyManager>,
    ids: Vec<String>,
) -> Result<Vec<DiffComment>, String> {
    manager.get_client()?.diff_comments_mark_sent(&ids)
}

#[tauri::command(async)]
pub fn review_eligibility(
    manager: State<'_, PtyManager>,
    cwd: String,
) -> Result<Eligibility, String> {
    manager.get_client()?.review_eligibility(&cwd)
}

#[tauri::command(async)]
pub fn create_review(
    manager: State<'_, PtyManager>,
    cwd: String,
    title: String,
    body: String,
    draft: bool,
) -> Result<CreatedReview, String> {
    manager.get_client()?.create_review(&cwd, &title, &body, draft)
}

#[tauri::command(async)]
pub fn review_status(
    manager: State<'_, PtyManager>,
    cwd: String,
) -> Result<PrStatus, String> {
    manager.get_client()?.review_status(&cwd)
}
