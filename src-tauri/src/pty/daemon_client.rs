use crate::pty::ipc_protocol::{
    get_daemon_socket_path, CreateOrAttachResult, DaemonEvent, DaemonRequest, DaemonResponse,
    DAEMON_PROTOCOL_VERSION,
};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub type OnData = Box<dyn Fn(&str, &[u8]) + Send + Sync + 'static>;
pub type OnExit = Box<dyn Fn(&str, Option<i32>) + Send + Sync + 'static>;
pub type OnCwd = Box<dyn Fn(&str, &str) + Send + Sync + 'static>;

#[derive(Default)]
struct SessionCallbacks {
    on_data: Option<OnData>,
    on_exit: Option<OnExit>,
    on_cwd: Option<OnCwd>,
}

/// Client adapter connecting to the detached background daemon over IPC.
pub struct DaemonClient {
    write_tx: tokio::sync::mpsc::UnboundedSender<String>,
    request_lock: Arc<Mutex<()>>,
    callbacks: Arc<Mutex<HashMap<String, SessionCallbacks>>>,
    out_tx_map: Arc<Mutex<HashMap<String, Sender<Vec<u8>>>>>,
    exit_tx_map: Arc<Mutex<HashMap<String, Sender<Option<i32>>>>>,
    out_rx_map: Arc<Mutex<HashMap<String, Receiver<Vec<u8>>>>>,
    exit_rx_map: Arc<Mutex<HashMap<String, Receiver<Option<i32>>>>>,
    pending_response: Arc<Mutex<Option<Sender<DaemonResponse>>>>,
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
        let callbacks = Arc::new(Mutex::new(HashMap::<String, SessionCallbacks>::new()));
        let out_tx_map = Arc::new(Mutex::new(HashMap::<String, Sender<Vec<u8>>>::new()));
        let exit_tx_map = Arc::new(Mutex::new(HashMap::<String, Sender<Option<i32>>>::new()));
        let out_rx_map = Arc::new(Mutex::new(HashMap::<String, Receiver<Vec<u8>>>::new()));
        let exit_rx_map = Arc::new(Mutex::new(HashMap::<String, Receiver<Option<i32>>>::new()));
        let pending_response = Arc::new(Mutex::new(None::<Sender<DaemonResponse>>));
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
                            return Err(format!("failed to connect to named pipe {socket_path_str}: {e}"));
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
                            return Err(format!("failed to connect to unix socket {socket_path_str}: {e}"));
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
        let callbacks_clone = Arc::clone(&callbacks);
        let out_tx_map_clone = Arc::clone(&out_tx_map);
        let exit_tx_map_clone = Arc::clone(&exit_tx_map);
        let out_rx_map_clone = Arc::clone(&out_rx_map);
        let exit_rx_map_clone = Arc::clone(&exit_rx_map);
        let pending_response_clone = Arc::clone(&pending_response);

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
                                    session_id,
                                    data,
                                    ..
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
                                // Global worktree events get a client-side hook in task 9
                                DaemonEvent::WorktreeChanged { .. } => {}
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
                let _ = sender.send(DaemonResponse::Error("connection closed by daemon".to_string()));
            }
            out_rx_map_clone.lock().clear();
            exit_rx_map_clone.lock().clear();
        });

        let client = Self {
            write_tx,
            request_lock,
            callbacks,
            out_tx_map,
            exit_tx_map,
            out_rx_map,
            exit_rx_map,
            pending_response,
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

        let mut json = serde_json::to_string(&req)
            .map_err(|e| format!("failed to serialize request: {e}"))?;
        json.push('\n');

        self.write_tx
            .send(json)
            .map_err(|e| format!("failed to queue request: {e}"))?;

        let resp = rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|e| {
                *self.pending_response.lock() = None;
                format!("timed out waiting for daemon response: {e}")
            })?;

        Ok(resp)
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

        self.out_tx_map.lock().insert(session_id.to_string(), out_tx);
        self.exit_tx_map
            .lock()
            .insert(session_id.to_string(), exit_tx);
        self.out_rx_map.lock().insert(session_id.to_string(), out_rx);
        self.exit_rx_map
            .lock()
            .insert(session_id.to_string(), exit_rx);
    }

    /// Take the session's test output receiver.
    #[allow(dead_code)]
    pub fn take_output(&self, session_id: &str) -> Option<Receiver<Vec<u8>>> {
        self.out_rx_map.lock().remove(session_id)
    }

    /// Take the session's test exit receiver.
    #[allow(dead_code)]
    pub fn take_exit(&self, session_id: &str) -> Option<Receiver<Option<i32>>> {
        self.exit_rx_map.lock().remove(session_id)
    }

    /// Create a new session or reattach to an existing one in the daemon.
    pub fn create_or_attach(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
        shell: Option<String>,
        resume_agents: bool,
    ) -> Result<CreateOrAttachResult, String> {
        let req = DaemonRequest::CreateOrAttach {
            session_id: session_id.to_string(),
            cols,
            rows,
            cwd,
            shell,
            resume_agents,
            worktree_id: None,
            extra_env: Vec::new(),
        };
        match self.send_request(req)? {
            DaemonResponse::SessionAttached(res) => Ok(res),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!("unexpected response for CreateOrAttach: {other:?}")),
        }
    }

    /// Write input data to the session PTY.
    pub fn write(&self, session_id: &str, data: &str) -> Result<(), String> {
        let req = DaemonRequest::Write {
            session_id: session_id.to_string(),
            data: data.to_string(),
        };
        match self.send_request(req)? {
            DaemonResponse::Ok => Ok(()),
            DaemonResponse::Error(e) => Err(e),
            other => Err(format!("unexpected response for Write: {other:?}")),
        }
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
        let req = DaemonRequest::Ack {
            session_id: session_id.to_string(),
            chars,
        };
        let mut json = serde_json::to_string(&req)
            .map_err(|e| format!("failed to serialize ack: {e}"))?;
        json.push('\n');
        self.write_tx
            .send(json)
            .map_err(|e| format!("failed to queue ack: {e}"))?;
        Ok(())
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

    /// Request the daemon to terminate all sessions and shut down.
    #[allow(dead_code)]
    pub fn shutdown(&self) -> Result<(), String> {
        let req = DaemonRequest::Shutdown;
        match self.send_request(req) {
            Ok(DaemonResponse::Ok) => Ok(()),
            Ok(DaemonResponse::Error(e)) if e.contains("connection closed") => Ok(()),
            Ok(DaemonResponse::Error(e)) => Err(e),
            Err(e) if e.contains("connection closed") => Ok(()),
            Ok(other) => Err(format!("unexpected response for Shutdown: {other:?}")),
            Err(e) => Err(e),
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
            .create_or_attach("client-session-1", 80, 24, None, Some(sh), false)
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
        client
            .resize("client-session-1", 100, 30)
            .expect("resize");
        client.ack("client-session-1", 100).expect("ack");

        // 5. Reattach to session
        let reattach_res = client
            .create_or_attach("client-session-1", 100, 30, None, None, false)
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
            .create_or_attach("ack-test-session", 80, 24, None, Some(sh), false)
            .expect("create_or_attach");
        assert!(attach_res.is_new);

        let start = std::time::Instant::now();
        for _ in 0..1000 {
            client.ack("ack-test-session", 1024).expect("async ack should succeed");
        }
        let elapsed = start.elapsed();
        assert!(elapsed < Duration::from_secs(1), "1000 ACKs took too long: {elapsed:?}");

        let sessions = client.list_sessions().expect("list_sessions after acks");
        assert!(sessions.contains(&"ack-test-session".to_string()));

        client.kill("ack-test-session").expect("kill");
        client.disconnect().expect("disconnect");
        cancel_token.cancel();
        let _ = server_thread.join();
    }
}
