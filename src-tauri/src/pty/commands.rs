use crate::pty::manager::PtyManager;
use tauri::State;

#[tauri::command]
pub fn pty_list(manager: State<'_, PtyManager>) -> Vec<String> {
    manager.sessions().lock().keys().cloned().collect()
}
