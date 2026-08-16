// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod pty;

use pty::manager::PtyManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(PtyManager::new())
        .invoke_handler(tauri::generate_handler![
            pty::commands::pty_spawn,
            pty::commands::pty_write,
            pty::commands::pty_resize,
            pty::commands::pty_kill,
            pty::commands::pty_ack,
            pty::commands::pty_list,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
