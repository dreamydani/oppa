use crate::pty::ipc_protocol::DaemonEvent;
use crate::pty::osc_scanner::OscScanner;
use crate::pty::screen_mirror::ScreenMirror;
use crate::pty::shell_args::resolve_shell_launch_config;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;

const HIGH_WATERMARK_BYTES: usize = 256 * 1024;
const LOW_WATERMARK_BYTES: usize = 32 * 1024;
const READ_CHUNK_SIZE: usize = 8 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(10);
const BROADCAST_CAPACITY: usize = 2048;
const SCREEN_SCROLLBACK_LINES: usize = 1000;

pub struct DaemonSession {
    pub id: String,
    pub master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    pub writer: Arc<Mutex<Box<dyn std::io::Write + Send>>>,
    pub child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    pub screen_mirror: Arc<Mutex<ScreenMirror>>,
    pub cwd: Arc<Mutex<Option<String>>>,
    pub cols: AtomicU16,
    pub rows: AtomicU16,
    pub pid: u32,
    pub pending_bytes: Arc<AtomicUsize>,
    pub paused: Arc<AtomicBool>,
    pub broadcast_tx: broadcast::Sender<DaemonEvent>,
    pub seq: Arc<AtomicU64>,
}

impl DaemonSession {
    /// Spawn a new shell session using standard shell resolution.
    pub fn spawn(
        id: String,
        shell: Option<String>,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
    ) -> Result<Arc<Self>, String> {
        let config = resolve_shell_launch_config(shell, cwd);
        Self::spawn_with_args(
            id,
            &config.program,
            &config.args,
            config.cwd.as_deref(),
            cols,
            rows,
        )
    }

