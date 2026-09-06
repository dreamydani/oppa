use crate::pty::daemon_session::DaemonSession;
use std::sync::Arc;
use std::time::Duration;

// Sampling cadence shared with the working-state watcher; the stability gate
// (~1s) keeps short commands (ls, cd) from ever touching titles, so the
// header and sidebar never flicker. Emission reuses the session announcer,
// which is itself edge-triggered.
pub const TITLE_POLL_INTERVAL: Duration = Duration::from_millis(250);
const STABLE_TICKS: u32 = 4;

/// Start the per-session title watcher thread: generic foreground commands
/// retitle the pane while stable, idle reverts to the birth name. Detached
/// like the other session threads — the loop's own is_alive check is its
/// shutdown path.
pub fn spawn(session: Arc<DaemonSession>) {
    let id = session.id.clone();
    let _ = std::thread::Builder::new()
        .name(format!("title-watch-{id}"))
        .spawn(move || run(session));
}

/// Test seam: same loop, but the caller keeps the JoinHandle.
#[cfg(test)]
pub(crate) fn spawn_joinable(session: Arc<DaemonSession>) -> std::thread::JoinHandle<()> {
    let id = session.id.clone();
    std::thread::Builder::new()
        .name(format!("title-watch-{id}"))
        .spawn(move || run(session))
        .expect("spawn title watcher")
}

// The watcher owns generic commands only: agents resolve to display names via
// the reader thread, and pins/topics always win. None = stand down.
fn generic_title_for(session: &DaemonSession, cmdline: &str) -> Option<String> {
    if session.auto_title_locked() || cmdline.trim().is_empty() {
        return None;
    }
    if crate::pty::agent_resume::display_name_for_command(cmdline).is_some() {
        return None;
    }
    crate::pty::friendly_name::generic_title_from_command(cmdline)
        .map(|t| crate::pty::ipc_protocol::sanitize_session_title(&t))
        .filter(|t| !t.is_empty())
}

fn run(session: Arc<DaemonSession>) {
    let mut stable_cmd: Option<String> = None;
    let mut stable_ticks = 0u32;
    let mut applied: Option<String> = None;
    while session.is_alive() {
        match session.foreground_command() {
            None => {
                // Revert only our own generic title; manual/topic titles stand
                // (a pin or topic always changes the title first).
                if let Some(last) = applied.take() {
                    if session.title().as_deref() == Some(last.as_str()) {
                        session.revert_to_idle_title();
                    }
                }
                stable_cmd = None;
                stable_ticks = 0;
            }
            Some(cmd) => match generic_title_for(&session, &cmd) {
                None => {
                    stable_cmd = None;
                    stable_ticks = 0;
                }
                Some(title) => {
                    if stable_cmd.as_deref() == Some(cmd.as_str()) {
                        stable_ticks += 1;
                    } else {
                        stable_cmd = Some(cmd);
                        stable_ticks = 1;
                    }
                    if stable_ticks >= STABLE_TICKS
                        && (session.title().as_deref() == Some(title.as_str())
                            || session.announce_title(title.clone()))
                    {
                        applied = Some(title);
                    }
                }
            },
        }
        std::thread::sleep(TITLE_POLL_INTERVAL);
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

    fn spawn_titled(id: &str) -> Arc<DaemonSession> {
        let session = DaemonSession::spawn_with_args(
            id.into(),
            &test_sh_path(),
            &[],
            None,
            80,
            24,
            None,
            &[],
        )
        .expect("spawn title shell");
        session.seed_birth_title("fox".into());
        let _handle = spawn_joinable(Arc::clone(&session));
        session
    }

    fn poll_title(session: &DaemonSession, want: Option<&str>, timeout: Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        while std::time::Instant::now() < deadline {
            if session.title().as_deref() == want {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    #[test]
    fn generic_title_for_ignores_agents_pins_and_empties() {
        let session = spawn_titled("tw-pure");
        assert_eq!(
            generic_title_for(&session, "npm run dev").as_deref(),
            Some("npm run dev")
        );
        assert_eq!(generic_title_for(&session, "opencode"), None);
        assert_eq!(generic_title_for(&session, ""), None);
        assert_eq!(generic_title_for(&session, "   "), None);
        session.pin_title();
        assert_eq!(generic_title_for(&session, "npm run dev"), None);
        let _ = session.kill();
    }

    #[test]
    fn stable_generic_command_retitles_then_reverts_on_end() {
        let session = spawn_titled("tw-stable");
        session
            .write(b"printf '\\033]133;C;npm run dev\\007'\n")
            .expect("write C marker");
        assert!(
            poll_title(&session, Some("npm run dev"), Duration::from_secs(5)),
            "stable generic command must retitle, got {:?}",
            session.title()
        );
        session
            .write(b"printf '\\033]133;D\\007'\n")
            .expect("write D marker");
        assert!(
            poll_title(&session, Some("fox"), Duration::from_secs(5)),
            "command end must revert to the birth name, got {:?}",
            session.title()
        );
        let _ = session.kill();
    }

    #[test]
    fn short_command_never_retitles() {
        let session = spawn_titled("tw-short");
        session
            .write(b"printf '\\033]133;C;ls\\007'\n")
            .expect("write C marker");
        std::thread::sleep(Duration::from_millis(100));
        session
            .write(b"printf '\\033]133;D\\007'\n")
            .expect("write D marker");
        std::thread::sleep(Duration::from_millis(1800));
        assert_eq!(session.title().as_deref(), Some("fox"));
        let _ = session.kill();
    }

    #[test]
    fn pinned_session_ignores_generic_commands() {
        let session = spawn_titled("tw-pinned");
        session.set_title("Build Output".into());
        session.pin_title();
        session
            .write(b"printf '\\033]133;C;npm run dev\\007'\n")
            .expect("write C marker");
        std::thread::sleep(Duration::from_millis(1800));
        assert_eq!(session.title().as_deref(), Some("Build Output"));
        let _ = session.kill();
    }
}
