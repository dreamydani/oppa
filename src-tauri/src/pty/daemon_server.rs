use crate::git::hosted_reviews::{
    GhClient, LiveGhClient, PrPollerState,
};
use crate::git::teardown::LiveSession;
use crate::pty::daemon_session::DaemonSession;
use crate::pty::ipc_protocol::{
    DaemonEvent, DaemonRequest, DaemonResponse, WaitCondition,
};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{broadcast, Notify};

// Test-only items referenced by this module's tests via super::*
#[cfg(test)]
use crate::pty::runtime_metadata;
#[cfg(test)]
use crate::agents::catalog::build_launch_command;
#[cfg(test)]
use crate::git::worktree_registry::WorktreeRegistry;
#[cfg(test)]
use crate::pty::ipc_protocol::{ResumeKind, ResumePlan, DAEMON_PROTOCOL_VERSION};
#[cfg(test)]
use crate::pty::snapshot::{SessionSnapshot, SnapshotStorage};
#[cfg(test)]
use std::path::Path;
#[cfg(test)]
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) const CHECKPOINT_INTERVAL: Duration = Duration::from_secs(3);
// Bounded so a stalled client cannot grow memory; lagged receivers resync by design
pub(crate) const GLOBAL_EVENT_CAPACITY: usize = 64;
pub(crate) const REGISTRY_UNAVAILABLE: &str = "registry unavailable";
// Daemon-initiated agent panes start at the classic size; GUI resize wins on attach
pub(crate) const HANDOFF_COLS: u16 = 80;
pub(crate) const HANDOFF_ROWS: u16 = 24;
// Post-ready prompt delivery must outlast the shell's injection fallback window
pub(crate) const PROMPT_DELIVERY_TIMEOUT: Duration = Duration::from_secs(20);

// Re-exported: existing callers (manager tests, cli) import the token from
// this module, and it stays the daemon's public face.
pub use crate::pty::cancellation::CancellationToken;

/// Detached Daemon Server managing active terminal sessions and IPC request routing.
/// Request dispatch, checkpoints/resume planning, the PR poller, and agent
/// handoff each live in sibling `pty::*` modules as additional impl blocks.
pub struct DaemonServer {
    pub(crate) sessions: Arc<Mutex<HashMap<String, Arc<DaemonSession>>>>,
    // App data dir for periodic session checkpoints; None skips persistence (tests)
    pub(crate) snapshot_dir: Option<PathBuf>,
    // Conversation ids already resumed since this daemon booted: a conversation
    // may be open in at most one pane (second claimant falls back to relaunch)
    pub(crate) resumed_agent_ids: Arc<Mutex<std::collections::HashSet<String>>>,
    // Some(snapshot_dir/worktrees.json) enables the repo/worktree request surface
    pub(crate) worktree_registry_path: Option<PathBuf>,
    // Some(snapshot_dir/diff-comments.json) enables the diff-comment request surface
    pub(crate) comments_store_path: Option<PathBuf>,
    // PR status poller: injectable gh client, per-worktree backoff state, push burst signal
    pub(crate) pr_client: Arc<dyn GhClient>,
    pub(crate) pr_poller_state: Arc<Mutex<PrPollerState>>,
    pub(crate) pr_push_burst: Arc<Notify>,
    // Set only when the discovery file was written; None keeps the pipe unauthenticated
    pub(crate) auth_token: Option<String>,
    pub(crate) global_events: broadcast::Sender<DaemonEvent>,
    // Test seam: isolated fake gh dir without mutating global PATH; None → PATH lookup
    pub(crate) gh_search_path: Option<PathBuf>,
}

impl Default for DaemonServer {
    fn default() -> Self {
        Self::new()
    }
}

impl DaemonServer {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            snapshot_dir: None,
            resumed_agent_ids: Arc::new(Mutex::new(std::collections::HashSet::new())),
            worktree_registry_path: None,
            comments_store_path: None,
            pr_client: Arc::new(LiveGhClient::new()),
            pr_poller_state: Arc::new(Mutex::new(PrPollerState::default())),
            pr_push_burst: Arc::new(Notify::new()),
            auth_token: None,
            global_events: broadcast::channel(GLOBAL_EVENT_CAPACITY).0,
            gh_search_path: None,
        }
    }

    pub fn with_snapshot_storage(app_data_dir: PathBuf) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            snapshot_dir: Some(app_data_dir.clone()),
            resumed_agent_ids: Arc::new(Mutex::new(std::collections::HashSet::new())),
            worktree_registry_path: Some(app_data_dir.join("worktrees.json")),
            comments_store_path: Some(app_data_dir.join("diff-comments.json")),
            pr_client: Arc::new(LiveGhClient::new()),
            pr_poller_state: Arc::new(Mutex::new(PrPollerState::default())),
            pr_push_burst: Arc::new(Notify::new()),
            auth_token: None,
            global_events: broadcast::channel(GLOBAL_EVENT_CAPACITY).0,
            gh_search_path: None,
        }
    }

    // Test seam: swap the live gh runner for a mock before booting the poller.
    pub fn with_pr_client(mut self, client: Arc<dyn GhClient>) -> Self {
        self.pr_client = client;
        self
    }

    // Test seam: isolated fake gh dir without mutating global PATH; None → PATH lookup.
    // When set, eligibility and creation use this dir for gh resolution, and the
    // poller client is rebuilt to honor the same path unless a mock was injected.
    pub fn with_fake_gh_dir(mut self, dir: PathBuf) -> Self {
        self.gh_search_path = Some(dir.clone());
        // Rebuild live client to honor the injected dir; a later with_pr_client can override.
        self.pr_client = Arc::new(LiveGhClient::with_search_path(Some(dir)));
        self
    }

    pub fn set_auth_token(&mut self, token: Option<String>) {
        self.auth_token = token;
    }

    pub fn subscribe_global_events(&self) -> broadcast::Receiver<DaemonEvent> {
        self.global_events.subscribe()
    }

    pub fn sessions(&self) -> Arc<Mutex<HashMap<String, Arc<DaemonSession>>>> {
        Arc::clone(&self.sessions)
    }

    pub(crate) fn publish_global(&self, event: DaemonEvent) {
        let _ = self.global_events.send(event);
    }

    pub(crate) fn live_sessions(&self) -> Vec<LiveSession> {
        self.sessions
            .lock()
            .iter()
            .map(|(session_id, session)| LiveSession {
                session_id: session_id.clone(),
                cwd: session.cwd(),
                worktree_id: session.worktree_id.clone(),
            })
            .collect()
    }

    /// Run the server listener on the designated platform socket.
    pub async fn run_listener(
        &self,
        socket_path: &str,
        cancel_token: CancellationToken,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let server = self.shared_clone();
        run_server_listener(server, socket_path, cancel_token).await
    }

    // Arc-shared clone so spawned tasks (listener, poller) share registry/event wiring.
    pub(crate) fn shared_clone(&self) -> Arc<DaemonServer> {
        Arc::new(Self {
            sessions: Arc::clone(&self.sessions),
            snapshot_dir: self.snapshot_dir.clone(),
            resumed_agent_ids: Arc::clone(&self.resumed_agent_ids),
            worktree_registry_path: self.worktree_registry_path.clone(),
            comments_store_path: self.comments_store_path.clone(),
            pr_client: Arc::clone(&self.pr_client),
            pr_poller_state: Arc::clone(&self.pr_poller_state),
            pr_push_burst: Arc::clone(&self.pr_push_burst),
            auth_token: self.auth_token.clone(),
            global_events: self.global_events.clone(),
            gh_search_path: self.gh_search_path.clone(),
        })
    }

}

/// Keepalive cadence for long-poll waits (orca parity: clients must see
/// traffic before their own read timeouts expire).
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(2);
const KEEPALIVE_FRAME: &str = "{\"_keepalive\":true}\n";

/// Handle a WaitFor request inline in the client stream: the wait can block
/// past the client's read timeout, so keepalive frames are emitted on the
/// same connection until the wait resolves. Returns the protocol response.
async fn handle_wait_for(
    server: &DaemonServer,
    out_tx: &tokio::sync::mpsc::Sender<String>,
    session_id: String,
    cond: WaitCondition,
    timeout_ms: u64,
) -> DaemonResponse {
    let session = {
        let sessions = server.sessions.lock();
        sessions.get(&session_id).cloned()
    };
    let Some(session) = session else {
        return DaemonResponse::Error("session not found".into());
    };

    let started = Instant::now();
    let deadline = started + Duration::from_millis(timeout_ms);

    let keepalive_tx = out_tx.clone();
    let keepalive = tokio::spawn(async move {
        let mut interval = tokio::time::interval(KEEPALIVE_INTERVAL);
        interval.tick().await;
        loop {
            interval.tick().await;
            if keepalive_tx.send(KEEPALIVE_FRAME.to_string()).await.is_err() {
                break;
            }
        }
    });

    let (satisfied, exit_code) = match cond {
        WaitCondition::Exit => {
            // Already-dead children never re-emit Exit, so poll try_wait
            // alongside the subscriber channel to close that race.
            let mut rx = session.subscribe();
            let mut result = (false, None);
            loop {
                if let Some(code) = session.exit_code() {
                    result = (true, Some(code));
                    break;
                }
                let now = Instant::now();
                if now >= deadline {
                    break;
                }
                match tokio::time::timeout(deadline - now, rx.recv()).await {
                    Ok(Some(event)) => {
                        if let DaemonEvent::Exit { code, .. } = &*event {
                            result = (true, *code);
                            break;
                        }
                        continue;
                    }
                    Ok(None) => break,
                    Err(_elapsed) => break,
                }
            }
            result
        }
        WaitCondition::TuiIdle => (session.wait_until_idle(deadline).await, None),
    };

    keepalive.abort();
    let waited_ms = started.elapsed().as_millis() as u64;
    DaemonResponse::WaitResult {
        satisfied,
        exit_code,
        waited_ms,
    }
}

