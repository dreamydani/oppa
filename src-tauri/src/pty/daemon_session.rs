use crate::pty::ipc_protocol::DaemonEvent;
use crate::pty::osc_scanner::{OscEvent, OscScanner};
use crate::pty::output_batcher::{new_drain, run_batcher, BatchCommand, OutputDrain, DEFAULT_FLUSH_INTERVAL_MS};
use crate::pty::snapshot::AgentSessionRef;
use crate::pty::screen_mirror::ScreenMirror;
use crate::pty::shell_args::resolve_shell_launch_config;
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
// TuiIdle: prompt-end (OSC133 D) followed by this much silence counts as idle…
const TUI_IDLE_AFTER_PROMPT_MS: u64 = 800;
// …otherwise plain output silence for this long is the fallback (cmd.exe etc.)
const FALLBACK_IDLE_MS: u64 = 1500;
// Test hook: OPPA_IDLE_MS overrides both thresholds so waits are fast/deterministic
pub fn idle_thresholds() -> (u64, u64) {
    match std::env::var("OPPA_IDLE_MS").ok().and_then(|v| v.parse::<u64>().ok()) {
        Some(ms) => (ms, ms),
        None => (TUI_IDLE_AFTER_PROMPT_MS, FALLBACK_IDLE_MS),
    }
}
const IDLE_POLL_INTERVAL: Duration = Duration::from_millis(50);
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
    // True when the ref was set by a hook payload (authoritative per pane).
    // Scan-tier refreshes must never overwrite hook-captured ids.
    pub agent_ref_from_hook: Arc<Mutex<bool>>,
    // Worktree this pane was bound to at spawn; fixed for the session's lifetime
    pub worktree_id: Option<String>,
    // Tab-title sync: set via SetSessionTitle, mirrored into checkpoints
    pub title: Mutex<Option<String>>,
    env_bindings: Vec<(String, String)>,
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
    // Coalesces reader chunks into larger Data events; finish() must run
    // before Exit is emitted so the tail output always precedes it.
    pub output_drain: OutputDrain,
    // Output activity tracking for WaitFor::TuiIdle
    pub last_output_at: Arc<Mutex<Instant>>,
    // Some(t) while the last OSC133 D marker is still the freshest output
    pub last_prompt_end_at: Arc<Mutex<Option<Instant>>>,
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
        env_bindings: &[(String, String)],
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
            env_bindings,
        )
    }

    /// Spawn a new PTY session with explicit program and args.
    #[allow(clippy::too_many_arguments)]
    pub fn spawn_with_args(
        id: String,
        shell: &str,
        args: &[String],
        cwd: Option<&str>,
        cols: u16,
        rows: u16,
        initial_command: Option<&str>,
        env_bindings: &[(String, String)],
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
        // Agent hook plumbing (Orca-parity): managed agent hooks echo these
        // back to the daemon so a hook payload binds to THIS pane.
        cmd.env("OPPA_PANE_KEY", id.clone());
        if let Some(hook) = crate::pty::agent_hook_server::hook_env() {
            cmd.env("OPPA_HOOK_PORT", hook.0.to_string());
            cmd.env("OPPA_HOOK_TOKEN", hook.1);
        }

        // Session-authoritative vars always win over injected bindings
        const AUTHORITATIVE_ENV_KEYS: &[&str] = &[
            "TERM",
            "COLORTERM",
            "TERM_PROGRAM",
            "TERM_PROGRAM_VERSION",
            "LANG",
            "OPPA_WORKSPACE_CWD",
            "OPPA_PANE_KEY",
            "OPPA_HOOK_PORT",
            "OPPA_HOOK_TOKEN",
        ];
        // Later OPPA_* bindings overwrite earlier ones — worktree identity is
        // newer truth than hook defaults; other duplicate keys keep first value.
        let mut applied_bindings: Vec<(String, String)> = Vec::with_capacity(env_bindings.len());
        for (key, value) in env_bindings {
            if AUTHORITATIVE_ENV_KEYS.contains(&key.as_str()) {
                continue;
            }
            match applied_bindings.iter_mut().find(|(k, _)| k == key) {
                Some(slot) => {
                    if key.starts_with("OPPA_") {
                        slot.1.clone_from(value);
                        cmd.env(key.as_str(), value.as_str());
                    }
                }
                None => {
                    applied_bindings.push((key.clone(), value.clone()));
                    cmd.env(key.as_str(), value.as_str());
                }
            }
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
        let (output_drain, batch_rx, batch_drained_tx) =
            new_drain();
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
            agent_ref_from_hook: Arc::new(Mutex::new(false)),
            worktree_id: applied_bindings
                .iter()
                .find(|(k, _)| k == "OPPA_WORKTREE_ID")
                .map(|(_, v)| v.clone()),
            title: Mutex::new(None),
            env_bindings: applied_bindings,
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
            output_drain,
            last_output_at: Arc::new(Mutex::new(Instant::now())),
            last_prompt_end_at: Arc::new(Mutex::new(None)),
        });

        Self::start_threads(
            Arc::clone(&session),
            reader,
            session.initial_command.clone(),
            batch_rx,
            batch_drained_tx,
        );
        Ok(session)
    }

    fn start_threads(
        session: Arc<Self>,
        mut reader: Box<dyn std::io::Read + Send>,
        initial_command: Option<String>,
        batch_rx: std::sync::mpsc::Receiver<BatchCommand>,
        batch_drained_tx: std::sync::mpsc::Sender<()>,
    ) {
        let id = session.id.clone();
        let session_cwd = Arc::clone(&session.cwd);
        let foreground = Arc::clone(&session.foreground_command);
        let agent_ref = Arc::clone(&session.agent_session_ref);
        let agent_from_hook = Arc::clone(&session.agent_ref_from_hook);
        let ready_seen = Arc::clone(&session.ready_seen);
        let initial_command_written = Arc::clone(&session.initial_command_written);
        let writer = Arc::clone(&session.writer);
        let pending = Arc::clone(&session.pending_bytes);
        let paused = Arc::clone(&session.paused);
        let master = Arc::clone(&session.master);
        let child = Arc::clone(&session.child);
        let screen_mirror = Arc::clone(&session.screen_mirror);
        let subscribers = Arc::clone(&session.subscribers);
        let last_output = Arc::clone(&session.last_output_at);
        let last_prompt_end = Arc::clone(&session.last_prompt_end_at);

        let id_watch = id.clone();
        let master_watch = Arc::clone(&master);
        let child_watch = Arc::clone(&child);
        let subscribers_watch = Arc::clone(&session.subscribers);
        let drain_watch = session.output_drain.clone();
        let output_drain_reader = session.output_drain.clone();

        // Output batcher: coalesces raw chunks into larger Data events and
        // owns the UTF-8 decoder so split code points resolve per batch.
        {
            let id_batch = id.clone();
            let subscribers_batch = Arc::clone(&session.subscribers);
            let seq_batch = Arc::clone(&session.seq);
            std::thread::spawn(move || {
                run_batcher(batch_rx, batch_drained_tx, DEFAULT_FLUSH_INTERVAL_MS, move |data, bytes| {
                    let seq_num = seq_batch.fetch_add(1, Ordering::SeqCst);
                    emit_event(
                        &subscribers_batch,
                        DaemonEvent::Data {
                            session_id: id_batch.clone(),
                            data,
                            bytes,
                            seq: seq_num,
                        },
                    );
                });
            });
        }

        // Reader thread: reads PTY output, feeds screen mirror, scans OSC,
        // and hands raw chunks to the output batcher for coalesced emission.
        let initial_command_reader = initial_command.clone();
        let writer_inject = Arc::clone(&writer);
        let written_inject = Arc::clone(&initial_command_written);
        std::thread::spawn(move || {
            let initial_command = initial_command_reader;
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

                        // Ready-marker detection; stop scanning once found
                        if !ready_seen.load(Ordering::SeqCst)
                            && chunk
                                .windows(READY_MARKER_BYTES.len())
                                .any(|w| w == READY_MARKER_BYTES)
                        {
                            ready_seen.store(true, Ordering::SeqCst);
                        }

                        // Record activity BEFORE osc handling: a D marker in this
                        // chunk must be fresher than the chunk's own bytes
                        *last_output.lock() = Instant::now();

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
                                    *agent_from_hook.lock() = false;
                                    *last_prompt_end.lock() = None;
                                }
                                OscEvent::CommandEnd => {
                                    *foreground.lock() = None;
                                    // agent_session_ref deliberately kept: a cold boot after
                                    // the agent exits must still be able to resume it
                                    *last_prompt_end.lock() = Some(Instant::now());
                                }
                            }
                        }

                        // Feed VT100 virtual screen buffer
                        screen_mirror.lock().process(chunk);

                        // Hand raw bytes to the batcher: coalesces into
                        // larger Data events (≤32KB / ~8ms) before emission.
                        output_drain_reader.send_chunk(chunk.to_vec());

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
                    // Tail output must precede Exit: bounded drain of the
                    // batcher before signalling the child is gone.
                    drain_watch.finish();
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

    /// Plain viewport text for ReadScreen (no ANSI; scrollback excluded).
    pub fn get_screen_text(&self) -> String {
        self.screen_mirror.lock().get_text()
    }

    /// Exit code once the child is gone; None while still running.
    pub fn exit_code(&self) -> Option<i32> {
        self.child
            .lock()
            .try_wait()
            .ok()
            .flatten()
            .map(|status| status.exit_code() as i32)
    }

    /// Pure TuiIdle decision: output silence for `fallback_quiet_ms` normally,
    /// shortened to `prompt_quiet_ms` once an OSC133 D marker has been seen.
    /// Output after the marker (next prompt redraw) does not reset the marker,
    /// only the silence clock; CommandStart clears the marker.
    fn is_tui_idle(
        now: Instant,
        last_output: Instant,
        prompt_end: Option<Instant>,
        prompt_quiet: Duration,
        fallback_quiet: Duration,
    ) -> bool {
        let quiet_for = now - last_output;
        if prompt_end.is_some() {
            return quiet_for >= prompt_quiet;
        }
        quiet_for >= fallback_quiet
    }

    /// Poll until TuiIdle or deadline; returns true only when satisfied.
    pub async fn wait_until_idle_with(
        &self,
        deadline: Instant,
        prompt_quiet: Duration,
        fallback_quiet: Duration,
    ) -> bool {
        loop {
            let now = Instant::now();
            let (last_output, prompt_end) = (*self.last_output_at.lock(), *self.last_prompt_end_at.lock());
            if Self::is_tui_idle(now, last_output, prompt_end, prompt_quiet, fallback_quiet) {
                return true;
            }
            if now >= deadline {
                return false;
            }
            tokio::time::sleep(IDLE_POLL_INTERVAL).await;
        }
    }

    pub async fn wait_until_idle(&self, deadline: Instant) -> bool {
        let (prompt_ms, fallback_ms) = idle_thresholds();
        self.wait_until_idle_with(deadline, Duration::from_millis(prompt_ms), Duration::from_millis(fallback_ms))
            .await
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

    /// Injected env vars that actually reached the child (post-dedupe).
    pub fn env_bindings(&self) -> &[(String, String)] {
        &self.env_bindings
    }

    /// Worktree this pane was bound to at spawn, if any.
    pub fn worktree_id(&self) -> Option<&str> {
        self.worktree_id.as_deref()
    }

    pub fn title(&self) -> Option<String> {
        self.title.lock().clone()
    }

    pub fn set_title(&self, title: String) {
        *self.title.lock() = Some(title);
    }

    /// Command currently running in the foreground, per OSC 133 C/D markers.
    pub fn foreground_command(&self) -> Option<String> {
        self.foreground_command.lock().clone()
    }

    pub fn is_alive(&self) -> bool {
        self.child.lock().try_wait().ok().flatten().is_none()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::daemon_server::DaemonServer;

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
            &[],
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
            &[],
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
            &[],
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
            &[],
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
            &[],
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
    async fn test_daemon_session_env_bindings_dedupe_and_authority() {
        let sh = test_sh_path();
        let bindings = vec![
            ("OPPA_WORKTREE_ID".to_string(), "repo::C:/ws/feat-a".to_string()),
            ("MY_CUSTOM_VAR".to_string(), "custom-1".to_string()),
            // Non-OPPA duplicate: first value wins
            ("MY_CUSTOM_VAR".to_string(), "custom-2".to_string()),
            // Session-authoritative key from a binding must be skipped entirely
            ("OPPA_PANE_KEY".to_string(), "hijack-attempt".to_string()),
        ];
        let session = DaemonSession::spawn_with_args(
            "env-bindings-s".into(),
            &sh,
            &[
                "-c".into(),
                "echo wt=$OPPA_WORKTREE_ID custom=$MY_CUSTOM_VAR pane=$OPPA_PANE_KEY".into(),
            ],
            None,
            80,
            24,
            None,
            &bindings,
        )
        .expect("spawn session with env bindings");

        assert_eq!(session.worktree_id(), Some("repo::C:/ws/feat-a"));
        assert_eq!(
            session.env_bindings(),
            &[
                ("OPPA_WORKTREE_ID".to_string(), "repo::C:/ws/feat-a".to_string()),
                ("MY_CUSTOM_VAR".to_string(), "custom-1".to_string()),
            ]
        );

        let mut rx = session.subscribe();
        let mut collected = String::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(300), rx.recv()).await {
                Ok(Some(DaemonEvent::Data { data, .. })) => {
                    collected.push_str(&data);
                    if collected.contains("pane=") && collected.contains('\r') {
                        break;
                    }
                }
                Ok(Some(DaemonEvent::Exit { .. })) => break,
                _ => continue,
            }
        }

        assert!(
            collected.contains("wt=repo::C:/ws/feat-a"),
            "expected worktree id injected, got: {collected}"
        );
        assert!(
            collected.contains("custom=custom-1"),
            "expected first duplicate value to win, got: {collected}"
        );
        assert!(
            !collected.contains("hijack-attempt"),
            "authoritative OPPA_PANE_KEY must survive binding injection, got: {collected}"
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
            &[],
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
            &[],
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
        assert!(
            !*session.agent_ref_from_hook.lock(),
            "hook-authority flag must reset with the ref"
        );
        let _ = session.kill();
    }

    #[tokio::test]
    async fn test_daemon_session_agent_ref_from_hook_survives_scan_refresh() {
        let sh = test_sh_path();
        let session = DaemonSession::spawn_with_args(
            "agent-ref-hook".into(),
            &sh,
            &[],
            None,
            80,
            24,
            None,
            &[],
        )
        .expect("spawn hook-ref shell");

        // A running agy foreground command would normally trigger scan-tier
        // capture — it must NOT overwrite a hook-captured id. Simulate the
        // hook firing WHILE agy runs (after its own C marker cleared state).
        session
            .write(b"printf '\\033]133;C;agy\\007'\n")
            .expect("write C marker");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if session.foreground_command().as_deref() == Some("agy") {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(session.foreground_command().as_deref(), Some("agy"));

        *session.agent_session_ref.lock() = Some(AgentSessionRef {
            agent: "agy".into(),
            id: "hook-conv-7".into(),
            transcript_path: None,
        });
        *session.agent_ref_from_hook.lock() = true;

        let snapshot = DaemonServer::build_checkpoint(&session);
        assert_eq!(
            snapshot.agent_session.as_ref().map(|r| r.id.as_str()),
            Some("hook-conv-7"),
            "scan tier must not overwrite hook-captured refs"
        );

        // Scan-sourced refs, in contrast, must be refreshable (from_hook=false)
        *session.agent_ref_from_hook.lock() = false;
        // Point the cwd at this repo so the real agy cwd-map (if any) decides;
        // either way the call must not panic and the field stays consistent.
        let _ = DaemonServer::build_checkpoint(&session);
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
            &[],
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
            &[],
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
    async fn test_daemon_session_set_title_flows_into_checkpoint_snapshot() {
        let sh = test_sh_path();
        let session = DaemonSession::spawn_with_args(
            "title-snap".into(),
            &sh,
            &[],
            None,
            80,
            24,
            None,
            &[],
        )
        .expect("spawn title session");
        assert_eq!(session.title(), None);

        session.set_title("release pane".into());
        assert_eq!(session.title().as_deref(), Some("release pane"));

        let snapshot = DaemonServer::build_checkpoint(&session);
        assert_eq!(
            snapshot.title.as_deref(),
            Some("release pane"),
            "checkpoint must carry the session title for warm/cold restore"
        );
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
            &[],
        )
        .expect("spawn interactive shell");

        assert!(session.pid() > 0);
        let kill_result = session.kill();
        assert!(kill_result.is_ok());
    }

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    #[test]
    fn test_is_tui_idle_prompt_marker_path() {
        let now = Instant::now();
        // Marker seen + quiet long enough: OSC path wins even though prompt
        // redraw output landed after the marker (last_output > marker)
        assert!(DaemonSession::is_tui_idle(now, now - ms(1000), Some(now - ms(1200)), ms(800), ms(5000)));
        // Marker seen but not quiet yet
        assert!(!DaemonSession::is_tui_idle(now, now - ms(300), Some(now - ms(400)), ms(800), ms(1500)));
        // No marker: fallback threshold governs
        assert!(!DaemonSession::is_tui_idle(now, now - ms(100), None, ms(800), ms(1500)));
        assert!(DaemonSession::is_tui_idle(now, now - ms(1600), None, ms(800), ms(1500)));
    }

    #[tokio::test]
    async fn test_wait_until_idle_prompt_marker_via_osc133() {
        let sh = test_sh_path();
        let session = DaemonSession::spawn_with_args(
            "idle-osc".into(),
            &sh,
            &[],
            None,
            80,
            24,
            None,
            &[],
        )
        .expect("spawn idle shell");
        session
            .write(b"printf '\\033]133;D\\007'\n")
            .expect("write D marker");

        // Tiny prompt threshold, huge fallback: only the OSC path can satisfy
        let started = Instant::now();
        let satisfied = session
            .wait_until_idle_with(Instant::now() + Duration::from_secs(5), ms(200), ms(60_000))
            .await;
        assert!(satisfied, "OSC133 D marker + silence must read as idle");
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "idle must come from the marker path, not the fallback: {:?}",
            started.elapsed()
        );
        let _ = session.kill();
    }

    #[tokio::test]
    async fn test_wait_until_idle_fallback_without_markers() {
        let sh = test_sh_path();
        let session = DaemonSession::spawn_with_args(
            "idle-fallback".into(),
            &sh,
            &[],
            None,
            80,
            24,
            None,
            &[],
        )
        .expect("spawn fallback shell");

        // Huge prompt threshold (no markers expected), tiny fallback
        let satisfied = session
            .wait_until_idle_with(Instant::now() + Duration::from_secs(5), ms(60_000), ms(400))
            .await;
        assert!(satisfied, "plain output silence must satisfy the fallback");
        assert!(session.last_prompt_end_at.lock().is_none());
        let _ = session.kill();
    }

    #[tokio::test]
    async fn test_wait_until_idle_times_out_while_output_flows() {
        let sh = test_sh_path();
        let session = DaemonSession::spawn_with_args(
            "idle-timeout".into(),
            &sh,
            &[],
            None,
            80,
            24,
            None,
            &[],
        )
        .expect("spawn timeout shell");
        // Continuous output refreshes last_output_at every ~50ms; thresholds
        // above that period can never be met inside the deadline
        session
            .write(b"while true; do echo busy-output; sleep 0.05; done\n")
            .expect("start output loop");

        // Only measure once output is confirmed flowing: shell startup lag
        // would otherwise count as pre-loop silence
        let mut rx = session.subscribe();
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(300), rx.recv()).await {
                Ok(Some(DaemonEvent::Data { data, .. })) => {
                    if data.contains("busy-output") {
                        break;
                    }
                }
                _ => continue,
            }
        }

        let satisfied = session
            .wait_until_idle_with(Instant::now() + Duration::from_millis(900), ms(500), ms(500))
            .await;
        assert!(!satisfied, "flowing output must keep the session non-idle");
        let _ = session.kill();
    }

    #[tokio::test]
    async fn test_exit_code_after_child_exit_and_get_screen_text() {
        let sh = test_sh_path();
        let session = DaemonSession::spawn_with_args(
            "exit-code-s".into(),
            &sh,
            &["-c".into(), "echo screen_text_probe; exit 7".into()],
            None,
            80,
            24,
            None,
            &[],
        )
        .expect("spawn exiting shell");

        let deadline = Instant::now() + Duration::from_secs(5);
        let mut code = None;
        while Instant::now() < deadline {
            if let Some(c) = session.exit_code() {
                code = Some(c);
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(code, Some(7));

        let text = session.get_screen_text();
        assert!(
            text.to_lowercase().contains("screen_text_probe"),
            "expected probe in screen text: {text:?}"
        );
        assert!(!text.contains('\x1b'), "screen text must be plain: {text:?}");
        let _ = session.kill();
    }
}

