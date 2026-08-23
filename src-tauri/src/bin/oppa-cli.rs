use clap::Parser;
use oppa_lib::cli::command_tree::{Cli, Command, RepoAction, TerminalAction, WorktreeAction};
use oppa_lib::cli::output::{
    render_agent_context, render_json, render_lineage_tree, render_ps_rows, render_repo_detail,
    render_repo_table, render_screen_text, render_session_detail, render_session_list,
    render_wait_result, render_worktree_list, render_worktree_show, CliActionNote, CliScreenText,
    CliSessionDetail, CliSessionHandle, CliSplitHandles, CliWaitResult, OkPayload,
    SWITCH_M1_NOTE,
};
use oppa_lib::cli::{
    build_repo_add, build_terminal_create, build_terminal_send, build_worktree_create,
    build_worktree_set, decode_attached, decode_ok, decode_ps_entries, decode_read_screen,
    decode_repo_records, decode_session_ids, decode_wait_result, decode_worktree_list,
    decode_worktree_many, decode_worktree_one, filter_active_only, new_session_handle, parse_status,
    parse_wait_condition, CreateArgs, CliError, ParentUpdate, RuntimeConnection,
    RUNTIME_UNAVAILABLE_HINT, WAIT_GRACE_MS,
};
use oppa_lib::pty::ipc_protocol::{DaemonRequest, DaemonResponse};
use std::path::PathBuf;
use std::time::{Duration, Instant};

fn main() {
    let cli = Cli::parse();
    let timeout = Duration::from_millis(cli.timeout_ms);
    let code = match run(&cli.command, cli.json, timeout) {
        Ok(()) => 0,
        Err(err) => {
            eprintln!("error: {err}");
            err.exit_code()
        }
    };
    std::process::exit(code);
}

fn run(command: &Command, json: bool, timeout: Duration) -> Result<(), CliError> {
    match command {
        Command::Status => run_status(json, timeout),
        Command::Open => run_open(timeout),
        Command::AgentContext => run_agent_context(json),
        Command::Repo { action } => run_repo(action, json, timeout),
        Command::Worktree { action } => run_worktree(action, json, timeout),
        Command::Terminal { action } => run_terminal(action, json, timeout),
    }
}

// One connection per invocation; each CLI verb sends exactly one request today.
fn send(request: DaemonRequest, timeout: Duration) -> Result<DaemonResponse, CliError> {
    let mut conn = RuntimeConnection::connect(timeout)?;
    conn.request(request)
}

fn emit<T: serde::Serialize>(
    json: bool,
    value: &T,
    human: impl FnOnce() -> String,
) -> Result<(), CliError> {
    if json {
        println!("{}", render_json(value));
    } else {
        println!("{}", human());
    }
    Ok(())
}

fn emit_single_record(resp: DaemonResponse, json: bool, label: &str) -> Result<(), CliError> {
    // None means "not found" on the daemon side; JSON keeps it as null.
    let record = decode_worktree_one(resp)?;
    match &record {
        Some(shown) => emit(json, &record, || render_worktree_show(shown)),
        None => {
            if json {
                println!("{}", render_json(&record));
            } else {
                println!("worktree not found: {label}");
            }
            Ok(())
        }
    }
}

fn run_unit(
    resp: DaemonResponse,
    json: bool,
    human: impl FnOnce() -> String,
) -> Result<(), CliError> {
    decode_ok(resp)?;
    let payload = OkPayload { ok: true };
    emit(json, &payload, human)
}

fn run_repo(action: &RepoAction, json: bool, timeout: Duration) -> Result<(), CliError> {
    match action {
        RepoAction::Add { path } => {
            let records = decode_repo_records(send(build_repo_add(path), timeout)?)?;
            emit(json, &records, || render_repo_table(&records))
        }
        RepoAction::List => {
            let records = decode_repo_records(send(DaemonRequest::RepoList, timeout)?)?;
            emit(json, &records, || render_repo_table(&records))
        }
        RepoAction::Show { repo_id } => {
            // No single-repo daemon verb yet; show filters the list client-side.
            let records = decode_repo_records(send(DaemonRequest::RepoList, timeout)?)?;
            let Some(record) = records.iter().find(|r| r.repo_id == *repo_id) else {
                if json {
                    println!("null");
                } else {
                    println!("repo not found: {repo_id}");
                }
                return Ok(());
            };
            emit(json, record, || render_repo_detail(record))
        }
    }
}

