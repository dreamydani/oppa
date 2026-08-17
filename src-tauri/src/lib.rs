// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod fs;
mod git;
mod layout;
mod pty;
mod workspace_presets;

use pty::manager::PtyManager;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Close-save handshake: the renderer saves the layout via an async
    // `invoke`, which `window.beforeunload` cannot await (the webview is torn
    // down as the window closes, so the save never lands). Intercept the exit
    // instead: tell the renderer to save, wait for its `app:save-complete`
    // signal, then exit. Falls back to exiting after a short timeout so a
    // hung renderer cannot trap the app.
    let save_done = Arc::new(AtomicBool::new(false));

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
            pty::commands::save_scrollback,
            pty::commands::load_scrollback,
            pty::commands::delete_scrollback,
            pty::commands::cleanup_stale_scrollbacks,
            layout::save_layout,
            layout::load_layout,
            fs::fs_read_dir,
            git::git_status,
            workspace_presets::save_recents,
            workspace_presets::load_recents,
            workspace_presets::save_presets,
            workspace_presets::load_presets,
            confirm_save_complete,
        ])
        .setup(move |app| {
            let save_done = Arc::clone(&save_done);
            // The renderer signals that it finished the save via a command.
            // (confirm_save_complete below sets the flag.)
            app.manage(save_done);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let flag = window.state::<Arc<AtomicBool>>().inner().clone();
                flag.store(false, Ordering::SeqCst);
                let window_clone = window.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = window_clone.emit("app:before-close", ());
                    let deadline = Instant::now() + Duration::from_millis(1500);
                    while Instant::now() < deadline {
                        if flag.load(Ordering::SeqCst) {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(25));
                    }
                    let _ = window_clone.destroy();
                });
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {});
}

/// The renderer calls this after it finishes flushing the layout save during
/// the close handshake, so the exit wait loop can stop early.
#[tauri::command]
fn confirm_save_complete(app: tauri::AppHandle) {
    let flag = app.state::<Arc<AtomicBool>>();
    flag.store(true, Ordering::SeqCst);
}
