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

/// Spawn a PTY session running `shell` (default: the platform's default
/// shell, see [`crate::pty::session::default_shell`]) in `cwd` (default: the
/// app's working directory) and return the new session id.
///
/// The emitter closures capture the `AppHandle` and forward output and exit
/// signals to the frontend as `pty:data` / `pty:exit` events. The manager
/// itself never sees the `AppHandle` (see `PtyManager::spawn`).
#[tauri::command]
pub fn pty_spawn(
    manager: State<'_, PtyManager>,
    app: AppHandle,
    shell: Option<String>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<String, String> {
    let cols = cols.unwrap_or(80);
    let rows = rows.unwrap_or(24);
    let seq = AtomicU64::new(0);

    // `app` is moved into the on_data closure; the on_exit closure gets its
    // own clone.
    let on_exit_app = app.clone();
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

    let args: Vec<String> = Vec::new();
    manager.spawn(shell, cwd, cols, rows, args, Some(on_data), Some(on_exit))
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
    manager.ack(&id, chars);
    Ok(())
}

#[tauri::command]
pub fn pty_list(manager: State<'_, PtyManager>) -> Vec<String> {
    pty_list_impl(&manager)
}

/// Shared body of `pty_list`: the session ids in registration order. Kept as
/// a plain function so tests can exercise the real logic without a Tauri
/// `State` guard (which would drag Tauri's runtime into the test binary and
/// break its load on Windows).
fn pty_list_impl(manager: &PtyManager) -> Vec<String> {
    manager.sessions().lock().keys().cloned().collect()
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
        let manager = PtyManager::new();
        let ids = pty_list_impl(&manager);
        assert!(
            ids.is_empty(),
            "expected no sessions on a fresh manager, got: {ids:?}"
        );
    }
}
