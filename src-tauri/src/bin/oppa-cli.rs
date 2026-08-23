use clap::{Parser, Subcommand};
use oppa_lib::cli::{CliError, RuntimeConnection, RUNTIME_UNAVAILABLE_HINT};
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
