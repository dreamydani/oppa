use crate::pty::manager::PtyManager;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, State};

/// Payload emitted on the `pty:data` event for each output chunk.
#[derive(Clone, Serialize)]
pub struct PtyDataPayload {
    pub id: String,
    pub data: String,
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

/// Payload returned when spawning or attaching to a PTY session.
#[derive(Clone, Serialize)]
pub struct PtySpawnResultPayload {
    pub id: String,
    pub is_new: bool,
    pub snapshot: Option<String>,
    pub pid: u32,
    pub cols: u16,
    pub rows: u16,
    pub cwd: Option<String>,
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
    persona_id: Option<String>,
) -> Result<PtySpawnResultPayload, String> {
    let cols = cols.unwrap_or(80);
    let rows = rows.unwrap_or(24);
    let seq = AtomicU64::new(0);

    let config = crate::pty::shell_args::resolve_shell_launch_config(shell, cwd);

    let session_id = match id {
        Some(s) if !s.trim().is_empty() => s,
        _ => manager.next_id(),
    };

    // `app` is moved into the on_data closure; the on_exit and on_cwd closures get their
    // own clones.
    let on_exit_app = app.clone();
    let on_cwd_app = app.clone();
    let on_data: Box<dyn Fn(&str, &[u8]) + Send + Sync + 'static> =
        Box::new(move |id: &str, bytes: &[u8]| {
            let payload = PtyDataPayload {
                id: id.to_string(),
                data: String::from_utf8_lossy(bytes).into_owned(),
                seq: seq.fetch_add(1, Ordering::SeqCst),
            };
            let _ = app.emit("pty:data", payload);
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
        persona_id,
        Some(on_data),
        Some(on_exit),
        Some(on_cwd),
    )?;

    Ok(PtySpawnResultPayload {
        id: session_id,
        is_new: attach_res.is_new,
        snapshot: attach_res.snapshot,
        pid: attach_res.pid,
        cols: attach_res.cols,
        rows: attach_res.rows,
        cwd: attach_res.cwd,
    })
}

#[tauri::command]
pub fn pty_write(
    manager: State<'_, PtyManager>,
    id: String,
    data: String,
) -> Result<(), String> {
    manager.write(&id, data.as_bytes()).map_err(|e| e.to_string())
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
pub fn pty_ack(
    manager: State<'_, PtyManager>,
    id: String,
    chars: usize,
) -> Result<(), String> {
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
    storage.cleanup_stale(&active_ids).map_err(|e| e.to_string())
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
            snapshot: Some("screen content".into()),
            pid: 12345,
            cols: 80,
            rows: 24,
            cwd: Some("/test/cwd".into()),
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("\"id\":\"s1\""));
        assert!(json.contains("\"is_new\":false"));
        assert!(json.contains("\"snapshot\":\"screen content\""));
        assert!(json.contains("\"pid\":12345"));
        assert!(json.contains("\"cols\":80"));
        assert!(json.contains("\"rows\":24"));
        assert!(json.contains("\"cwd\":\"/test/cwd\""));
    }
}
