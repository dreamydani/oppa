use portable_pty::{Child, CommandBuilder, MasterPty, PtyPair, PtySize};
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::sync::Arc;

/// Pick the platform's default shell.
///
/// On Windows the console's `COMSPEC` (cmd.exe by default) is preferred, with
/// `powershell.exe` as the fallback. Elsewhere `$SHELL` is honored when set and
/// non-empty; otherwise the first of `/bin/zsh`, `/bin/bash`, `/bin/sh` that
/// actually exists is used.
pub fn default_shell() -> String {
    #[cfg(target_os = "windows")]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".into())
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("SHELL")
            .ok()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| {
                ["/bin/zsh", "/bin/bash", "/bin/sh"]
                    .into_iter()
                    .find(|candidate| std::path::Path::new(candidate).exists())
                    .unwrap_or("/bin/sh")
                    .to_string()
            })
    }
}

/// A running PTY session: the master end, the shared input writer, the
/// spawned child, its geometry, and the flow-control state shared with the
/// manager's read loop.
///
/// The master is behind a `Mutex<Option<..>>` so the manager's watchdog can
/// close it (drop it) when the child exits — on Windows ConPTY the output
/// pipe does not EOF on child exit, and dropping the master is what unblocks
/// the read loop.
pub struct PtySession {
    pub id: String,
    pub master: Arc<parking_lot::Mutex<Option<Box<dyn MasterPty + Send>>>>,
    /// Shared with the manager's read loop (which also uses it for the
    /// ConPTY cursor-position handshake). Writes from `write()` and from the
    /// handshake are serialized through the mutex.
    pub writer: Arc<parking_lot::Mutex<Box<dyn std::io::Write + Send>>>,
    /// Shared with the manager's watchdog, which polls `try_wait` to detect
    /// child exit and then closes the master.
    pub child: Arc<parking_lot::Mutex<Box<dyn Child + Send + Sync>>>,
    pub cols: u16,
    pub rows: u16,
    pub pending_bytes: Arc<AtomicUsize>,
    pub paused: Arc<AtomicBool>,
}

impl PtySession {
    /// Spawn `shell` with `args` attached to the given `pair`'s slave end.
    ///
    /// `cwd` sets the child's working directory when provided.
    pub fn new(
        id: String,
        pair: PtyPair,
        shell: &str,
        args: &[String],
        cwd: Option<&str>,
        cols: u16,
        rows: u16,
    ) -> std::io::Result<Self> {
        let mut cmd = CommandBuilder::new(shell);
        cmd.args(args.iter().map(String::as_str));
        if let Some(cwd) = cwd {
            cmd.cwd(cwd);
        }
        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(std::io::Error::other)?;
        let writer = pair.master.take_writer().map_err(std::io::Error::other)?;
        Ok(Self {
            id,
            master: Arc::new(parking_lot::Mutex::new(Some(pair.master))),
            writer: Arc::new(parking_lot::Mutex::new(writer)),
            child: Arc::new(parking_lot::Mutex::new(child)),
            cols,
            rows,
            pending_bytes: Arc::new(AtomicUsize::new(0)),
            paused: Arc::new(AtomicBool::new(false)),
        })
    }

    /// Resize the PTY and update the recorded geometry.
    pub fn resize(&mut self, cols: u16, rows: u16) -> std::io::Result<()> {
        let master = self.master.lock();
        if let Some(master) = master.as_ref() {
            master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(std::io::Error::other)?;
        }
        self.cols = cols;
        self.rows = rows;
        Ok(())
    }

    /// Write input bytes to the PTY's input end.
    pub fn write(&self, data: &[u8]) -> std::io::Result<()> {
        self.writer.lock().write_all(data)
    }
}
