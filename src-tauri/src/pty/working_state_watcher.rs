use crate::pty::daemon_session::DaemonSession;
use crate::pty::ipc_protocol::DaemonEvent;
use std::sync::Arc;
use std::time::Duration;

// Sampling cadence: slow enough to debounce OSC-marker chatter, fast enough
// that dots feel live. Emission is edge-triggered, so steady state costs one
// comparison per tick — no polling storms reach subscribers.
pub const WORKING_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Start the per-session working/idle watcher thread: announces only flips
/// (subscribe() seeds new receivers with the live state) and exits once the
/// child is gone. Detached like the other session threads — the loop's own
/// is_alive check is its shutdown path.
pub fn spawn(session: Arc<DaemonSession>) {
    let id = session.id.clone();
    let _ = std::thread::Builder::new()
        .name(format!("working-watch-{id}"))
        .spawn(move || run(session));
}

/// Test seam: same loop, but the caller keeps the JoinHandle.
#[cfg(test)]
pub(crate) fn spawn_joinable(session: Arc<DaemonSession>) -> std::thread::JoinHandle<()> {
    let id = session.id.clone();
    std::thread::Builder::new()
        .name(format!("working-watch-{id}"))
        .spawn(move || run(session))
        .expect("spawn working-state watcher")
}

fn run(session: Arc<DaemonSession>) {
    // Baseline at spawn-time: subscribe() seeds every new receiver with the
    // live state, so the watcher itself only ever announces flips.
    let mut last_emitted = Some(session.working_state());
    while session.is_alive() {
        let working = session.working_state();
        if last_emitted != Some(working) {
            session.publish_event(DaemonEvent::SessionWorking {
                session_id: session.id.clone(),
                working,
            });
            last_emitted = Some(working);
        }
        std::thread::sleep(WORKING_POLL_INTERVAL);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::ipc_protocol::DaemonEvent;
    use std::time::{Duration, Instant};

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

    // Env override is process-global; restoring in Drop keeps sibling tests honest.
    struct IdleMsGuard;
    impl IdleMsGuard {
        fn set(ms: &str) -> Self {
            std::env::set_var("OPPA_IDLE_MS", ms);
            Self
        }
    }
    impl Drop for IdleMsGuard {
        fn drop(&mut self) {
            std::env::remove_var("OPPA_IDLE_MS");
        }
    }

    // The env var is shared by every test in this binary: hold the lock for a
    // test's whole override window so parallel siblings never see mixed values.
    static IDLE_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    fn idle_env_lock() -> std::sync::MutexGuard<'static, ()> {
        IDLE_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    async fn next_working(
        rx: &mut tokio::sync::mpsc::UnboundedReceiver<std::sync::Arc<DaemonEvent>>,
        timeout: Duration,
    ) -> Option<bool> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            match tokio::time::timeout(timeout.min(Duration::from_millis(300)), rx.recv()).await {
                Ok(Some(event)) => match event.as_ref() {
                    DaemonEvent::SessionWorking { working, .. } => return Some(*working),
                    _ => continue,
                },
                Ok(None) => return None,
                Err(_) => continue,
            }
        }
        None
    }

    #[tokio::test]
    async fn watcher_emits_initial_state_then_stays_quiet_without_flips() {
        let _env = idle_env_lock();
        let _guard = IdleMsGuard::set("60000");
        let sh = test_sh_path();
        let session = DaemonSession::spawn_with_args(
            "ws-watch-initial".into(),
            &sh,
            &[],
            None,
            80,
            24,
            None,
            &[],
        )
        .expect("spawn watcher shell");
        let mut rx = session.subscribe();

        // Huge threshold keeps the pane working: the first event must carry it
        assert_eq!(
            next_working(&mut rx, Duration::from_secs(2)).await,
            Some(true),
            "initial SessionWorking must arrive within ~2s matching working_state"
        );
        assert!(session.working_state());

        // Edge-triggered: no state change means no further events
        assert_eq!(
            next_working(&mut rx, Duration::from_millis(900)).await,
            None,
            "steady-state sampling must not emit duplicate events"
        );
        let _ = session.kill();
    }

    #[tokio::test]
    async fn watcher_emits_idle_transition_via_osc133_markers() {
        let _env = idle_env_lock();
        let _guard = IdleMsGuard::set("200");
        let sh = test_sh_path();
        let session = DaemonSession::spawn_with_args(
            "ws-watch-flip".into(),
            &sh,
            &[],
            None,
            80,
            24,
            None,
            &[],
        )
        .expect("spawn flip shell");
        let mut rx = session.subscribe();

        // Whatever the startup race yields, drain until the first event lands
        let initial = next_working(&mut rx, Duration::from_secs(2)).await;
        assert!(initial.is_some(), "initial SessionWorking must arrive");

        // C marker: foreground command starts → working (may equal initial, then no flip)
        session
            .write(b"printf '\\033]133;C;sleepy-job\\007'\n")
            .expect("write C marker");
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && !session.working_state() {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(session.working_state(), "C marker must mark the session working");

        // D marker + quiet past OPPA_IDLE_MS → the watcher must emit the flip
        session
            .write(b"printf '\\033]133;D\\007'\n")
            .expect("write D marker");
        let flipped = loop {
            match next_working(&mut rx, Duration::from_secs(5)).await {
                Some(false) => break true,
                Some(true) => continue,
                None => break false,
            }
        };
        assert!(flipped, "expected SessionWorking{{false}} after D marker + quiet");

        // Settled idle must stay edge-triggered: straggler prompt-repaint
        // output may legally flip the dot, but the same state can never be
        // emitted twice in a row (that would mean per-tick re-emission).
        let mut last_seen = false;
        let mut repeated_state = false;
        let window = Instant::now() + Duration::from_millis(900);
        while Instant::now() < window {
            match tokio::time::timeout(Duration::from_millis(150), rx.recv()).await {
                Ok(Some(event)) => match event.as_ref() {
                    DaemonEvent::SessionWorking { working, .. } => {
                        if *working == last_seen {
                            repeated_state = true;
                        }
                        last_seen = *working;
                    }
                    _ => {}
                },
                Ok(None) => break,
                Err(_) => continue,
            }
        }
        assert!(
            !repeated_state,
            "unchanged state must never be re-emitted back-to-back"
        );
        let _ = session.kill();
    }

    #[test]
    fn watcher_thread_exits_once_child_is_gone() {
        let _env = idle_env_lock();
        let _guard = IdleMsGuard::set("50");
        let sh = test_sh_path();
        let session = DaemonSession::spawn_with_args(
            "ws-watch-exit".into(),
            &sh,
            &["-c".into(), "echo bye".into()],
            None,
            80,
            24,
            None,
            &[],
        )
        .expect("spawn exiting shell");
        let handle = spawn_joinable(Arc::clone(&session));

        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && session.is_alive() {
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(!session.is_alive(), "child should have exited");
        let _ = session.kill();

        // The watcher polls is_alive each tick; joining from a helper thread
        // with a timeout proves it noticed and terminated instead of leaking.
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = handle.join();
            let _ = done_tx.send(());
        });
        assert!(
            done_rx
                .recv_timeout(Duration::from_secs(WORKING_POLL_INTERVAL.as_secs() + 3))
                .is_ok(),
            "watcher thread must exit once the child is gone"
        );
    }
}
