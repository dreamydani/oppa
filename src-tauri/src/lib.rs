mod browser;
mod fs;
mod git;
mod layout;
pub mod pty;
pub mod settings;
mod workspace_presets;

use pty::manager::PtyManager;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

/// Entry point when spawned with `--daemon`.
pub fn run_daemon() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("failed to build tokio runtime for daemon");
    rt.block_on(async {
        let socket_path = pty::ipc_protocol::get_daemon_socket_path();
        let server = pty::daemon_server::DaemonServer::new();
        let cancel_token = pty::daemon_server::CancellationToken::new();
        if let Err(e) = server.run_listener(&socket_path, cancel_token).await {
            eprintln!("Daemon listener exited: {e}");
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("oppa=info,warn")),
        )
        .try_init();

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
        .manage(browser::manager::BrowserManager::new())
        .invoke_handler(tauri::generate_handler![
            pty::commands::pty_spawn,
            pty::commands::pty_write,
            pty::commands::pty_resize,
            pty::commands::pty_kill,
            pty::commands::pty_ack,
            pty::commands::pty_list,
            pty::commands::pty_disconnect,
            pty::commands::pty_shutdown,
            pty::commands::save_scrollback,
            pty::commands::load_scrollback,
            pty::commands::delete_scrollback,
            pty::commands::cleanup_stale_scrollbacks,
            layout::save_layout,
            layout::load_layout,
            settings::save_settings,
            settings::load_settings,
            fs::fs_read_dir,
            fs::fs_read_file,
            fs::fs_write_file,
            fs::fs_create_file,
            git::git_status,
            workspace_presets::save_recents,
            workspace_presets::load_recents,
            workspace_presets::save_presets,
            workspace_presets::load_presets,
            browser::commands::browser_open,
            browser::commands::browser_navigate,
            browser::commands::browser_set_bounds,
            browser::commands::browser_hide,
            browser::commands::browser_show,
            browser::commands::browser_go_back,
            browser::commands::browser_go_forward,
            browser::commands::browser_reload,
            browser::commands::browser_open_devtools,
            confirm_save_complete,
        ])
        .setup(move |app| {
            let save_done = Arc::clone(&save_done);
            // The renderer signals that it finished the save via a command.
            // (confirm_save_complete below sets the flag.)
            app.manage(save_done);

            // Pre-warm daemon client in background so first terminal spawn is immediate
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Some(manager) = app_handle.try_state::<PtyManager>() {
                    let _ = manager.get_client();
                }
            });

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
                        tokio::time::sleep(Duration::from_millis(25)).await;
                    }
                    if let Some(manager) = window_clone.try_state::<PtyManager>() {
                        let _ = manager.disconnect();
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
