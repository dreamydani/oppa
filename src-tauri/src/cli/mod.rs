// CLI-facing runtime discovery + authed connect; the `oppa-cli` binary is a thin wrapper over this module.
use crate::git::worktree_registry::WorktreeStatus;
use crate::pty::ipc_protocol::{
    get_daemon_socket_path, DaemonRequest, DaemonResponse, DAEMON_PROTOCOL_VERSION,
};
use output::{CliRepoRecord, CliWorktreeListEntry, CliWorktreePsEntry, CliWorktreeRecord};

pub mod output;
pub mod vocabulary;

use std::path::PathBuf;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, BufWriter};

pub const RUNTIME_UNAVAILABLE_HINT: &str = "Start the Oppa app first.";

// 75 (EX_TEMPFAIL) is reserved for "runtime temporarily unavailable" in a later milestone.
#[derive(Debug, PartialEq, Eq)]
pub enum CliError {
    RuntimeUnavailable(String),
    Unauthorized,
    Timeout,
    Protocol(String),
    Io(String),
    // Bare passthrough so stderr reads exactly "error: {daemon message}".
    Daemon(String),
    // Client-side argument mistakes; bare passthrough like Daemon.
    Usage(String),
}

impl std::fmt::Display for CliError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CliError::RuntimeUnavailable(msg) => write!(f, "{msg}"),
            CliError::Unauthorized => write!(f, "daemon rejected the client auth token"),
            CliError::Timeout => write!(f, "timed out talking to the oppa daemon"),
            CliError::Protocol(msg) => write!(f, "protocol error: {msg}"),
            CliError::Io(msg) => write!(f, "io error: {msg}"),
            CliError::Daemon(msg) => write!(f, "{msg}"),
            CliError::Usage(msg) => write!(f, "{msg}"),
        }
    }
}

impl CliError {
    pub fn exit_code(&self) -> i32 {
        // All M1 failures exit 1; 75 stays reserved for later.
        1
    }
}

pub const DATA_DIR_ENV: &str = "OPPA_DATA_DIR";

pub fn resolve_data_dir() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var(DATA_DIR_ENV) {
        if !dir.is_empty() {
            return Some(PathBuf::from(dir));
        }
    }
    // Same resolution the daemon used when writing the discovery file.
    crate::pty::snapshot::resolve_app_data_dir()
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct StatusReport {
    pub protocol_version: u32,
    pub sessions: Vec<String>,
}

#[cfg(windows)]
type PlatformStream = tokio::net::windows::named_pipe::NamedPipeClient;
#[cfg(not(windows))]
type PlatformStream = tokio::net::UnixStream;

pub struct RuntimeConnection {
    runtime: tokio::runtime::Runtime,
    reader: BufReader<tokio::io::ReadHalf<PlatformStream>>,
    writer: BufWriter<tokio::io::WriteHalf<PlatformStream>>,
    io_timeout: Duration,
    protocol_version: u32,
}

impl RuntimeConnection {
    pub fn connect(timeout: Duration) -> Result<Self, CliError> {
        Self::connect_with_data_dir(resolve_data_dir(), timeout)
    }

    /// Explicit data dir lets tests point discovery at a temp metadata file.
    pub fn connect_with_data_dir(
        data_dir: Option<PathBuf>,
        timeout: Duration,
    ) -> Result<Self, CliError> {
        let dir = data_dir.ok_or_else(|| CliError::RuntimeUnavailable(RUNTIME_UNAVAILABLE_HINT.into()))?;
        // Missing/corrupt metadata reads as "no live runtime"; pid liveness is skipped on M1.
        let metadata = crate::pty::runtime_metadata::read_runtime_metadata(&dir)
            .ok_or_else(|| CliError::RuntimeUnavailable(RUNTIME_UNAVAILABLE_HINT.into()))?;
        let endpoint = if metadata.pipe_path.is_empty() {
            get_daemon_socket_path()
        } else {
            metadata.pipe_path.clone()
        };

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .map_err(|e| CliError::Io(format!("failed to build tokio runtime: {e}")))?;

        let deadline = Instant::now() + timeout;
        let stream = runtime.block_on(open_platform_stream(&endpoint, deadline))?;

        let (read_half, write_half) = tokio::io::split(stream);
        let mut conn = Self {
            reader: BufReader::new(read_half),
            writer: BufWriter::new(write_half),
            io_timeout: timeout,
            protocol_version: DAEMON_PROTOCOL_VERSION,
            runtime,
        };
        let hello = DaemonRequest::Hello {
            client_version: env!("CARGO_PKG_VERSION").to_string(),
            protocol_version: DAEMON_PROTOCOL_VERSION,
            auth_token: metadata.auth_token,
        };
        match conn.request(hello)? {
            DaemonResponse::HelloOk { protocol_version } => {
                if protocol_version != DAEMON_PROTOCOL_VERSION {
                    return Err(CliError::Protocol(format!(
                        "version mismatch: client={DAEMON_PROTOCOL_VERSION}, server={protocol_version}"
                    )));
                }
                conn.protocol_version = protocol_version;
                Ok(conn)
            }
            // The daemon only errors a Hello on token mismatch.
            DaemonResponse::Error(_) => Err(CliError::Unauthorized),
            other => Err(CliError::Protocol(format!(
                "unexpected hello response: {}",
                response_kind(&other)
            ))),
        }
    }