/// Handle bidirectional JSON communication with a single connected client stream.
pub async fn handle_client_stream<S>(
    stream: S,
    server: Arc<DaemonServer>,
    cancel_token: CancellationToken,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (read_half, mut write_half) = tokio::io::split(stream);
    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel::<String>(256);
    // Global events (worktree mutations etc.) fan out to every connected client,
    // alongside the per-session subscriber streams wired up below.
    let mut global_rx = server.subscribe_global_events();
    let mut global_open = true;

    let writer_task = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            if write_half.write_all(msg.as_bytes()).await.is_err() {
                break;
            }
            if write_half.flush().await.is_err() {
                break;
            }
        }
    });

    let mut reader = BufReader::new(read_half);
    let mut line = String::new();
    let mut subscribed_sessions: HashMap<String, tokio::task::JoinHandle<()>> = HashMap::new();

    loop {
        line.clear();
        tokio::select! {
            _ = cancel_token.cancelled() => {
                break;
            }
            global_res = global_rx.recv(), if global_open => {
                match global_res {
                    Ok(event) => {
                        if let Ok(json) = serde_json::to_string(&event) {
                            let _ = out_tx.send(format!("{json}\n")).await;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => global_open = false,
                }
            }
            read_res = reader.read_line(&mut line) => {
                match read_res {
                    Ok(0) => break, // EOF
                    Ok(_) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        let req: DaemonRequest = match serde_json::from_str(trimmed) {
                            Ok(r) => r,
                            Err(e) => {
                                let err_resp = DaemonResponse::Error(format!("invalid request JSON: {e}"));
                                if let Ok(json) = serde_json::to_string(&err_resp) {
                                    let _ = out_tx.send(format!("{json}\n")).await;
                                }
                                continue;
                            }
                        };

                        let is_disconnect = matches!(req, DaemonRequest::Disconnect);
                        let is_shutdown = matches!(req, DaemonRequest::Shutdown);
                        let is_ack = matches!(req, DaemonRequest::Ack { .. });

                        let session_to_sub = match &req {
                            DaemonRequest::CreateOrAttach { session_id, .. } => Some(session_id.clone()),
                            _ => None,
                        };

                        // Inline long-poll: handle_request is sync and would
                        // stall this select loop (and thus keepalives)
                        let wait = match &req {
                            DaemonRequest::WaitFor {
                                session_id,
                                cond,
                                timeout_ms,
                            } => Some((session_id.clone(), *cond, *timeout_ms)),
                            _ => None,
                        };
                        let resp = match wait {
                            Some((session_id, cond, timeout_ms)) => {
                                handle_wait_for(&server, &out_tx, session_id, cond, timeout_ms)
                                    .await
                            }
                            None => server.handle_request(req),
                        };

                        // If CreateOrAttach succeeded, wire up subscriber task if not already streaming to this client
                        if let Some(session_id) = session_to_sub {
                            if matches!(resp, DaemonResponse::SessionAttached(_)) && !subscribed_sessions.contains_key(&session_id) {
                                let session = server.sessions.lock().get(&session_id).cloned();
                                if let Some(session) = session {
                                    let mut rx = session.subscribe();
                                    let out_tx_sub = out_tx.clone();
                                    let sub_task = tokio::spawn(async move {
                                        while let Some(event) = rx.recv().await {
                                            if let Ok(json) = serde_json::to_string(&event) {
                                                if out_tx_sub.send(format!("{json}\n")).await.is_err() {
                                                    break;
                                                }
                                            }
                                        }
                                    });
                                    subscribed_sessions.insert(session_id, sub_task);
                                }
                            }
                        }

                        if !is_ack {
                            if let Ok(json) = serde_json::to_string(&resp) {
                                let _ = out_tx.send(format!("{json}\n")).await;
                            }
                        }

                        if is_disconnect {
                            break;
                        }
                        if is_shutdown {
                            cancel_token.cancel();
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        }
    }

    for (_, handle) in subscribed_sessions {
        handle.abort();
    }
    writer_task.abort();

    Ok(())
}

/// Platform-specific listener runner
pub async fn run_server_listener(
    server: Arc<DaemonServer>,
    socket_path: &str,
    cancel_token: CancellationToken,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    #[cfg(target_os = "windows")]
    {
        use tokio::net::windows::named_pipe::ServerOptions;

        let mut is_first = true;
        loop {
            if cancel_token.is_cancelled() {
                break;
            }

            let pipe_server = match ServerOptions::new()
                .first_pipe_instance(is_first)
                .max_instances(254)
                .create(socket_path)
            {
                Ok(server) => {
                    is_first = false;
                    server
                }
                Err(_) => {
                    if cancel_token.is_cancelled() {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    continue;
                }
            };

            tokio::select! {
                _ = cancel_token.cancelled() => {
                    break;
                }
                conn_res = pipe_server.connect() => {
                    match conn_res {
                        Ok(()) => {
                            let server_clone = Arc::clone(&server);
                            let cancel_clone = cancel_token.clone();
                            tokio::spawn(async move {
                                let _ = handle_client_stream(pipe_server, server_clone, cancel_clone).await;
                            });
                        }
                        Err(_) => {
                            if cancel_token.is_cancelled() {
                                break;
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        use tokio::net::UnixListener;

        let _ = std::fs::remove_file(socket_path);
        if let Some(parent) = std::path::Path::new(socket_path).parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let listener = UnixListener::bind(socket_path)?;

        loop {
            tokio::select! {
                _ = cancel_token.cancelled() => {
                    break;
                }
                res = listener.accept() => {
                    match res {
                        Ok((stream, _)) => {
                            let server_clone = Arc::clone(&server);
                            let cancel_clone = cancel_token.clone();
                            tokio::spawn(async move {
                                let _ = handle_client_stream(stream, server_clone, cancel_clone).await;
                            });
                        }
                        Err(_) => {
                            if cancel_token.is_cancelled() {
                                break;
                            }
                        }
                    }
                }
            }
        }
        let _ = std::fs::remove_file(socket_path);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::ipc_protocol::DaemonEvent;
    use std::time::Duration;
    use std::time::Instant;

    // Raw-stream twin of RuntimeConnection::request: skip streamed event /
    // keepalive frames so strict next-line response assertions stay valid
    // now that attach seeds a SessionWorking frame onto every subscriber.
    async fn read_response<R>(reader: &mut BufReader<R>, line: &mut String) -> DaemonResponse
    where
        R: tokio::io::AsyncRead + Unpin,
    {
        loop {
            line.clear();
            reader.read_line(line).await.unwrap();
            let value: serde_json::Value = serde_json::from_str(line.trim())
                .unwrap_or(serde_json::Value::Null);
            if value.get("event").is_some() || value.get("_keepalive").is_some() {
                continue;
            }
            return serde_json::from_value(value)
                .unwrap_or_else(|e| panic!("undecodable response frame {line:?}: {e}"));
        }
    }

    #[tokio::test]
    async fn test_daemon_server_handle_request_lifecycle() {
        let server = DaemonServer::new();

        // 1. Hello
        let resp = server.handle_request(DaemonRequest::Hello {
            client_version: "0.1.0".into(),
            protocol_version: DAEMON_PROTOCOL_VERSION,
            auth_token: None,
        });
        assert_eq!(
            resp,
            DaemonResponse::HelloOk {
                protocol_version: DAEMON_PROTOCOL_VERSION
            }
        );

        // 2. CreateOrAttach (new)
        let resp = server.handle_request(DaemonRequest::CreateOrAttach {
            session_id: "req-test-1".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: None,
            resume_agents: false,
            worktree_id: None,
            extra_env: Vec::new(),
        });
        match resp {
            DaemonResponse::SessionAttached(res) => {
                assert!(res.is_new);
                assert_eq!(res.cols, 80);
                assert_eq!(res.rows, 24);
                assert!(res.snapshot.is_none());
            }
            other => panic!("expected SessionAttached, got {other:?}"),
        }

        // 3. Write
        let resp = server.handle_request(DaemonRequest::Write {
            session_id: "req-test-1".into(),
            data: "echo hello\n".into(),
        });
        assert_eq!(resp, DaemonResponse::Ok);

        // 4. Resize
        let resp = server.handle_request(DaemonRequest::Resize {
            session_id: "req-test-1".into(),
            cols: 120,
            rows: 40,
        });
        assert_eq!(resp, DaemonResponse::Ok);

        // 5. Ack
        let resp = server.handle_request(DaemonRequest::Ack {
            session_id: "req-test-1".into(),
            chars: 100,
        });
        assert_eq!(resp, DaemonResponse::Ok);

        // 6. ListSessions
        let resp = server.handle_request(DaemonRequest::ListSessions);
        match resp {
            DaemonResponse::SessionList(sessions) => {
                assert_eq!(sessions, vec!["req-test-1".to_string()]);
            }
            other => panic!("expected SessionList, got {other:?}"),
        }

        // 7. CreateOrAttach (attach existing)
        let resp = server.handle_request(DaemonRequest::CreateOrAttach {
            session_id: "req-test-1".into(),
            cols: 120,
            rows: 40,
            cwd: None,
            shell: None,
            resume_agents: false,
            worktree_id: None,
            extra_env: Vec::new(),
        });
        match resp {
            DaemonResponse::SessionAttached(res) => {
                assert!(!res.is_new);
                assert_eq!(res.cols, 120);
                assert_eq!(res.rows, 40);
                assert!(res.snapshot.is_some());
            }
            other => panic!("expected SessionAttached, got {other:?}"),
        }

        // 8. Kill
        let resp = server.handle_request(DaemonRequest::Kill {
            session_id: "req-test-1".into(),
        });
        assert_eq!(resp, DaemonResponse::Ok);

        // 9. ListSessions is empty
        let resp = server.handle_request(DaemonRequest::ListSessions);
        match resp {
            DaemonResponse::SessionList(list) => {
                assert!(list.is_empty());
            }
            other => panic!("expected empty SessionList, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_daemon_server_socket_ipc_roundtrip() {
        let server = Arc::new(DaemonServer::new());
        let cancel_token = CancellationToken::new();

        #[cfg(target_os = "windows")]
        let socket_path = format!(
            r"\\.\pipe\oppa-test-daemon-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );

        #[cfg(not(target_os = "windows"))]
        let socket_path = format!(
            "/tmp/oppa-test-daemon-{}.sock",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );

        let srv_clone = Arc::clone(&server);
        let cancel_clone = cancel_token.clone();
        let path_clone = socket_path.clone();

        tokio::spawn(async move {
            let _ = srv_clone.run_listener(&path_clone, cancel_clone).await;
        });

        // Small wait for server listener to bind
        tokio::time::sleep(Duration::from_millis(100)).await;

        // 1. Connect Client 1
        #[cfg(target_os = "windows")]
        let client_stream = {
            use tokio::net::windows::named_pipe::ClientOptions;
            let mut client = None;
            for _ in 0..20 {
                if let Ok(c) = ClientOptions::new().open(&socket_path) {
                    client = Some(c);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            client.expect("connect to test named pipe")
        };

        #[cfg(not(target_os = "windows"))]
        let client_stream = {
            use tokio::net::UnixStream;
            let mut client = None;
            for _ in 0..20 {
                if let Ok(c) = UnixStream::connect(&socket_path).await {
                    client = Some(c);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            client.expect("connect to test unix socket")
        };

        let (read_half, mut write_half) = tokio::io::split(client_stream);
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();

        // Client 1: Hello
        let hello_req = DaemonRequest::Hello {
            client_version: "0.1.0".into(),
            protocol_version: DAEMON_PROTOCOL_VERSION,
            auth_token: None,
        };
        let mut hello_str = serde_json::to_string(&hello_req).unwrap();
        hello_str.push('\n');
        write_half.write_all(hello_str.as_bytes()).await.unwrap();

        line.clear();
        reader.read_line(&mut line).await.unwrap();
        let hello_resp: DaemonResponse = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(
            hello_resp,
            DaemonResponse::HelloOk {
                protocol_version: DAEMON_PROTOCOL_VERSION
            }
        );

        // Client 1: CreateOrAttach
        let create_req = DaemonRequest::CreateOrAttach {
            session_id: "ipc-test-session".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: None,
            resume_agents: false,
            worktree_id: None,
            extra_env: Vec::new(),
        };
        let mut create_str = serde_json::to_string(&create_req).unwrap();
        create_str.push('\n');
        write_half.write_all(create_str.as_bytes()).await.unwrap();

        match read_response(&mut reader, &mut line).await {
            DaemonResponse::SessionAttached(res) => {
                assert!(res.is_new);
            }
            other => panic!("expected SessionAttached, got {other:?}"),
        }

        // Client 1: Write command
        let write_req = DaemonRequest::Write {
            session_id: "ipc-test-session".into(),
            data: "echo persistent_ipc_content\n".into(),
        };
        let mut write_str = serde_json::to_string(&write_req).unwrap();
        write_str.push('\n');
        write_half.write_all(write_str.as_bytes()).await.unwrap();

        // Read response for Write or streaming events
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut found_content = false;
        while std::time::Instant::now() < deadline {
            line.clear();
            if let Ok(Ok(n)) = tokio::time::timeout(Duration::from_millis(500), reader.read_line(&mut line)).await {
                if n == 0 {
                    break;
                }
                if let Ok(DaemonEvent::Data { data, .. }) = serde_json::from_str::<DaemonEvent>(line.trim()) {
                    if data.contains("persistent_ipc_content") {
                        found_content = true;
                        break;
                    }
                }
            }
        }
        assert!(found_content, "expected to receive output event containing 'persistent_ipc_content'");

        // Client 1: Disconnect (leaves session intact)
        let disc_req = DaemonRequest::Disconnect;
        let mut disc_str = serde_json::to_string(&disc_req).unwrap();
        disc_str.push('\n');
        write_half.write_all(disc_str.as_bytes()).await.unwrap();
        drop(write_half);
        drop(reader);

        // 2. Connect Client 2 (Reattach test)
        tokio::time::sleep(Duration::from_millis(100)).await;

        #[cfg(target_os = "windows")]
        let client_stream2 = {
            use tokio::net::windows::named_pipe::ClientOptions;
            let mut client = None;
            for _ in 0..20 {
                if let Ok(c) = ClientOptions::new().open(&socket_path) {
                    client = Some(c);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            client.expect("connect client 2 to test named pipe")
        };

        #[cfg(not(target_os = "windows"))]
        let client_stream2 = {
            use tokio::net::UnixStream;
            let mut client = None;
            for _ in 0..20 {
                if let Ok(c) = UnixStream::connect(&socket_path).await {
                    client = Some(c);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            client.expect("connect client 2 to test unix socket")
        };

        let (read_half2, mut write_half2) = tokio::io::split(client_stream2);
        let mut reader2 = BufReader::new(read_half2);

        // Client 2: Reattach to the same session
        let reattach_req = DaemonRequest::CreateOrAttach {
            session_id: "ipc-test-session".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: None,
            resume_agents: false,
            worktree_id: None,
            extra_env: Vec::new(),
        };
        let mut reattach_str = serde_json::to_string(&reattach_req).unwrap();
        reattach_str.push('\n');
        write_half2.write_all(reattach_str.as_bytes()).await.unwrap();

        match read_response(&mut reader2, &mut line).await {
            DaemonResponse::SessionAttached(res) => {
                assert!(!res.is_new, "expected reattached session to have is_new: false");
                let snapshot = res.snapshot.expect("expected reattached session snapshot");
                assert!(
                    snapshot.contains("persistent_ipc_content"),
                    "expected snapshot to contain 'persistent_ipc_content', got: {snapshot}"
                );
            }
            other => panic!("expected SessionAttached, got {other:?}"),
        }

        // Clean up: Shutdown
        let shutdown_req = DaemonRequest::Shutdown;
        let mut shutdown_str = serde_json::to_string(&shutdown_req).unwrap();
        shutdown_str.push('\n');
        write_half2.write_all(shutdown_str.as_bytes()).await.unwrap();

        cancel_token.cancel();
    }

    #[tokio::test]
    async fn test_daemon_server_ack_one_way_no_response_frame() {
        let server = Arc::new(DaemonServer::new());
        let cancel_token = CancellationToken::new();

        #[cfg(target_os = "windows")]
        let socket_path = format!(
            r"\\.\pipe\oppa-test-ack-srv-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );

        #[cfg(not(target_os = "windows"))]
        let socket_path = format!(
            "/tmp/oppa-test-ack-srv-{}.sock",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );

        let srv_clone = Arc::clone(&server);
        let cancel_clone = cancel_token.clone();
        let path_clone = socket_path.clone();

        tokio::spawn(async move {
            let _ = srv_clone.run_listener(&path_clone, cancel_clone).await;
        });

        tokio::time::sleep(Duration::from_millis(100)).await;

        #[cfg(target_os = "windows")]
        let client_stream = {
            use tokio::net::windows::named_pipe::ClientOptions;
            let mut client = None;
            for _ in 0..20 {
                if let Ok(c) = ClientOptions::new().open(&socket_path) {
                    client = Some(c);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            client.expect("connect named pipe")
        };

        #[cfg(not(target_os = "windows"))]
        let client_stream = {
            use tokio::net::UnixStream;
            let mut client = None;
            for _ in 0..20 {
                if let Ok(c) = UnixStream::connect(&socket_path).await {
                    client = Some(c);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            client.expect("connect unix socket")
        };

        let (read_half, mut write_half) = tokio::io::split(client_stream);
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();

        // 1. Hello
        let hello = serde_json::to_string(&DaemonRequest::Hello {
            client_version: "0.1.0".into(),
            protocol_version: DAEMON_PROTOCOL_VERSION,
            auth_token: None,
        })
        .unwrap()
            + "\n";
        write_half.write_all(hello.as_bytes()).await.unwrap();
        reader.read_line(&mut line).await.unwrap();

        // 2. CreateOrAttach
        let create = serde_json::to_string(&DaemonRequest::CreateOrAttach {
            session_id: "ack-srv-test".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: None,
            resume_agents: false,
            worktree_id: None,
            extra_env: Vec::new(),
        })
        .unwrap()
            + "\n";
        write_half.write_all(create.as_bytes()).await.unwrap();
        let _create_resp = read_response(&mut reader, &mut line).await;

        // Send ACK over stream
        let ack_msg = serde_json::to_string(&DaemonRequest::Ack {
            session_id: "ack-srv-test".into(),
            chars: 50,
        })
        .unwrap()
            + "\n";
        write_half.write_all(ack_msg.as_bytes()).await.unwrap();

        // Send ListSessions request immediately after ACK.
        // If Ack is one-way (no response frame), the very next response MUST be SessionList, not Ok!
        let list_req = serde_json::to_string(&DaemonRequest::ListSessions).unwrap() + "\n";
        write_half.write_all(list_req.as_bytes()).await.unwrap();

        match read_response(&mut reader, &mut line).await {
            DaemonResponse::SessionList(sessions) => {
                assert!(sessions.contains(&"ack-srv-test".to_string()));
            }
            DaemonResponse::Ok => {
                panic!("received unexpected Ok response from Ack request; Ack should be one-way!")
            }
            other => panic!("expected SessionList, got {other:?}"),
        }

        // Clean up
        cancel_token.cancel();
    }

    #[tokio::test]
    async fn test_create_or_attach_resizes_before_taking_snapshot() {
        let server = DaemonServer::new();

        // 1. Initial create at 80x24
        let resp = server.handle_request(DaemonRequest::CreateOrAttach {
            session_id: "resize-reattach-test".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: None,
            resume_agents: false,
            worktree_id: None,
            extra_env: Vec::new(),
        });
        match resp {
            DaemonResponse::SessionAttached(res) => {
                assert!(res.is_new);
                assert_eq!(res.cols, 80);
                assert_eq!(res.rows, 24);
            }
            other => panic!("expected SessionAttached, got {other:?}"),
        }

        // 2. Reattach with 50x14
        let resp = server.handle_request(DaemonRequest::CreateOrAttach {
            session_id: "resize-reattach-test".into(),
            cols: 50,
            rows: 14,
            cwd: None,
            shell: None,
            resume_agents: false,
            worktree_id: None,
            extra_env: Vec::new(),
        });
        match resp {
            DaemonResponse::SessionAttached(res) => {
                assert!(!res.is_new);
                assert_eq!(res.cols, 50);
                assert_eq!(res.rows, 14);
                assert!(res.snapshot.is_some());
            }
            other => panic!("expected SessionAttached, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_cold_restore_returns_resume_plan_and_injects_command() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let storage = SnapshotStorage::new(temp_dir.path().to_path_buf());
        storage
            .save_snapshot(&SessionSnapshot {
                session_id: "resume-test".into(),
                cwd: String::new(),
                title: None,
                cols: 80,
                rows: 24,
                persona_id: None,
                scrollback: "old screen".into(),
                timestamp: 1,
                foreground_command: Some("claude --resume abc123".into()),
                agent_session: None,
                worktree_id: None,
            })
            .expect("seed checkpoint");

        let server = DaemonServer::with_snapshot_storage(temp_dir.path().to_path_buf());
        let resp = server.handle_request(DaemonRequest::CreateOrAttach {
            session_id: "resume-test".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: None,
            resume_agents: true,
            worktree_id: None,
            extra_env: Vec::new(),
        });
        match resp {
            DaemonResponse::SessionAttached(res) => {
                assert!(res.is_new);
                assert_eq!(
                    res.resume,
                    Some(ResumePlan {
                        // No captured session ref: plain relaunch of the known
                        // agent's original command line
                        command_line: "claude --resume abc123".into(),
                        kind: ResumeKind::CommandRelaunch,
                    })
                );
                assert_eq!(
                    res.resume_declined_reason,
                    Some("no verified resume command for this agent".into())
                );
            }
            other => panic!("expected SessionAttached, got {other:?}"),
        }

        // Marker-triggered injection: feed the ready marker, expect the resumed
        // command written into the PTY (echoed back in the data stream)
        let session = server
            .sessions()
            .lock()
            .get("resume-test")
            .cloned()
            .expect("session live");
        let mut rx = session.subscribe();
        session.write(b"\x1b]633;oppa-ready\x07").expect("marker");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut collected = String::new();
        while std::time::Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(300), rx.recv()).await {
                Ok(Some(event)) => match event.as_ref() {
                    DaemonEvent::Data { data, .. } => {
                        collected.push_str(data);
                        if collected.contains("claude") {
                            break;
                        }
                    }
                    _ => {}
                },
                _ => continue,
            }
        }
        assert!(
            collected.contains("claude"),
            "expected injected resume command echoed, got: {collected}"
        );
        let _ = server.handle_request(DaemonRequest::Kill {
            session_id: "resume-test".into(),
        });
    }

    #[tokio::test]
    async fn test_cold_restore_without_resume_flag_stays_plain() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let storage = SnapshotStorage::new(temp_dir.path().to_path_buf());
        storage
            .save_snapshot(&SessionSnapshot {
                session_id: "no-resume-test".into(),
                cwd: String::new(),
                title: None,
                cols: 80,
                rows: 24,
                persona_id: None,
                scrollback: "old screen".into(),
                timestamp: 1,
                foreground_command: Some("claude --resume abc123".into()),
                agent_session: None,
                worktree_id: None,
            })
            .expect("seed checkpoint");

        let server = DaemonServer::with_snapshot_storage(temp_dir.path().to_path_buf());
        let resp = server.handle_request(DaemonRequest::CreateOrAttach {
            session_id: "no-resume-test".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: None,
            resume_agents: false,
            worktree_id: None,
            extra_env: Vec::new(),
        });
        match resp {
            DaemonResponse::SessionAttached(res) => {
                assert!(res.is_new);
                assert!(res.resume.is_none());
                assert!(res.resume_declined_reason.is_none());
            }
            other => panic!("expected SessionAttached, got {other:?}"),
        }
        let _ = server.handle_request(DaemonRequest::Kill {
            session_id: "no-resume-test".into(),
        });
    }

    #[tokio::test]
    async fn test_same_conversation_claimed_by_second_pane_downgrades_to_relaunch() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let storage = SnapshotStorage::new(temp_dir.path().to_path_buf());
        // Two panes ran the same conversation (e.g. same cwd). Claude is used
        // here because its transcript dir for this cwd has no alternatives on
        // the test machine, making the fallback deterministic.
        for sid in ["dedup-a", "dedup-b"] {
            storage
                .save_snapshot(&SessionSnapshot {
                    session_id: sid.into(),
                    cwd: r"C:\shared\project".into(),
                    title: None,
                    cols: 80,
                    rows: 24,
                    persona_id: None,
                    scrollback: "old screen".into(),
                    timestamp: 1,
                    foreground_command: Some("claude".into()),
                    agent_session: Some(crate::pty::snapshot::AgentSessionRef {
                        agent: "claude".into(),
                        id: "same-conv-1".into(),
                        transcript_path: None,
                    }),
                    worktree_id: None,
                })
                .expect("seed checkpoint");
        }

        let server = DaemonServer::with_snapshot_storage(temp_dir.path().to_path_buf());

        // First pane wins the conversation
        let resp = server.handle_request(DaemonRequest::CreateOrAttach {
            session_id: "dedup-a".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: None,
            resume_agents: true,
            worktree_id: None,
            extra_env: Vec::new(),
        });
        match resp {
            DaemonResponse::SessionAttached(res) => {
                assert!(matches!(
                    res.resume,
                    Some(ResumePlan { kind: ResumeKind::AgentResume, .. })
                ));
            }
            other => panic!("expected SessionAttached, got {other:?}"),
        }

        // Second pane must NOT reopen the same conversation
        let resp = server.handle_request(DaemonRequest::CreateOrAttach {
            session_id: "dedup-b".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: None,
            resume_agents: true,
            worktree_id: None,
            extra_env: Vec::new(),
        });
        match resp {
            DaemonResponse::SessionAttached(res) => {
                assert!(matches!(
                    res.resume,
                    Some(ResumePlan {
                        command_line: ref cmd,
                        kind: ResumeKind::CommandRelaunch,
                    }) if cmd == "claude"
                ));
                assert_eq!(
                    res.resume_declined_reason,
                    Some("conversation already resumed in another pane".into())
                );
            }
            other => panic!("expected SessionAttached, got {other:?}"),
        }
        let _ = server.handle_request(DaemonRequest::Kill {
            session_id: "dedup-a".into(),
        });
        let _ = server.handle_request(DaemonRequest::Kill {
            session_id: "dedup-b".into(),
        });
    }

    #[tokio::test]
    async fn test_checkpoint_task_writes_snapshot_within_debounce_window() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let server = DaemonServer::with_snapshot_storage(temp_dir.path().to_path_buf());

        let resp = server.handle_request(DaemonRequest::CreateOrAttach {
            session_id: "checkpoint-test".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: None,
            resume_agents: false,
            worktree_id: None,
            extra_env: Vec::new(),
        });
        match resp {
            DaemonResponse::SessionAttached(res) => assert!(res.is_new),
            other => panic!("expected SessionAttached, got {other:?}"),
        }

        tokio::time::sleep(Duration::from_secs(4)).await;

        let storage = SnapshotStorage::new(temp_dir.path().to_path_buf());
        let snap = storage
            .load_snapshot("checkpoint-test")
            .expect("load succeeds")
            .expect("checkpoint file written within debounce window");
        assert_eq!(snap.session_id, "checkpoint-test");
        assert!(snap.timestamp > 0);

        let _ = server.handle_request(DaemonRequest::Kill {
            session_id: "checkpoint-test".into(),
        });
    }

    #[tokio::test]
    async fn test_shutdown_flushes_final_snapshot_for_live_sessions() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let server = DaemonServer::with_snapshot_storage(temp_dir.path().to_path_buf());

        let resp = server.handle_request(DaemonRequest::CreateOrAttach {
            session_id: "flush-test".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: None,
            resume_agents: false,
            worktree_id: None,
            extra_env: Vec::new(),
        });
        match resp {
            DaemonResponse::SessionAttached(res) => assert!(res.is_new),
            other => panic!("expected SessionAttached, got {other:?}"),
        }

        // Shutdown must flush synchronously before draining/killing
        let resp = server.handle_request(DaemonRequest::Shutdown);
        assert_eq!(resp, DaemonResponse::Ok);

        let storage = SnapshotStorage::new(temp_dir.path().to_path_buf());
        let snap = storage
            .load_snapshot("flush-test")
            .expect("load succeeds")
            .expect("shutdown flushed final snapshot");
        assert_eq!(snap.session_id, "flush-test");
    }

    fn hello(token: Option<&str>) -> DaemonRequest {
        DaemonRequest::Hello {
            client_version: "test".into(),
            protocol_version: DAEMON_PROTOCOL_VERSION,
            auth_token: token.map(str::to_string),
        }
    }

    #[tokio::test]
    async fn test_hello_auth_rejects_mismatch_but_grants_missing_and_matching() {
        let mut server = DaemonServer::new();
        server.set_auth_token(Some("secret".into()));

        match server.handle_request(hello(Some("wrong"))) {
            DaemonResponse::Error(e) => assert!(e.contains("unauthorized"), "got: {e}"),
            other => panic!("expected unauthorized error, got {other:?}"),
        }
        // M1 grace: renderers before task 6 send no token at all
        assert!(matches!(
            server.handle_request(hello(None)),
            DaemonResponse::HelloOk { .. }
        ));
        assert!(matches!(
            server.handle_request(hello(Some("secret"))),
            DaemonResponse::HelloOk { .. }
        ));

        let open_server = DaemonServer::new();
        assert!(matches!(
            open_server.handle_request(hello(Some("anything"))),
            DaemonResponse::HelloOk { .. }
        ));
    }

    #[tokio::test]
    async fn test_worktree_requests_error_without_registry() {
        let server = DaemonServer::new();
        for req in [
            DaemonRequest::RepoAdd { path: "/tmp/x".into() },
            DaemonRequest::RepoList,
            DaemonRequest::WorktreeList,
            DaemonRequest::WorktreePs,
        ] {
            match server.handle_request(req) {
                DaemonResponse::Error(e) => assert!(e.contains("registry unavailable"), "got: {e}"),
                other => panic!("expected registry-unavailable error, got {other:?}"),
            }
        }
    }

    fn v3_create_request(repo_path: &Path, name: &str) -> DaemonRequest {
        DaemonRequest::WorktreeCreate {
            repo_path: repo_path.to_string_lossy().into_owned(),
            name: Some(name.into()),
            branch: None,
            base_ref: None,
            parent_worktree_id: None,
            workspace_dir: None,
            nest_workspaces: None,
            agent: None,
            prompt: None,
            command: None,
        }
    }

    fn expect_record_one(resp: DaemonResponse, what: &str) -> crate::git::worktree_registry::WorktreeRecord {
        match resp {
            DaemonResponse::WorktreeRecordOne(Some(record)) => record,
            other => panic!("expected WorktreeRecordOne for {what}, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_v3_worktree_surface_create_show_set_remove_purge_end_to_end() {
        let s = crate::git::test_support::sandbox("v3-surface");
        let server = DaemonServer::with_snapshot_storage(s.root.clone());

        // RepoAdd
        let resp = server.handle_request(DaemonRequest::RepoAdd {
            path: s.repo.to_string_lossy().into_owned(),
        });
        let repo = match resp {
            DaemonResponse::RepoRecords(repos) => repos.into_iter().next().expect("repo record"),
            other => panic!("expected RepoRecords, got {other:?}"),
        };
        assert_eq!(repo.repo_id, "repo");

        // WorktreeCreate
        let created = expect_record_one(
            server.handle_request(v3_create_request(&s.repo, "feat-a")),
            "create",
        );
        assert_eq!(created.branch, "feat-a");

        // WorktreeList shows the entry with its branch and live directory
        match server.handle_request(DaemonRequest::WorktreeList) {
            DaemonResponse::WorktreeRecords(entries) => {
                assert_eq!(entries.len(), 1);
                assert_eq!(entries[0].record.branch, "feat-a");
                assert!(!entries[0].missing_on_disk);
            }
            other => panic!("expected WorktreeRecords, got {other:?}"),
        }

        // WorktreeShow by id + WorktreeCurrent by cwd
        let shown = expect_record_one(
            server.handle_request(DaemonRequest::WorktreeShow { id: created.id.clone() }),
            "show",
        );
        assert_eq!(shown.id, created.id);
        match server.handle_request(DaemonRequest::WorktreeCurrent {
            cwd: created.path.to_string_lossy().into_owned(),
        }) {
            DaemonResponse::WorktreeRecordOne(Some(current)) => assert_eq!(current.id, created.id),
            other => panic!("expected current worktree, got {other:?}"),
        }

        // WorktreeSet persists the status change
        let updated = expect_record_one(
            server.handle_request(DaemonRequest::WorktreeSet {
                id: created.id.clone(),
                set_parent: false,
                parent_worktree_id: None,
                workspace_status: Some(crate::git::worktree_registry::WorktreeStatus::InProgress),
                display_name: Some("Feat A".into()),
            }),
            "set",
        );
        assert_eq!(
            updated.workspace_status,
            crate::git::worktree_registry::WorktreeStatus::InProgress
        );
        assert_eq!(
            crate::git::worktrees::worktree_show(&s.root.join("worktrees.json"), &created.id)
                .unwrap()
                .workspace_status,
            crate::git::worktree_registry::WorktreeStatus::InProgress
        );

        // Remove is gated while a live session sits inside the worktree
        let session_id = "wt-live-session";
        let attach = server.handle_request(DaemonRequest::CreateOrAttach {
            session_id: session_id.into(),
            cols: 80,
            rows: 24,
            cwd: Some(created.path.to_string_lossy().into_owned()),
            shell: None,
            resume_agents: false,
            worktree_id: None,
            extra_env: Vec::new(),
        });
        assert!(matches!(attach, DaemonResponse::SessionAttached(_)));
        let blocked = server.handle_request(DaemonRequest::WorktreeRemove {
            id: created.id.clone(),
            force: false,
            delete_branch: false,
        });
        match blocked {
            DaemonResponse::Error(e) => {
                assert!(e.contains(session_id), "error must name the session: {e}");
            }
            other => panic!("expected blocked removal, got {other:?}"),
        }

        // With the session gone, removal tombstones and purge drops the record
        assert_eq!(
            server.handle_request(DaemonRequest::Kill { session_id: session_id.into() }),
            DaemonResponse::Ok
        );
        assert_eq!(
            server.handle_request(DaemonRequest::WorktreeRemove {
                id: created.id.clone(),
                force: false,
                delete_branch: false,
            }),
            DaemonResponse::Ok
        );
        let tombstone = expect_record_one(
            server.handle_request(DaemonRequest::WorktreeShow { id: created.id.clone() }),
            "tombstone show",
        );
        assert!(tombstone.retired);

        assert_eq!(
            server.handle_request(DaemonRequest::WorktreePurge { id: created.id.clone() }),
            DaemonResponse::Ok
        );
        match server.handle_request(DaemonRequest::WorktreeShow { id: created.id.clone() }) {
            DaemonResponse::Error(e) => assert!(e.contains("not found"), "got: {e}"),
            other => panic!("expected purged record to be gone, got {other:?}"),
        }
    }

    // ---- task 12: worktree create --agent full handoff ----

    #[test]
    fn handoff_validation_rejects_conflicts_and_orphan_prompts() {
        assert_eq!(
            DaemonServer::validate_handoff(Some("claude"), Some("p"), None),
            Ok(())
        );
        assert_eq!(
            DaemonServer::validate_handoff(None, Some("p"), Some("x")),
            Ok(())
        );
        match DaemonServer::validate_handoff(Some("claude"), None, Some("x")) {
            Err(msg) => assert!(msg.contains("mutually exclusive"), "{msg}"),
            Ok(()) => panic!("agent+command must be rejected"),
        }
        match DaemonServer::validate_handoff(None, Some("p"), None) {
            Err(msg) => assert!(msg.contains("--prompt requires"), "{msg}"),
            Ok(()) => panic!("prompt without target must be rejected"),
        }
        assert_eq!(DaemonServer::validate_handoff(None, None, None), Ok(()));
    }

    #[test]
    fn unknown_agent_id_errors_and_generic_command_becomes_launch_profile() {
        match DaemonServer::resolve_handoff_profile(Some("not-an-agent"), None) {
            Err(msg) => assert!(msg.contains("unknown agent: not-an-agent"), "{msg}"),
            Ok(_) => panic!("unknown id must fail"),
        }
        let profile = DaemonServer::resolve_handoff_profile(None, Some("mytool --fast")).unwrap();
        assert_eq!(profile.command, "mytool");
        let argv = build_launch_command(profile, Some("do it"));
        assert_eq!(argv, vec!["mytool", "--fast", "do it"]);
    }

    #[test]
    fn path_miss_names_the_missing_executable() {
        let profile = DaemonServer::generic_profile("definitely-not-a-tool-xyz");
        match DaemonServer::ensure_executable(profile) {
            Err(msg) => assert_eq!(
                msg,
                "agent executable not found on PATH: definitely-not-a-tool-xyz"
            ),
            Ok(()) => panic!("garbage command must fail resolution"),
        }
    }

    #[tokio::test]
    async fn agent_handoff_creates_worktree_spawns_bound_session_with_env() {
        let s = crate::git::test_support::sandbox("handoff-unit");
        std::env::set_var("OPPA_SKIP_HOOK_INSTALL", "1");
        let server = DaemonServer::with_snapshot_storage(s.root.clone());
        server.handle_request(DaemonRequest::RepoAdd {
            path: s.repo.to_string_lossy().into_owned(),
        });

        let program = if cfg!(windows) { "cmd.exe /c exit" } else { "/bin/sh -c true" };
        let req = DaemonRequest::WorktreeCreate {
            repo_path: s.repo.to_string_lossy().into_owned(),
            name: Some("agentized".into()),
            branch: None,
            base_ref: None,
            parent_worktree_id: None,
            workspace_dir: None,
            nest_workspaces: None,
            agent: None,
            prompt: Some("hello".into()),
            command: Some(program.into()),
        };
        let (record, session_id) = match server.handle_request(req) {
            DaemonResponse::AgentHandoff { record, session_id } => (record, session_id),
            other => panic!("expected AgentHandoff, got {other:?}"),
        };
        assert!(session_id.starts_with("agent-"));
        assert_eq!(record.branch, "agentized");

        // The handle IS the terminal identity: listed and attachable
        match server.handle_request(DaemonRequest::ListSessions) {
            DaemonResponse::SessionList(ids) => assert!(ids.contains(&session_id), "{ids:?}"),
            other => panic!("expected SessionList, got {other:?}"),
        }
        let session = {
            let sessions = server.sessions.lock();
            sessions.get(&session_id).expect("registered").clone()
        };
        assert_eq!(session.worktree_id(), Some(record.id.as_str()));
        assert!(
            session
                .env_bindings()
                .iter()
                .any(|(k, v)| k == "OPPA_AGENT_ID" && v == "generic"),
            "pane must carry OPPA_AGENT_ID: {:?}",
            session.env_bindings()
        );
        assert_eq!(
            server.handle_request(DaemonRequest::Kill { session_id }),
            DaemonResponse::Ok
        );
    }

    #[tokio::test]
    async fn test_successful_mutations_publish_worktree_changed_events() {
        use crate::git::worktree_registry::WorktreeStatus;

        let s = crate::git::test_support::sandbox("v3-events");
        let server = DaemonServer::with_snapshot_storage(s.root.clone());
        let mut rx = server.subscribe_global_events();

        let created = expect_record_one(
            server.handle_request(v3_create_request(&s.repo, "evented")),
            "create",
        );
        async fn next_changed_id(rx: &mut broadcast::Receiver<DaemonEvent>) -> Option<String> {
            let deadline = Instant::now() + Duration::from_secs(2);
            while Instant::now() < deadline {
                match tokio::time::timeout(Duration::from_millis(300), rx.recv()).await {
                    Ok(Ok(DaemonEvent::WorktreeChanged { id })) => return id,
                    Ok(_) | Err(_) => continue,
                }
            }
            None
        }

        assert_eq!(
            next_changed_id(&mut rx).await.as_deref(),
            Some(created.id.as_str()),
            "create must publish WorktreeChanged"
        );

        server.handle_request(DaemonRequest::WorktreeSet {
            id: created.id.clone(),
            set_parent: false,
            parent_worktree_id: None,
            workspace_status: Some(WorktreeStatus::Completed),
            display_name: None,
        });
        assert_eq!(
            next_changed_id(&mut rx).await.as_deref(),
            Some(created.id.as_str()),
            "set must publish WorktreeChanged"
        );

        server.handle_request(DaemonRequest::WorktreeRemove {
            id: created.id.clone(),
            force: false,
            delete_branch: false,
        });
        assert_eq!(
            next_changed_id(&mut rx).await.as_deref(),
            Some(created.id.as_str()),
            "remove must publish WorktreeChanged"
        );

        // Read-only requests never publish
        let _ = server.handle_request(DaemonRequest::WorktreeList);
        assert!(next_changed_id(&mut rx).await.is_none(), "list must stay silent");
    }

    #[tokio::test]
    async fn test_shutdown_removes_runtime_metadata_file() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        runtime_metadata::write_runtime_metadata(temp_dir.path(), "/tmp/pipe", "tok").unwrap();
        assert!(runtime_metadata::metadata_path(temp_dir.path()).exists());

        let server = DaemonServer::with_snapshot_storage(temp_dir.path().to_path_buf());
        assert_eq!(server.handle_request(DaemonRequest::Shutdown), DaemonResponse::Ok);
        assert!(!runtime_metadata::metadata_path(temp_dir.path()).exists());
    }

    #[tokio::test]
    async fn test_pipe_level_v3_repo_add_create_list_roundtrip_with_event_fanout() {
        let s = crate::git::test_support::sandbox("v3-pipe");
        let server = Arc::new(DaemonServer::with_snapshot_storage(s.root.clone()));
        let cancel_token = CancellationToken::new();

        #[cfg(target_os = "windows")]
        let socket_path = format!(
            r"\\.\pipe\oppa-test-v3-{}",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        );
        #[cfg(not(target_os = "windows"))]
        let socket_path = format!(
            "/tmp/oppa-test-v3-{}.sock",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        );

        let srv_clone = Arc::clone(&server);
        let cancel_clone = cancel_token.clone();
        let path_clone = socket_path.clone();
        tokio::spawn(async move {
            let _ = srv_clone.run_listener(&path_clone, cancel_clone).await;
        });
        tokio::time::sleep(Duration::from_millis(150)).await;

        #[cfg(target_os = "windows")]
        let client_stream = {
            use tokio::net::windows::named_pipe::ClientOptions;
            let mut client = None;
            for _ in 0..20 {
                if let Ok(c) = ClientOptions::new().open(&socket_path) {
                    client = Some(c);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            client.expect("connect named pipe")
        };
        #[cfg(not(target_os = "windows"))]
        let client_stream = {
            use tokio::net::UnixStream;
            let mut client = None;
            for _ in 0..20 {
                if let Ok(c) = UnixStream::connect(&socket_path).await {
                    client = Some(c);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            client.expect("connect unix socket")
        };

        let (read_half, mut write_half) = tokio::io::split(client_stream);
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();

        let send = |req: &DaemonRequest| {
            let mut json = serde_json::to_string(req).unwrap();
            json.push('\n');
            json
        };

        write_half.write_all(send(&hello(None)).as_bytes()).await.unwrap();
        line.clear();
        reader.read_line(&mut line).await.unwrap();
        assert!(matches!(
            serde_json::from_str::<DaemonResponse>(line.trim()).unwrap(),
            DaemonResponse::HelloOk { .. }
        ));

        write_half
            .write_all(send(&DaemonRequest::RepoAdd {
                path: s.repo.to_string_lossy().into_owned(),
            }).as_bytes())
            .await
            .unwrap();
        line.clear();
        reader.read_line(&mut line).await.unwrap();
        assert!(matches!(
            serde_json::from_str::<DaemonResponse>(line.trim()).unwrap(),
            DaemonResponse::RepoRecords(_)
        ));

        // Create over the pipe; the response frame precedes the broadcast event on this stream
        write_half.write_all(send(&v3_create_request(&s.repo, "feat-pipe")).as_bytes()).await.unwrap();
        let mut created_id = String::new();
        let mut saw_event = false;
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            line.clear();
            if reader.read_line(&mut line).await.unwrap() == 0 {
                break;
            }
            if let Ok(resp) = serde_json::from_str::<DaemonResponse>(line.trim()) {
                if let DaemonResponse::WorktreeRecordOne(Some(record)) = resp {
                    created_id = record.id.clone();
                    assert_eq!(record.branch, "feat-pipe");
                    continue;
                }
            }
            if let Ok(DaemonEvent::WorktreeChanged { id: Some(ref id) }) =
                serde_json::from_str::<DaemonEvent>(line.trim())
            {
                if !created_id.is_empty() && *id == created_id {
                    saw_event = true;
                    break;
                }
            }
        }
        assert!(!created_id.is_empty(), "create response never arrived");
        assert!(saw_event, "WorktreeChanged never fanned out to the client stream");

        // List over the pipe reflects the new worktree
        write_half.write_all(send(&DaemonRequest::WorktreeList).as_bytes()).await.unwrap();
        line.clear();
        reader.read_line(&mut line).await.unwrap();
        match serde_json::from_str::<DaemonResponse>(line.trim()).unwrap() {
            DaemonResponse::WorktreeRecords(entries) => {
                assert_eq!(entries.len(), 1);
                assert_eq!(entries[0].record.branch, "feat-pipe");
            }
            other => panic!("expected WorktreeRecords, got {other:?}"),
        }

        cancel_token.cancel();
    }

    // ---- session title sync ----

    fn spawn_bare_session(server: &DaemonServer, id: &str) {
        match server.handle_request(DaemonRequest::CreateOrAttach {
            session_id: id.into(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: None,
            resume_agents: false,
            worktree_id: None,
            extra_env: Vec::new(),
        }) {
            DaemonResponse::SessionAttached(_) => {}
            other => panic!("expected SessionAttached, got {other:?}"),
        }
    }

    #[test]
    fn set_session_title_rejects_empty_and_unknown_sessions() {
        let server = DaemonServer::new();
        // Empty after sanitize wins over the existence check
        assert_eq!(
            server.handle_request(DaemonRequest::SetSessionTitle {
                session_id: "ghost".into(),
                title: "  \x07 ".into(),
            }),
            DaemonResponse::Error("title required".into())
        );
        assert_eq!(
            server.handle_request(DaemonRequest::SetSessionTitle {
                session_id: "ghost".into(),
                title: "valid".into(),
            }),
            DaemonResponse::Error("session not found".into())
        );
        assert_eq!(
            server.handle_request(DaemonRequest::RequestSessionFocus {
                session_id: "ghost".into(),
            }),
            DaemonResponse::Error("session not found".into())
        );
    }

    #[tokio::test]
    async fn set_session_title_sanitizes_stores_and_publishes() {
        let server = DaemonServer::new();
        spawn_bare_session(&server, "titled");
        let mut rx = server.subscribe_global_events();

        assert_eq!(
            server.handle_request(DaemonRequest::SetSessionTitle {
                session_id: "titled".into(),
                title: "\x07 My Tab \n".into(),
            }),
            DaemonResponse::Ok
        );

        let session = server.sessions.lock().get("titled").cloned().expect("live");
        assert_eq!(
            session.title().as_deref(),
            Some("My Tab"),
            "sanitized title must be stored on the session"
        );
        match tokio::time::timeout(Duration::from_millis(500), rx.recv()).await {
            Ok(Ok(DaemonEvent::TitleChanged { session_id, title })) => {
                assert_eq!(session_id, "titled");
                assert_eq!(title, "My Tab");
            }
            other => panic!("expected TitleChanged broadcast, got {other:?}"),
        }

        assert_eq!(
            server.handle_request(DaemonRequest::RequestSessionFocus {
                session_id: "titled".into(),
            }),
            DaemonResponse::Ok
        );
        match tokio::time::timeout(Duration::from_millis(500), rx.recv()).await {
            Ok(Ok(DaemonEvent::SessionFocusRequested { session_id })) => {
                assert_eq!(session_id, "titled");
            }
            other => panic!("expected SessionFocusRequested broadcast, got {other:?}"),
        }
        let _ = server.handle_request(DaemonRequest::Kill {
            session_id: "titled".into(),
        });
    }

    #[tokio::test]
    async fn test_pipe_level_set_session_title_fans_out_to_second_client() {
        let server = Arc::new(DaemonServer::new());
        let cancel_token = CancellationToken::new();

        #[cfg(target_os = "windows")]
        let socket_path = format!(
            r"\\.\pipe\oppa-test-title-{}",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        );
        #[cfg(not(target_os = "windows"))]
        let socket_path = format!(
            "/tmp/oppa-test-title-{}.sock",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        );

        let srv_clone = Arc::clone(&server);
        let cancel_clone = cancel_token.clone();
        let path_clone = socket_path.clone();
        tokio::spawn(async move {
            let _ = srv_clone.run_listener(&path_clone, cancel_clone).await;
        });
        tokio::time::sleep(Duration::from_millis(150)).await;

        let send = |req: &DaemonRequest| {
            let mut json = serde_json::to_string(req).unwrap();
            json.push('\n');
            json
        };
        async fn hello_line() -> String {
            serde_json::to_string(&DaemonRequest::Hello {
                client_version: "0.0.0".into(),
                protocol_version: DAEMON_PROTOCOL_VERSION,
                auth_token: None,
            })
            .unwrap()
            + "\n"
        }

        // Client A creates the session
        #[cfg(target_os = "windows")]
        let client_a = {
            use tokio::net::windows::named_pipe::ClientOptions;
            let mut client = None;
            for _ in 0..20 {
                if let Ok(c) = ClientOptions::new().open(&socket_path) {
                    client = Some(c);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            client.expect("connect client A")
        };
        #[cfg(not(target_os = "windows"))]
        let client_a = {
            use tokio::net::UnixStream;
            let mut client = None;
            for _ in 0..20 {
                if let Ok(c) = UnixStream::connect(&socket_path).await {
                    client = Some(c);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            client.expect("connect client A")
        };

        let (read_a, mut write_a) = tokio::io::split(client_a);
        let mut reader_a = BufReader::new(read_a);
        write_a.write_all(hello_line().await.as_bytes()).await.unwrap();
        let mut line = String::new();
        reader_a.read_line(&mut line).await.unwrap();
        write_a
            .write_all(send(&DaemonRequest::CreateOrAttach {
                session_id: "title-pipe-sess".into(),
                cols: 80,
                rows: 24,
                cwd: None,
                shell: None,
                resume_agents: false,
                worktree_id: None,
                extra_env: Vec::new(),
            })
            .as_bytes())
            .await
            .unwrap();
        assert!(matches!(
            read_response(&mut reader_a, &mut line).await,
            DaemonResponse::SessionAttached(_)
        ));

        // Second connected client renames it
        #[cfg(target_os = "windows")]
        let client_b = {
            use tokio::net::windows::named_pipe::ClientOptions;
            let mut client = None;
            for _ in 0..20 {
                if let Ok(c) = ClientOptions::new().open(&socket_path) {
                    client = Some(c);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            client.expect("connect client B")
        };
        #[cfg(not(target_os = "windows"))]
        let client_b = {
            use tokio::net::UnixStream;
            let mut client = None;
            for _ in 0..20 {
                if let Ok(c) = UnixStream::connect(&socket_path).await {
                    client = Some(c);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            client.expect("connect client B")
        };

        let (read_b, mut write_b) = tokio::io::split(client_b);
        let mut reader_b = BufReader::new(read_b);
        write_b.write_all(hello_line().await.as_bytes()).await.unwrap();
        line.clear();
        reader_b.read_line(&mut line).await.unwrap();
        write_b
            .write_all(send(&DaemonRequest::SetSessionTitle {
                session_id: "title-pipe-sess".into(),
                title: "build".into(),
            })
            .as_bytes())
            .await
            .unwrap();

        // B sees its own Ok response frame followed by the broadcast event
        let mut saw_ok_on_b = false;
        let mut saw_event_on_b = false;
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && !(saw_ok_on_b && saw_event_on_b) {
            line.clear();
            if reader_b.read_line(&mut line).await.unwrap() == 0 {
                break;
            }
            if matches!(
                serde_json::from_str::<DaemonResponse>(line.trim()).unwrap_or(DaemonResponse::Error(String::new())),
                DaemonResponse::Ok
            ) {
                saw_ok_on_b = true;
            }
            if let Ok(DaemonEvent::TitleChanged { ref title, .. }) =
                serde_json::from_str::<DaemonEvent>(line.trim())
            {
                assert_eq!(title, "build");
                saw_event_on_b = true;
            }
        }
        assert!(saw_ok_on_b, "rename response never reached client B");
        assert!(saw_event_on_b, "TitleChanged never fanned out to client B");

        // A (the other attached client) observes the same broadcast
        let mut saw_event_on_a = false;
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            line.clear();
            if reader_a.read_line(&mut line).await.unwrap() == 0 {
                break;
            }
            if let Ok(DaemonEvent::TitleChanged { ref title, .. }) =
                serde_json::from_str::<DaemonEvent>(line.trim())
            {
                assert_eq!(title, "build");
                saw_event_on_a = true;
                break;
            }
        }
        assert!(saw_event_on_a, "TitleChanged never reached the first client");

        cancel_token.cancel();
    }

    #[tokio::test]
    async fn test_worktree_bound_pane_blocks_removal_by_id_without_cwd() {
        let s = crate::git::test_support::sandbox("v3-bind-id");
        let server = DaemonServer::with_snapshot_storage(s.root.clone());

        match server.handle_request(DaemonRequest::RepoAdd {
            path: s.repo.to_string_lossy().into_owned(),
        }) {
            DaemonResponse::RepoRecords(repos) => assert_eq!(repos.len(), 1),
            other => panic!("expected RepoRecords, got {other:?}"),
        }
        let created = expect_record_one(
            server.handle_request(v3_create_request(&s.repo, "bound")),
            "create",
        );

        // cwd: None — only the id-match gate can block removal
        match server.handle_request(DaemonRequest::CreateOrAttach {
            session_id: "bound-pane".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: None,
            resume_agents: false,
            worktree_id: Some(created.id.clone()),
            extra_env: vec![("MY_TOOL_FLAG".to_string(), "verbose".to_string())],
        }) {
            DaemonResponse::SessionAttached(res) => assert!(res.is_new),
            other => panic!("expected SessionAttached, got {other:?}"),
        }

        let session = server
            .sessions()
            .lock()
            .get("bound-pane")
            .cloned()
            .expect("session live");
        assert_eq!(session.worktree_id(), Some(created.id.as_str()));
        assert_eq!(
            session.env_bindings(),
            &[
                ("OPPA_WORKTREE_ID".to_string(), created.id.clone()),
                ("OPPA_WORKTREE_BRANCH".to_string(), created.branch.clone()),
                (
                    "OPPA_WORKTREE_PATH".to_string(),
                    created.path.to_string_lossy().into_owned()
                ),
                ("OPPA_TAB_ID".to_string(), "bound-pane".to_string()),
                ("MY_TOOL_FLAG".to_string(), "verbose".to_string()),
            ]
        );

        match server.handle_request(DaemonRequest::WorktreePs) {
            DaemonResponse::WorktreePsEntries(entries) => {
                let entry = entries
                    .iter()
                    .find(|e| e.record.id == created.id)
                    .expect("ps entry for bound worktree");
                assert_eq!(entry.live_sessions, 1, "id-match must count the pane");
            }
            other => panic!("expected WorktreePsEntries, got {other:?}"),
        }

        match server.handle_request(DaemonRequest::WorktreeRemove {
            id: created.id.clone(),
            force: false,
            delete_branch: false,
        }) {
            DaemonResponse::Error(e) => assert!(e.contains("bound-pane"), "got: {e}"),
            other => panic!("expected blocked removal, got {other:?}"),
        }
        assert_eq!(
            server.handle_request(DaemonRequest::Kill {
                session_id: "bound-pane".into()
            }),
            DaemonResponse::Ok
        );
        assert_eq!(
            server.handle_request(DaemonRequest::WorktreeRemove {
                id: created.id.clone(),
                force: false,
                delete_branch: false,
            }),
            DaemonResponse::Ok
        );
    }

    #[tokio::test]
    async fn test_unknown_requested_worktree_id_errors_before_spawn() {
        let s = crate::git::test_support::sandbox("v3-bind-miss");
        let server = DaemonServer::with_snapshot_storage(s.root.clone());

        match server.handle_request(DaemonRequest::CreateOrAttach {
            session_id: "miss-pane".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: None,
            resume_agents: false,
            worktree_id: Some("repo::C:/ws/ghost".into()),
            extra_env: Vec::new(),
        }) {
            DaemonResponse::Error(e) => {
                assert!(e.contains("worktree not found"), "got: {e}");
                assert!(e.contains("repo::C:/ws/ghost"), "got: {e}");
            }
            other => panic!("expected not-found error, got {other:?}"),
        }
        assert!(server.sessions().lock().is_empty(), "nothing spawned");
    }

    #[tokio::test]
    async fn test_cold_restore_rebuilds_worktree_binding_from_checkpoint() {
        let s = crate::git::test_support::sandbox("v3-bind-cold");
        let server = DaemonServer::with_snapshot_storage(s.root.clone());

        assert!(matches!(
            server.handle_request(DaemonRequest::RepoAdd {
                path: s.repo.to_string_lossy().into_owned(),
            }),
            DaemonResponse::RepoRecords(_)
        ));
        let created = expect_record_one(
            server.handle_request(v3_create_request(&s.repo, "feat-cold")),
            "create",
        );

        let storage = SnapshotStorage::new(s.root.clone());
        storage
            .save_snapshot(&SessionSnapshot {
                session_id: "cold-wt".into(),
                cwd: String::new(),
                title: None,
                cols: 80,
                rows: 24,
                persona_id: None,
                scrollback: "old screen".into(),
                timestamp: 1,
                foreground_command: None,
                agent_session: None,
                worktree_id: Some(created.id.clone()),
            })
            .expect("seed checkpoint");

        // No request.worktree_id: the checkpoint restores the binding
        match server.handle_request(DaemonRequest::CreateOrAttach {
            session_id: "cold-wt".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: None,
            resume_agents: false,
            worktree_id: None,
            extra_env: Vec::new(),
        }) {
            DaemonResponse::SessionAttached(res) => assert!(res.is_new),
            other => panic!("expected SessionAttached, got {other:?}"),
        }

        let session = server
            .sessions()
            .lock()
            .get("cold-wt")
            .cloned()
            .expect("cold-restored session live");
        assert_eq!(session.worktree_id(), Some(created.id.as_str()));
        let bindings = session.env_bindings();
        assert!(bindings.contains(&("OPPA_WORKTREE_ID".to_string(), created.id.clone())));
        assert!(bindings.contains(&("OPPA_TAB_ID".to_string(), "cold-wt".to_string())));
        assert!(bindings.contains(&(
            "OPPA_WORKTREE_BRANCH".to_string(),
            created.branch.clone()
        )));

        // And the restored identity alone gates teardown
        match server.handle_request(DaemonRequest::WorktreeRemove {
            id: created.id.clone(),
            force: false,
            delete_branch: false,
        }) {
            DaemonResponse::Error(e) => assert!(e.contains("cold-wt"), "got: {e}"),
            other => panic!("expected blocked removal, got {other:?}"),
        }
        let _ = server.handle_request(DaemonRequest::Kill {
            session_id: "cold-wt".into(),
        });
    }

    // ---- v4 source-control surface ----

    #[test]
    fn test_v4_git_and_comment_requests_error_without_registry() {
        let server = DaemonServer::new();
        let git_requests = vec![
            DaemonRequest::GitStatus { cwd: "/r".into() },
            DaemonRequest::GitStage {
                cwd: "/r".into(),
                paths: vec![],
            },
            DaemonRequest::GitUnstage {
                cwd: "/r".into(),
                paths: vec![],
            },
            DaemonRequest::GitDiscard {
                cwd: "/r".into(),
                paths: vec![],
                include_untracked: false,
            },
            DaemonRequest::GitCommit {
                cwd: "/r".into(),
                message: "m".into(),
            },
            DaemonRequest::GitLocalBranches { cwd: "/r".into() },
            DaemonRequest::GitCheckout {
                cwd: "/r".into(),
                branch: "main".into(),
            },
            DaemonRequest::GitFileDiff {
                cwd: "/r".into(),
                path: "p".into(),
                staged: false,
                compare_against_head: false,
            },
            DaemonRequest::GitHistory { cwd: "/r".into(), limit: None },
            DaemonRequest::GitBranchCompare {
                cwd: "/r".into(),
                base_ref: "main".into(),
            },
            DaemonRequest::GitFetch { cwd: "/r".into() },
            DaemonRequest::GitPull { cwd: "/r".into(), ff_only: true },
            DaemonRequest::GitFastForward { cwd: "/r".into() },
            DaemonRequest::GitPush {
                cwd: "/r".into(),
                publish: false,
                force_with_lease: false,
            },
            DaemonRequest::GitUpstreamRefresh { cwd: "/r".into() },
            DaemonRequest::DiffCommentsList { worktree_id: "w".into() },
        ];
        for req in git_requests {
            match server.handle_request(req) {
                DaemonResponse::Error(e) => assert!(e.contains("registry unavailable"), "got: {e}"),
                other => panic!("expected registry-unavailable error, got {other:?}"),
            }
        }
    }

    fn sample_new_comment(worktree_id: &str, line: u32, body: &str) -> DaemonRequest {
        DaemonRequest::DiffCommentAdd {
            comment: crate::git::comments_store::NewDiffComment {
                worktree_id: worktree_id.into(),
                file_path: "src/lib.rs".into(),
                source: crate::git::comments_store::DiffCommentSource::Diff,
                selected_text: None,
                start_line: Some(line),
                line_number: line,
                body: body.into(),
                scope: crate::git::comments_store::DiffCommentScope::Unstaged,
                old_path: None,
            },
        }
    }

    fn expect_comment_one(resp: DaemonResponse, what: &str) -> crate::git::comments_store::DiffComment {
        match resp {
            DaemonResponse::CommentRecordOne(record) => record,
            other => panic!("expected CommentRecordOne for {what}, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_v4_comment_crud_validation_marksent_and_delete_over_handlers() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let server = DaemonServer::with_snapshot_storage(temp_dir.path().to_path_buf());
        let mut rx = server.subscribe_global_events();

        // Validation rejects never touch the store nor broadcast
        for bad in [
            sample_new_comment("", 1, "body"),
            sample_new_comment("wt", 0, "body"),
            sample_new_comment("wt", 1, "  "),
        ] {
            match server.handle_request(bad) {
                DaemonResponse::Error(_) => {}
                other => panic!("expected validation error, got {other:?}"),
            }
        }

        let added = expect_comment_one(
            server.handle_request(sample_new_comment("wt-a", 12, "why here?")),
            "add",
        );
        assert!(!added.id.is_empty());
        assert!(added.created_at_ms > 0);
        assert_eq!(
            next_git_changed(&mut rx).await,
            true,
            "add must publish GitChanged"
        );

        let updated = expect_comment_one(
            server.handle_request(DaemonRequest::DiffCommentUpdate {
                id: added.id.clone(),
                body: "edited".into(),
            }),
            "update",
        );
        assert_eq!(updated.body, "edited");
        assert!(updated.updated_at_ms.unwrap_or(0) >= added.created_at_ms);

        let stamped = match server.handle_request(DaemonRequest::DiffCommentsMarkSent {
            ids: vec![added.id.clone()],
        }) {
            DaemonResponse::CommentRecords(records) => records,
            other => panic!("expected CommentRecords from mark-sent, got {other:?}"),
        };
        assert_eq!(stamped.len(), 1);
        assert!(stamped[0].sent_at.unwrap_or(0) > 0);

        // List reflects the full roundtrip before deletion
        match server.handle_request(DaemonRequest::DiffCommentsList {
            worktree_id: "wt-a".into(),
        }) {
            DaemonResponse::CommentRecords(records) => {
                assert_eq!(records.len(), 1);
                assert_eq!(records[0].body, "edited");
                assert!(records[0].sent_at.is_some());
            }
            other => panic!("expected CommentRecords list, got {other:?}"),
        }

        assert_eq!(
            server.handle_request(DaemonRequest::DiffCommentDelete { id: added.id }),
            DaemonResponse::Ok
        );
        match server.handle_request(DaemonRequest::DiffCommentsList {
            worktree_id: "wt-a".into(),
        }) {
            DaemonResponse::CommentRecords(records) => assert!(records.is_empty()),
            other => panic!("expected empty list after delete, got {other:?}"),
        }
        // Unknown-id ops surface daemon errors, not panics
        assert!(matches!(
            server.handle_request(DaemonRequest::DiffCommentUpdate {
                id: "ghost".into(),
                body: "x".into()
            }),
            DaemonResponse::Error(_)
        ));
    }

    async fn next_git_changed(rx: &mut broadcast::Receiver<DaemonEvent>) -> bool {
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {
                Ok(Ok(DaemonEvent::GitChanged)) => return true,
                Ok(_) | Err(_) => continue,
            }
        }
        false
    }

    #[test]
    fn test_v4_comments_persist_across_daemon_restart_on_same_snapshot_dir() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let added = {
            let server = DaemonServer::with_snapshot_storage(temp_dir.path().to_path_buf());
            expect_comment_one(
                server.handle_request(sample_new_comment("wt-persist", 3, "survives")),
                "add",
            )
        };

        // A fresh daemon on the same snapshot_dir reads the same diff-comments.json
        let rebooted = DaemonServer::with_snapshot_storage(temp_dir.path().to_path_buf());
        match rebooted.handle_request(DaemonRequest::DiffCommentsList {
            worktree_id: "wt-persist".into(),
        }) {
            DaemonResponse::CommentRecords(records) => {
                assert_eq!(records.len(), 1);
                assert_eq!(records[0].id, added.id);
            }
            other => panic!("expected persisted comment after restart, got {other:?}"),
        }
    }

    #[test]
    fn test_v4_git_status_history_branches_flow_through_handlers() {
        let s = crate::git::test_support::sandbox("v4-git-handlers");
        std::fs::write(s.repo.join("flow.txt"), "v1").unwrap();

        let server = DaemonServer::with_snapshot_storage(s.root.clone());
        let cwd = s.repo.to_string_lossy().into_owned();

        match server.handle_request(DaemonRequest::GitStatus { cwd: cwd.clone() }) {
            DaemonResponse::ScStatus(st) => {
                let entry = st.entries.iter().find(|e| e.path == "flow.txt").unwrap();
                assert_eq!(
                    entry.area,
                    crate::git::source_control::GitArea::Untracked
                );
            }
            other => panic!("expected ScStatus, got {other:?}"),
        }

        assert_eq!(
            server.handle_request(DaemonRequest::GitStage {
                cwd: cwd.clone(),
                paths: vec!["flow.txt".into()],
            }),
            DaemonResponse::Ok
        );
        match server.handle_request(DaemonRequest::GitStatus { cwd: cwd.clone() }) {
            DaemonResponse::ScStatus(st) => {
                let entry = st.entries.iter().find(|e| e.path == "flow.txt").unwrap();
                assert_eq!(entry.area, crate::git::source_control::GitArea::Staged);
            }
            other => panic!("expected staged ScStatus, got {other:?}"),
        }

        match server.handle_request(DaemonRequest::GitCommit {
            cwd: cwd.clone(),
            message: "feat: flow commit".into(),
        }) {
            DaemonResponse::ScCommit(id) => assert!(!id.is_empty()),
            other => panic!("expected ScCommit, got {other:?}"),
        }
        // Nothing staged now
        assert!(matches!(
            server.handle_request(DaemonRequest::GitCommit {
                cwd: cwd.clone(),
                message: "empty".into(),
            }),
            DaemonResponse::Error(ref e) if e.contains("nothing to commit")
        ));

        match server.handle_request(DaemonRequest::GitHistory {
            cwd: cwd.clone(),
            limit: Some(10),
        }) {
            DaemonResponse::ScHistory(result) => {
                assert_eq!(result.items.len(), 2);
                assert_eq!(result.items[0].subject, "feat: flow commit");
            }
            other => panic!("expected ScHistory, got {other:?}"),
        }

        match server.handle_request(DaemonRequest::GitLocalBranches { cwd: cwd.clone() }) {
            DaemonResponse::ScBranches(branches) => {
                assert_eq!(branches.current.as_deref(), Some("main"));
            }
            other => panic!("expected ScBranches, got {other:?}"),
        }

        match server.handle_request(DaemonRequest::GitFileDiff {
            cwd: cwd.clone(),
            path: "README.md".into(),
            staged: false,
            compare_against_head: false,
        }) {
            DaemonResponse::ScDiff(diff) => {
                assert_eq!(
                    diff.kind,
                    crate::git::source_control::DiffKind::Text
                );
            }
            other => panic!("expected ScDiff, got {other:?}"),
        }

        match server.handle_request(DaemonRequest::GitBranchCompare {
            cwd: cwd.clone(),
            base_ref: "no-such-ref".into(),
        }) {
            DaemonResponse::Error(e) => assert!(e.contains("no-such-ref"), "{e}"),
            other => panic!("expected compare error, got {other:?}"),
        }
    }

    // Global broadcasts interleave with responses on every client stream, so
    // frame readers skip non-matching frames under a per-read timeout.
    async fn read_response_matching<R: tokio::io::AsyncBufRead + Unpin>(
        reader: &mut R,
        line: &mut String,
        pred: impl Fn(&DaemonResponse) -> bool,
    ) -> DaemonResponse {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            assert!(Instant::now() < deadline, "timed out waiting for response frame");
            line.clear();
            tokio::time::timeout(Duration::from_secs(2), reader.read_line(line))
                .await
                .expect("frame within timeout")
                .unwrap();
            if let Ok(resp) = serde_json::from_str::<DaemonResponse>(line.trim()) {
                if pred(&resp) {
                    return resp;
                }
            }
        }
    }

    async fn read_event_matching<R: tokio::io::AsyncBufRead + Unpin>(
        reader: &mut R,
        line: &mut String,
        pred: impl Fn(&DaemonEvent) -> bool,
    ) -> DaemonEvent {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            assert!(Instant::now() < deadline, "timed out waiting for event frame");
            line.clear();
            tokio::time::timeout(Duration::from_secs(2), reader.read_line(line))
                .await
                .expect("frame within timeout")
                .unwrap();
            if let Ok(event) = serde_json::from_str::<DaemonEvent>(line.trim()) {
                if pred(&event) {
                    return event;
                }
            }
        }
    }

    #[tokio::test]
    async fn test_pipe_level_v4_git_status_stage_commit_with_git_changed_fanout() {        let s = crate::git::test_support::sandbox("v4-pipe-git");
        std::fs::write(s.repo.join("pipe.txt"), "v1").unwrap();
        let server = Arc::new(DaemonServer::with_snapshot_storage(s.root.clone()));
        let cancel_token = CancellationToken::new();

        #[cfg(target_os = "windows")]
        let socket_path = format!(
            r"\\.\pipe\oppa-test-v4git-{}",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        );
        #[cfg(not(target_os = "windows"))]
        let socket_path = format!(
            "/tmp/oppa-test-v4git-{}.sock",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        );

        let srv_clone = Arc::clone(&server);
        let cancel_clone = cancel_token.clone();
        let path_clone = socket_path.clone();
        tokio::spawn(async move {
            let _ = srv_clone.run_listener(&path_clone, cancel_clone).await;
        });
        tokio::time::sleep(Duration::from_millis(150)).await;

        let open_client = || async {
            #[cfg(target_os = "windows")]
            {
                use tokio::net::windows::named_pipe::ClientOptions;
                let mut client = None;
                for _ in 0..20 {
                    if let Ok(c) = ClientOptions::new().open(&socket_path) {
                        client = Some(c);
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                client.expect("connect named pipe")
            }
            #[cfg(not(target_os = "windows"))]
            {
                use tokio::net::UnixStream;
                let mut client = None;
                for _ in 0..20 {
                    if let Ok(c) = UnixStream::connect(&socket_path).await {
                        client = Some(c);
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
                client.expect("connect unix socket")
            }
        };

        // Peer listener observes GitChanged; mutator drives the real workflow.
        let (listener_read, mut listener_write) = tokio::io::split(open_client().await);
        let mut listener_reader = BufReader::new(listener_read);
        let (mutator_read, mut mutator_write) = tokio::io::split(open_client().await);
        let mut mutator_reader = BufReader::new(mutator_read);

        let hello_json = serde_json::to_string(&hello(None)).unwrap() + "\n";
        listener_write.write_all(hello_json.as_bytes()).await.unwrap();
        let mut line = String::new();
        listener_reader.read_line(&mut line).await.unwrap();
        assert!(matches!(
            serde_json::from_str::<DaemonResponse>(line.trim()).unwrap(),
            DaemonResponse::HelloOk { .. }
        ));
        mutator_write.write_all(hello_json.as_bytes()).await.unwrap();
        line.clear();
        mutator_reader.read_line(&mut line).await.unwrap();

        let send = |req: &DaemonRequest| serde_json::to_string(req).unwrap() + "\n";
        let cwd = s.repo.to_string_lossy().into_owned();

        // status → untracked entry over the wire
        mutator_write
            .write_all(send(&DaemonRequest::GitStatus { cwd: cwd.clone() }).as_bytes())
            .await
            .unwrap();
        let area_of = |resp: &DaemonResponse, want: &str| {
            if let DaemonResponse::ScStatus(st) = resp {
                st.entries
                    .iter()
                    .find(|e| e.path == want)
                    .map(|e| e.area.clone())
            } else {
                None
            }
        };
        let resp = read_response_matching(&mut mutator_reader, &mut line, |r| {
            matches!(r, DaemonResponse::ScStatus(_))
        })
        .await;
        assert_eq!(
            area_of(&resp, "pipe.txt"),
            Some(crate::git::source_control::GitArea::Untracked)
        );

        // stage → Ok + refreshed status; the peer's stream sees GitChanged.
        // Broadcasts interleave with responses, so reads match by frame kind.
        mutator_write
            .write_all(
                send(&DaemonRequest::GitStage {
                    cwd: cwd.clone(),
                    paths: vec!["pipe.txt".into()],
                })
                .as_bytes(),
            )
            .await
            .unwrap();
        mutator_write
            .write_all(send(&DaemonRequest::GitStatus { cwd: cwd.clone() }).as_bytes())
            .await
            .unwrap();

        read_response_matching(&mut mutator_reader, &mut line, |r| {
            matches!(r, DaemonResponse::Ok)
        })
        .await;
        let staged = read_response_matching(&mut mutator_reader, &mut line, |r| {
            matches!(r, DaemonResponse::ScStatus(_))
        })
        .await;
        assert_eq!(
            area_of(&staged, "pipe.txt"),
            Some(crate::git::source_control::GitArea::Staged)
        );
        read_event_matching(&mut listener_reader, &mut line, |e| {
            matches!(e, DaemonEvent::GitChanged)
        })
        .await;

        // commit closes the loop
        mutator_write
            .write_all(
                send(&DaemonRequest::GitCommit {
                    cwd: cwd.clone(),
                    message: "feat: pipe commit".into(),
                })
                .as_bytes(),
            )
            .await
            .unwrap();
        match read_response_matching(&mut mutator_reader, &mut line, |r| {
            matches!(r, DaemonResponse::ScCommit(_))
        })
        .await
        {
            DaemonResponse::ScCommit(id) => assert!(!id.is_empty()),
            other => panic!("expected ScCommit, got {other:?}"),
        }
        mutator_write
            .write_all(send(&DaemonRequest::GitStatus { cwd }).as_bytes())
            .await
            .unwrap();
        match read_response_matching(&mut mutator_reader, &mut line, |r| {
            matches!(r, DaemonResponse::ScStatus(_))
        })
        .await
        {
            DaemonResponse::ScStatus(st) => {
                assert!(st.entries.is_empty(), "commit must clear entries: {:?}", st.entries);
            }
            other => panic!("expected clean ScStatus, got {other:?}"),
        }

        cancel_token.cancel();
    }

    // ---------- task 3: pr poller ----------

    use crate::git::hosted_reviews::{GhClient, PrStatus};
    use crate::git::test_support::sandbox_with_origin;
    use crate::git::worktree_registry::{worktree_record_id, WorktreeRecord, WorktreeStatus};

    struct MergedPrClient {
        calls: Mutex<Vec<String>>,
    }

    impl GhClient for MergedPrClient {
        fn status(&self, _cwd: &Path, url: &str) -> Result<PrStatus, String> {
            self.calls.lock().push(url.to_string());
            Ok(PrStatus {
                number: 5,
                title: "t".into(),
                url: url.into(),
                state: "merged".into(),
                draft: false,
                mergeable: "unknown".into(),
                base_ref_name: "main".into(),
                head_ref_name: "feature".into(),
                checks: vec![],
                fetched_at_ms: 0,
            })
        }
    }

    // Open state keeps the link intact so repeated bursts keep fetching (a merged
    // client would clear the link after the first pass and starve later bursts).
    struct OpenPrClient {
        calls: Mutex<Vec<String>>,
    }

    impl GhClient for OpenPrClient {
        fn status(&self, _cwd: &Path, url: &str) -> Result<PrStatus, String> {
            self.calls.lock().push(url.to_string());
            Ok(PrStatus {
                number: 5,
                title: "t".into(),
                url: url.into(),
                state: "open".into(),
                draft: false,
                mergeable: "unknown".into(),
                base_ref_name: "main".into(),
                head_ref_name: "feature".into(),
                checks: vec![],
                fetched_at_ms: 0,
            })
        }
    }

    fn register_linked_wt(registry_path: &Path, repo_id: &str, path: &Path) -> String {
        let id = worktree_record_id(repo_id, path);
        let mut registry = WorktreeRegistry::load(registry_path);
        registry.upsert_worktree(WorktreeRecord {
            id: id.clone(),
            repo_id: repo_id.into(),
            name: "wt".into(),
            display_name: None,
            branch: "feature".into(),
            path: path.to_path_buf(),
            base_ref: "main".into(),
            parent_worktree_id: None,
            child_worktree_ids: vec![],
            workspace_status: WorktreeStatus::Todo,
            retired: false,
            created_at_ms: 0,
            linked_pr_url: Some("https://github.com/o/r/pull/5".into()),
        });
        registry.save(registry_path).unwrap();
        id
    }

    async fn next_pr_changed(rx: &mut broadcast::Receiver<DaemonEvent>) -> Option<String> {
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {
                Ok(Ok(DaemonEvent::PrChanged { worktree_id })) => return worktree_id,
                Ok(_) | Err(_) => continue,
            }
        }
        panic!("PrChanged never arrived on the global broadcast");
    }

    #[tokio::test]
    async fn git_push_success_signals_poll_burst_but_errors_do_not() {
        let (s, _bare) = sandbox_with_origin("ds-push-burst");
        let server = DaemonServer::with_snapshot_storage(s.root.clone());
        let resp = server.handle_request(DaemonRequest::GitPush {
            cwd: s.repo.to_string_lossy().into_owned(),
            publish: false,
            force_with_lease: false,
        });
        assert!(matches!(resp, DaemonResponse::ScPush(_)));
        tokio::time::timeout(Duration::from_secs(2), server.pr_push_burst.notified())
            .await
            .expect("successful push must arm the poll burst");

        let bad = server.handle_request(DaemonRequest::GitPush {
            cwd: "Z:\\not-a-repo-oppa".into(),
            publish: false,
            force_with_lease: false,
        });
        assert!(matches!(bad, DaemonResponse::Error(_)));
        assert!(
            tokio::time::timeout(Duration::from_millis(150), server.pr_push_burst.notified())
                .await
                .is_err(),
            "failed push must not arm another burst"
        );
    }

    #[tokio::test]
    async fn run_pr_poll_pass_publishes_pr_changed_and_clears_merged_link() {
        let (s, _bare) = sandbox_with_origin("ds-poll-pass");
        let registry_path = s.root.join("worktrees.json");
        let id = register_linked_wt(&registry_path, "repo", &s.repo);
        let client = Arc::new(MergedPrClient { calls: Mutex::new(Vec::new()) });
        let server =
            DaemonServer::with_snapshot_storage(s.root.clone()).with_pr_client(client.clone());
        let mut rx = server.subscribe_global_events();

        assert_eq!(server.run_pr_poll_pass(), 1);
        assert_eq!(
            next_pr_changed(&mut rx).await.as_deref(),
            Some(id.as_str()),
            "pass must fan out PrChanged with the worktree id"
        );
        assert_eq!(client.calls.lock().len(), 1);
        assert!(WorktreeRegistry::load(&registry_path).worktrees[&id]
            .linked_pr_url
            .is_none());
    }

    #[tokio::test]
    async fn start_pr_poller_runs_single_immediate_pass_per_burst() {
        let (s, _bare) = sandbox_with_origin("ds-poller-loop");
        let registry_path = s.root.join("worktrees.json");
        let _id = register_linked_wt(&registry_path, "repo", &s.repo);
        let client = Arc::new(OpenPrClient { calls: Mutex::new(Vec::new()) });
        let server =
            DaemonServer::with_snapshot_storage(s.root.clone()).with_pr_client(client.clone());

        // A pre-boot permit makes the loop's first notified() resolve instantly.
        server.pr_push_burst.notify_one();
        server.start_pr_poller();

        let wait_for_calls = |target: usize| {
            let client = Arc::clone(&client);
            async move {
                let deadline = Instant::now() + Duration::from_secs(5);
                while Instant::now() < deadline {
                    if client.calls.lock().len() >= target {
                        return;
                    }
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
                panic!("poller never reached {target} gh calls");
            }
        };
        wait_for_calls(1).await;
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(client.calls.lock().len(), 1, "one burst ⇒ exactly one immediate pass");

        server.pr_push_burst.notify_one();
        wait_for_calls(2).await;
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(client.calls.lock().len(), 2, "each burst triggers exactly one pass");
    }
}
