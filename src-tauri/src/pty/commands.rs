use crate::agents::catalog::PromptDelivery;
use crate::git::commit_message::CommitMessage;
use crate::git::comments_store::{DiffComment, NewDiffComment};
use crate::git::source_control::{
    BranchCompare, DiffContent, HistoryResult, LocalBranches, PullOutcome, PushOutcome,
    SourceControlStatus, UpstreamStatus,
};
use crate::git::worktree_registry::{RepoRecord, WorktreeRecord, WorktreeStatus};
use crate::git::worktrees::WorktreeListEntry;
use crate::pty::daemon_client::WorktreeAgentHandoff;
use crate::pty::ipc_protocol::WorktreePsEntry;
use crate::pty::manager::PtyManager;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

/// Payload emitted on the `pty:data` event for each output chunk.
#[derive(Clone, Serialize)]
pub struct PtyDataPayload {
    pub id: String,
    pub data: String,
    pub bytes: usize,
    pub seq: u64,
}

/// Payload emitted on the `pty:exit` event when a session's child exits.
#[derive(Clone, Serialize)]
pub struct PtyExitPayload {
    pub id: String,
    pub code: Option<i32>,
    pub error: Option<String>,
}

/// Payload emitted on the `pty:cwd` event when a session's CWD changes.
#[derive(Clone, Serialize)]
pub struct PtyCwdPayload {
    pub id: String,
    pub cwd: String,
}

/// Payload emitted on the `worktree-changed` event when any client mutates a worktree.
#[derive(Clone, Serialize)]
pub struct WorktreeChangedPayload {
    pub id: Option<String>,
}

/// Payload emitted on `session-title-changed` when any client renames a session.
#[derive(Clone, Serialize)]
pub struct SessionTitleChangedPayload {
    pub id: String,
    pub title: String,
}

/// Payload emitted on `session-focus-requested` (CLI-driven tab switch).
#[derive(Clone, Serialize)]
pub struct SessionFocusRequestedPayload {
    pub id: String,
}

/// Builds the webview forwarder installed on the manager; survives reconnects
/// because PtyManager re-applies it to every client it creates.
pub fn worktree_changed_forwarder(app: &AppHandle) -> Arc<dyn Fn(Option<&str>) + Send + Sync> {
    let emitter = app.clone();
    Arc::new(move |id| {
        let _ = emitter.emit(
            "worktree-changed",
            WorktreeChangedPayload {
                id: id.map(str::to_string),
            },
        );
    })
}

pub fn session_title_changed_forwarder(app: &AppHandle) -> Arc<dyn Fn(&str, &str) + Send + Sync> {
    let emitter = app.clone();
    Arc::new(move |id, title| {
        let _ = emitter.emit(
            "session-title-changed",
            SessionTitleChangedPayload {
                id: id.to_string(),
                title: title.to_string(),
            },
        );
    })
}

pub fn session_focus_requested_forwarder(app: &AppHandle) -> Arc<dyn Fn(&str) + Send + Sync> {
    let emitter = app.clone();
    Arc::new(move |id| {
        let _ = emitter.emit(
            "session-focus-requested",
            SessionFocusRequestedPayload { id: id.to_string() },
        );
    })
}

pub fn git_changed_forwarder(app: &AppHandle) -> Arc<dyn Fn() + Send + Sync> {
    let emitter = app.clone();
    Arc::new(move || {
        let _ = emitter.emit("git-changed", ());
    })
}

/// Resume plan surfaced to the frontend when a cold-restored session relaunches work.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumePlanPayload {
    pub command_line: String,
    pub kind: String,
}

/// Payload returned when spawning or attaching to a PTY session.
#[derive(Clone, Serialize)]
pub struct PtySpawnResultPayload {
    pub id: String,
    pub is_new: bool,
    pub is_warm: bool,
    pub snapshot: Option<String>,
    pub cold_scrollback: Option<String>,
    pub pid: u32,
    pub cols: u16,
    pub rows: u16,
    pub cwd: Option<String>,
    pub resume: Option<ResumePlanPayload>,
    pub resume_declined_reason: Option<String>,
}