    /// One-shot NDJSON exchange; the socket stays open for follow-up calls.
    pub fn request(&mut self, req: DaemonRequest) -> Result<DaemonResponse, CliError> {
        self.runtime.block_on(async {
            let json = serde_json::to_string(&req)
                .map_err(|e| CliError::Protocol(format!("serialize failed: {e}")))?;
            let write = async {
                self.writer.write_all(json.as_bytes()).await?;
                self.writer.write_all(b"\n").await?;
                self.writer.flush().await?;
                Ok::<(), std::io::Error>(())
            };
            tokio::time::timeout(self.io_timeout, write)
                .await
                .map_err(|_| CliError::Timeout)?
                .map_err(|e| CliError::Io(e.to_string()))?;

            let mut line = String::new();
            loop {
                line.clear();
                let read = self.reader.read_line(&mut line);
                let n = tokio::time::timeout(self.io_timeout, read)
                    .await
                    .map_err(|_| CliError::Timeout)?
                    .map_err(|e| CliError::Io(e.to_string()))?;
                if n == 0 {
                    return Err(CliError::Io("connection closed by daemon".into()));
                }
                let value: serde_json::Value = serde_json::from_str(line.trim())
                    .map_err(|e| CliError::Protocol(format!("bad response line: {e}")))?;
                // Global broadcasts (worktree mutations) interleave with responses;
                // event frames carry "event" instead of "type".
                if value.get("event").is_some() {
                    continue;
                }
                return serde_json::from_value(value)
                    .map_err(|e| CliError::Protocol(format!("bad response line: {e}")));
            }
        })
    }

    pub fn protocol_version(&self) -> u32 {
        self.protocol_version
    }

    pub fn status_report(timeout: Duration) -> Result<StatusReport, CliError> {
        Self::status_report_in(resolve_data_dir(), timeout)
    }

    pub fn status_report_in(
        data_dir: Option<PathBuf>,
        timeout: Duration,
    ) -> Result<StatusReport, CliError> {
        let mut conn = Self::connect_with_data_dir(data_dir, timeout)?;
        let protocol_version = conn.protocol_version();
        match conn.request(DaemonRequest::ListSessions)? {
            DaemonResponse::SessionList(sessions) => Ok(StatusReport {
                protocol_version,
                sessions,
            }),
            DaemonResponse::Error(e) => Err(CliError::Protocol(e)),
            other => Err(CliError::Protocol(format!(
                "unexpected ListSessions response: {}",
                response_kind(&other)
            ))),
        }
    }
}

// ---- arg -> request builders; pure so tests never spawn a process ----

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreateArgs<'a> {
    pub repo_path: &'a str,
    pub name: &'a str,
    pub branch: Option<&'a str>,
    pub base_ref: Option<&'a str>,
    pub parent_worktree_id: Option<&'a str>,
    pub workspace_dir: Option<&'a str>,
    pub nest_workspaces: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParentUpdate {
    Untouched,
    Clear,
    Set(String),
}

pub fn build_repo_add(path: &str) -> DaemonRequest {
    DaemonRequest::RepoAdd { path: path.into() }
}

pub fn parse_status(raw: &str) -> Result<WorktreeStatus, CliError> {
    match raw {
        "todo" => Ok(WorktreeStatus::Todo),
        "in-progress" => Ok(WorktreeStatus::InProgress),
        "in-review" => Ok(WorktreeStatus::InReview),
        "completed" => Ok(WorktreeStatus::Completed),
        _ => Err(CliError::Usage(format!(
            "invalid --status '{raw}'; expected todo | in-progress | in-review | completed"
        ))),
    }
}

pub fn build_worktree_create(args: CreateArgs) -> DaemonRequest {
    DaemonRequest::WorktreeCreate {
        repo_path: args.repo_path.into(),
        name: Some(args.name.into()),
        branch: args.branch.map(Into::into),
        base_ref: args.base_ref.map(Into::into),
        parent_worktree_id: args.parent_worktree_id.map(Into::into),
        workspace_dir: args.workspace_dir.map(Into::into),
        nest_workspaces: Some(args.nest_workspaces),
    }
}

pub fn build_worktree_set(
    id: &str,
    status: Option<WorktreeStatus>,
    display_name: Option<&str>,
    parent: ParentUpdate,
) -> DaemonRequest {
    let (set_parent, parent_worktree_id) = match parent {
        ParentUpdate::Untouched => (false, None),
        ParentUpdate::Clear => (true, None),
        ParentUpdate::Set(id) => (true, Some(id)),
    };
    DaemonRequest::WorktreeSet {
        id: id.into(),
        set_parent,
        parent_worktree_id,
        workspace_status: status,
        display_name: display_name.map(Into::into),
    }
}

