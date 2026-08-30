use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;
#[cfg(target_os = "windows")]
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

/// File name the decoupled daemon is placed under `<app_data_dir>/daemon/`.
///
/// A future installer that decouples the daemon from the GUI install (see the
/// note on [`daemon_executable_path`]) drops the daemon binary here so every
/// build resolves it from this stable location instead of `current_exe`.
#[cfg(target_os = "windows")]
pub const DAEMON_FILE_NAME: &str = "oppa-daemon.exe";
#[cfg(not(target_os = "windows"))]
pub const DAEMON_FILE_NAME: &str = "oppa-daemon";

/// Resolves where the daemon binary lives, preferring a stable location.
///
/// 1. If `<app_data_dir>/daemon/<DAEMON_FILE_NAME>` EXISTS, that file wins —
///    the decoupled daemon a future installer places in the data dir.
/// 2. Otherwise fall back to `current_exe` (today's behavior: the daemon is
///    the GUI binary itself, spawned as `current_exe --daemon`).
///
/// ## Installer-side follow-up (out of scope here; bundler/installer work)
///
/// Making the daemon independent of the GUI install completes with versioned
/// install folders and a daemon in the data dir:
///
/// - Install each release into a versioned folder (`app-<version>/`) and keep
///   a `current` pointer that flips to the newest version after a successful
///   install — so an in-flight update never replaces files a running daemon
///   has open (the file-lock problem that kills sessions today).
/// - The installers place the daemon binary at
///   `<app_data_dir>/daemon/oppa-daemon` (or `.exe`), which this resolver
///   already prefers. `spawn_detached_daemon` then launches the decoupled
///   daemon and the old daemon upgrades lazily: the GUI attaches to it across
///   the update (Task 6's min-version handshake) and it self-replaces only
///   when idle (zero sessions) or on the next machine reboot, where the new
///   daemon simply comes up from the data dir.
///
/// That layout is a `tauri.conf.json` bundler + per-platform installer concern
/// and is not code-testable in this repo today; this function is the code seam
/// that makes it a pure file-placement change with no code changes later.
pub fn daemon_executable_path() -> PathBuf {
    daemon_executable_path_for(crate::pty::snapshot::resolve_app_data_dir())
}

/// Testable core of [`daemon_executable_path`]: same preference order, with
/// the app data dir supplied by the caller (tests use temp dirs).
pub fn daemon_executable_path_for(app_data_dir: Option<PathBuf>) -> PathBuf {
    let decoupled = app_data_dir
        .as_deref()
        .map(|dir| dir.join("daemon").join(DAEMON_FILE_NAME))
        .filter(|candidate| candidate.exists());
    match decoupled {
        Some(path) => path,
        None => std::env::current_exe().unwrap_or_else(|_| PathBuf::from("oppa")),
    }
}

/// Spawns a detached background daemon process running `executable_path --daemon`.
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
pub fn ensure_daemon_running() -> Result<(), String> {
    let socket_path = crate::pty::ipc_protocol::get_daemon_socket_path();
    let exe_path = daemon_executable_path();
    ensure_daemon_running_at(&socket_path, &exe_path)
}

