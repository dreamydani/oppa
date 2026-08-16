use crate::pty::session::{default_shell, PtySession};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, PtySize};
use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::time::Duration;

/// Callback invoked once per output chunk with `(id, bytes)`. Optional: the
/// Tauri command layer uses it to emit `pty:data` events; tests can use it to
/// observe output without touching Tauri.
pub type OnData = Box<dyn Fn(&str, &[u8]) + Send + Sync + 'static>;
/// Callback invoked when a session's child exits with `(id, exit_code)`.
pub type OnExit = Box<dyn Fn(&str, Option<i32>) + Send + Sync + 'static>;

/// Pending output below this watermark releases backpressure. Full watermark
/// logic (high/low watermarks) lands in a later task; ack() already uses this
/// as the "safe to resume" threshold.
const RESUME_WATERMARK: usize = 32 * 1024;
const READ_CHUNK_SIZE: usize = 8 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(10);

/// Registry of live PTY sessions plus the per-session channels that carry
/// output and exit signals to observers.
///
/// All maps are behind a `parking_lot::Mutex` so the manager can be shared as
/// Tauri managed state (`State<'_, PtyManager>` requires `Send + Sync`; the
/// `Receiver` ends are Send and the Mutex adds Sync). The read loop owns the
/// `Sender` ends; observers take the `Receiver` ends via `take_output` /
/// `take_exit`.
///
/// The manager deliberately contains NO Tauri runtime types: the emitter is
/// injected as a plain closure at `spawn` time, so the manager (and its tests)
/// link without Tauri's runtime and the test binary loads on Windows.
#[derive(Default)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
    out_rx: Mutex<HashMap<String, Receiver<Vec<u8>>>>,
    exit_rx: Mutex<HashMap<String, Receiver<Option<i32>>>>,
    next_id: AtomicU64,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            out_rx: Mutex::new(HashMap::new()),
            exit_rx: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(0),
        }
    }

    pub fn sessions(&self) -> &Mutex<HashMap<String, PtySession>> {
        &self.sessions
    }

    /// Spawn a PTY session and return its id.
    ///
    /// `shell` defaults to [`default_shell()`]; `cwd` sets the child's working
    /// directory. Output chunks go to the session's channel AND the optional
    /// `on_data` callback; child exit fires the session's exit channel AND the
    /// optional `on_exit` callback.
    ///
    /// Returns `Err(String)` instead of panicking when the PTY cannot be
    /// opened or the shell cannot be spawned.
    pub fn spawn(
        &self,
        shell: Option<String>,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
        args: Vec<String>,
        on_data: Option<OnData>,
        on_exit: Option<OnExit>,
    ) -> Result<String, String> {
        let shell = shell.unwrap_or_else(default_shell);

        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("failed to open pty: {e}"))?;

        let id = (self.next_id.fetch_add(1, Ordering::SeqCst) + 1).to_string();

        let (out_tx, out_rx) = channel::<Vec<u8>>();
        let (exit_tx, exit_rx) = channel::<Option<i32>>();
        self.out_rx.lock().insert(id.clone(), out_rx);
        self.exit_rx.lock().insert(id.clone(), exit_rx);

        let session = PtySession::new(id.clone(), pair, &shell, &args, cwd.as_deref(), cols, rows)
            .map_err(|e| format!("failed to spawn pty session: {e}"))?;
        self.start_read_loop(&session, out_tx, exit_tx, on_data, on_exit);
        self.sessions.lock().insert(id.clone(), session);

        Ok(id)
    }

    fn start_read_loop(
        &self,
        session: &PtySession,
        out_tx: Sender<Vec<u8>>,
        exit_tx: Sender<Option<i32>>,
        on_data: Option<OnData>,
        on_exit: Option<OnExit>,
    ) {
        let id = session.id.clone();
        let mut reader = session
            .master
            .lock()
            .as_ref()
            .expect("master must exist at spawn")
            .try_clone_reader()
            .expect("failed to clone pty reader");
        let writer = Arc::clone(&session.writer);
        let pending = Arc::clone(&session.pending_bytes);
        let paused = Arc::clone(&session.paused);
        let master = Arc::clone(&session.master);
        let child = Arc::clone(&session.child);

        // The watchdog thread gets its own copies of the id, the exit sender,
        // and the master/child handles.
        let id_watch = id.clone();
        let exit_tx_watch = exit_tx.clone();
        let master_watch = Arc::clone(&master);
        let child_watch = Arc::clone(&child);

        // Reader thread: pump pty output into the session channel.
        std::thread::spawn(move || {
            let mut buf = [0u8; READ_CHUNK_SIZE];
            loop {
                if paused.load(Ordering::SeqCst) {
                    std::thread::sleep(POLL_INTERVAL);
                    continue;
                }
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF: child exited or the pty closed
                    Ok(n) => {
                        let chunk = buf[..n].to_vec();
                        pending.fetch_add(n, Ordering::SeqCst);
                        // ConPTY handshake: the console sends a cursor
                        // position request (ESC[6n) and stalls further output
                        // until the app replies with ESC[<row>;<col>R. Answer
                        // it immediately so the child's output keeps flowing.
                        if chunk.windows(4).any(|w| w == b"\x1b[6n") {
                            let _ = writer.lock().write_all(b"\x1b[1;1R");
                        }
                        if let Some(on_data) = &on_data {
                            on_data(&id, &chunk);
                        }
                        // A dropped receiver means no subscriber; keep reading
                        // and draining so the pty doesn't stall.
                        let _ = out_tx.send(chunk);
                    }
                    Err(_) => break,
                }
            }
            let _ = exit_tx.send(None);
        });

        // Watchdog thread: on Windows ConPTY the output pipe does not EOF
        // when the child exits, so the blocked reader would never notice.
        // Poll the child; once it has exited, close (drop) the master, which
        // unblocks the reader with EOF and fires the exit signal.
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
                    if let Some(on_exit) = &on_exit {
                        on_exit(&id_watch, Some(code));
                    }
                    let _ = exit_tx_watch.send(Some(code));
                    break;
                }
                std::thread::sleep(POLL_INTERVAL);
            }
        });
    }

    /// Write input bytes to the session's PTY.
    pub fn write(&self, id: &str, data: &[u8]) -> std::io::Result<()> {
        match self.sessions.lock().get_mut(id) {
            Some(session) => session.write(data),
            None => Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("no session with id {id}"),
            )),
        }
    }

    /// Resize the session's PTY.
    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> std::io::Result<()> {
        match self.sessions.lock().get_mut(id) {
            Some(session) => session.resize(cols, rows),
            None => Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("no session with id {id}"),
            )),
        }
    }

    /// Kill the session's child process.
    pub fn kill(&self, id: &str) -> std::io::Result<()> {
        match self.sessions.lock().get_mut(id) {
            Some(session) => session.child.lock().kill(),
            None => Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("no session with id {id}"),
            )),
        }
    }

    /// Acknowledge that the consumer processed `chars` bytes, releasing
    /// backpressure once pending output drops below the resume watermark.
    pub fn ack(&self, id: &str, chars: usize) {
        let sessions = self.sessions.lock();
        let Some(session) = sessions.get(id) else {
            return;
        };
        let pending = session
            .pending_bytes
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |p| {
                Some(p.saturating_sub(chars))
            })
            .unwrap_or(0);
        if pending.saturating_sub(chars) < RESUME_WATERMARK {
            session.paused.store(false, Ordering::SeqCst);
        }
    }

    /// Whether the session's child process has exited. Test observation API.
    #[cfg(test)]
    pub fn child_exited(&self, id: &str) -> bool {
        self.sessions
            .lock()
            .get_mut(id)
            .and_then(|session| session.child.lock().try_wait().ok().flatten())
            .is_some()
    }

    /// Take the session's output receiver (test observation API; the Tauri
    /// emitter is delivered via the `on_data` callback instead).
    #[cfg(test)]
    pub fn take_output(&self, id: &str) -> Option<Receiver<Vec<u8>>> {
        self.out_rx.lock().remove(id)
    }

    /// Take the session's exit receiver (carries `Some(exit_code)` when the
    /// watchdog observes the child's exit, `None` on reader EOF). Test
    /// observation API.
    #[cfg(test)]
    pub fn take_exit(&self, id: &str) -> Option<Receiver<Option<i32>>> {
        self.exit_rx.lock().remove(id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Locate a real `sh` for the PTY tests. `sh` ships with Git for Windows
    /// but is not on the PATH cmd.exe inherits, so resolve it explicitly:
    /// first scan PATH, then fall back to standard Git install locations.
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
        // Last resort: rely on PATH resolution; spawn will fail with a clear
        // error if `sh` is genuinely unavailable.
        "sh".to_string()
    }

    /// Drain the session's output channel until it closes, the expected
    /// `needle` is seen, or the deadline passes.
    fn drain_until(rx: Receiver<Vec<u8>>, needle: &str, timeout: Duration) -> Vec<u8> {
        let deadline = std::time::Instant::now() + timeout;
        let mut collected = Vec::new();
        while std::time::Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(250)) {
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

    #[test]
    fn new_manager_is_empty() {
        let manager = PtyManager::new();
        assert!(manager.sessions().lock().is_empty());
    }

    #[test]
    fn spawn_echo() {
        let sh = sh_path();
        let manager = PtyManager::new();
        let id = manager
            .spawn(
                Some(sh),
                None,
                80,
                24,
                vec!["-c".to_string(), "echo hi".to_string()],
                None,
                None,
            )
            .expect("spawn should succeed");
        assert!(manager.sessions().lock().contains_key(&id));

        let rx = manager.take_output(&id).expect("session has an output channel");
        let out = drain_until(rx, "hi", Duration::from_secs(5));
        assert!(
            String::from_utf8_lossy(&out).contains("hi"),
            "expected pty output containing 'hi', got: {:?}",
            String::from_utf8_lossy(&out)
        );
    }

    #[test]
    fn write_echo() {
        let sh = sh_path();
        let manager = PtyManager::new();
        let id = manager
            .spawn(Some(sh), None, 80, 24, Vec::new(), None, None)
            .expect("spawn should succeed");
        assert!(manager.sessions().lock().contains_key(&id));

        let rx = manager.take_output(&id).expect("session has an output channel");
        manager
            .write(&id, b"echo hi\n")
            .expect("write to pty should succeed");

        let out = drain_until(rx, "hi", Duration::from_secs(5));
        assert!(
            String::from_utf8_lossy(&out).contains("hi"),
            "expected interactive pty output containing 'hi', got: {:?}",
            String::from_utf8_lossy(&out)
        );
    }

    #[test]
    fn resize_and_ack() {
        let sh = sh_path();
        let manager = PtyManager::new();
        let id = manager
            .spawn(Some(sh), None, 80, 24, Vec::new(), None, None)
            .expect("spawn should succeed");
        assert!(manager.sessions().lock().contains_key(&id));

        manager
            .resize(&id, 132, 43)
            .expect("resize should succeed");
        {
            let sessions = manager.sessions().lock();
            let session = sessions.get(&id).unwrap();
            assert_eq!(session.cols, 132);
            assert_eq!(session.rows, 43);
            assert_eq!(
                session.master.lock().as_ref().unwrap().get_size().unwrap(),
                PtySize { rows: 43, cols: 132, pixel_width: 0, pixel_height: 0 }
            );
        } // guard released here

        // ack with no pending bytes: fetch_sub saturates at 0, paused stays
        // false; no panic.
        manager.ack(&id, 1024);
        {
            let sessions = manager.sessions().lock();
            let session = sessions.get(&id).unwrap();
            assert_eq!(session.pending_bytes.load(Ordering::SeqCst), 0);
            assert!(!session.paused.load(Ordering::SeqCst));
        }
    }

    #[test]
    fn exit_signal() {
        let sh = sh_path();
        let manager = PtyManager::new();
        let id = manager
            .spawn(
                Some(sh),
                None,
                80,
                24,
                vec!["-c".to_string(), "exit 0".to_string()],
                None,
                None,
            )
            .expect("spawn should succeed");
        assert!(manager.sessions().lock().contains_key(&id));

        let exit_rx = manager.take_exit(&id).expect("session has an exit channel");

        let saw_exit = exit_rx.recv_timeout(Duration::from_secs(5)).is_ok();
        assert!(saw_exit, "expected an exit signal after the child exited");
    }

    #[test]
    fn kill_tree() {
        let sh = sh_path();
        let manager = PtyManager::new();
        let id = manager
            .spawn(
                Some(sh),
                None,
                80,
                24,
                vec!["-c".to_string(), "sleep 100".to_string()],
                None,
                None,
            )
            .expect("spawn should succeed");
        assert!(manager.sessions().lock().contains_key(&id));
        assert!(
            !manager.child_exited(&id),
            "child should still be running before kill"
        );

        manager.kill(&id).expect("kill should succeed");

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if manager.child_exited(&id) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("child should be gone after kill");
    }

    #[test]
    fn on_data_callback_receives_output() {
        let sh = sh_path();
        let manager = PtyManager::new();
        let (data_tx, data_rx) = channel::<Vec<u8>>();
        let id = manager
            .spawn(
                Some(sh),
                None,
                80,
                24,
                vec!["-c".to_string(), "echo hi".to_string()],
                Some(Box::new(move |_id, bytes| {
                    let _ = data_tx.send(bytes.to_vec());
                })),
                None,
            )
            .expect("spawn should succeed");

        let out = drain_until(data_rx, "hi", Duration::from_secs(5));
        assert!(
            String::from_utf8_lossy(&out).contains("hi"),
            "expected the on_data callback to receive pty output containing 'hi', got: {:?}",
            String::from_utf8_lossy(&out)
        );
        let _ = id;
    }

    #[test]
    fn on_exit_callback_receives_code() {
        let sh = sh_path();
        let manager = PtyManager::new();
        let (exit_tx, exit_rx) = channel::<Option<i32>>();
        let id = manager
            .spawn(
                Some(sh),
                None,
                80,
                24,
                vec!["-c".to_string(), "exit 0".to_string()],
                None,
                Some(Box::new(move |_id, code| {
                    let _ = exit_tx.send(code);
                })),
            )
            .expect("spawn should succeed");

        let code = exit_rx.recv_timeout(Duration::from_secs(5)).unwrap_or(None);
        assert_eq!(code, Some(0), "expected exit code 0 from 'exit 0'");
        let _ = id;
    }

    #[test]
    fn spawn_errors_without_panicking() {
        let manager = PtyManager::new();
        let result = manager.spawn(
            Some("definitely-not-a-real-shell-xyz".into()),
            None,
            80,
            24,
            Vec::new(),
            None,
            None,
        );
        assert!(
            result.is_err(),
            "spawning a nonexistent shell should return Err, got: {result:?}"
        );
        assert!(manager.sessions().lock().is_empty());
    }

    #[test]
    fn spawn_with_default_shell() {
        let manager = PtyManager::new();
        let id = manager
            .spawn(None, None, 80, 24, Vec::new(), None, None)
            .expect("spawn with default_shell should succeed");
        assert!(manager.sessions().lock().contains_key(&id));

        let rx = manager.take_output(&id).expect("session has an output channel");
        // A fresh default shell just prints a prompt; wait briefly for any
        // output rather than asserting on its exact content.
        let deadline = std::time::Instant::now() + Duration::from_secs(3);
        let mut got = Vec::new();
        while std::time::Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(250)) {
                Ok(chunk) => got.extend_from_slice(&chunk),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        assert!(
            !got.is_empty(),
            "expected the default shell to produce some output"
        );
    }

    #[test]
    fn spawn_honors_cwd() {
        let sh = sh_path();
        let manager = PtyManager::new();
        let cwd = std::env::current_dir().expect("current dir should exist");
        let id = manager
            .spawn(
                Some(sh),
                Some(cwd.to_string_lossy().into_owned()),
                80,
                24,
                Vec::new(),
                None,
                None,
            )
            .expect("spawn should succeed");

        // `pwd -P` prints the physical working directory; the child must have
        // started in `cwd`. Under the MSYS shell a Windows path like
        // `D:\...` is reported as `/d/...`, so only require the drive letter
        // and the last path segment to match (e.g. `/d/.../src-tauri`).
        let rx = manager.take_output(&id).expect("session has an output channel");
        manager
            .write(&id, b"pwd -P\n")
            .expect("write to pty should succeed");

        // Collect whatever the shell prints (the first chunk is typically the
        // ConPTY `ESC[6n` handshake) until we see the cwd or run out of time.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut printed = String::new();
        let expected = cwd.to_string_lossy().into_owned();
        let tail = std::path::Path::new(&expected)
            .file_name()
            .and_then(|name| name.to_str())
            .expect("cwd should have a file name");
        let drive = expected
            .chars()
            .next()
            .map(|c| c.to_ascii_lowercase())
            .unwrap_or_default();
        while std::time::Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(250)) {
                Ok(chunk) => printed.push_str(&String::from_utf8_lossy(&chunk)),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
            let lower = printed.to_ascii_lowercase();
            if lower.contains(&drive.to_string()) && lower.contains(&tail.to_ascii_lowercase()) {
                return;
            }
        }
        panic!(
            "expected pty cwd to reference '{}', got: {:?}",
            expected, printed
        );
    }
}
