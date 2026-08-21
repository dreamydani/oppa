use crate::pty::ipc_protocol::DaemonEvent;
use crate::pty::osc_scanner::{OscEvent, OscScanner};
use crate::pty::snapshot::AgentSessionRef;
use crate::pty::screen_mirror::ScreenMirror;
use crate::pty::shell_args::resolve_shell_launch_config;
use crate::pty::utf8_decoder::Utf8ChunkDecoder;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const HIGH_WATERMARK_BYTES: usize = 256 * 1024;
const LOW_WATERMARK_BYTES: usize = 32 * 1024;
const READ_CHUNK_SIZE: usize = 8 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(10);
const SCREEN_SCROLLBACK_LINES: usize = 1000;
// Bootstrap emits this once after prompt hooks install; injection waits for it
const READY_MARKER_BYTES: &[u8] = b"\x1b]633;oppa-ready\x07";
// Shells without our bootstrap (e.g. cmd.exe) never emit the marker — inject anyway
const FALLBACK_INJECT_SECS: u64 = 15;
const FALLBACK_INJECT_DURATION: Duration = Duration::from_secs(FALLBACK_INJECT_SECS);

pub struct DaemonSession {
    pub id: String,
    pub master: Arc<Mutex<Option<Box<dyn MasterPty + Send>>>>,
    pub writer: Arc<Mutex<Box<dyn std::io::Write + Send>>>,
    pub child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    pub screen_mirror: Arc<Mutex<ScreenMirror>>,
    pub cwd: Arc<Mutex<Option<String>>>,
    pub foreground_command: Arc<Mutex<Option<String>>>,
    // Last known agent session id for this pane; kept even after the command
    // exits so a later cold boot can resume the conversation.
    pub agent_session_ref: Arc<Mutex<Option<AgentSessionRef>>>,
    pub ready_seen: Arc<AtomicBool>,
    pub initial_command: Option<String>,
    pub initial_command_written: Arc<AtomicBool>,
    pub cols: AtomicU16,
    pub rows: AtomicU16,
    pub pid: u32,
    pub pending_bytes: Arc<AtomicUsize>,
    pub paused: Arc<AtomicBool>,
    pub subscribers: Arc<Mutex<Vec<tokio::sync::mpsc::UnboundedSender<DaemonEvent>>>>,
    pub seq: Arc<AtomicU64>,
}

fn emit_event(
    subscribers: &Arc<Mutex<Vec<tokio::sync::mpsc::UnboundedSender<DaemonEvent>>>>,
    event: DaemonEvent,
) {
    let mut subs = subscribers.lock();
    subs.retain(|tx| tx.send(event.clone()).is_ok());
}

impl DaemonSession {
    /// Spawn a new shell session using standard shell resolution.
    pub fn spawn(
        id: String,
        shell: Option<String>,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        initial_command: Option<&str>,
    ) -> Result<Arc<Self>, String> {
        let config = resolve_shell_launch_config(shell, cwd);
        Self::spawn_with_args(
            id,
            &config.program,
            &config.args,
            config.cwd.as_deref(),
            cols,
            rows,
            initial_command,
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
        initial_command: Option<&str>,
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
            cmd.env("OPPA_WORKSPACE_CWD", cwd);
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

        let subscribers = Arc::new(Mutex::new(Vec::new()));
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
            foreground_command: Arc::new(Mutex::new(None)),
            agent_session_ref: Arc::new(Mutex::new(None)),
            ready_seen: Arc::new(AtomicBool::new(false)),
            initial_command: initial_command.map(str::to_string),
            initial_command_written: Arc::new(AtomicBool::new(false)),
            cols: AtomicU16::new(cols),
            rows: AtomicU16::new(rows),
            pid,
            pending_bytes: Arc::new(AtomicUsize::new(0)),
            paused: Arc::new(AtomicBool::new(false)),
            subscribers,
            seq: Arc::new(AtomicU64::new(0)),
        });

