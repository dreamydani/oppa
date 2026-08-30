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

/// Payload emitted on `session-working` when a session flips working/idle.
/// Event name matches the sibling `session-*` events; camelCase keys mirror
/// the TS payload the frontend listener forwards verbatim.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionWorkingPayload {
    pub session_id: String,
    pub working: bool,
}

pub fn session_working_forwarder(app: &AppHandle) -> Arc<dyn Fn(&str, bool) + Send + Sync> {
    let emitter = app.clone();
    Arc::new(move |id, working| {
        let _ = emitter.emit(
            "session-working",
            SessionWorkingPayload {
                session_id: id.to_string(),
                working,
            },
        );
    })
}

/// Payload emitted on `agent-status`; the classified entry rides verbatim
/// snake_case so the renderer mirrors the IPC shape 1:1 with zero mapping.
#[derive(Clone, Serialize)]
pub struct AgentStatusPayload {
    pub pane_key: String,
    pub entry: crate::agents::status::AgentStatusEntry,
}

pub fn agent_status_forwarder(
    app: &AppHandle,
) -> Arc<dyn Fn(&str, &crate::agents::status::AgentStatusEntry) + Send + Sync> {
    let emitter = app.clone();
    Arc::new(move |pane_key, entry| {
        let _ = emitter.emit(
            "agent-status",
            AgentStatusPayload {
                pane_key: pane_key.to_string(),
                entry: entry.clone(),
            },
        );
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
    // Mirrors CreateOrAttachResult.working so warm reattach hydrates dots
    pub working: bool,
}

/// Spawn or reattach to a PTY session running in the background daemon.
///
/// The emitter closures capture the `AppHandle` and forward output, exit, and
/// cwd signals to the frontend as `pty:data` / `pty:exit` / `pty:cwd` events.
#[tauri::command(async)]
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
        let scrollback = crate::pty::snapshot::resolve_gui_data_dir(&app).and_then(|dir| {
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
        working: attach_res.working,
    })
}

#[tauri::command(async)]
pub fn pty_write(manager: State<'_, PtyManager>, id: String, data: String) -> Result<(), String> {
    manager
        .write(&id, data.as_bytes())
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn pty_resize(
    manager: State<'_, PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    manager.resize(&id, cols, rows).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn pty_kill(manager: State<'_, PtyManager>, id: String) -> Result<(), String> {
    manager.kill(&id).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn pty_ack(manager: State<'_, PtyManager>, id: String, chars: usize) -> Result<(), String> {
    manager.ack(&id, chars)
}

#[tauri::command(async)]
pub fn pty_list(manager: State<'_, PtyManager>) -> Vec<String> {
    pty_list_impl(&manager)
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
            working: true,
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
        assert!(json.contains("\"working\":true"));
    }

    #[test]
    fn session_working_payload_serializes_camel_case() {
        let json = serde_json::to_string(&SessionWorkingPayload {
            session_id: "s1".into(),
            working: false,
        })
        .unwrap();
        assert_eq!(json, r#"{"sessionId":"s1","working":false}"#);
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
}