fn run_worktree(action: &WorktreeAction, json: bool, timeout: Duration) -> Result<(), CliError> {
    match action {
        WorktreeAction::List { all } => {
            let mut entries = decode_worktree_list(send(DaemonRequest::WorktreeList, timeout)?)?;
            if !*all {
                entries = filter_active_only(entries);
            }
            emit(json, &entries, || render_worktree_list(&entries))
        }
        WorktreeAction::Show { id } => {
            emit_single_record(send(DaemonRequest::WorktreeShow { id: id.clone() }, timeout)?, json, id)
        }
        WorktreeAction::Current { cwd } => {
            let cwd = match cwd {
                Some(dir) => dir.clone(),
                None => std::env::current_dir()
                    .map_err(|e| CliError::Io(e.to_string()))?
                    .to_string_lossy()
                    .into_owned(),
            };
            emit_single_record(
                send(DaemonRequest::WorktreeCurrent { cwd }, timeout)?,
                json,
                "current directory",
            )
        }
        WorktreeAction::Create {
            name,
            repo,
            branch,
            base_ref,
            parent_worktree,
            workspace_dir,
            nest_workspaces,
        } => {
            let request = build_worktree_create(CreateArgs {
                repo_path: repo,
                name,
                branch: branch.as_deref(),
                base_ref: base_ref.as_deref(),
                parent_worktree_id: parent_worktree.as_deref(),
                workspace_dir: workspace_dir.as_deref(),
                nest_workspaces: *nest_workspaces,
            });
            emit_single_record(send(request, timeout)?, json, name)
        }
        WorktreeAction::Set {
            id,
            status,
            display_name,
            parent,
            no_parent,
        } => {
            let status = match status {
                Some(raw) => Some(parse_status(raw)?),
                None => None,
            };
            let parent = if *no_parent {
                ParentUpdate::Clear
            } else {
                match parent {
                    Some(id) => ParentUpdate::Set(id.clone()),
                    None => ParentUpdate::Untouched,
                }
            };
            let request = build_worktree_set(id, status, display_name.as_deref(), parent);
            emit_single_record(send(request, timeout)?, json, id)
        }
        WorktreeAction::Rm {
            id,
            force,
            delete_branch,
        } => run_unit(
            send(
                DaemonRequest::WorktreeRemove {
                    id: id.clone(),
                    force: *force,
                    delete_branch: *delete_branch,
                },
                timeout,
            )?,
            json,
            || format!("removed {id}"),
        ),
        WorktreeAction::Purge { id } => run_unit(
            send(DaemonRequest::WorktreePurge { id: id.clone() }, timeout)?,
            json,
            || format!("purged {id}"),
        ),
        WorktreeAction::Ps => {
            let entries = decode_ps_entries(send(DaemonRequest::WorktreePs, timeout)?)?;
            emit(json, &entries, || render_ps_rows(&entries))
        }
        WorktreeAction::Lineage { id } => {
            let records =
                decode_worktree_many(send(DaemonRequest::WorktreeLineage { id: id.clone() }, timeout)?)?;
            emit(json, &records, || render_lineage_tree(&records))
        }
    }
}

fn run_terminal(action: &TerminalAction, json: bool, timeout: Duration) -> Result<(), CliError> {
    match action {
        TerminalAction::List => {
            let ids = decode_session_ids(send(DaemonRequest::ListSessions, timeout)?)?;
            emit(json, &ids, || render_session_list(&ids))
        }
        TerminalAction::Show { id } => {
            let attached = attach_existing(id, timeout)?;
            let detail = CliSessionDetail {
                id: id.clone(),
                pid: attached.pid,
                cols: attached.cols,
                rows: attached.rows,
                cwd: attached.cwd,
                worktree_id: attached.worktree_id,
            };
            emit(json, &detail, || render_session_detail(&detail))
        }
        TerminalAction::Read { id, .. } => {
            let screen: CliScreenText =
                decode_read_screen(send(DaemonRequest::ReadScreen { session_id: id.clone() }, timeout)?)?;
            let text = screen.text.clone();
            emit(json, &screen, || render_screen_text(&text))
        }
        TerminalAction::Send {
            id,
            text,
            enter,
            interrupt,
        } => run_unit(
            send(
                build_terminal_send(id, text, *enter, *interrupt),
                timeout,
            )?,
            json,
            || format!("sent to {id}"),
        ),
        TerminalAction::Wait {
            id,
            for_cond,
            timeout_ms,
        } => {
            let cond = parse_wait_condition(for_cond)?;
            // The connection must outlive the daemon-side wait; keepalive
            // frames reset each read, so only the grace needs headroom
            let conn_timeout = Duration::from_millis(
                (*timeout_ms).max(timeout.as_millis() as u64) + WAIT_GRACE_MS,
            );
            let mut conn = RuntimeConnection::connect(conn_timeout)?;
            let resp = conn.request(DaemonRequest::WaitFor {
                session_id: id.clone(),
                cond,
                timeout_ms: *timeout_ms,
            });
            drop(conn);
            let result: CliWaitResult = decode_wait_result(resp?)?;
            emit(json, &result, || render_wait_result(&result))
        }
        TerminalAction::Create {
            cwd,
            worktree,
            name,
        } => {
            let handle = name.clone().unwrap_or_else(new_session_handle);
            decode_attached(send(
                build_terminal_create(&handle, cwd.as_deref(), worktree.as_deref()),
                timeout,
            )?)?;
            emit(
                json,
                &CliSessionHandle {
                    session_id: handle.clone(),
                },
                || format!("session {handle}"),
            )
        }
        TerminalAction::Close { id } => run_unit(
            send(
                DaemonRequest::Kill {
                    session_id: id.clone(),
                },
                timeout,
            )?,
            json,
            || format!("closed {id}"),
        ),
        TerminalAction::Switch { id } => {
            require_existing(id, timeout)?;
            emit(
                json,
                &CliActionNote {
                    ok: true,
                    note: SWITCH_M1_NOTE.into(),
                },
                || format!("switched to {id}\nnote: {SWITCH_M1_NOTE}"),
            )
        }
        TerminalAction::Rename { .. } => Err(CliError::Usage(
            "rename arrives with tab-title sync".into(),
        )),
        TerminalAction::Split { id } => {
            require_existing(id, timeout)?;
            let source = attach_existing(id, timeout)?;
            let new_id = new_session_handle();
            decode_attached(send(
                build_terminal_create(&new_id, source.cwd.as_deref(), source.worktree_id.as_deref()),
                timeout,
            )?)?;
            emit(
                json,
                &CliSplitHandles {
                    primary: id.clone(),
                    secondary: new_id.clone(),
                },
                || format!("{id}\n{new_id}"),
            )
        }
    }
}

