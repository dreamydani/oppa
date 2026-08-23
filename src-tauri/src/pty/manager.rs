use crate::pty::daemon_client::{
    DaemonClient, OnCwd, OnData, OnExit, OnFocusRequested, OnGitChanged, OnPrChanged,
    OnTitleChanged, OnWorktreeChanged,
};
use crate::pty::ipc_protocol::{get_daemon_socket_path, CreateOrAttachResult};
use parking_lot::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::Receiver;
use std::sync::Arc;

/// Registry and Tauri managed state adapter delegating PTY operations to the detached daemon.
pub struct PtyManager {
    client: Arc<Mutex<Option<Arc<DaemonClient>>>>,
    worktree_changed_cb: Mutex<Option<OnWorktreeChanged>>,
    title_changed_cb: Mutex<Option<OnTitleChanged>>,
    focus_requested_cb: Mutex<Option<OnFocusRequested>>,
    git_changed_cb: Mutex<Option<OnGitChanged>>,
    pr_changed_cb: Mutex<Option<OnPrChanged>>,
    custom_socket_path: Option<String>,
    next_id: AtomicU64,
}

impl Default for PtyManager {
    fn default() -> Self {
        Self::new()
    }
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            client: Arc::new(Mutex::new(None)),
            worktree_changed_cb: Mutex::new(None),
            title_changed_cb: Mutex::new(None),
            focus_requested_cb: Mutex::new(None),
            git_changed_cb: Mutex::new(None),
            pr_changed_cb: Mutex::new(None),
            custom_socket_path: None,
            next_id: AtomicU64::new(0),
        }
    }

    #[allow(dead_code)]
    pub fn with_socket_path(socket_path: &str) -> Self {
        Self {
            client: Arc::new(Mutex::new(None)),
            worktree_changed_cb: Mutex::new(None),
            title_changed_cb: Mutex::new(None),
            focus_requested_cb: Mutex::new(None),
            git_changed_cb: Mutex::new(None),
            pr_changed_cb: Mutex::new(None),
            custom_socket_path: Some(socket_path.to_string()),
            next_id: AtomicU64::new(0),
        }
    }

    pub fn next_id(&self) -> String {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let seq = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        format!("s-{now}-{seq}")
    }

    #[allow(dead_code)]
    pub fn with_client(client: Arc<DaemonClient>) -> Self {
        Self {
            client: Arc::new(Mutex::new(Some(client))),
            worktree_changed_cb: Mutex::new(None),
            title_changed_cb: Mutex::new(None),
            focus_requested_cb: Mutex::new(None),
            git_changed_cb: Mutex::new(None),
            pr_changed_cb: Mutex::new(None),
            custom_socket_path: None,
            next_id: AtomicU64::new(0),
        }
    }

    /// Install the global worktree-event forwarder; re-applied on every reconnect.
    pub fn set_worktree_changed_callback(&self, cb: OnWorktreeChanged) {
        *self.worktree_changed_cb.lock() = Some(Arc::clone(&cb));
        if let Some(client) = self.client.lock().as_ref() {
            client.set_worktree_changed_callback(cb);
        }
    }

    /// Install the session-title forwarder; re-applied on every reconnect.
    pub fn set_title_changed_callback(&self, cb: OnTitleChanged) {
        *self.title_changed_cb.lock() = Some(Arc::clone(&cb));
        if let Some(client) = self.client.lock().as_ref() {
            client.set_title_changed_callback(cb);
        }
    }

    /// Install the session-focus forwarder; re-applied on every reconnect.
    pub fn set_focus_requested_callback(&self, cb: OnFocusRequested) {
        *self.focus_requested_cb.lock() = Some(Arc::clone(&cb));
        if let Some(client) = self.client.lock().as_ref() {
            client.set_focus_requested_callback(cb);
        }
    }

    /// Install the git-changed forwarder; re-applied on every reconnect.
    pub fn set_git_changed_callback(&self, cb: OnGitChanged) {
        *self.git_changed_cb.lock() = Some(Arc::clone(&cb));
        if let Some(client) = self.client.lock().as_ref() {
            client.set_git_changed_callback(cb);
        }
    }

    /// Install the pr-changed forwarder; re-applied on every reconnect.
    pub fn set_pr_changed_callback(&self, cb: OnPrChanged) {
        *self.pr_changed_cb.lock() = Some(Arc::clone(&cb));
        if let Some(client) = self.client.lock().as_ref() {
            client.set_pr_changed_callback(cb);
        }
    }

    /// Obtain or lazily initialize the daemon client connection.
    pub fn get_client(&self) -> Result<Arc<DaemonClient>, String> {
        let mut client_guard = self.client.lock();
        if let Some(client) = client_guard.as_ref() {
            return Ok(Arc::clone(client));
        }

        let socket_path = match &self.custom_socket_path {
            Some(p) => p.clone(),
            None => {
                crate::pty::daemon_spawner::ensure_daemon_running()?;
                get_daemon_socket_path()
            }
        };

        let client = Arc::new(match DaemonClient::connect(&socket_path) {
            Ok(c) => c,
            Err(e) => {
                // A daemon left running by an older build speaks an old protocol.
                // Restart it (its shutdown handler flushes session checkpoints)
                // and reconnect once; sessions restore via warm/cold paths.
                if e.contains("protocol version mismatch") {
                    crate::pty::daemon_spawner::restart_stale_daemon(&socket_path)?;
                    DaemonClient::connect(&socket_path)?
                } else {
                    return Err(e);
                }
            }
        });
        *client_guard = Some(Arc::clone(&client));
        if let Some(cb) = self.worktree_changed_cb.lock().as_ref() {
            client.set_worktree_changed_callback(Arc::clone(cb));
        }
        if let Some(cb) = self.title_changed_cb.lock().as_ref() {
            client.set_title_changed_callback(Arc::clone(cb));
        }
        if let Some(cb) = self.focus_requested_cb.lock().as_ref() {
            client.set_focus_requested_callback(Arc::clone(cb));
        }
        if let Some(cb) = self.git_changed_cb.lock().as_ref() {
            client.set_git_changed_callback(Arc::clone(cb));
        }
        if let Some(cb) = self.pr_changed_cb.lock().as_ref() {
            client.set_pr_changed_callback(Arc::clone(cb));
        }
        Ok(client)
    }

    /// Create or attach to a session in the background daemon.
    #[allow(clippy::too_many_arguments)]
    pub fn create_or_attach(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
        shell: Option<String>,
        on_data: Option<OnData>,
        on_exit: Option<OnExit>,
        on_cwd: Option<OnCwd>,
        resume_agents: bool,
        worktree_id: Option<String>,
    ) -> Result<CreateOrAttachResult, String> {
        let client = self.get_client()?;
        client.register_callbacks(session_id, on_data, on_exit, on_cwd);
        let _ = client.create_session_channels(session_id);
        client.create_or_attach(
            session_id,
            cols,
            rows,
            cwd,
            shell,
            resume_agents,
            worktree_id,
        )
    }

    /// Spawn a new shell session and return its id.
    #[allow(dead_code)]
    pub fn spawn(
        &self,
        shell: Option<String>,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        _args: Vec<String>,
        on_data: Option<OnData>,
        on_exit: Option<OnExit>,
        on_cwd: Option<OnCwd>,
    ) -> Result<String, String> {
        let id = self.next_id();
        let client = self.get_client()?;
        client.register_callbacks(&id, on_data, on_exit, on_cwd);
        let _ = client.create_session_channels(&id);

        client.create_or_attach(&id, cols, rows, cwd, shell, false, None)?;
        Ok(id)
    }

    /// Write input bytes to the session PTY.
    pub fn write(&self, id: &str, data: &[u8]) -> std::io::Result<()> {
        let client = self
            .get_client()
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        let data_str = String::from_utf8_lossy(data).into_owned();
        client
            .write(id, &data_str)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
    }

    /// Resize the session PTY.
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> std::io::Result<()> {
        let client = self
            .get_client()
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        client
            .resize(id, cols, rows)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
    }

    /// Kill the session child process.
    pub fn kill(&self, id: &str) -> std::io::Result<()> {
        let client = self
            .get_client()
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        client
            .kill(id)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
    }

    /// Acknowledge processed bytes to release backpressure.
    pub fn ack(&self, id: &str, chars: usize) -> Result<(), String> {
        let client = self.get_client()?;
        client.ack(id, chars)
    }

    /// List all active session IDs.
    pub fn list(&self) -> Vec<String> {
        match self.get_client().and_then(|c| c.list_sessions()) {
            Ok(list) => list,
            Err(_) => Vec::new(),
        }
    }

    /// Disconnect from the daemon without stopping running sessions.
    #[allow(dead_code)]
    pub fn disconnect(&self) -> Result<(), String> {
        if let Some(client) = self.client.lock().as_ref() {
            client.disconnect()
        } else {
            Ok(())
        }
    }

    /// Request the daemon to terminate all sessions and shut down.
    #[allow(dead_code)]
    pub fn shutdown(&self) -> Result<(), String> {
        if let Some(client) = self.client.lock().as_ref() {
            client.shutdown()
        } else {
            Ok(())
        }
    }

    /// Take output channel for test observation.
    #[allow(dead_code)]
    pub fn take_output(&self, id: &str) -> Option<Receiver<Vec<u8>>> {
        self.get_client().ok().and_then(|c| c.take_output(id))
    }

    /// Take exit channel for test observation.
    #[allow(dead_code)]
    pub fn take_exit(&self, id: &str) -> Option<Receiver<Option<i32>>> {
        self.get_client().ok().and_then(|c| c.take_exit(id))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::pty::daemon_server::{CancellationToken, DaemonServer};
    use std::sync::mpsc::channel;
    use std::time::Duration;

    fn sh_path() -> String {
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

    fn drain_until(rx: Receiver<Vec<u8>>, needle: &str, timeout: Duration) -> Vec<u8> {
        let deadline = std::time::Instant::now() + timeout;
        let mut collected = Vec::new();
        while std::time::Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(chunk) => {
                    collected.extend_from_slice(&chunk);
                    if String::from_utf8_lossy(&collected).contains(needle) {
                        break;
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        collected
    }

    pub(crate) fn setup_test_server_and_manager(
    ) -> (PtyManager, CancellationToken, std::thread::JoinHandle<()>) {
        let server = Arc::new(DaemonServer::new());
        let cancel_token = CancellationToken::new();

        #[cfg(target_os = "windows")]
        let socket_path = format!(
            r"\\.\pipe\oppa-test-manager-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );

        #[cfg(not(target_os = "windows"))]
        let socket_path = format!(
            "/tmp/oppa-test-manager-{}.sock",
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

        let manager = PtyManager::with_socket_path(&socket_path);
        (manager, cancel_token, server_thread)
    }

    #[test]
    fn test_manager_spawn_echo_and_take_output() {
        let (manager, cancel_token, server_thread) = setup_test_server_and_manager();
        let sh = sh_path();

        let id = manager
            .spawn(Some(sh), None, 80, 24, Vec::new(), None, None, None)
            .expect("spawn");

        let rx = manager.take_output(&id).expect("output channel");
        manager.write(&id, b"echo hi\n").expect("write");

        let out = drain_until(rx, "hi", Duration::from_secs(5));
        assert!(
            String::from_utf8_lossy(&out).contains("hi"),
            "expected 'hi' in output, got: {:?}",
            String::from_utf8_lossy(&out)
        );

        manager.kill(&id).expect("kill");
        cancel_token.cancel();
        let _ = server_thread.join();
    }

    #[test]
    fn test_manager_create_or_attach_and_snapshot() {
        let (manager, cancel_token, server_thread) = setup_test_server_and_manager();
        let sh = sh_path();

        let res = manager
            .create_or_attach(
                "session-mgr-1",
                80,
                24,
                None,
                Some(sh),
                None,
                None,
                None,
                false,
                None,
            )
            .expect("create");
        assert!(res.is_new);
        assert_eq!(res.cols, 80);
        assert_eq!(res.rows, 24);

        let rx = manager
            .take_output("session-mgr-1")
            .expect("output channel");
        manager
            .write("session-mgr-1", b"echo persistent_val\n")
            .expect("write");

        let _ = drain_until(rx, "persistent_val", Duration::from_secs(5));

        // Reattach to same session
        let reattach = manager
            .create_or_attach(
                "session-mgr-1",
                80,
                24,
                None,
                None,
                None,
                None,
                None,
                false,
                None,
            )
            .expect("reattach");
        assert!(!reattach.is_new);
        assert!(reattach.snapshot.is_some());
        assert!(
            reattach.snapshot.unwrap().contains("persistent_val"),
            "expected snapshot to contain persistent_val"
        );

        manager.kill("session-mgr-1").expect("kill");
        cancel_token.cancel();
        let _ = server_thread.join();
    }

    #[test]
    fn test_manager_callbacks_on_data_and_on_exit() {
        let (manager, cancel_token, server_thread) = setup_test_server_and_manager();
        let sh = sh_path();

        let (data_tx, data_rx) = channel::<String>();
        let (exit_tx, exit_rx) = channel::<Option<i32>>();

        let on_data = Box::new(move |_id: &str, bytes: &[u8]| {
            let _ = data_tx.send(String::from_utf8_lossy(bytes).into_owned());
        });
        let on_exit = Box::new(move |_id: &str, code: Option<i32>| {
            let _ = exit_tx.send(code);
        });

        let id = manager
            .spawn(
                Some(sh),
                None,
                80,
                24,
                Vec::new(),
                Some(on_data),
                Some(on_exit),
                None,
            )
            .expect("spawn");

        manager.write(&id, b"echo callback_test\n").expect("write");

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut got_data = false;
        while std::time::Instant::now() < deadline {
            if let Ok(chunk) = data_rx.recv_timeout(Duration::from_millis(200)) {
                if chunk.contains("callback_test") {
                    got_data = true;
                    break;
                }
            }
        }
        assert!(got_data, "expected on_data callback with callback_test");

        manager.write(&id, b"exit 0\n").expect("write exit");
        let exit_res = exit_rx.recv_timeout(Duration::from_secs(5));
        assert!(exit_res.is_ok(), "expected on_exit callback");

        cancel_token.cancel();
        let _ = server_thread.join();
    }

    #[test]
    fn test_manager_resize_ack_list() {
        let (manager, cancel_token, server_thread) = setup_test_server_and_manager();
        let sh = sh_path();

        let id = manager
            .spawn(Some(sh), None, 80, 24, Vec::new(), None, None, None)
            .expect("spawn");

        manager.resize(&id, 120, 40).expect("resize");
        manager.ack(&id, 512).expect("ack");

        let list = manager.list();
        assert!(list.contains(&id));

        manager.kill(&id).expect("kill");
        cancel_token.cancel();
        let _ = server_thread.join();
    }
}