// Best-effort Shutdown request over a throwaway connection; the daemon's
// handler flushes final session checkpoints before killing sessions.
fn request_shutdown(socket_path: &str) {
    let json = serde_json::to_string(&crate::pty::ipc_protocol::DaemonRequest::Shutdown)
        .unwrap_or_else(|_| "{\"type\":\"Shutdown\"}".to_string());

    #[cfg(target_os = "windows")]
    {
        if let Ok(mut pipe) = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(socket_path)
        {
            use std::io::Write;
            let _ = pipe.write_all(format!("{json}\n").as_bytes());
            let _ = pipe.flush();
            // Dropping closes the pipe handle; the daemon exits after replying.
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        if let Ok(mut stream) = std::os::unix::net::UnixStream::connect(socket_path) {
            use std::io::Write;
            let _ = stream.write_all(format!("{json}\n").as_bytes());
            let _ = stream.flush();
        }
    }
}

/// Recovers from a daemon built by an older binary (protocol mismatch): asks it
/// to shut down gracefully (flushing checkpoints), waits for the socket to
/// clear, spawns a fresh daemon, and waits for readiness.
///
/// Only genuinely too-old daemons (below the minimum supported protocol)
/// reach this path now; compatible older daemons are attached in place.
///
/// **This is the breaking-swap path — it KILLS every running session.** The
/// daemon's shutdown handler flushes checkpoints, but live shells end. It is
/// unreachable today (`MIN_SUPPORTED_DAEMON_PROTOCOL_VERSION` == the current
/// protocol), but if a future protocol bump makes it live, it MUST route
/// through the user-facing session warning (`can_upgrade_daemon` +
/// UpdateBanner's "Update anyway") rather than firing silently. Sessions are
/// sacred — never call this without surfacing the cost to the user.
pub fn restart_stale_daemon(socket_path: &str) -> Result<(), String> {
    request_shutdown(socket_path);

    let deadline = Instant::now() + Duration::from_secs(3);
    while probe_daemon(socket_path) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    if probe_daemon(socket_path) {
        return Err("stale daemon did not shut down within 3 seconds".to_string());
    }

    let exe_path = daemon_executable_path();
    spawn_detached_daemon(&exe_path)?;

    let deadline = Instant::now() + Duration::from_secs(5);
    while !probe_daemon(socket_path) {
        if Instant::now() >= deadline {
            return Err("timed out waiting for restarted daemon".to_string());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Ok(())
}

/// Helper allowing custom socket and executable paths for testing.
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

    #[tokio::test]
    async fn test_request_shutdown_stops_daemon_and_frees_socket() {
        use crate::pty::daemon_server::{CancellationToken, DaemonServer};
        use std::sync::Arc;

        let server = Arc::new(DaemonServer::new());
        let cancel_token = CancellationToken::new();

        #[cfg(target_os = "windows")]
        let socket_path = format!(
            r"\\.\pipe\oppa-test-shutdown-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );

        #[cfg(not(target_os = "windows"))]
        let socket_path = format!(
            "/tmp/oppa-test-shutdown-{}.sock",
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

        tokio::time::sleep(Duration::from_millis(150)).await;
        assert!(probe_daemon(&socket_path));

        // A bare Shutdown request must stop the listener so the socket frees up
        request_shutdown(&socket_path);

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while probe_daemon(&socket_path) && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            !probe_daemon(&socket_path),
            "daemon should have stopped after Shutdown request"
        );
    }

    // ---- task 6: daemon-binary path resolution from a stable location ----

    #[test]
    fn daemon_executable_path_prefers_data_dir_daemon_when_present() {
        let data_dir = std::env::temp_dir().join(format!(
            "oppa-daemon-resolver-present-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(data_dir.join("daemon")).unwrap();
        let daemon_file = data_dir.join("daemon").join(DAEMON_FILE_NAME);
        std::fs::write(&daemon_file, b"placeholder").unwrap();

        let resolved = daemon_executable_path_for(Some(data_dir.clone()));
        assert_eq!(
            resolved,
            daemon_file,
            "a daemon file in the data dir must be preferred over current_exe"
        );
        std::fs::remove_dir_all(&data_dir).ok();
    }

    #[test]
    fn daemon_executable_path_falls_back_to_current_exe_when_absent() {
        // A data dir with no daemon file (or no data dir at all) must resolve
        // to today's current_exe so the single-build world keeps working.
        let empty_dir = std::env::temp_dir().join(format!(
            "oppa-daemon-resolver-absent-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&empty_dir).unwrap();
        let resolved = daemon_executable_path_for(Some(empty_dir.clone()));
        assert_eq!(
            resolved,
            std::env::current_exe().expect("current exe resolves"),
            "absent daemon file must fall back to current_exe"
        );
        std::fs::remove_dir_all(&empty_dir).ok();

        assert_eq!(
            daemon_executable_path_for(None),
            std::env::current_exe().expect("current exe resolves"),
            "no data dir must fall back to current_exe"
        );
    }
}
