use crate::pty::daemon_session::DaemonSession;
use crate::pty::ipc_protocol::{
    CreateOrAttachResult, DaemonEvent, DaemonRequest, DaemonResponse, DAEMON_PROTOCOL_VERSION,
};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::Notify;

/// Simple cancellation token for graceful shutdown of async listeners and sessions.
#[derive(Clone, Default)]
pub struct CancellationToken {
    notify: Arc<Notify>,
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }
        self.notify.notified().await;
    }
}

/// Detached Daemon Server managing active terminal sessions and IPC request routing.
pub struct DaemonServer {
    sessions: Arc<Mutex<HashMap<String, Arc<DaemonSession>>>>,
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
        }
    }

    #[allow(dead_code)]
    pub fn sessions(&self) -> Arc<Mutex<HashMap<String, Arc<DaemonSession>>>> {
        Arc::clone(&self.sessions)
    }

    /// Dispatch a single DaemonRequest to the session registry.
    pub fn handle_request(&self, req: DaemonRequest) -> DaemonResponse {
        match req {
            DaemonRequest::Hello { .. } => DaemonResponse::HelloOk {
                protocol_version: DAEMON_PROTOCOL_VERSION,
            },
            DaemonRequest::CreateOrAttach {
                session_id,
                cols,
                rows,
                cwd,
                shell,
            } => {
                let mut sessions = self.sessions.lock();
                if let Some(session) = sessions.get(&session_id) {
                    let snapshot = session.get_snapshot();
                    DaemonResponse::SessionAttached(CreateOrAttachResult {
                        is_new: false,
                        pid: session.pid(),
                        cols: session.cols(),
                        rows: session.rows(),
                        cwd: session.cwd(),
                        snapshot: Some(snapshot),
                    })
                } else {
                    match DaemonSession::spawn(session_id.clone(), shell, cwd, cols, rows) {
                        Ok(session) => {
                            let pid = session.pid();
                            let session_cols = session.cols();
                            let session_rows = session.rows();
                            let session_cwd = session.cwd();
                            sessions.insert(session_id, Arc::clone(&session));
                            DaemonResponse::SessionAttached(CreateOrAttachResult {
                                is_new: true,
                                pid,
                                cols: session_cols,
                                rows: session_rows,
                                cwd: session_cwd,
                                snapshot: None,
                            })
                        }
                        Err(e) => DaemonResponse::Error(e),
                    }
                }
            }
            DaemonRequest::Write { session_id, data } => {
                let sessions = self.sessions.lock();
                if let Some(session) = sessions.get(&session_id) {
                    match session.write(data.as_bytes()) {
                        Ok(()) => DaemonResponse::Ok,
                        Err(e) => DaemonResponse::Error(e.to_string()),
                    }
                } else {
                    DaemonResponse::Error(format!("session {session_id} not found"))
                }
            }
            DaemonRequest::Resize {
                session_id,
                cols,
                rows,
            } => {
                let sessions = self.sessions.lock();
                if let Some(session) = sessions.get(&session_id) {
                    match session.resize(cols, rows) {
                        Ok(()) => DaemonResponse::Ok,
                        Err(e) => DaemonResponse::Error(e),
                    }
                } else {
                    DaemonResponse::Error(format!("session {session_id} not found"))
                }
            }
            DaemonRequest::Ack { session_id, chars } => {
                let sessions = self.sessions.lock();
                if let Some(session) = sessions.get(&session_id) {
                    match session.ack(chars) {
                        Ok(()) => DaemonResponse::Ok,
                        Err(e) => DaemonResponse::Error(e),
                    }
                } else {
                    DaemonResponse::Error(format!("session {session_id} not found"))
                }
            }
            DaemonRequest::Kill { session_id } => {
                let mut sessions = self.sessions.lock();
                if let Some(session) = sessions.remove(&session_id) {
                    let _ = session.kill();
                    DaemonResponse::Ok
                } else {
                    DaemonResponse::Error(format!("session {session_id} not found"))
                }
            }
            DaemonRequest::ListSessions => {
                let sessions = self.sessions.lock();
                let keys: Vec<String> = sessions.keys().cloned().collect();
                DaemonResponse::SessionList(keys)
            }
            DaemonRequest::Disconnect => DaemonResponse::Ok,
            DaemonRequest::Shutdown => {
                let mut sessions = self.sessions.lock();
                for (_, session) in sessions.drain() {
                    let _ = session.kill();
                }
                DaemonResponse::Ok
            }
        }
    }

    /// Run the server listener on the designated platform socket.
    pub async fn run_listener(
        &self,
        socket_path: &str,
        cancel_token: CancellationToken,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let server = Arc::new(Self {
            sessions: Arc::clone(&self.sessions),
        });
        run_server_listener(server, socket_path, cancel_token).await
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

                        let session_to_sub = match &req {
                            DaemonRequest::CreateOrAttach { session_id, .. } => Some(session_id.clone()),
                            _ => None,
                        };

                        let resp = server.handle_request(req);

                        // If CreateOrAttach succeeded, wire up subscriber task if not already streaming to this client
                        if let Some(session_id) = session_to_sub {
                            if matches!(resp, DaemonResponse::SessionAttached(_)) && !subscribed_sessions.contains_key(&session_id) {
                                let sessions = server.sessions.lock();
                                if let Some(session) = sessions.get(&session_id) {
                                    let mut rx = session.subscribe();
                                    let out_tx_sub = out_tx.clone();
                                    let sub_task = tokio::spawn(async move {
                                        loop {
                                            match rx.recv().await {
                                                Ok(event) => {
                                                    if let Ok(json) = serde_json::to_string(&event) {
                                                        if out_tx_sub.send(format!("{json}\n")).await.is_err() {
                                                            break;
                                                        }
                                                    }
                                                }
                                                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                                                    continue;
                                                }
                                                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                                                    break;
                                                }
                                            }
                                        }
                                    });
                                    subscribed_sessions.insert(session_id, sub_task);
                                }
                            }
                        }

                        if let Ok(json) = serde_json::to_string(&resp) {
                            let _ = out_tx.send(format!("{json}\n")).await;
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
    use std::time::Duration;

    #[tokio::test]
    async fn test_daemon_server_handle_request_lifecycle() {
        let server = DaemonServer::new();

        // 1. Hello
        let resp = server.handle_request(DaemonRequest::Hello {
            client_version: "0.1.0".into(),
            protocol_version: DAEMON_PROTOCOL_VERSION,
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
            DaemonResponse::SessionList(list) => {
                assert_eq!(list, vec!["req-test-1".to_string()]);
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
        };
        let mut create_str = serde_json::to_string(&create_req).unwrap();
        create_str.push('\n');
        write_half.write_all(create_str.as_bytes()).await.unwrap();

        line.clear();
        reader.read_line(&mut line).await.unwrap();
        let create_resp: DaemonResponse = serde_json::from_str(line.trim()).unwrap();
        match create_resp {
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
        };
        let mut reattach_str = serde_json::to_string(&reattach_req).unwrap();
        reattach_str.push('\n');
        write_half2.write_all(reattach_str.as_bytes()).await.unwrap();

        line.clear();
        reader2.read_line(&mut line).await.unwrap();
        let reattach_resp: DaemonResponse = serde_json::from_str(line.trim()).unwrap();
        match reattach_resp {
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
}
