use crate::git::commit_message::CommitMessage;
use crate::git::pr_message::PrMessage;
use crate::git::comments_store::{DiffComment, NewDiffComment};
use crate::git::hosted_reviews::{CreatedReview, Eligibility, PrStatus};
use crate::git::source_control::{
    BranchCompare, DiffContent, HistoryResult, LocalBranches, PullOutcome, PushOutcome,
    SourceControlStatus, UpstreamStatus,
};
use crate::git::worktree_registry::{RepoRecord, WorktreeRecord, WorktreeStatus};
use crate::git::worktrees::WorktreeListEntry;
use crate::pty::ipc_protocol::{
    get_daemon_socket_path, CreateOrAttachResult, DaemonEvent, DaemonRequest, DaemonResponse,
    WorktreePsEntry, DAEMON_PROTOCOL_VERSION,
};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub type OnData = Box<dyn Fn(&str, &[u8]) + Send + Sync + 'static>;
pub type OnExit = Box<dyn Fn(&str, Option<i32>) + Send + Sync + 'static>;
pub type OnCwd = Box<dyn Fn(&str, &str) + Send + Sync + 'static>;
// Arc-shared so one forwarder can be installed on every reconnecting client.
pub type OnWorktreeChanged = Arc<dyn Fn(Option<&str>) + Send + Sync>;
pub type OnTitleChanged = Arc<dyn Fn(&str, &str) + Send + Sync>;
pub type OnFocusRequested = Arc<dyn Fn(&str) + Send + Sync>;
pub type OnGitChanged = Arc<dyn Fn() + Send + Sync>;
pub type OnPrChanged = Arc<dyn Fn(Option<&str>) + Send + Sync>;

/// Agent handoff result: created worktree plus the live agent session a pane
/// can bind to (session_id doubles as the agent terminal handle).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorktreeAgentHandoff {
    pub record: WorktreeRecord,
    pub session_id: String,
}

#[derive(Default)]
struct SessionCallbacks {
    on_data: Option<OnData>,
    on_exit: Option<OnExit>,
    on_cwd: Option<OnCwd>,
}

/// Client adapter connecting to the detached background daemon over IPC.
pub struct DaemonClient {
    write_tx: tokio::sync::mpsc::UnboundedSender<String>,
    // Flipped false by the reader task on EOF/pipe error so queued-only
    // requests (write/ack) fail fast instead of piling up undelivered.
    connected: Arc<AtomicBool>,
    request_lock: Arc<Mutex<()>>,
    callbacks: Arc<Mutex<HashMap<String, SessionCallbacks>>>,
    out_tx_map: Arc<Mutex<HashMap<String, Sender<Vec<u8>>>>>,
    exit_tx_map: Arc<Mutex<HashMap<String, Sender<Option<i32>>>>>,
    out_rx_map: Arc<Mutex<HashMap<String, Receiver<Vec<u8>>>>>,
    exit_rx_map: Arc<Mutex<HashMap<String, Receiver<Option<i32>>>>>,
    pending_response: Arc<Mutex<Option<Sender<DaemonResponse>>>>,
    worktree_changed_cb: Arc<Mutex<Option<OnWorktreeChanged>>>,
    title_changed_cb: Arc<Mutex<Option<OnTitleChanged>>>,
    focus_requested_cb: Arc<Mutex<Option<OnFocusRequested>>>,
    git_changed_cb: Arc<Mutex<Option<OnGitChanged>>>,
    pr_changed_cb: Arc<Mutex<Option<OnPrChanged>>>,
    _runtime: Arc<tokio::runtime::Runtime>,
}