fn session_exists(id: &str, timeout: Duration) -> Result<bool, CliError> {
    let ids = decode_session_ids(send(DaemonRequest::ListSessions, timeout)?)?;
    Ok(ids.iter().any(|existing| existing == id))
}

fn require_existing(id: &str, timeout: Duration) -> Result<(), CliError> {
    if session_exists(id, timeout)? {
        Ok(())
    } else {
        Err(CliError::Daemon(format!("session {id} not found")))
    }
}

// cols=0 skips the resize-on-attach path. A true spawn here means the
// session vanished between list and attach: kill it and report honestly.
fn attach_existing(id: &str, timeout: Duration) -> Result<oppa_lib::pty::ipc_protocol::CreateOrAttachResult, CliError> {
    require_existing(id, timeout)?;
    let attached = decode_attached(send(
        DaemonRequest::CreateOrAttach {
            session_id: id.into(),
            cols: 0,
            rows: 0,
            cwd: None,
            shell: None,
            resume_agents: false,
            worktree_id: None,
            extra_env: Vec::new(),
        },
        timeout,
    )?)?;
    if attached.is_new {
        let _ = send(
            DaemonRequest::Kill {
                session_id: id.into(),
            },
            timeout,
        );
        return Err(CliError::Daemon(format!("session {id} not found")));
    }
    Ok(attached)
}

fn run_status(json: bool, timeout: Duration) -> Result<(), CliError> {
    let report = RuntimeConnection::status_report(timeout)?;
    if json {
        println!("{}", serde_json::to_string(&report).expect("status json"));
    } else {
        println!(
            "daemon ok · protocol v{} · sessions {}",
            report.protocol_version,
            report.sessions.len()
        );
    }
    Ok(())
}

fn run_open(timeout: Duration) -> Result<(), CliError> {
    let app_binary = locate_app_binary().ok_or_else(|| {
        CliError::RuntimeUnavailable(format!(
            "{RUNTIME_UNAVAILABLE_HINT} (no oppa app binary found next to the CLI)"
        ))
    })?;
    oppa_lib::pty::daemon_spawner::spawn_detached_daemon(&app_binary)
        .map_err(CliError::RuntimeUnavailable)?;

    let deadline = Instant::now() + timeout;
    loop {
        match RuntimeConnection::connect(Duration::from_millis(500)) {
            Ok(mut conn) => {
                // Hello already ran; drop after confirming the runtime answers.
                let _ = conn.request(oppa_lib::pty::ipc_protocol::DaemonRequest::ListSessions);
                return Ok(());
            }
            Err(err) if Instant::now() >= deadline => return Err(err),
            Err(_) => std::thread::sleep(Duration::from_millis(100)),
        }
    }
}

fn run_agent_context(json: bool) -> Result<(), CliError> {
    let doc = oppa_lib::cli::vocabulary::agent_context_document();
    emit(json, &doc, || render_agent_context(&doc))
}

fn locate_app_binary() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    #[cfg(windows)]
    let candidate = exe_dir.join("oppa.exe");
    #[cfg(not(windows))]
    let candidate = exe_dir.join("oppa");
    candidate.is_file().then_some(candidate)
}
