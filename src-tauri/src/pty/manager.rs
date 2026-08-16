use crate::pty::session::PtySession;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, PtySize};
use std::collections::HashMap;
use std::io::Read;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Arc;
use std::time::Duration;

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
/// `take_exit`. A later task replaces the output channel with the Tauri
/// emitter.
#[derive(Default)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<String, PtySession>>>,
    out_rx: Mutex<HashMap<String, Receiver<Vec<u8>>>>,
    exit_rx: Mutex<HashMap<String, Receiver<()>>>,
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

    /// Spawn `shell` with `args` in a fresh PTY, start its read loop, and
    /// return the new session id.
    ///
    /// Output chunks are pushed to the session's output channel; EOF/child
    /// exit fires the session's exit channel. A later task swaps the output
    /// channel for the Tauri emitter. Task 2 passes `"sh"` explicitly — no
    /// shell detection here.
    pub fn spawn(&self, shell: &str, args: &[&str], cols: u16, rows: u16) -> String {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("failed to open pty");

        let id = (self.next_id.fetch_add(1, Ordering::SeqCst) + 1).to_string();

        let (out_tx, out_rx) = channel::<Vec<u8>>();
        let (exit_tx, exit_rx) = channel::<()>();
        self.out_rx.lock().insert(id.clone(), out_rx);
        self.exit_rx.lock().insert(id.clone(), exit_rx);

        let session = PtySession::new(id.clone(), pair, shell, args, cols, rows)
            .expect("failed to spawn pty session");
        self.start_read_loop(&session, out_tx, exit_tx);
        self.sessions.lock().insert(id.clone(), session);

        id
    }

    fn start_read_loop(&self, session: &PtySession, out_tx: Sender<Vec<u8>>, exit_tx: Sender<()>) {
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
                        // A dropped receiver means no subscriber; keep reading
                        // and draining so the pty doesn't stall.
                        let _ = out_tx.send(chunk);
                    }
                    Err(_) => break,
                }
            }
            let _ = exit_tx.send(());
        });

        // Watchdog thread: on Windows ConPTY the output pipe does not EOF
        // when the child exits, so the blocked reader would never notice.
        // Poll the child; once it has exited, close (drop) the master, which
        // unblocks the reader with EOF and fires the exit signal.
        std::thread::spawn(move || {
            loop {
                let exited = child
                    .lock()
                    .try_wait()
                    .map(|status| status.is_some())
                    .unwrap_or(false);
                if exited {
                    master.lock().take();
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

    /// Whether the session's child process has exited.
    pub fn child_exited(&self, id: &str) -> bool {
        self.sessions
            .lock()
            .get_mut(id)
            .and_then(|session| session.child.lock().try_wait().ok().flatten())
            .is_some()
    }

    /// Take the session's output receiver (test/observation path; the Tauri
    /// emitter replaces it in a later task).
    pub fn take_output(&self, id: &str) -> Option<Receiver<Vec<u8>>> {
        self.out_rx.lock().remove(id)
    }

    /// Take the session's exit receiver.
    pub fn take_exit(&self, id: &str) -> Option<Receiver<()>> {
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
        let id = manager.spawn(&sh, &["-c", "echo hi"], 80, 24);
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
        let id = manager.spawn(&sh, &[], 80, 24);
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
        let id = manager.spawn(&sh, &[], 80, 24);
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
        let id = manager.spawn(&sh, &["-c", "exit 0"], 80, 24);
        assert!(manager.sessions().lock().contains_key(&id));

        let exit_rx = manager.take_exit(&id).expect("session has an exit channel");

        let saw_exit = exit_rx.recv_timeout(Duration::from_secs(5)).is_ok();
        assert!(saw_exit, "expected an exit signal after the child exited");
    }

    #[test]
    fn kill_tree() {
        let sh = sh_path();
        let manager = PtyManager::new();
        let id = manager.spawn(&sh, &["-c", "sleep 100"], 80, 24);
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
}
