use clap::{Parser, Subcommand};
use oppa_lib::cli::output::{
    render_json, render_lineage_tree, render_ps_rows, render_repo_detail, render_repo_table,
    render_worktree_list, render_worktree_show, OkPayload,
};
use oppa_lib::cli::{
    build_repo_add, build_worktree_create, build_worktree_set, decode_ok, decode_ps_entries,
    decode_repo_records, decode_worktree_list, decode_worktree_many, decode_worktree_one,
    filter_active_only, parse_status, CreateArgs, CliError, ParentUpdate, RuntimeConnection,
    RUNTIME_UNAVAILABLE_HINT,
};
use oppa_lib::pty::ipc_protocol::{DaemonRequest, DaemonResponse};
use std::path::PathBuf;
use std::time::{Duration, Instant};

#[derive(Parser)]
#[command(name = "oppa", version, about = "Oppa terminal CLI")]
struct Cli {
    #[arg(long, global = true)]
    json: bool,

    #[arg(long, global = true, default_value_t = 10_000)]
    timeout_ms: u64,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Show daemon liveness and active sessions
    Status,
    /// Launch the Oppa runtime (GUI/daemon), then wait for it to accept connections
    Open,
    /// Machine-readable context for coding agents
    AgentContext,
    /// Register and inspect repositories
    Repo {
        #[command(subcommand)]
        action: RepoAction,
    },
    /// Manage worktrees inside registered repositories
    Worktree {
        #[command(subcommand)]
        action: WorktreeAction,
    },
}

#[derive(Subcommand)]
enum RepoAction {
    /// Register a repository by path
    Add { path: String },
    /// List registered repositories
    List,
    /// Show one repository's record
    Show { repo_id: String },
}

#[derive(Subcommand)]
enum WorktreeAction {
    /// List worktrees (retired tombstones only appear with --all)
    List {
        #[arg(long)]
        all: bool,
    },
    /// Show a single worktree record by id
    Show { id: String },
    /// Resolve the worktree containing a directory (defaults to the current directory)
    Current { cwd: Option<String> },
    /// Create a worktree in a registered repo
    Create {
        name: String,
        #[arg(long)]
        repo: String,
        #[arg(long)]
        branch: Option<String>,
        #[arg(long = "base-ref")]
        base_ref: Option<String>,
        #[arg(long = "parent-worktree")]
        parent_worktree: Option<String>,
        #[arg(long = "workspace-dir")]
        workspace_dir: Option<String>,
        #[arg(long = "nest-workspaces")]
        nest_workspaces: bool,
    },
    /// Update status, display name, or parent of a worktree
    Set {
        id: String,
        #[arg(long)]
        status: Option<String>,
        #[arg(long = "display-name")]
        display_name: Option<String>,
        #[arg(long, conflicts_with = "no_parent")]
        parent: Option<String>,
        #[arg(long = "no-parent")]
        no_parent: bool,
    },
    /// Remove a worktree (tombstones its record)
    #[command(alias = "delete", alias = "remove")]
    Rm {
        id: String,
        #[arg(long)]
        force: bool,
        #[arg(long = "delete-branch")]
        delete_branch: bool,
    },
    /// Drop a tombstoned worktree record entirely
    Purge { id: String },
    /// Live sessions per worktree
    Ps,
    /// Show the parent/child tree rooted at a worktree
    Lineage { id: String },
}

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
    if json {
        println!(r#"{{"commands":[]}}"#);
    } else {
        println!("agent-context coming in task 10");
    }
    Ok(())
}

fn locate_app_binary() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    #[cfg(windows)]
    let candidate = exe_dir.join("oppa.exe");
    #[cfg(not(windows))]
    let candidate = exe_dir.join("oppa");
    candidate.is_file().then_some(candidate)
}
