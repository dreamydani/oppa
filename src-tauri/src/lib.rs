pub mod agents;
pub mod atomic_file;
mod browser;
pub mod channel;
pub mod channel_commands;
pub mod cli;
pub mod extensions;
mod fs;
pub mod git;
pub mod layout;
pub mod pty;
pub mod settings;
pub mod updater;
mod workspace_presets;

use pty::manager::PtyManager;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
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
        let app_data_dir = pty::snapshot::resolve_app_data_dir();
        let server = match &app_data_dir {
            Some(dir) => {
                let mut server =
                    pty::daemon_server::DaemonServer::with_snapshot_storage(dir.clone());
                // Token is only enforced when the discovery file landed; a failed
                // write leaves the pipe open so the GUI keeps working (M1 grace).
                let auth_token = pty::runtime_metadata::generate_auth_token();
                match pty::runtime_metadata::write_runtime_metadata(dir, &socket_path, &auth_token)
                {
                    Ok(_) => server.set_auth_token(Some(auth_token)),
                    Err(e) => eprintln!("runtime metadata write failed ({e}); pipe left unauthenticated"),
                }
                server
            }
            None => pty::daemon_server::DaemonServer::new(),
        };
        // Agent hook receiver: managed hooks POST authoritative session ids here
        if let Some(hook) =
            pty::agent_hook_server::AgentHookServer::start(server.sessions()).await
        {
            pty::agent_hook_server::write_endpoint_files(
                app_data_dir.as_deref(),
                hook.port,
                &hook.token,
            );
            // Install/remove the Claude Code managed hooks per user setting.
            // The hook payload is what enables true resume-by-session-id.
            let auto_resume = app_data_dir
                .as_deref()
                .map(|dir| {
                    std::path::Path::new(dir)
                        .join("settings.json")
                })
                .and_then(|path| crate::settings::load_settings_at(&path).ok().flatten())
                .and_then(|json| serde_json::from_str::<crate::settings::AppSettings>(&json).ok())
                .map(|s| s.general.auto_resume_agents)
                .unwrap_or(true);
            if let (Some(dir), Some(home)) = (app_data_dir.as_deref(), dirs::home_dir()) {
                let result = if auto_resume {
                    pty::agent_hook_installer::install(dir, &home)
                } else {
                    pty::agent_hook_installer::uninstall(&home)
                };
                if let Err(e) = result {
                    eprintln!("agent hook installer: {e}");
                }
            }
        }
        let cancel_token = pty::daemon_server::CancellationToken::new();
        server.start_pr_poller();
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

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Process plugin (relaunch after install) is channel-independent.
        .plugin(tauri_plugin_process::init())
        .manage(PtyManager::new())
        .manage(browser::manager::BrowserManager::new());
    // The updater is stable-only: a dev build NEVER checks for updates, so the
    // plugin (which would add its own update-check commands) is not registered
    // on dev. `Channel::current()` is compile-time, so the registration is
    // baked into the binary.
    //
    // NOTE: the plugin's NATIVE check()/downloadAndInstall() become the real
    // flow in Task 5; the custom manifest check in `updater.rs` stays as the
    // fallback for one release (dual-manifest transition, no flag day).
    if channel::Channel::current() == channel::Channel::Stable {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }
    builder
        .invoke_handler(tauri::generate_handler![
            channel_commands::app_channel,
            updater::check_for_update,
            pty::commands::pty_spawn,
            pty::commands::pty_write,
            pty::commands::pty_resize,
            pty::commands::pty_kill,
            pty::commands::pty_ack,
            pty::commands::pty_list,
            pty::commands::can_upgrade_daemon,
            layout::save_scrollback,
            layout::load_scrollback,
            layout::delete_scrollback,
            layout::cleanup_stale_scrollbacks,
            git::worktree_commands::repo_add,
            git::worktree_commands::repo_list,
            git::worktree_commands::worktree_create,
            git::worktree_commands::worktree_create_agent,
            git::worktree_commands::worktree_create_fleet,
            git::worktree_commands::agent_profiles,
            git::worktree_commands::worktree_list,
            git::worktree_commands::worktree_show,
            git::worktree_commands::worktree_current,
            git::worktree_commands::worktree_set,
            git::worktree_commands::worktree_remove,
            git::worktree_commands::worktree_purge,
            git::worktree_commands::worktree_ps,
            git::worktree_commands::worktree_lineage,
            git::commands::sc_status,
            git::commands::sc_stage,
            git::commands::sc_unstage,
            git::commands::sc_discard,
            git::commands::sc_commit,
            git::commands::sc_local_branches,
            git::commands::sc_checkout,
            git::commands::sc_file_diff,
            git::commands::sc_history,
            git::commands::sc_branch_compare,
            git::commands::sc_fetch,
            git::commands::sc_pull,
            git::commands::sc_fast_forward,
            git::commands::sc_push,
            git::commands::sc_upstream_refresh,
            git::commands::sc_merge_to_base,
            git::commands::sc_generate_commit_message,
            git::commands::sc_generate_pr_message,
            git::commands::diff_comments_list,
            git::commands::diff_comment_add,
            git::commands::diff_comment_update,
            git::commands::diff_comment_delete,
            git::commands::diff_comments_mark_sent,
            git::commands::review_eligibility,
            git::commands::create_review,
            git::commands::review_status,
            layout::save_layout,
            layout::load_layout,
            layout::confirm_save_complete,
            settings::save_settings,
            settings::load_settings,
            fs::fs_read_dir,
            fs::fs_read_file,
            fs::fs_write_file,
            fs::fs_create_file,
            fs::fs_create_dir,
            fs::fs_detect_editors,
            fs::fs_open_with,
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
            extensions::commands::list_extensions,
            extensions::commands::set_extension_enabled,
            extensions::commands::get_contributions,
            extensions::commands::grant_extension_consent,
            extensions::commands::get_extension_fingerprint,
        ])
        .setup(move |app| {
            let save_done = Arc::clone(&save_done);
            // The renderer signals that it finished the save via a command.
            // (confirm_save_complete below sets the flag.)
            app.manage(save_done);

            // Extension registry: built-ins + user-installed, honoring the
            // persisted disabled set. A missing data dir just skips managing
            // state; commands then fail loudly instead of half-working.
            if let (Some(user_dir), Some(state_path), Some(data_root)) = (
                pty::snapshot::resolve_gui_data_dir(app.handle())
                    .map(|d| d.join("extensions")),
                pty::snapshot::resolve_gui_data_dir(app.handle())
                    .map(|d| d.join(extensions::registry::STATE_FILE_NAME)),
                pty::snapshot::resolve_gui_data_dir(app.handle()),
            ) {
                let registry = extensions::commands::init_registry_at(&user_dir, &state_path);

                // Host service: webview notifications + PTY write path + crash
                // pump that auto-disables and persists the failing extension.
                let services = extensions::host::HostServices {
                    notify: Arc::new(extensions::service::WebviewNotifySink(
                        app.handle().clone(),
                    )),
                    terminal: Arc::new(extensions::service::ManagerTerminalWriter(
                        app.handle().clone(),
                    )),
                    storage_root: data_root.join("extension-storage"),
                };
                let report_app = app.handle().clone();
                let host_service = Arc::new(extensions::service::ExtensionHostService::new(
                    services,
                    move |report| match report {
                        extensions::host::EngineReport::Crashed { ext_id, reason } => {
                            if let Some(state) = report_app.try_state::<extensions::commands::ExtensionsState>() {
                                if let Ok(mut reg) = state.0.lock() {
                                    reg.record_error(&ext_id, reason.clone());
                                    let _ = reg.set_enabled(&ext_id, false);
                                    if let Some(p) =
                                        pty::snapshot::resolve_gui_data_dir(&report_app)
                                            .map(|d| d.join(extensions::registry::STATE_FILE_NAME))
                                    {
                                        let _ = extensions::registry::save_state_at(
                                            &p,
                                            &extensions::registry::ExtensionsStateFile {
                                                disabled_ids: reg.disabled_ids(),
                                                consents: reg.consents().clone(),
                                            },
                                        );
                                    }
                                }
                            }
                            let _ = report_app.emit(
                                "extensions:crashed",
                                serde_json::json!({ "id": ext_id, "reason": reason }),
                            );
                        }
                    },
                ));
                app.manage(host_service.clone());

                // Boot-start engines for enabled + consented scriptable entries.
                for entry in registry.entries() {
                    let Some(manifest) = entry.manifest.as_ref() else {
                        continue;
                    };
                    let Some(entry_source) = entry.entry_source.as_ref() else {
                        continue;
                    };
                    if registry.is_enabled(&manifest.id)
                        && registry.is_consented(&manifest.id, &entry.fingerprint)
                    {
                        host_service.start(
                            &manifest.id,
                            manifest.capabilities.clone(),
                            entry_source.clone(),
                        );
                    }
                }

                app.manage(extensions::commands::ExtensionsState(Mutex::new(registry)));

                // Extension event taps: ride the existing Tauri event bus so no
                // PTY internals change. Payloads are forwarded as raw JSON —
                // extensions only ever see the documented subset of fields.
                use tauri::Listener;
                let tap_host = host_service.clone();
                app.listen("pty:exit", move |event| {
                    tap_host.broadcast("session-exit", event.payload().to_string());
                });
                let tap_host = host_service.clone();
                app.listen("session-title-changed", move |event| {
                    tap_host.broadcast("title-changed", event.payload().to_string());
                });
                let tap_host = host_service.clone();
                app.listen("session-focus-requested", move |event| {
                    tap_host.broadcast("focus-changed", event.payload().to_string());
                });
            }

            // Pre-warm daemon client in background so first terminal spawn is immediate
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Some(manager) = app_handle.try_state::<PtyManager>() {
                    // Set before get_client so the forwarder is re-applied to
                    // every client the manager creates.
                    manager.set_worktree_changed_callback(
                        pty::commands::worktree_changed_forwarder(&app_handle),
                    );
                    manager.set_title_changed_callback(
                        pty::commands::session_title_changed_forwarder(&app_handle),
                    );
                    manager.set_focus_requested_callback(
                        pty::commands::session_focus_requested_forwarder(&app_handle),
                    );
                    manager.set_git_changed_callback(git::commands::git_changed_forwarder(
                        &app_handle,
                    ));
                    manager.set_pr_changed_callback(git::commands::pr_changed_forwarder(
                        &app_handle,
                    ));
                    manager.set_working_state_callback(
                        pty::commands::session_working_forwarder(&app_handle),
                    );
                    manager.set_agent_status_callback(pty::commands::agent_status_forwarder(
                        &app_handle,
                    ));
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
                    // Extension engines die with the window (spec: GUI-process host).
                    if let Some(host) = window_clone
                        .try_state::<Arc<extensions::service::ExtensionHostService>>()
                    {
                        host.stop_all();
                    }
                    let _ = window_clone.destroy();
                });
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app_handle, _event| {});
}