impl DaemonClient {
    /// Connect to the daemon server at `socket_path` and perform the protocol handshake.
    pub fn connect(socket_path: &str) -> Result<Self, String> {
        let (endpoint, auth_token) = Self::resolve_endpoint(socket_path);
        let socket_path = endpoint.as_str();
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(|e| format!("failed to build tokio runtime: {e}"))?;
        let handle = runtime.handle().clone();
        let rt = Arc::new(runtime);

        let (write_tx, mut write_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let connected = Arc::new(AtomicBool::new(true));
        let callbacks = Arc::new(Mutex::new(HashMap::<String, SessionCallbacks>::new()));
        let out_tx_map = Arc::new(Mutex::new(HashMap::<String, Sender<Vec<u8>>>::new()));
        let exit_tx_map = Arc::new(Mutex::new(HashMap::<String, Sender<Option<i32>>>::new()));
        let out_rx_map = Arc::new(Mutex::new(HashMap::<String, Receiver<Vec<u8>>>::new()));
        let exit_rx_map = Arc::new(Mutex::new(HashMap::<String, Receiver<Option<i32>>>::new()));
        let pending_response = Arc::new(Mutex::new(None::<Sender<DaemonResponse>>));
        let worktree_changed_cb: Arc<Mutex<Option<OnWorktreeChanged>>> = Arc::new(Mutex::new(None));
        let title_changed_cb: Arc<Mutex<Option<OnTitleChanged>>> = Arc::new(Mutex::new(None));
        let focus_requested_cb: Arc<Mutex<Option<OnFocusRequested>>> = Arc::new(Mutex::new(None));
        let git_changed_cb: Arc<Mutex<Option<OnGitChanged>>> = Arc::new(Mutex::new(None));
        let pr_changed_cb: Arc<Mutex<Option<OnPrChanged>>> = Arc::new(Mutex::new(None));
        let request_lock = Arc::new(Mutex::new(()));

        let socket_path_str = socket_path.to_string();
        let _reactor_guard = handle.enter();

        #[cfg(target_os = "windows")]
        let (read_half, mut write_half) = {
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            let client = loop {
                match tokio::net::windows::named_pipe::ClientOptions::new().open(&socket_path_str) {
                    Ok(client) => break client,
                    Err(e) => {
                        if std::time::Instant::now() >= deadline {
                            return Err(format!(
                                "failed to connect to named pipe {socket_path_str}: {e}"
                            ));
                        }
                        std::thread::sleep(Duration::from_millis(50));
                    }
                }
            };
            tokio::io::split(client)
        };

        #[cfg(not(target_os = "windows"))]
        let (read_half, mut write_half) = {
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            let std_stream = loop {
                match std::os::unix::net::UnixStream::connect(&socket_path_str) {
                    Ok(stream) => break stream,
                    Err(e) => {
                        if std::time::Instant::now() >= deadline {
                            return Err(format!(
                                "failed to connect to unix socket {socket_path_str}: {e}"
                            ));
                        }
                        std::thread::sleep(Duration::from_millis(50));
                    }
                }
            };
            std_stream
                .set_nonblocking(true)
                .map_err(|e| format!("failed to set nonblocking on unix stream: {e}"))?;
            let stream = tokio::net::UnixStream::from_std(std_stream)
                .map_err(|e| format!("failed to convert unix stream: {e}"))?;
            tokio::io::split(stream)
        };

        // Spawn async writer task
        handle.spawn(async move {
            while let Some(msg) = write_rx.recv().await {
                if write_half.write_all(msg.as_bytes()).await.is_err() {
                    break;
                }
                if write_half.flush().await.is_err() {
                    break;
                }
            }
        });

        // Spawn async reader task
        let connected_reader = Arc::clone(&connected);
        let callbacks_clone = Arc::clone(&callbacks);
        let out_tx_map_clone = Arc::clone(&out_tx_map);
        let exit_tx_map_clone = Arc::clone(&exit_tx_map);
        let out_rx_map_clone = Arc::clone(&out_rx_map);
        let exit_rx_map_clone = Arc::clone(&exit_rx_map);
        let pending_response_clone = Arc::clone(&pending_response);
        let worktree_changed_cb_clone = Arc::clone(&worktree_changed_cb);
        let title_changed_cb_clone = Arc::clone(&title_changed_cb);
        let focus_requested_cb_clone = Arc::clone(&focus_requested_cb);
        let git_changed_cb_clone = Arc::clone(&git_changed_cb);
        let pr_changed_cb_clone = Arc::clone(&pr_changed_cb);

        handle.spawn(async move {
            let mut reader = BufReader::new(read_half);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) => break, // EOF
                    Ok(_) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }

                        // 1. Push events from daemon
                        if let Ok(event) = serde_json::from_str::<DaemonEvent>(trimmed) {
                            match event {
                                DaemonEvent::Data {
                                    session_id, data, ..
                                } => {
                                    let bytes = data.as_bytes();
                                    if let Some(cb) = callbacks_clone.lock().get(&session_id) {
                                        if let Some(on_data) = &cb.on_data {
                                            on_data(&session_id, bytes);
                                        }
                                    }
                                    if let Some(tx) = out_tx_map_clone.lock().get(&session_id) {
                                        let _ = tx.send(bytes.to_vec());
                                    }
                                }
                                DaemonEvent::Exit { session_id, code } => {
                                    if let Some(cb) = callbacks_clone.lock().get(&session_id) {
                                        if let Some(on_exit) = &cb.on_exit {
                                            on_exit(&session_id, code);
                                        }
                                    }
                                    if let Some(tx) = exit_tx_map_clone.lock().get(&session_id) {
                                        let _ = tx.send(code);
                                    }
                                    callbacks_clone.lock().remove(&session_id);
                                    out_tx_map_clone.lock().remove(&session_id);
                                    exit_tx_map_clone.lock().remove(&session_id);
                                }
                                DaemonEvent::Cwd { session_id, cwd } => {
                                    if let Some(cb) = callbacks_clone.lock().get(&session_id) {
                                        if let Some(on_cwd) = &cb.on_cwd {
                                            on_cwd(&session_id, &cwd);
                                        }
                                    }
                                }
                                DaemonEvent::WorktreeChanged { id } => {
                                    if let Some(cb) = worktree_changed_cb_clone.lock().as_ref() {
                                        cb(id.as_deref());
                                    }
                                }
                                DaemonEvent::TitleChanged { session_id, title } => {
                                    if let Some(cb) = title_changed_cb_clone.lock().as_ref() {
                                        cb(&session_id, &title);
                                    }
                                }
                                DaemonEvent::SessionFocusRequested { session_id } => {
                                    if let Some(cb) = focus_requested_cb_clone.lock().as_ref() {
                                        cb(&session_id);
                                    }
                                }
                                DaemonEvent::GitChanged => {
                                    if let Some(cb) = git_changed_cb_clone.lock().as_ref() {
                                        cb();
                                    }
                                }
                                DaemonEvent::PrChanged { worktree_id } => {
                                    if let Some(cb) = pr_changed_cb_clone.lock().as_ref() {
                                        cb(worktree_id.as_deref());
                                    }
                                }
                            }
                            continue;
                        }

                        // 2. RPC Responses from daemon
                        if let Ok(resp) = serde_json::from_str::<DaemonResponse>(trimmed) {
                            if let Some(sender) = pending_response_clone.lock().take() {
                                let _ = sender.send(resp);
                            }
                            continue;
                        }
                    }
                    Err(_) => break,
                }
            }

            if let Some(sender) = pending_response_clone.lock().take() {
                let _ = sender.send(DaemonResponse::Error(
                    "connection closed by daemon".to_string(),
                ));
            }
            connected_reader.store(false, Ordering::SeqCst);
            out_rx_map_clone.lock().clear();
            exit_rx_map_clone.lock().clear();
        });

        let client = Self {
            write_tx,
            connected,
            request_lock,
            callbacks,
            out_tx_map,
            exit_tx_map,
            out_rx_map,
            exit_rx_map,
            pending_response,
            worktree_changed_cb,
            title_changed_cb,
            focus_requested_cb,
            git_changed_cb,
            pr_changed_cb,
            _runtime: rt,
        };

        // Perform Hello handshake
        let hello = DaemonRequest::Hello {
            client_version: env!("CARGO_PKG_VERSION").to_string(),
            protocol_version: DAEMON_PROTOCOL_VERSION,
            auth_token,
        };
        match client.send_request(hello)? {
            DaemonResponse::HelloOk { protocol_version } => {
                if protocol_version != DAEMON_PROTOCOL_VERSION {
                    return Err(format!(
                        "protocol version mismatch: client={DAEMON_PROTOCOL_VERSION}, server={protocol_version}"
                    ));
                }
            }
            DaemonResponse::Error(e) => return Err(e),
            other => return Err(format!("unexpected hello response: {other:?}")),
        }

        Ok(client)
    }

    /// Explicit endpoints (tests, custom pipes) never redirect; only the default
    /// endpoint consults the daemon's discovery file for the live pipe + token.
    fn resolve_endpoint(socket_path: &str) -> (String, Option<String>) {
        if socket_path != get_daemon_socket_path() {
            return (socket_path.to_string(), None);
        }
        match crate::pty::snapshot::resolve_app_data_dir()
            .and_then(|dir| crate::pty::runtime_metadata::read_runtime_metadata(&dir))
        {
            Some(metadata) if !metadata.pipe_path.is_empty() => {
                (metadata.pipe_path, metadata.auth_token)
            }
            _ => (socket_path.to_string(), None),
        }
    }

    fn send_request(&self, req: DaemonRequest) -> Result<DaemonResponse, String> {
        let _guard = self.request_lock.lock();
        let (tx, rx) = channel();
        *self.pending_response.lock() = Some(tx);

        let mut json =
            serde_json::to_string(&req).map_err(|e| format!("failed to serialize request: {e}"))?;
        json.push('\n');

        self.write_tx
            .send(json)
            .map_err(|e| format!("failed to queue request: {e}"))?;

        let resp = rx.recv_timeout(Duration::from_secs(5)).map_err(|e| {
            *self.pending_response.lock() = None;
            format!("timed out waiting for daemon response: {e}")
        })?;

        Ok(resp)
    }

    /// Register a global hook fired whenever any client mutates a worktree.
    pub fn set_worktree_changed_callback(&self, cb: OnWorktreeChanged) {
        *self.worktree_changed_cb.lock() = Some(cb);
    }

    /// Register a global hook fired whenever any client renames a session.
    pub fn set_title_changed_callback(&self, cb: OnTitleChanged) {
        *self.title_changed_cb.lock() = Some(cb);
    }

    /// Register a global hook fired whenever any client requests session focus.
    pub fn set_focus_requested_callback(&self, cb: OnFocusRequested) {
        *self.focus_requested_cb.lock() = Some(cb);
    }

    /// Register a global hook fired whenever any client mutates source-control state.
    pub fn set_git_changed_callback(&self, cb: OnGitChanged) {
        *self.git_changed_cb.lock() = Some(cb);
    }

    /// Register a global hook fired whenever a linked worktree's PR status refreshes.
    pub fn set_pr_changed_callback(&self, cb: OnPrChanged) {
        *self.pr_changed_cb.lock() = Some(cb);
    }

    /// Register callbacks for a specific session ID.
    pub fn register_callbacks(
        &self,
        session_id: &str,
        on_data: Option<OnData>,
        on_exit: Option<OnExit>,
        on_cwd: Option<OnCwd>,
    ) {
        let mut callbacks = self.callbacks.lock();
        callbacks.insert(
            session_id.to_string(),
            SessionCallbacks {
                on_data,
                on_exit,
                on_cwd,
            },
        );
    }

    /// Create internal MPSC channels for observing output and exit in unit tests.
    pub fn create_session_channels(&self, session_id: &str) {
        let (out_tx, out_rx) = channel::<Vec<u8>>();
        let (exit_tx, exit_rx) = channel::<Option<i32>>();

        self.out_tx_map
            .lock()
            .insert(session_id.to_string(), out_tx);
        self.exit_tx_map
            .lock()
            .insert(session_id.to_string(), exit_tx);
        self.out_rx_map
            .lock()
            .insert(session_id.to_string(), out_rx);
        self.exit_rx_map
            .lock()
            .insert(session_id.to_string(), exit_rx);
    }

    /// Take the session's test output receiver.
    #[cfg(test)]
    pub fn take_output(&self, session_id: &str) -> Option<Receiver<Vec<u8>>> {
        self.out_rx_map.lock().remove(session_id)
    }

    /// Take the session's test exit receiver.
    #[cfg(test)]
    pub fn take_exit(&self, session_id: &str) -> Option<Receiver<Option<i32>>> {
        self.exit_rx_map.lock().remove(session_id)
    }

    /// Create a new session or reattach to an existing one in the daemon.
    #[allow(clippy::too_many_arguments)]
    pub fn create_or_attach(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
        shell: Option<String>,
        resume_agents: bool,
        worktree_id: Option<String>,
    ) -> Result<CreateOrAttachResult, String> {
        let req = DaemonRequest::CreateOrAttach {
            session_id: session_id.to_string(),
            cols,
            rows,
            cwd,
            shell,
            resume_agents,
            worktree_id,
            extra_env: Vec::new(),
        };
        match self.send_request(req)? {
            DaemonResponse::SessionAttached(res) => Ok(res),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!("unexpected response for CreateOrAttach: {other:?}")),
        }
    }

    /// Write input data to the session PTY.
    /// Queue a request without waiting for the daemon's response.
    /// Used for high-frequency paths (keystrokes, ACKs) where a round trip
    /// would stall the caller; delivery failure surfaces through the reader
    /// task flipping `connected`, not through this return value.
    fn queue_request(
        write_tx: &tokio::sync::mpsc::UnboundedSender<String>,
        connected: &AtomicBool,
        req: DaemonRequest,
        err_context: &str,
    ) -> Result<(), String> {
        if !connected.load(Ordering::SeqCst) {
            return Err("daemon disconnected".to_string());
        }
        let mut json = serde_json::to_string(&req)
            .map_err(|e| format!("failed to serialize {err_context}: {e}"))?;
        json.push('\n');
        write_tx
            .send(json)
            .map_err(|e| format!("failed to queue {err_context}: {e}"))?;
        Ok(())
    }

    pub fn write(&self, session_id: &str, data: &str) -> Result<(), String> {
        // Fire-and-forget: keystrokes must never block on a pipe round trip
        // (the old send_request path held the global request lock and waited
        // up to 5s per keypress). A dead pipe fails fast via `connected`.
        Self::queue_request(
            &self.write_tx,
            &self.connected,
            DaemonRequest::Write {
                session_id: session_id.to_string(),
                data: data.to_string(),
            },
            "write",
        )
    }

    /// Resize the session PTY.
    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let req = DaemonRequest::Resize {
            session_id: session_id.to_string(),
            cols,
            rows,
        };
        match self.send_request(req)? {
            DaemonResponse::Ok => Ok(()),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!("unexpected response for Resize: {other:?}")),
        }
    }

    /// Acknowledge processed output bytes for backpressure release.
    pub fn ack(&self, session_id: &str, chars: usize) -> Result<(), String> {
        Self::queue_request(
            &self.write_tx,
            &self.connected,
            DaemonRequest::Ack {
                session_id: session_id.to_string(),
                chars,
            },
            "ack",
        )
    }

    /// Kill the session child process.
    pub fn kill(&self, session_id: &str) -> Result<(), String> {
        let req = DaemonRequest::Kill {
            session_id: session_id.to_string(),
        };
        match self.send_request(req)? {
            DaemonResponse::Ok => Ok(()),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!("unexpected response for Kill: {other:?}")),
        }
    }

    /// List all active session IDs in the daemon.
    pub fn list_sessions(&self) -> Result<Vec<String>, String> {
        let req = DaemonRequest::ListSessions;
        match self.send_request(req)? {
            DaemonResponse::SessionList(sessions) => Ok(sessions),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!("unexpected response for ListSessions: {other:?}")),
        }
    }

    /// Gracefully disconnect from the daemon without stopping sessions.
    pub fn disconnect(&self) -> Result<(), String> {
        let req = DaemonRequest::Disconnect;
        match self.send_request(req) {
            Ok(DaemonResponse::Ok) => Ok(()),
            Ok(DaemonResponse::Error(e)) if e.contains("connection closed") => Ok(()),
            Ok(DaemonResponse::Error(e)) => Err(e),
            Err(e) if e.contains("connection closed") => Ok(()),
            Ok(other) => Err(format!("unexpected response for Disconnect: {other:?}")),
            Err(e) => Err(e),
        }
    }

    /// Register a repo in the worktree registry (idempotent per canonical path).
    pub fn repo_add(&self, path: &str) -> Result<Vec<RepoRecord>, String> {
        match self.send_request(DaemonRequest::RepoAdd { path: path.into() })? {
            DaemonResponse::RepoRecords(repos) => Ok(repos),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!("unexpected response for RepoAdd: {other:?}")),
        }
    }

    pub fn repo_list(&self) -> Result<Vec<RepoRecord>, String> {
        match self.send_request(DaemonRequest::RepoList)? {
            DaemonResponse::RepoRecords(repos) => Ok(repos),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!("unexpected response for RepoList: {other:?}")),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn worktree_create(
        &self,
        repo_path: &str,
        name: Option<String>,
        branch: Option<String>,
        base_ref: Option<String>,
        parent_worktree_id: Option<String>,
        workspace_dir: Option<String>,
        nest_workspaces: Option<bool>,
    ) -> Result<WorktreeRecord, String> {
        let req = DaemonRequest::WorktreeCreate {
            repo_path: repo_path.into(),
            name,
            branch,
            base_ref,
            parent_worktree_id,
            workspace_dir,
            nest_workspaces,
            // Plain creates never hand off; see create_worktree_with_agent
            agent: None,
            prompt: None,
            command: None,
        };
        match self.send_request(req)? {
            DaemonResponse::WorktreeRecordOne(Some(record)) => Ok(record),
            DaemonResponse::WorktreeRecordOne(None) => {
                Err("worktree create returned no record".into())
            }
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!("unexpected response for WorktreeCreate: {other:?}")),
        }
    }

    // Same WorktreeCreate verb, but the daemon launches the agent and replies
    // AgentHandoff with a live session id instead of a bare record.
    #[allow(clippy::too_many_arguments)]
    pub fn create_worktree_with_agent(
        &self,
        repo_path: &str,
        name: Option<String>,
        branch: Option<String>,
        base_ref: Option<String>,
        parent_worktree_id: Option<String>,
        workspace_dir: Option<String>,
        nest_workspaces: Option<bool>,
        agent: Option<String>,
        prompt: Option<String>,
        command: Option<String>,
    ) -> Result<WorktreeAgentHandoff, String> {
        let req = DaemonRequest::WorktreeCreate {
            repo_path: repo_path.into(),
            name,
            branch,
            base_ref,
            parent_worktree_id,
            workspace_dir,
            nest_workspaces,
            agent,
            prompt,
            command,
        };
        match self.send_request(req)? {
            DaemonResponse::AgentHandoff { record, session_id } => Ok(WorktreeAgentHandoff {
                record,
                session_id,
            }),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!("unexpected response for WorktreeCreate: {other:?}")),
        }
    }

    pub fn worktree_list(&self) -> Result<Vec<WorktreeListEntry>, String> {
        match self.send_request(DaemonRequest::WorktreeList)? {
            DaemonResponse::WorktreeRecords(entries) => Ok(entries),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!("unexpected response for WorktreeList: {other:?}")),
        }
    }

    // Show keeps the Option so a purged id reads as "gone", not a transport error.
    pub fn worktree_show(&self, id: &str) -> Result<Option<WorktreeRecord>, String> {
        let req = DaemonRequest::WorktreeShow { id: id.into() };
        match self.send_request(req)? {
            DaemonResponse::WorktreeRecordOne(record) => Ok(record),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!("unexpected response for WorktreeShow: {other:?}")),
        }
    }

    pub fn worktree_current(&self, cwd: &str) -> Result<Option<WorktreeRecord>, String> {
        let req = DaemonRequest::WorktreeCurrent { cwd: cwd.into() };
        match self.send_request(req)? {
            DaemonResponse::WorktreeRecordOne(record) => Ok(record),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!(
                "unexpected response for WorktreeCurrent: {other:?}"
            )),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn worktree_set(
        &self,
        id: &str,
        set_parent: bool,
        parent_worktree_id: Option<String>,
        workspace_status: Option<WorktreeStatus>,
        display_name: Option<String>,
    ) -> Result<WorktreeRecord, String> {
        let req = DaemonRequest::WorktreeSet {
            id: id.into(),
            set_parent,
            parent_worktree_id,
            workspace_status,
            display_name,
        };
        match self.send_request(req)? {
            DaemonResponse::WorktreeRecordOne(Some(record)) => Ok(record),
            DaemonResponse::WorktreeRecordOne(None) => Err(format!("worktree not found: {id}")),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!("unexpected response for WorktreeSet: {other:?}")),
        }
    }

    pub fn worktree_remove(
        &self,
        id: &str,
        force: bool,
        delete_branch: bool,
    ) -> Result<(), String> {
        let req = DaemonRequest::WorktreeRemove {
            id: id.into(),
            force,
            delete_branch,
        };
        match self.send_request(req)? {
            DaemonResponse::Ok => Ok(()),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!("unexpected response for WorktreeRemove: {other:?}")),
        }
    }

    pub fn worktree_purge(&self, id: &str) -> Result<(), String> {
        let req = DaemonRequest::WorktreePurge { id: id.into() };
        match self.send_request(req)? {
            DaemonResponse::Ok => Ok(()),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!("unexpected response for WorktreePurge: {other:?}")),
        }
    }

    pub fn worktree_ps(&self) -> Result<Vec<WorktreePsEntry>, String> {
        match self.send_request(DaemonRequest::WorktreePs)? {
            DaemonResponse::WorktreePsEntries(entries) => Ok(entries),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!("unexpected response for WorktreePs: {other:?}")),
        }
    }

    pub fn worktree_lineage(&self, id: &str) -> Result<Vec<WorktreeRecord>, String> {
        let req = DaemonRequest::WorktreeLineage { id: id.into() };
        match self.send_request(req)? {
            DaemonResponse::WorktreeRecordsList(records) => Ok(records),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!(
                "unexpected response for WorktreeLineage: {other:?}"
            )),
        }
    }

    // ---- v4 source-control passthroughs; payloads are the git module's serde structs ----

    pub fn sc_status(&self, cwd: &str) -> Result<SourceControlStatus, String> {
        match self.send_request(DaemonRequest::GitStatus { cwd: cwd.into() })? {
            DaemonResponse::ScStatus(status) => Ok(status),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!("unexpected response for GitStatus: {other:?}")),
        }
    }

    fn sc_void(&self, req: DaemonRequest, what: &str) -> Result<(), String> {
        match self.send_request(req)? {
            DaemonResponse::Ok => Ok(()),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!("unexpected response for {what}: {other:?}")),
        }
    }

    pub fn sc_stage(&self, cwd: &str, paths: &[String]) -> Result<(), String> {
        self.sc_void(
            DaemonRequest::GitStage {
                cwd: cwd.into(),
                paths: paths.to_vec(),
            },
            "GitStage",
        )
    }

    pub fn sc_unstage(&self, cwd: &str, paths: &[String]) -> Result<(), String> {
        self.sc_void(
            DaemonRequest::GitUnstage {
                cwd: cwd.into(),
                paths: paths.to_vec(),
            },
            "GitUnstage",
        )
    }

    pub fn sc_discard(
        &self,
        cwd: &str,
        paths: &[String],
        include_untracked: bool,
    ) -> Result<(), String> {
        self.sc_void(
            DaemonRequest::GitDiscard {
                cwd: cwd.into(),
                paths: paths.to_vec(),
                include_untracked,
            },
            "GitDiscard",
        )
    }

    pub fn sc_commit(&self, cwd: &str, message: &str) -> Result<String, String> {
        let req = DaemonRequest::GitCommit {
            cwd: cwd.into(),
            message: message.into(),
        };
        match self.send_request(req)? {
            DaemonResponse::ScCommit(id) => Ok(id),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!("unexpected response for GitCommit: {other:?}")),
        }
    }

    pub fn sc_local_branches(&self, cwd: &str) -> Result<LocalBranches, String> {
        match self.send_request(DaemonRequest::GitLocalBranches { cwd: cwd.into() })? {
            DaemonResponse::ScBranches(branches) => Ok(branches),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!(
                "unexpected response for GitLocalBranches: {other:?}"
            )),
        }
    }

    pub fn sc_checkout(&self, cwd: &str, branch: &str) -> Result<(), String> {
        self.sc_void(
            DaemonRequest::GitCheckout {
                cwd: cwd.into(),
                branch: branch.into(),
            },
            "GitCheckout",
        )
    }

    pub fn sc_file_diff(
        &self,
        cwd: &str,
        path: &str,
        staged: bool,
        compare_against_head: bool,
    ) -> Result<DiffContent, String> {
        let req = DaemonRequest::GitFileDiff {
            cwd: cwd.into(),
            path: path.into(),
            staged,
            compare_against_head,
        };
        match self.send_request(req)? {
            DaemonResponse::ScDiff(diff) => Ok(diff),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!("unexpected response for GitFileDiff: {other:?}")),
        }
    }

    pub fn sc_history(&self, cwd: &str, limit: Option<u32>) -> Result<HistoryResult, String> {
        let req = DaemonRequest::GitHistory {
            cwd: cwd.into(),
            limit,
        };
        match self.send_request(req)? {
            DaemonResponse::ScHistory(result) => Ok(result),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!("unexpected response for GitHistory: {other:?}")),
        }
    }

    pub fn sc_branch_compare(&self, cwd: &str, base_ref: &str) -> Result<BranchCompare, String> {
        let req = DaemonRequest::GitBranchCompare {
            cwd: cwd.into(),
            base_ref: base_ref.into(),
        };
        match self.send_request(req)? {
            DaemonResponse::ScCompare(compare) => Ok(compare),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!(
                "unexpected response for GitBranchCompare: {other:?}"
            )),
        }
    }

    pub fn sc_fetch(&self, cwd: &str) -> Result<(), String> {
        self.sc_void(DaemonRequest::GitFetch { cwd: cwd.into() }, "GitFetch")
    }

    pub fn sc_pull(&self, cwd: &str, ff_only: bool) -> Result<PullOutcome, String> {
        let req = DaemonRequest::GitPull {
            cwd: cwd.into(),
            ff_only,
        };
        match self.send_request(req)? {
            DaemonResponse::ScPull(outcome) => Ok(outcome),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!("unexpected response for GitPull: {other:?}")),
        }
    }

    pub fn sc_fast_forward(&self, cwd: &str) -> Result<PullOutcome, String> {
        match self.send_request(DaemonRequest::GitFastForward { cwd: cwd.into() })? {
            DaemonResponse::ScPull(outcome) => Ok(outcome),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!("unexpected response for GitFastForward: {other:?}")),
        }
    }

    pub fn sc_push(
        &self,
        cwd: &str,
        publish: bool,
        force_with_lease: bool,
    ) -> Result<PushOutcome, String> {
        let req = DaemonRequest::GitPush {
            cwd: cwd.into(),
            publish,
            force_with_lease,
        };
        match self.send_request(req)? {
            DaemonResponse::ScPush(outcome) => Ok(outcome),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!("unexpected response for GitPush: {other:?}")),
        }
    }

    pub fn sc_upstream_refresh(&self, cwd: &str) -> Result<UpstreamStatus, String> {
        match self.send_request(DaemonRequest::GitUpstreamRefresh { cwd: cwd.into() })? {
            DaemonResponse::ScUpstream(upstream) => Ok(upstream),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!(
                "unexpected response for GitUpstreamRefresh: {other:?}"
            )),
        }
    }

    pub fn sc_generate_commit_message(&self, cwd: &str) -> Result<CommitMessage, String> {
        match self.send_request(DaemonRequest::GitGenerateCommitMessage { cwd: cwd.into() })? {
            DaemonResponse::ScCommitMessage(message) => Ok(message),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!(
                "unexpected response for GitGenerateCommitMessage: {other:?}"
            )),
        }
    }

    pub fn sc_generate_pr_message(&self, cwd: &str) -> Result<PrMessage, String> {
        match self.send_request(DaemonRequest::GitGeneratePrMessage { cwd: cwd.into() })? {
            DaemonResponse::ScPrMessage(msg) => Ok(msg),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!(
                "unexpected response for GitGeneratePrMessage: {other:?}"
            )),
        }
    }

    pub fn review_eligibility(&self, cwd: &str) -> Result<Eligibility, String> {
        match self.send_request(DaemonRequest::ReviewEligibility { cwd: cwd.into() })? {
            DaemonResponse::ReviewEligibility(eligibility) => Ok(eligibility),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!("unexpected response for ReviewEligibility: {other:?}")),
        }
    }

    pub fn create_review(
        &self,
        cwd: &str,
        title: &str,
        body: &str,
        draft: bool,
    ) -> Result<CreatedReview, String> {
        let req = DaemonRequest::CreateReview {
            cwd: cwd.into(),
            title: title.into(),
            body: body.into(),
            draft,
        };
        match self.send_request(req)? {
            DaemonResponse::CreateReview(created) => Ok(created),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!("unexpected response for CreateReview: {other:?}")),
        }
    }

    pub fn review_status(&self, cwd: &str) -> Result<PrStatus, String> {
        match self.send_request(DaemonRequest::ReviewStatus { cwd: cwd.into() })? {
            DaemonResponse::ReviewStatus(status) => Ok(status),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!("unexpected response for ReviewStatus: {other:?}")),
        }
    }

    pub fn diff_comments_list(&self, worktree_id: &str) -> Result<Vec<DiffComment>, String> {
        let req = DaemonRequest::DiffCommentsList {
            worktree_id: worktree_id.into(),
        };
        match self.send_request(req)? {
            DaemonResponse::CommentRecords(records) => Ok(records),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!(
                "unexpected response for DiffCommentsList: {other:?}"
            )),
        }
    }

    pub fn diff_comment_add(&self, comment: NewDiffComment) -> Result<DiffComment, String> {
        match self.send_request(DaemonRequest::DiffCommentAdd { comment })? {
            DaemonResponse::CommentRecordOne(record) => Ok(record),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!("unexpected response for DiffCommentAdd: {other:?}")),
        }
    }

    pub fn diff_comment_update(&self, id: &str, body: &str) -> Result<DiffComment, String> {
        let req = DaemonRequest::DiffCommentUpdate {
            id: id.into(),
            body: body.into(),
        };
        match self.send_request(req)? {
            DaemonResponse::CommentRecordOne(record) => Ok(record),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!(
                "unexpected response for DiffCommentUpdate: {other:?}"
            )),
        }
    }

    pub fn diff_comment_delete(&self, id: &str) -> Result<(), String> {
        self.sc_void(
            DaemonRequest::DiffCommentDelete { id: id.into() },
            "DiffCommentDelete",
        )
    }

    pub fn diff_comments_mark_sent(&self, ids: &[String]) -> Result<Vec<DiffComment>, String> {
        match self.send_request(DaemonRequest::DiffCommentsMarkSent {
            ids: ids.to_vec(),
        })? {
            DaemonResponse::CommentRecords(records) => Ok(records),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!(
                "unexpected response for DiffCommentsMarkSent: {other:?}"
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::daemon_server::{CancellationToken, DaemonServer};

    fn test_sh_path() -> String {
        if let Some(found) = std::env::var_os("PATH").and_then(|path| {
            std::env::split_paths(&path)
                .map(|dir| dir.join("sh.exe"))
                .find(|candidate| candidate.exists())
        }) {
            return found.to_string_lossy().into_owned();
        }
        let program_files =
            std::env::var_os("ProgramFiles").unwrap_or_else(|| "C:\\Program Files".into());
        for candidate in [
            std::path::Path::new(&program_files).join("Git\\bin\\sh.exe"),
            std::path::Path::new(&program_files).join("Git\\usr\\bin\\sh.exe"),
        ] {
            if candidate.exists() {
                return candidate.to_string_lossy().into_owned();
            }
        }
        "sh".to_string()
    }

    #[test]
    fn test_daemon_client_lifecycle_and_callbacks() {
        let server = Arc::new(DaemonServer::new());
        let cancel_token = CancellationToken::new();

        #[cfg(target_os = "windows")]
        let socket_path = format!(
            r"\\.\pipe\oppa-test-client-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );

        #[cfg(not(target_os = "windows"))]
        let socket_path = format!(
            "/tmp/oppa-test-client-{}.sock",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );

        let srv_clone = Arc::clone(&server);
        let cancel_clone = cancel_token.clone();
        let path_clone = socket_path.clone();

        let server_thread = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async move {
                let _ = srv_clone.run_listener(&path_clone, cancel_clone).await;
            });
        });

        std::thread::sleep(Duration::from_millis(150));

        let client = DaemonClient::connect(&socket_path).expect("connect client");

        // 1. Register callbacks
        let (data_tx, data_rx) = channel::<String>();
        let (exit_tx, _exit_rx) = channel::<Option<i32>>();
        let (cwd_tx, _cwd_rx) = channel::<String>();

        client.register_callbacks(
            "client-session-1",
            Some(Box::new(move |_id, bytes| {
                let _ = data_tx.send(String::from_utf8_lossy(bytes).into_owned());
            })),
            Some(Box::new(move |_id, code| {
                let _ = exit_tx.send(code);
            })),
            Some(Box::new(move |_id, cwd| {
                let _ = cwd_tx.send(cwd.to_string());
            })),
        );

        let sh = test_sh_path();
        let attach_res = client
            .create_or_attach("client-session-1", 80, 24, None, Some(sh), false, None)
            .expect("create_or_attach");

        assert!(attach_res.is_new);
        assert_eq!(attach_res.cols, 80);
        assert_eq!(attach_res.rows, 24);

        client
            .write("client-session-1", "echo client-stream-ok\n")
            .expect("write command");

        // Wait for data callback
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut output = String::new();
        while std::time::Instant::now() < deadline {
            if let Ok(chunk) = data_rx.recv_timeout(Duration::from_millis(200)) {
                output.push_str(&chunk);
                if output.contains("client-stream-ok") {
                    break;
                }
            }
        }
        assert!(
            output.contains("client-stream-ok"),
            "expected output containing 'client-stream-ok', got: {output}"
        );

        // 3. List sessions
        let sessions = client.list_sessions().expect("list sessions");
        assert!(sessions.contains(&"client-session-1".to_string()));

        // 4. Resize and ack
        client.resize("client-session-1", 100, 30).expect("resize");
        client.ack("client-session-1", 100).expect("ack");

        // 5. Reattach to session
        let reattach_res = client
            .create_or_attach("client-session-1", 100, 30, None, None, false, None)
            .expect("reattach");
        assert!(!reattach_res.is_new);
        assert!(reattach_res.snapshot.is_some());

        // 6. Kill session
        client.kill("client-session-1").expect("kill session");

        // 7. Disconnect and Shutdown
        client.disconnect().expect("disconnect");
        cancel_token.cancel();
        let _ = server_thread.join();
    }

    #[test]
    fn test_daemon_client_async_ack_high_throughput() {
        let server = Arc::new(DaemonServer::new());
        let cancel_token = CancellationToken::new();

        #[cfg(target_os = "windows")]
        let socket_path = format!(
            r"\\.\pipe\oppa-test-ack-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );

        #[cfg(not(target_os = "windows"))]
        let socket_path = format!(
            "/tmp/oppa-test-ack-{}.sock",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );

        let srv_clone = Arc::clone(&server);
        let cancel_clone = cancel_token.clone();
        let path_clone = socket_path.clone();

        let server_thread = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async move {
                let _ = srv_clone.run_listener(&path_clone, cancel_clone).await;
            });
        });

        std::thread::sleep(Duration::from_millis(150));

        let client = DaemonClient::connect(&socket_path).expect("connect client");

        let sh = test_sh_path();
        let attach_res = client
            .create_or_attach("ack-test-session", 80, 24, None, Some(sh), false, None)
            .expect("create_or_attach");
        assert!(attach_res.is_new);

        let start = std::time::Instant::now();
        for _ in 0..1000 {
            client
                .ack("ack-test-session", 1024)
                .expect("async ack should succeed");
        }
        let elapsed = start.elapsed();
        assert!(
            elapsed < Duration::from_secs(1),
            "1000 ACKs took too long: {elapsed:?}"
        );

        let sessions = client.list_sessions().expect("list_sessions after acks");
        assert!(sessions.contains(&"ack-test-session".to_string()));

        client.kill("ack-test-session").expect("kill");
        client.disconnect().expect("disconnect");
        cancel_token.cancel();
        let _ = server_thread.join();
    }

    #[test]
    fn worktree_agent_handoff_serializes_snake_case_for_tauri() {
        let handoff = WorktreeAgentHandoff {
            record: sample_worktree_record(),
            session_id: "agent-abc".into(),
        };
        let json = serde_json::to_value(&handoff).unwrap();
        assert_eq!(json["session_id"], "agent-abc");
        assert_eq!(json["record"]["id"], "demo::C:/ws/feat-a");
    }

    fn sample_worktree_record() -> WorktreeRecord {
        serde_json::from_value(serde_json::json!({
            "id": "demo::C:/ws/feat-a",
            "repo_id": "demo",
            "name": "feat-a",
            "display_name": null,
            "branch": "feat-a",
            "path": "C:/ws/feat-a",
            "base_ref": "main",
            "parent_worktree_id": null,
            "child_worktree_ids": [],
            "workspace_status": "todo",
            "retired": false,
            "created_at_ms": 1723900000000u64,
            "linked_pr_url": null
        }))
        .unwrap()
    }

    // Validation failures round-trip through the real pipe, proving the request
    // carries the handoff fields and the Error response maps to Err.
    #[test]
    fn create_worktree_with_agent_surfaces_server_validation_errors() {
        let temp_dir = std::env::temp_dir().join(format!("oppa_handoff_{}", std::process::id()));
        std::fs::create_dir_all(&temp_dir).unwrap();
        let server = Arc::new(DaemonServer::with_snapshot_storage(temp_dir));
        let cancel_token = CancellationToken::new();

        #[cfg(target_os = "windows")]
        let socket_path = format!(
            r"\\.\pipe\oppa-test-handoff-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );

        #[cfg(not(target_os = "windows"))]
        let socket_path = format!(
            "/tmp/oppa-test-handoff-{}.sock",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );

        let srv_clone = Arc::clone(&server);
        let cancel_clone = cancel_token.clone();
        let path_clone = socket_path.clone();
        let server_thread = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async move {
                let _ = srv_clone.run_listener(&path_clone, cancel_clone).await;
            });
        });

        std::thread::sleep(Duration::from_millis(150));

        let client = DaemonClient::connect(&socket_path).expect("connect client");

        let both = client.create_worktree_with_agent(
            "/tmp/repo",
            Some("feat-a".into()),
            None,
            None,
            None,
            None,
            None,
            Some("claude".into()),
            None,
            Some("claude --yolo".into()),
        );
        assert!(
            both.err().unwrap().contains("mutually exclusive"),
            "agent+command must be rejected"
        );

        let orphan_prompt = client.create_worktree_with_agent(
            "/tmp/repo",
            Some("feat-a".into()),
            None,
            None,
            None,
            None,
            None,
            Some("no-such-agent-xyz".into()),
            None,
            None,
        );
        assert!(
            orphan_prompt.err().unwrap().contains("unknown agent"),
            "unknown agent id must be rejected"
        );

        client.disconnect().expect("disconnect");
        cancel_token.cancel();
        let _ = server_thread.join();
    }

    // Answers the Hello handshake, then never replies to anything again —
    // used to prove write() no longer blocks on a daemon response.
    fn spawn_silent_server(socket_path: &str) -> std::thread::JoinHandle<()> {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

        let path = socket_path.to_string();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async move {
                #[cfg(target_os = "windows")]
                {
                    use tokio::net::windows::named_pipe::ServerOptions;
                    let mut server = ServerOptions::new()
                        .first_pipe_instance(true)
                        .create(&path)
                        .unwrap();
                    server.connect().await.unwrap();
                    let (reader, mut writer) = tokio::io::split(server);
                    let mut line = String::new();
                    BufReader::new(reader)
                        .read_line(&mut line)
                        .await
                        .unwrap();
                    let hello_ok = serde_json::to_string(&DaemonResponse::HelloOk {
                        protocol_version: DAEMON_PROTOCOL_VERSION,
                    })
                    .unwrap();
                    writer
                        .write_all(format!("{hello_ok}\n").as_bytes())
                        .await
                        .unwrap();
                    loop {
                        tokio::time::sleep(Duration::from_secs(3600)).await;
                    }
                }
                #[cfg(not(target_os = "windows"))]
                {
                    let listener = tokio::net::UnixListener::bind(&path).unwrap();
                    let (stream, _) = listener.accept().await.unwrap();
                    let (reader, mut writer) = tokio::io::split(stream);
                    let mut line = String::new();
                    BufReader::new(&mut reader).read_line(&mut line).await.unwrap();
                    let hello_ok = serde_json::to_string(&DaemonResponse::HelloOk {
                        protocol_version: crate::pty::ipc_protocol::DAEMON_PROTOCOL_VERSION,
                    })
                    .unwrap();
                    writer
                        .write_all(format!("{hello_ok}\n").as_bytes())
                        .await
                        .unwrap();
                    loop {
                        tokio::time::sleep(Duration::from_secs(3600)).await;
                    }
                }
            });
        })
    }

    #[test]
    fn write_is_fire_and_forget_when_daemon_stops_responding() {
        #[cfg(target_os = "windows")]
        let socket_path = format!(
            r"\\.\pipe\oppa-test-silent-write-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        #[cfg(not(target_os = "windows"))]
        let socket_path = format!(
            "/tmp/oppa-test-silent-write-{}.sock",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );

        let _server_thread = spawn_silent_server(&socket_path);
        std::thread::sleep(Duration::from_millis(150));

        let client = DaemonClient::connect(&socket_path).expect("connect to silent server");

        let start = std::time::Instant::now();
        let result = client.write("silent-session", "x");
        let elapsed = start.elapsed();

        assert!(
            elapsed < Duration::from_secs(2),
            "write() blocked {elapsed:?} waiting for a daemon response"
        );
        assert!(result.is_ok(), "queued write must succeed: {result:?}");

        client.disconnect().ok();
    }
}