        Self::start_threads(
            Arc::clone(&session),
            reader,
            session.initial_command.clone(),
        );
        Ok(session)
    }

    fn start_threads(
        session: Arc<Self>,
        mut reader: Box<dyn std::io::Read + Send>,
        initial_command: Option<String>,
    ) {
        let id = session.id.clone();
        let session_cwd = Arc::clone(&session.cwd);
        let foreground = Arc::clone(&session.foreground_command);
        let agent_ref = Arc::clone(&session.agent_session_ref);
        let ready_seen = Arc::clone(&session.ready_seen);
        let initial_command_written = Arc::clone(&session.initial_command_written);
        let writer = Arc::clone(&session.writer);
        let pending = Arc::clone(&session.pending_bytes);
        let paused = Arc::clone(&session.paused);
        let master = Arc::clone(&session.master);
        let child = Arc::clone(&session.child);
        let screen_mirror = Arc::clone(&session.screen_mirror);
        let subscribers = Arc::clone(&session.subscribers);
        let seq = Arc::clone(&session.seq);

        let id_watch = id.clone();
        let master_watch = Arc::clone(&master);
        let child_watch = Arc::clone(&child);
        let subscribers_watch = Arc::clone(&session.subscribers);

        // Reader thread: reads PTY output, feeds screen mirror, scans OSC, and emits data events
        let initial_command_reader = initial_command.clone();
        let writer_inject = Arc::clone(&writer);
        let written_inject = Arc::clone(&initial_command_written);
        std::thread::spawn(move || {
            let initial_command = initial_command_reader;
            let mut buf = [0u8; READ_CHUNK_SIZE];
            let mut osc_scanner = OscScanner::new();
            let mut utf8_decoder = Utf8ChunkDecoder::new();
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

                        // Ready-marker detection; stop scanning once found
                        if !ready_seen.load(Ordering::SeqCst)
                            && chunk
                                .windows(READY_MARKER_BYTES.len())
                                .any(|w| w == READY_MARKER_BYTES)
                        {
                            ready_seen.store(true, Ordering::SeqCst);
                        }

                        for osc_event in osc_scanner.scan(chunk) {
                            match osc_event {
                                OscEvent::Cwd(new_cwd) => {
                                    *session_cwd.lock() = Some(new_cwd.clone());
                                    emit_event(
                                        &subscribers,
                                        DaemonEvent::Cwd {
                                            session_id: id.clone(),
                                            cwd: new_cwd,
                                        },
                                    );
                                }
                                OscEvent::CommandStart(cmdline) => {
                                    // Empty cmdline means the hook couldn't capture it — unknown, not empty
                                    *foreground.lock() =
                                        if cmdline.is_empty() { None } else { Some(cmdline) };
                                    // New foreground work invalidates the previous agent session
                                    *agent_ref.lock() = None;
                                }
                                OscEvent::CommandEnd => {
                                    *foreground.lock() = None;
                                    // agent_session_ref deliberately kept: a cold boot after
                                    // the agent exits must still be able to resume it
                                }
                            }
                        }

                        // Feed VT100 virtual screen buffer
                        screen_mirror.lock().process(chunk);

                        // Emit Data event with monotonic sequence number
                        let seq_num = seq.fetch_add(1, Ordering::SeqCst);
                        emit_event(
                            &subscribers,
                            DaemonEvent::Data {
                                session_id: id.clone(),
                                data: utf8_decoder.decode(chunk),
                                bytes: chunk.len(),
                                seq: seq_num,
                            },
                        );

                        // Inject initial command exactly once when the ready marker arrives.
                        // Fallback timeout lives in a timer thread: the reader blocks in
                        // read() on quiet shells and would never observe the deadline.
                        if ready_seen.load(Ordering::SeqCst)
                            && !initial_command_written.swap(true, Ordering::SeqCst)
                        {
                            if let Some(cmd) = initial_command.as_deref() {
                                let _ = writer.lock().write_all(format!("{cmd}\r").as_bytes());
                            }
                        }
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
                    emit_event(
                        &subscribers_watch,
                        DaemonEvent::Exit {
                            session_id: id_watch,
                            code: Some(code),
                        },
                    );
                    break;
                }
                std::thread::sleep(POLL_INTERVAL);
            }
        });

        // Fallback injector: shells without our bootstrap never emit the ready marker,
        // so inject after the deadline unless the reader already did (or command absent)
        if let Some(cmd) = initial_command {
            std::thread::spawn(move || {
                let deadline = Instant::now() + FALLBACK_INJECT_DURATION;
                while Instant::now() < deadline && !written_inject.load(Ordering::SeqCst) {
                    std::thread::sleep(POLL_INTERVAL);
                }
                if !written_inject.swap(true, Ordering::SeqCst) {
                    let _ = writer_inject
                        .lock()
                        .write_all(format!("{cmd}\r").as_bytes());
                }
            });
        }
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

    /// Kill the child process and its process tree.
    pub fn kill(&self) -> std::io::Result<()> {
        let res = self.child.lock().kill();

        #[cfg(windows)]
        {
            if self.pid > 0 {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x08000000;
                let _ = std::process::Command::new("taskkill")
                    .args(["/F", "/T", "/PID", &self.pid.to_string()])
                    .creation_flags(CREATE_NO_WINDOW)
                    .output();
            }
        }

        #[cfg(unix)]
        {
            if self.pid > 0 {
                unsafe {
                    libc::killpg(self.pid as i32, libc::SIGKILL);
                }
            }
        }

        res
    }


    /// Return an ANSI formatted snapshot of the virtual screen state.
    pub fn get_snapshot(&self) -> String {
        self.screen_mirror.lock().get_formatted_snapshot()
    }

    /// Subscribe to real-time events for this session.
    pub fn subscribe(&self) -> tokio::sync::mpsc::UnboundedReceiver<DaemonEvent> {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        self.subscribers.lock().push(tx);
        rx
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

    /// Command currently running in the foreground, per OSC 133 C/D markers.
    pub fn foreground_command(&self) -> Option<String> {
        self.foreground_command.lock().clone()
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
            None,
        )
        .expect("spawn daemon session");

        let mut rx = session.subscribe();
        let mut collected = String::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);

        while std::time::Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(300), rx.recv()).await {
                Ok(Some(DaemonEvent::Data { data, .. })) => {
                    collected.push_str(&data);
                    if collected.contains("daemon-test-ok") {
                        break;
                    }
                }
                Ok(Some(DaemonEvent::Exit { .. })) => break,
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
            None,
        )
        .expect("spawn interactive shell");

        let mut rx = session.subscribe();
        session.write(b"echo snapshot_content_123\n").expect("write command");

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(300), rx.recv()).await {
                Ok(Some(DaemonEvent::Data { data, .. })) => {
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
            None,
        )
        .expect("spawn interactive shell");

        session.resize(100, 30).expect("resize session");
        assert_eq!(session.cols(), 100);
        assert_eq!(session.rows(), 30);

        session.ack(512).expect("ack session");
        assert_eq!(session.pending_bytes.load(Ordering::SeqCst), 0);
        let _ = session.kill();
    }

    #[tokio::test]
    async fn test_daemon_session_multibyte_byte_counts_and_ack() {
        let sh = test_sh_path();
        let session = DaemonSession::spawn_with_args(
            "s-multibyte".into(),
            &sh,
            &["-c".into(), "echo '🚀 日本語 test'".into()],
            None,
            80,
            24,
            None,
        )
        .expect("spawn multibyte shell");

        let mut rx = session.subscribe();
        let mut total_bytes_received = 0usize;
        let deadline = std::time::Instant::now() + Duration::from_secs(5);

        while std::time::Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(300), rx.recv()).await {
                Ok(Some(DaemonEvent::Data { bytes, data, .. })) => {
                    assert_eq!(bytes, data.as_bytes().len());
                    total_bytes_received += bytes;
                    if data.contains("🚀") || data.contains("日本語") || data.contains("test") {
                        break;
                    }
                }
                Ok(Some(DaemonEvent::Exit { .. })) => break,
                _ => continue,
            }
        }

        assert!(total_bytes_received > 0);
        session.ack(total_bytes_received).expect("ack multibyte bytes");
        assert_eq!(session.pending_bytes.load(Ordering::SeqCst), 0);
        let _ = session.kill();
    }

    #[tokio::test]
    async fn test_daemon_session_cwd_env_injection() {
        let sh = test_sh_path();
        let session = DaemonSession::spawn_with_args(
            "env-test-s".into(),
            &sh,
            &["-c".into(), "echo cwd=$OPPA_WORKSPACE_CWD".into()],
            Some("test_ws_cwd"),
            80,
            24,
            None,
        )
        .expect("spawn session with cwd");

        let mut rx = session.subscribe();
        let mut collected = String::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);

        while std::time::Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(300), rx.recv()).await {
                Ok(Some(DaemonEvent::Data { data, .. })) => {
                    collected.push_str(&data);
                    if collected.contains("cwd=test_ws_cwd") {
                        break;
                    }
                }
                Ok(Some(DaemonEvent::Exit { .. })) => break,
                _ => continue,
            }
        }

        assert!(
            collected.contains("cwd=test_ws_cwd"),
            "expected output to contain 'cwd=test_ws_cwd', got: {collected}"
        );
        let _ = session.kill();
    }

    #[tokio::test]
    async fn test_daemon_session_foreground_command_tracking() {
        let sh = test_sh_path();
        let session = DaemonSession::spawn_with_args(
            "fg-track".into(),
            &sh,
            &[],
            None,
            80,
            24,
            None,
        )
        .expect("spawn interactive shell");

        // printf turns the literal \033/\007 text into real ESC/BEL bytes on output
        session
            .write(b"printf '\\033]133;C;git status\\007'\n")
            .expect("write C marker");

        let mut saw_start = false;
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if session.foreground_command().as_deref() == Some("git status") {
                saw_start = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(
            saw_start,
            "expected foreground_command Some(\"git status\"), got {:?}",
            session.foreground_command()
        );

        session
            .write(b"printf '\\033]133;D\\007'\n")
            .expect("write D marker");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if session.foreground_command().is_none() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(
            session.foreground_command().is_none(),
            "expected foreground_command cleared after D marker"
        );
        let _ = session.kill();
    }

    #[tokio::test]
    async fn test_daemon_session_agent_ref_kept_after_command_end_and_cleared_on_new_command() {
        let sh = test_sh_path();
        let session = DaemonSession::spawn_with_args(
            "agent-ref".into(),
            &sh,
            &[],
            None,
            80,
            24,
            None,
        )
        .expect("spawn agent-ref shell");

        // Simulate a captured agent session, then end the command via OSC D
        *session.agent_session_ref.lock() = Some(AgentSessionRef {
            agent: "claude".into(),
            id: "conv-42".into(),
            transcript_path: None,
        });
        session
            .write(b"printf '\\033]133;D\\007'\n")
            .expect("write D marker");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if session.foreground_command().is_none() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(
            session.agent_session_ref.lock().is_some(),
            "agent ref must survive command end so cold boot can resume it"
        );

        // A NEW foreground command invalidates it
        session
            .write(b"printf '\\033]133;C;git status\\007'\n")
            .expect("write C marker");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if session.agent_session_ref.lock().is_none() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(
            session.agent_session_ref.lock().is_none(),
            "agent ref must be cleared when a new command starts"
        );
        let _ = session.kill();
    }

    #[tokio::test]
    async fn test_daemon_session_initial_command_fallback_injection() {
        let sh = test_sh_path();
        let session = DaemonSession::spawn_with_args(
            "fallback-inject".into(),
            &sh,
            &[],
            None,
            80,
            24,
            Some("echo injected_cmd_ok"),
        )
        .expect("spawn with initial command");

        let mut rx = session.subscribe();
        let mut collected = String::new();
        // Fallback window plus shell startup slack
        let deadline =
            std::time::Instant::now() + Duration::from_secs(FALLBACK_INJECT_SECS + 5);
        while std::time::Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(300), rx.recv()).await {
                Ok(Some(DaemonEvent::Data { data, .. })) => {
                    collected.push_str(&data);
                    if collected.contains("injected_cmd_ok") {
                        break;
                    }
                }
                Ok(Some(DaemonEvent::Exit { .. })) => break,
                _ => continue,
            }
        }

        assert!(
            collected.contains("injected_cmd_ok"),
            "expected fallback injection of initial command, got: {collected}"
        );
        assert!(session.initial_command_written.load(Ordering::SeqCst));
        let _ = session.kill();
    }

    #[tokio::test]
    async fn test_daemon_session_initial_command_ready_marker_injection() {
        let sh = test_sh_path();
        let started = std::time::Instant::now();
        let session = DaemonSession::spawn_with_args(
            "marker-inject".into(),
            &sh,
            &[],
            None,
            80,
            24,
            Some("echo marker_injected_ok"),
        )
        .expect("spawn with initial command");

        // Emit the ready marker ourselves, well inside the fallback window
        session
            .write(b"printf '\\033]633;oppa-ready\\007'\n")
            .expect("write ready marker");

        let mut rx = session.subscribe();
        let mut collected = String::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(300), rx.recv()).await {
                Ok(Some(DaemonEvent::Data { data, .. })) => {
                    collected.push_str(&data);
                    if collected.contains("marker_injected_ok") {
                        break;
                    }
                }
                Ok(Some(DaemonEvent::Exit { .. })) => break,
                _ => continue,
            }
        }

        assert!(
            collected.contains("marker_injected_ok"),
            "expected marker-triggered injection, got: {collected}"
        );
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "injection should be marker-driven, not fallback-timed; took {:?}",
            started.elapsed()
        );
        assert!(session.ready_seen.load(Ordering::SeqCst));
        let _ = session.kill();
    }

    #[tokio::test]
    async fn test_daemon_session_kill_process_tree() {
        let sh = test_sh_path();
        let session = DaemonSession::spawn_with_args(
            "kill-tree-unit".into(),
            &sh,
            &[],
            None,
            80,
            24,
            None,
        )
        .expect("spawn interactive shell");

        assert!(session.pid() > 0);
        let kill_result = session.kill();
        assert!(kill_result.is_ok());
    }
}