/// Spawn or reattach to a PTY session running in the background daemon.
///
/// The emitter closures capture the `AppHandle` and forward output, exit, and
/// cwd signals to the frontend as `pty:data` / `pty:exit` / `pty:cwd` events.
#[tauri::command]
pub fn pty_spawn(
    manager: State<'_, PtyManager>,
    app: AppHandle,
    id: Option<String>,
    shell: Option<String>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    resume_agents: Option<bool>,
    worktree_id: Option<String>,
) -> Result<PtySpawnResultPayload, String> {
    let cols = cols.unwrap_or(80);
    let rows = rows.unwrap_or(24);
    let seq = AtomicU64::new(0);

    let config = crate::pty::shell_args::resolve_shell_launch_config(shell, cwd);

    let session_id = match id {
        Some(s) if !s.trim().is_empty() => s,
        _ => manager.next_id(),
    };

    // The closures capture clones of `AppHandle` so `app` remains available.
    let on_data_app = app.clone();
    let on_exit_app = app.clone();
    let on_cwd_app = app.clone();
    let on_data: Box<dyn Fn(&str, &[u8]) + Send + Sync + 'static> =
        Box::new(move |id: &str, bytes: &[u8]| {
            let payload = PtyDataPayload {
                id: id.to_string(),
                data: String::from_utf8_lossy(bytes).into_owned(),
                bytes: bytes.len(),
                seq: seq.fetch_add(1, Ordering::SeqCst),
            };
            let _ = on_data_app.emit("pty:data", payload);
        });
    let on_exit: Box<dyn Fn(&str, Option<i32>) + Send + Sync + 'static> =
        Box::new(move |id: &str, code: Option<i32>| {
            let payload = PtyExitPayload {
                id: id.to_string(),
                code,
                error: None,
            };
            let _ = on_exit_app.emit("pty:exit", payload);
        });
    let on_cwd: Box<dyn Fn(&str, &str) + Send + Sync + 'static> =
        Box::new(move |id: &str, cwd: &str| {
            let payload = PtyCwdPayload {
                id: id.to_string(),
                cwd: cwd.to_string(),
            };
            let _ = on_cwd_app.emit("pty:cwd", payload);
        });

    let attach_res = manager.create_or_attach(
        &session_id,
        cols,
        rows,
        config.cwd,
        Some(config.program),
        Some(on_data),
        Some(on_exit),
        Some(on_cwd),
        resume_agents.unwrap_or(true),
        worktree_id,
    )?;

    let (is_warm, cold_scrollback) = if !attach_res.is_new {
        (true, None)
    } else {
        use tauri::Manager;
        let scrollback = app.path().app_data_dir().ok().and_then(|dir| {
            let storage = crate::pty::snapshot::SnapshotStorage::new(dir);
            storage
                .load_snapshot(&session_id)
                .ok()
                .flatten()
                .map(|s| s.scrollback)
        });
        (false, scrollback)
    };

    Ok(PtySpawnResultPayload {
        id: session_id,
        is_new: attach_res.is_new,
        is_warm,
        snapshot: attach_res.snapshot,
        cold_scrollback,
        pid: attach_res.pid,
        cols: attach_res.cols,
        rows: attach_res.rows,
        cwd: attach_res.cwd,
        resume: attach_res.resume.map(|r| ResumePlanPayload {
            command_line: r.command_line,
            kind: match r.kind {
                crate::pty::ipc_protocol::ResumeKind::AgentResume => "agent-resume".into(),
                crate::pty::ipc_protocol::ResumeKind::CommandRelaunch => "command-relaunch".into(),
            },
        }),
        resume_declined_reason: attach_res.resume_declined_reason,
    })
}