// ---- response -> DTO decoders ----

fn unexpected(context: &str, resp: &DaemonResponse) -> CliError {
    CliError::Protocol(format!("unexpected {context} response: {}", response_kind(resp)))
}

pub fn decode_repo_records(resp: DaemonResponse) -> Result<Vec<CliRepoRecord>, CliError> {
    match resp {
        DaemonResponse::RepoRecords(records) => Ok(records.iter().map(Into::into).collect()),
        DaemonResponse::Error(msg) => Err(CliError::Daemon(msg)),
        other => Err(unexpected("repo", &other)),
    }
}

pub fn decode_worktree_one(resp: DaemonResponse) -> Result<Option<CliWorktreeRecord>, CliError> {
    match resp {
        DaemonResponse::WorktreeRecordOne(record) => Ok(record.as_ref().map(Into::into)),
        DaemonResponse::Error(msg) => Err(CliError::Daemon(msg)),
        other => Err(unexpected("worktree", &other)),
    }
}

pub fn decode_worktree_list(resp: DaemonResponse) -> Result<Vec<CliWorktreeListEntry>, CliError> {
    match resp {
        DaemonResponse::WorktreeRecords(entries) => Ok(entries
            .iter()
            .map(|entry| CliWorktreeListEntry {
                record: (&entry.record).into(),
                missing_on_disk: entry.missing_on_disk,
            })
            .collect()),
        DaemonResponse::Error(msg) => Err(CliError::Daemon(msg)),
        other => Err(unexpected("worktree list", &other)),
    }
}

pub fn decode_worktree_many(resp: DaemonResponse) -> Result<Vec<CliWorktreeRecord>, CliError> {
    match resp {
        DaemonResponse::WorktreeRecordsList(records) => Ok(records.iter().map(Into::into).collect()),
        DaemonResponse::Error(msg) => Err(CliError::Daemon(msg)),
        other => Err(unexpected("worktree lineage", &other)),
    }
}

pub fn decode_ps_entries(resp: DaemonResponse) -> Result<Vec<CliWorktreePsEntry>, CliError> {
    match resp {
        DaemonResponse::WorktreePsEntries(entries) => Ok(entries
            .iter()
            .map(|entry| CliWorktreePsEntry {
                record: (&entry.record).into(),
                live_sessions: entry.live_sessions,
            })
            .collect()),
        DaemonResponse::Error(msg) => Err(CliError::Daemon(msg)),
        other => Err(unexpected("worktree ps", &other)),
    }
}

pub fn decode_ok(resp: DaemonResponse) -> Result<(), CliError> {
    match resp {
        DaemonResponse::Ok => Ok(()),
        DaemonResponse::Error(msg) => Err(CliError::Daemon(msg)),
        other => Err(unexpected("ok", &other)),
    }
}

// Default `worktree list` hides retired tombstones; --all keeps them.
pub fn filter_active_only(entries: Vec<CliWorktreeListEntry>) -> Vec<CliWorktreeListEntry> {
    entries
        .into_iter()
        .filter(|entry| !entry.record.retired)
        .collect()
}

async fn open_platform_stream(endpoint: &str, deadline: Instant) -> Result<PlatformStream, CliError> {
    loop {
        let attempt = async {
            #[cfg(windows)]
            {
                tokio::net::windows::named_pipe::ClientOptions::new().open(endpoint)
            }
            #[cfg(not(windows))]
            {
                tokio::net::UnixStream::connect(endpoint).await
            }
        };
        match attempt.await {
            Ok(stream) => return Ok(stream),
            Err(_) if Instant::now() >= deadline => {
                return Err(CliError::RuntimeUnavailable(RUNTIME_UNAVAILABLE_HINT.into()))
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(50)).await,
        }
    }
}

fn response_kind(resp: &DaemonResponse) -> String {
    match resp {
        DaemonResponse::HelloOk { .. } => "HelloOk".into(),
        DaemonResponse::SessionAttached(_) => "SessionAttached".into(),
        DaemonResponse::SessionList(_) => "SessionList".into(),
        DaemonResponse::Ok => "Ok".into(),
        DaemonResponse::Error(e) => format!("Error({e})"),
        DaemonResponse::RepoRecords(_) => "RepoRecords".into(),
        DaemonResponse::WorktreeRecords(_) => "WorktreeRecords".into(),
        DaemonResponse::WorktreeRecordOne(_) => "WorktreeRecordOne".into(),
        DaemonResponse::WorktreeRecordsList(_) => "WorktreeRecordsList".into(),
        DaemonResponse::WorktreePsEntries(_) => "WorktreePsEntries".into(),
    }
}

#[cfg(test)]
mod tests;