    /// Spawn a new PTY session with explicit program and args.
    pub fn spawn_with_args(
        id: String,
        shell: &str,
        args: &[String],
        cwd: Option<&str>,
        cols: u16,
        rows: u16,
    ) -> Result<Arc<Self>, String> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("failed to open pty: {e}"))?;

        let mut cmd = CommandBuilder::new(shell);
        cmd.args(args.iter().map(String::as_str));
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "oppa");
        cmd.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
        match std::env::var_os("LANG") {
            Some(lang) if !lang.is_empty() => {}
            _ => {
                cmd.env("LANG", "C.UTF-8");
            }
        }
        if let Some(cwd) = cwd {
            cmd.cwd(cwd);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("failed to spawn child command: {e}"))?;
        let pid = child.process_id().unwrap_or(0);
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("failed to take pty writer: {e}"))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("failed to clone pty reader: {e}"))?;

        let (broadcast_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let screen_mirror = Arc::new(Mutex::new(ScreenMirror::new(
            cols,
            rows,
            SCREEN_SCROLLBACK_LINES,
        )));

        let session = Arc::new(Self {
            id: id.clone(),
            master: Arc::new(Mutex::new(Some(pair.master))),
            writer: Arc::new(Mutex::new(writer)),
            child: Arc::new(Mutex::new(child)),
            screen_mirror,
            cwd: Arc::new(Mutex::new(cwd.map(|s| s.to_string()))),
            cols: AtomicU16::new(cols),
            rows: AtomicU16::new(rows),
            pid,
            pending_bytes: Arc::new(AtomicUsize::new(0)),
            paused: Arc::new(AtomicBool::new(false)),
            broadcast_tx,
            seq: Arc::new(AtomicU64::new(0)),
        });

        Self::start_threads(Arc::clone(&session), reader);

        Ok(session)
    }

    fn start_threads(
        session: Arc<Self>,
        mut reader: Box<dyn std::io::Read + Send>,
    ) {
        let id = session.id.clone();
        let session_cwd = Arc::clone(&session.cwd);
        let writer = Arc::clone(&session.writer);
        let pending = Arc::clone(&session.pending_bytes);
        let paused = Arc::clone(&session.paused);
        let master = Arc::clone(&session.master);
        let child = Arc::clone(&session.child);
        let screen_mirror = Arc::clone(&session.screen_mirror);
        let broadcast_tx = session.broadcast_tx.clone();
        let seq = Arc::clone(&session.seq);

        let id_watch = id.clone();
        let master_watch = Arc::clone(&master);
        let child_watch = Arc::clone(&child);
        let broadcast_tx_watch = broadcast_tx.clone();

        // Reader thread: reads PTY output, feeds screen mirror, scans OSC, and broadcasts data events
        std::thread::spawn(move || {
            let mut buf = [0u8; READ_CHUNK_SIZE];
            let mut osc_scanner = OscScanner::new();
            loop {
                if paused.load(Ordering::SeqCst) {
                    if pending.load(Ordering::SeqCst) < LOW_WATERMARK_BYTES {
                        paused.store(false, Ordering::SeqCst);
                    }
                    std::thread::sleep(POLL_INTERVAL);
                    continue;
                }

                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let chunk = &buf[..n];
                        pending.fetch_add(n, Ordering::SeqCst);
                        if pending.load(Ordering::SeqCst) > HIGH_WATERMARK_BYTES {
                            paused.store(true, Ordering::SeqCst);
                        }

                        // ConPTY handshake
                        if chunk.windows(4).any(|w| w == b"\x1b[6n") {
                            let _ = writer.lock().write_all(b"\x1b[1;1R");
                        }

                        // OSC scanning for CWD tracking
                        if let Some(new_cwd) = osc_scanner.scan(chunk) {
                            *session_cwd.lock() = Some(new_cwd.clone());
                            let _ = broadcast_tx.send(DaemonEvent::Cwd {
                                session_id: id.clone(),
                                cwd: new_cwd,
                            });
                        }

                        // Feed VT100 virtual screen buffer
                        screen_mirror.lock().process(chunk);

                        // Broadcast Data event with monotonic sequence number
                        let seq_num = seq.fetch_add(1, Ordering::SeqCst);
                        let _ = broadcast_tx.send(DaemonEvent::Data {
                            session_id: id.clone(),
                            data: String::from_utf8_lossy(chunk).into_owned(),
                            seq: seq_num,
                        });
                    }
                    Err(_) => break,
                }
            }
        });

        // Watchdog thread: polls child exit, closes master to unblock reader, and emits Exit event
        std::thread::spawn(move || {
            loop {
                let exit_code = child_watch
                    .lock()
                    .try_wait()
                    .ok()
                    .flatten()
                    .map(|status| status.exit_code() as i32);
                if let Some(code) = exit_code {
                    master_watch.lock().take();
                    let _ = broadcast_tx_watch.send(DaemonEvent::Exit {
                        session_id: id_watch,
                        code: Some(code),
                    });
                    break;
                }
                std::thread::sleep(POLL_INTERVAL);
            }
        });
    }

    /// Write input bytes to the PTY's input stream.
    pub fn write(&self, data: &[u8]) -> std::io::Result<()> {
        self.writer.lock().write_all(data)
    }

    /// Resize the PTY and underlying virtual terminal mirror.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let master = self.master.lock();
        if let Some(master) = master.as_ref() {
            master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| format!("failed to resize pty: {e}"))?;
        }
        self.cols.store(cols, Ordering::SeqCst);
        self.rows.store(rows, Ordering::SeqCst);
        self.screen_mirror.lock().resize(cols, rows);
        Ok(())
    }

    /// Release backpressure by acknowledging processed bytes.
    pub fn ack(&self, chars: usize) -> Result<(), String> {
        self.pending_bytes
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |p| {
                Some(p.saturating_sub(chars))
            })
            .unwrap_or(0);
        if self.pending_bytes.load(Ordering::SeqCst) < LOW_WATERMARK_BYTES {
            self.paused.store(false, Ordering::SeqCst);
        }
        Ok(())
    }

    /// Kill the child process.
    pub fn kill(&self) -> std::io::Result<()> {
        self.child.lock().kill()
    }

    /// Return an ANSI formatted snapshot of the virtual screen state.
    pub fn get_snapshot(&self) -> String {
        self.screen_mirror.lock().get_formatted_snapshot()
    }

    /// Subscribe to real-time events for this session.
    pub fn subscribe(&self) -> broadcast::Receiver<DaemonEvent> {
        self.broadcast_tx.subscribe()
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn cols(&self) -> u16 {
        self.cols.load(Ordering::SeqCst)
    }

    pub fn rows(&self) -> u16 {
        self.rows.load(Ordering::SeqCst)
    }

    pub fn cwd(&self) -> Option<String> {
        self.cwd.lock().clone()
    }

    #[allow(dead_code)]
    pub fn is_alive(&self) -> bool {
        self.child.lock().try_wait().ok().flatten().is_none()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[tokio::test]
    async fn test_daemon_session_spawn_and_data_stream() {
        let sh = test_sh_path();
        let session = DaemonSession::spawn_with_args(
            "s1".into(),
            &sh,
            &["-c".into(), "echo daemon-test-ok".into()],
            None,
            80,
            24,
        )
        .expect("spawn daemon session");

        let mut rx = session.subscribe();
        let mut collected = String::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);

        while std::time::Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(300), rx.recv()).await {
                Ok(Ok(DaemonEvent::Data { data, .. })) => {
                    collected.push_str(&data);
                    if collected.contains("daemon-test-ok") {
                        break;
                    }
                }
                Ok(Ok(DaemonEvent::Exit { .. })) => break,
                _ => continue,
            }
        }

        assert!(
            collected.contains("daemon-test-ok"),
            "expected output to contain 'daemon-test-ok', got: {collected}"
        );
    }

    #[tokio::test]
    async fn test_daemon_session_screen_mirror_snapshot() {
        let sh = test_sh_path();
        let session = DaemonSession::spawn_with_args(
            "s2".into(),
            &sh,
            &[],
            None,
            80,
            24,
        )
        .expect("spawn interactive shell");

        let mut rx = session.subscribe();
        session.write(b"echo snapshot_content_123\n").expect("write command");

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(300), rx.recv()).await {
                Ok(Ok(DaemonEvent::Data { data, .. })) => {
                    if data.contains("snapshot_content_123") {
                        break;
                    }
                }
                _ => continue,
            }
        }

        let snapshot = session.get_snapshot();
        assert!(
            snapshot.contains("snapshot_content_123"),
            "expected snapshot to contain 'snapshot_content_123', got: {snapshot}"
        );
        let _ = session.kill();
    }

    #[test]
    fn test_daemon_session_resize_and_ack() {
        let sh = test_sh_path();
        let session = DaemonSession::spawn_with_args(
            "s3".into(),
            &sh,
            &[],
            None,
            80,
            24,
        )
        .expect("spawn interactive shell");

        session.resize(100, 30).expect("resize session");
        assert_eq!(session.cols(), 100);
        assert_eq!(session.rows(), 30);

        session.ack(512).expect("ack session");
        assert_eq!(session.pending_bytes.load(Ordering::SeqCst), 0);
        let _ = session.kill();
    }
}