#[tauri::command]
pub fn pty_write(manager: State<'_, PtyManager>, id: String, data: String) -> Result<(), String> {
    manager
        .write(&id, data.as_bytes())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    manager: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    manager.resize(&id, cols, rows).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(manager: State<'_, PtyManager>, id: String) -> Result<(), String> {
    manager.kill(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_ack(manager: State<'_, PtyManager>, id: String, chars: usize) -> Result<(), String> {
    manager.ack(&id, chars)
}

#[tauri::command]
pub fn pty_list(manager: State<'_, PtyManager>) -> Vec<String> {
    pty_list_impl(&manager)
}

#[tauri::command]
pub fn pty_disconnect(manager: State<'_, PtyManager>) -> Result<(), String> {
    manager.disconnect()
}

#[tauri::command]
pub fn pty_shutdown(manager: State<'_, PtyManager>) -> Result<(), String> {
    manager.shutdown()
}

// Worktree/repo commands: thin forwarders so the daemon stays the single owner
// of the registry (the GUI process never touches worktrees.json directly).

#[tauri::command]
pub fn repo_add(manager: State<'_, PtyManager>, path: String) -> Result<Vec<RepoRecord>, String> {
    manager.get_client()?.repo_add(&path)
}

#[tauri::command]
pub fn repo_list(manager: State<'_, PtyManager>) -> Result<Vec<RepoRecord>, String> {
    manager.get_client()?.repo_list()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn worktree_create(
    manager: State<'_, PtyManager>,
    repo_path: String,
    name: Option<String>,
    branch: Option<String>,
    base_ref: Option<String>,
    parent_worktree_id: Option<String>,
    workspace_dir: Option<String>,
    nest_workspaces: Option<bool>,
) -> Result<Option<WorktreeRecord>, String> {
    let client = manager.get_client()?;
    client
        .worktree_create(
            &repo_path,
            name,
            branch,
            base_ref,
            parent_worktree_id,
            workspace_dir,
            nest_workspaces,
        )
        .map(Some)
}

#[tauri::command]
pub fn worktree_list(manager: State<'_, PtyManager>) -> Result<Vec<WorktreeListEntry>, String> {
    manager.get_client()?.worktree_list()
}

/// Minimal agent descriptor for the GUI picker; launch details stay daemon-side.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfileDto {
    pub id: String,
    pub display_name: String,
    pub prompt_delivery: PromptDelivery,
}

fn agent_profiles_impl() -> Vec<AgentProfileDto> {
    crate::agents::catalog::profiles()
        .iter()
        .map(|p| AgentProfileDto {
            id: p.id.to_string(),
            display_name: p.display_name.to_string(),
            prompt_delivery: p.prompt_delivery,
        })
        .collect()
}

/// Static catalog read in-process; the frontend never hardcodes agent lists.
#[tauri::command]
pub fn agent_profiles() -> Vec<AgentProfileDto> {
    agent_profiles_impl()
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn worktree_create_agent(
    manager: State<'_, PtyManager>,
    repo_path: String,
    name: Option<String>,
    branch: Option<String>,
    base_ref: Option<String>,
    parent_worktree_id: Option<String>,
    workspace_dir: Option<String>,
    nest_workspaces: Option<bool>,
    agent: Option<String>,
    prompt: Option<String>,
    command: Option<String>,
) -> Result<WorktreeAgentHandoff, String> {
    manager.get_client()?.create_worktree_with_agent(
        &repo_path,
        name,
        branch,
        base_ref,
        parent_worktree_id,
        workspace_dir,
        nest_workspaces,
        agent,
        prompt,
        command,
    )
}

#[tauri::command]
pub fn worktree_show(
    manager: State<'_, PtyManager>,
    id: String,
) -> Result<Option<WorktreeRecord>, String> {
    manager.get_client()?.worktree_show(&id)
}

#[tauri::command]
pub fn worktree_current(
    manager: State<'_, PtyManager>,
    cwd: String,
) -> Result<Option<WorktreeRecord>, String> {
    manager.get_client()?.worktree_current(&cwd)
}

#[tauri::command]
pub fn worktree_set(
    manager: State<'_, PtyManager>,
    id: String,
    set_parent: bool,
    parent_worktree_id: Option<String>,
    workspace_status: Option<WorktreeStatus>,
    display_name: Option<String>,
) -> Result<Option<WorktreeRecord>, String> {
    let client = manager.get_client()?;
    client
        .worktree_set(
            &id,
            set_parent,
            parent_worktree_id,
            workspace_status,
            display_name,
        )
        .map(Some)
}

#[tauri::command]
pub fn worktree_remove(
    manager: State<'_, PtyManager>,
    id: String,
    force: bool,
    delete_branch: bool,
) -> Result<(), String> {
    manager
        .get_client()?
        .worktree_remove(&id, force, delete_branch)
}

#[tauri::command]
pub fn worktree_purge(manager: State<'_, PtyManager>, id: String) -> Result<(), String> {
    manager.get_client()?.worktree_purge(&id)
}

#[tauri::command]
pub fn worktree_ps(manager: State<'_, PtyManager>) -> Result<Vec<WorktreePsEntry>, String> {
    manager.get_client()?.worktree_ps()
}

#[tauri::command]
pub fn worktree_lineage(
    manager: State<'_, PtyManager>,
    id: String,
) -> Result<Vec<WorktreeRecord>, String> {
    manager.get_client()?.worktree_lineage(&id)
}

// Source-control commands: sc_* prefix avoids the legacy in-process git_status;
// every one is a daemon forwarder so the daemon stays the single git owner.

#[tauri::command]
pub fn sc_status(
    manager: State<'_, PtyManager>,
    cwd: String,
) -> Result<SourceControlStatus, String> {
    manager.get_client()?.sc_status(&cwd)
}

#[tauri::command]
pub fn sc_stage(
    manager: State<'_, PtyManager>,
    cwd: String,
    paths: Vec<String>,
) -> Result<(), String> {
    manager.get_client()?.sc_stage(&cwd, &paths)
}

#[tauri::command]
pub fn sc_unstage(
    manager: State<'_, PtyManager>,
    cwd: String,
    paths: Vec<String>,
) -> Result<(), String> {
    manager.get_client()?.sc_unstage(&cwd, &paths)
}

#[tauri::command]
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

#[tauri::command]
pub fn sc_commit(
    manager: State<'_, PtyManager>,
    cwd: String,
    message: String,
) -> Result<String, String> {
    manager.get_client()?.sc_commit(&cwd, &message)
}

#[tauri::command]
pub fn sc_local_branches(
    manager: State<'_, PtyManager>,
    cwd: String,
) -> Result<LocalBranches, String> {
    manager.get_client()?.sc_local_branches(&cwd)
}

#[tauri::command]
pub fn sc_checkout(
    manager: State<'_, PtyManager>,
    cwd: String,
    branch: String,
) -> Result<(), String> {
    manager.get_client()?.sc_checkout(&cwd, &branch)
}

#[tauri::command]
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

#[tauri::command]
pub fn sc_history(
    manager: State<'_, PtyManager>,
    cwd: String,
    limit: Option<u32>,
) -> Result<HistoryResult, String> {
    manager.get_client()?.sc_history(&cwd, limit)
}

#[tauri::command]
pub fn sc_branch_compare(
    manager: State<'_, PtyManager>,
    cwd: String,
    base_ref: String,
) -> Result<BranchCompare, String> {
    manager.get_client()?.sc_branch_compare(&cwd, &base_ref)
}

#[tauri::command]
pub fn sc_fetch(manager: State<'_, PtyManager>, cwd: String) -> Result<(), String> {
    manager.get_client()?.sc_fetch(&cwd)
}

#[tauri::command]
pub fn sc_pull(
    manager: State<'_, PtyManager>,
    cwd: String,
    ff_only: bool,
) -> Result<PullOutcome, String> {
    manager.get_client()?.sc_pull(&cwd, ff_only)
}

#[tauri::command]
pub fn sc_fast_forward(
    manager: State<'_, PtyManager>,
    cwd: String,
) -> Result<PullOutcome, String> {
    manager.get_client()?.sc_fast_forward(&cwd)
}

#[tauri::command]
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

#[tauri::command]
pub fn sc_upstream_refresh(
    manager: State<'_, PtyManager>,
    cwd: String,
) -> Result<UpstreamStatus, String> {
    manager.get_client()?.sc_upstream_refresh(&cwd)
}

#[tauri::command]
pub fn sc_generate_commit_message(
    manager: State<'_, PtyManager>,
    cwd: String,
) -> Result<CommitMessage, String> {
    manager.get_client()?.sc_generate_commit_message(&cwd)
}

#[tauri::command]
pub fn diff_comments_list(
    manager: State<'_, PtyManager>,
    worktree_id: String,
) -> Result<Vec<DiffComment>, String> {
    manager.get_client()?.diff_comments_list(&worktree_id)
}

#[tauri::command]
pub fn diff_comment_add(
    manager: State<'_, PtyManager>,
    comment: NewDiffComment,
) -> Result<DiffComment, String> {
    manager.get_client()?.diff_comment_add(comment)
}

#[tauri::command]
pub fn diff_comment_update(
    manager: State<'_, PtyManager>,
    id: String,
    body: String,
) -> Result<DiffComment, String> {
    manager.get_client()?.diff_comment_update(&id, &body)
}

#[tauri::command]
pub fn diff_comment_delete(manager: State<'_, PtyManager>, id: String) -> Result<(), String> {
    manager.get_client()?.diff_comment_delete(&id)
}

#[tauri::command]
pub fn diff_comments_mark_sent(
    manager: State<'_, PtyManager>,
    ids: Vec<String>,
) -> Result<Vec<DiffComment>, String> {
    manager.get_client()?.diff_comments_mark_sent(&ids)
}

#[tauri::command]
pub fn save_scrollback(app: AppHandle, id: String, data: String) -> Result<(), String> {
    use tauri::Manager;
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let storage = crate::pty::snapshot::SnapshotStorage::new(app_data_dir);
    storage.save(&id, &data).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn load_scrollback(app: AppHandle, id: String) -> Result<Option<String>, String> {
    use tauri::Manager;
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let storage = crate::pty::snapshot::SnapshotStorage::new(app_data_dir);
    storage.load(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_scrollback(app: AppHandle, id: String) -> Result<(), String> {
    use tauri::Manager;
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let storage = crate::pty::snapshot::SnapshotStorage::new(app_data_dir);
    storage.delete(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cleanup_stale_scrollbacks(app: AppHandle, active_ids: Vec<String>) -> Result<(), String> {
    use tauri::Manager;
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let storage = crate::pty::snapshot::SnapshotStorage::new(app_data_dir);
    storage
        .cleanup_stale(&active_ids)
        .map_err(|e| e.to_string())
}

/// Shared body of `pty_list`: the session ids in registration order. Kept as
/// a plain function so tests can exercise the real logic without a Tauri
/// `State` guard (which would drag Tauri's runtime into the test binary and
/// break its load on Windows).
fn pty_list_impl(manager: &PtyManager) -> Vec<String> {
    manager.list()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::session::default_shell;

    #[test]
    fn default_shell_is_nonempty() {
        assert!(!default_shell().is_empty());
    }

    #[test]
    fn pty_list_empty_on_fresh_manager() {
        let (manager, cancel_token, server_thread) =
            crate::pty::manager::tests::setup_test_server_and_manager();
        let ids = pty_list_impl(&manager);
        assert!(
            ids.is_empty(),
            "expected no sessions on a fresh manager, got: {ids:?}"
        );
        cancel_token.cancel();
        let _ = server_thread.join();
    }

    #[test]
    fn pty_data_payload_serializes() {
        let payload = PtyDataPayload {
            id: "session-123".into(),
            data: "hello world".into(),
            bytes: 11,
            seq: 1,
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("\"id\":\"session-123\""));
        assert!(json.contains("\"data\":\"hello world\""));
        assert!(json.contains("\"bytes\":11"));
        assert!(json.contains("\"seq\":1"));
    }

    #[test]
    fn pty_cwd_payload_serializes() {
        let payload = PtyCwdPayload {
            id: "session-123".into(),
            cwd: "C:\\projects\\oppa".into(),
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("\"id\":\"session-123\""));
        assert!(json.contains("\"cwd\":\"C:\\\\projects\\\\oppa\""));
    }

    #[test]
    fn pty_spawn_result_payload_serializes() {
        let payload = PtySpawnResultPayload {
            id: "s1".into(),
            is_new: false,
            is_warm: true,
            snapshot: Some("screen content".into()),
            cold_scrollback: None,
            pid: 12345,
            cols: 80,
            rows: 24,
            cwd: Some("/test/cwd".into()),
            resume: None,
            resume_declined_reason: None,
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("\"id\":\"s1\""));
        assert!(json.contains("\"is_new\":false"));
        assert!(json.contains("\"is_warm\":true"));
        assert!(json.contains("\"snapshot\":\"screen content\""));
        assert!(json.contains("\"cold_scrollback\":null"));
        assert!(json.contains("\"pid\":12345"));
        assert!(json.contains("\"cols\":80"));
        assert!(json.contains("\"rows\":24"));
        assert!(json.contains("\"cwd\":\"/test/cwd\""));
    }

    #[test]
    fn worktree_changed_payload_serializes() {
        let with_id = serde_json::to_string(&WorktreeChangedPayload {
            id: Some("repo::C:/ws/feat-a".into()),
        })
        .unwrap();
        assert!(with_id.contains("\"id\":\"repo::C:/ws/feat-a\""));

        let without_id = serde_json::to_string(&WorktreeChangedPayload { id: None }).unwrap();
        assert!(without_id.contains("\"id\":null"));
    }

    #[test]
    fn session_title_changed_payload_serializes() {
        let json = serde_json::to_string(&SessionTitleChangedPayload {
            id: "s1".into(),
            title: "build".into(),
        })
        .unwrap();
        assert!(json.contains("\"id\":\"s1\""));
        assert!(json.contains("\"title\":\"build\""));
    }

    #[test]
    fn session_focus_requested_payload_serializes() {
        let json =
            serde_json::to_string(&SessionFocusRequestedPayload { id: "s1".into() }).unwrap();
        assert_eq!(json, r#"{"id":"s1"}"#);
    }

    #[test]
    fn agent_profiles_dto_mirrors_catalog_with_camel_case_keys() {
        let dtos = agent_profiles_impl();
        assert_eq!(dtos.len(), crate::agents::catalog::profiles().len());
        let json = serde_json::to_string(&dtos).unwrap();
        assert!(json.contains("\"displayName\":\"Claude Code\""));
        assert!(json.contains("\"promptDelivery\":\"arg\""));
        assert!(json.contains("\"promptDelivery\":\"stdin\""));
        assert!(!json.contains("display_name"), "must not leak snake_case");
    }
}
