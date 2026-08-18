use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
#[allow(dead_code)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
#[cfg(target_os = "windows")]
#[allow(dead_code)]
const DETACHED_PROCESS: u32 = 0x00000008;

/// Probes whether a daemon server is actively listening on the given socket path.
pub fn probe_daemon(socket_path: &str) -> bool {
    #[cfg(target_os = "windows")]
    {
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(socket_path)
            .is_ok()
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::os::unix::net::UnixStream::connect(socket_path).is_ok()
    }
}

/// Spawns a detached background daemon process running `executable_path --daemon`.
#[allow(dead_code)]
pub fn spawn_detached_daemon(executable_path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new(executable_path)
            .arg("--daemon")
            .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("failed to spawn detached daemon: {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        #[cfg(unix)]
        use std::os::unix::process::CommandExt;

        let mut cmd = Command::new(executable_path);
        cmd.arg("--daemon")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(unix)]
        cmd.process_group(0);

        cmd.spawn()
            .map_err(|e| format!("failed to spawn detached daemon: {e}"))?;
        Ok(())
    }
}

/// Ensures the daemon is running; probes the socket, launches the detached daemon if missing,
/// and awaits readiness up to 5 seconds.
#[allow(dead_code)]
pub fn ensure_daemon_running() -> Result<(), String> {
    let socket_path = crate::pty::ipc_protocol::get_daemon_socket_path();
    let exe_path = std::env::current_exe()
        .map_err(|e| format!("failed to determine current executable path: {e}"))?;
    ensure_daemon_running_at(&socket_path, &exe_path)
}

/// Helper allowing custom socket and executable paths for testing.
#[allow(dead_code)]
pub fn ensure_daemon_running_at(socket_path: &str, executable_path: &Path) -> Result<(), String> {
    if probe_daemon(socket_path) {
        return Ok(());
    }

    spawn_detached_daemon(executable_path)?;

    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if probe_daemon(socket_path) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    Err("timed out waiting for daemon to become ready after 5 seconds".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_probe_nonexistent_socket_returns_false() {
        let fake_socket = if cfg!(windows) {
            r"\\.\pipe\oppa-nonexistent-socket-test-12345"
        } else {
            "/tmp/oppa-nonexistent-socket-test-12345.sock"
        };
        assert!(!probe_daemon(fake_socket));
    }

    #[tokio::test]
    async fn test_probe_active_daemon_returns_true() {
        use crate::pty::daemon_server::{CancellationToken, DaemonServer};
        use std::sync::Arc;

        let server = Arc::new(DaemonServer::new());
        let cancel_token = CancellationToken::new();

        #[cfg(target_os = "windows")]
        let socket_path = format!(
            r"\\.\pipe\oppa-test-probe-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );

        #[cfg(not(target_os = "windows"))]
        let socket_path = format!(
            "/tmp/oppa-test-probe-{}.sock",
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
        assert!(probe_daemon(&socket_path));
        cancel_token.cancel();
    }
}
