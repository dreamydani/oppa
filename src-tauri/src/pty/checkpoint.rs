use crate::pty::agent_resume;
use crate::pty::daemon_session::{DaemonSession, SessionReaper};
use crate::pty::ipc_protocol::{
    ResumeKind, ResumePlan,
};
use crate::pty::snapshot::{SessionSnapshot, SnapshotStorage};
use parking_lot::Mutex;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{SystemTime, UNIX_EPOCH};
use crate::pty::daemon_server::{CHECKPOINT_INTERVAL, DaemonServer};


// Session checkpoints + cold-restore resume planning. Pure move.

impl DaemonServer {
    pub(crate) fn snapshot_foreground(checkpoint: &Option<SessionSnapshot>) -> Option<String> {
        checkpoint
            .as_ref()
            .and_then(|s| s.foreground_command.clone())
    }

    /// Enforces one-conversation-per-pane at restore. On an id collision the
    /// pane receives the next most recent unclaimed conversation for that
    /// agent (several same-project panes are common) rather than a fresh
    /// shell; only when no alternative exists does it fall back to relaunch.
    pub(crate) fn finalize_resume_plan(
        planned: &(Option<ResumePlan>, Option<String>, Option<String>),
        checkpoint: &Option<SessionSnapshot>,
        claimed: &Mutex<std::collections::HashSet<String>>,
    ) -> (Option<ResumePlan>, Option<String>, Option<String>) {
        let Some(agent_ref) = checkpoint.as_ref().and_then(|s| s.agent_session.as_ref()) else {
            return planned.clone();
        };
        let Some(plan) = &planned.0 else {
            return planned.clone();
        };
        if !matches!(plan.kind, ResumeKind::AgentResume) {
            return planned.clone();
        }
        let mut claimed = claimed.lock();
        if claimed.insert(agent_ref.id.clone()) {
            return planned.clone();
        }
        let fallback = || {
            let fg = Self::snapshot_foreground(checkpoint);
            (
                fg.clone()
                    .map(|cmd| ResumePlan { command_line: cmd, kind: ResumeKind::CommandRelaunch }),
                Some("conversation already resumed in another pane".to_string()),
                fg,
            )
        };
        let cwd = checkpoint
            .as_ref()
            .map(|s| s.cwd.clone())
            .unwrap_or_default();
        let alt_id = dirs::home_dir().and_then(|home| {
            agent_resume::recent_unclaimed_ids(
                &agent_ref.agent,
                &home,
                &cwd,
                &claimed,
                1,
            )
            .into_iter()
            .next()
        });
        let Some(alt_id) = alt_id else {
            return fallback();
        };
        let Some(cmd) = agent_resume::plan_resume(&crate::pty::snapshot::AgentSessionRef {
            agent: agent_ref.agent.clone(),
            id: alt_id.clone(),
            transcript_path: None,
        }) else {
            return fallback();
        };
        claimed.insert(alt_id);
        (
            Some(ResumePlan {
                command_line: cmd.clone(),
                kind: ResumeKind::AgentResume,
            }),
            Some(
                "original conversation open in another pane - resumed next most recent"
                    .to_string(),
            ),
            Some(cmd),
        )
    }

    // Resume priority: native resume by session id (hook, cwd-map or transcript
    // scan), then plain re-execution of the known-agent command. Unknown
    // programs are never re-executed. No blind "--continue": it pulls the
    // globally most recent conversation and duplicates it across panes.
    pub(crate) fn plan_resume_from_checkpoint(        checkpoint: &Option<SessionSnapshot>,
    ) -> (
        Option<ResumePlan>,
        Option<String>,
        Option<String>,
    ) {
        let Some(snap) = checkpoint else {
            return (None, None, None);
        };
        if let Some(agent_ref) = &snap.agent_session {
            if let Some(cmd) = agent_resume::plan_resume(agent_ref) {
                return (
                    Some(ResumePlan {
                        command_line: cmd.clone(),
                        kind: ResumeKind::AgentResume,
                    }),
                    None,
                    Some(cmd),
                );
            }
        }
        if let Some(cmd) = &snap.foreground_command {
            if agent_resume::is_known_agent_program(cmd) {
                // No id captured: plain relaunch. Never blind-continue —
                // "--continue" pulls the globally most recent conversation,
                // which duplicates it across every pane (user-reported bug).
                return (
                    Some(ResumePlan {
                        command_line: cmd.clone(),
                        kind: ResumeKind::CommandRelaunch,
                    }),
                    Some("no verified resume command for this agent".into()),
                    Some(cmd.clone()),
                );
            }
        }
        (None, None, None)
    }

    pub(crate)     fn build_checkpoint(session: &DaemonSession) -> SessionSnapshot {
        let cwd = session.cwd().unwrap_or_default();
        let foreground_command = session.foreground_command();

        // Tier 1: hook payloads — authoritative per pane, never overwritten.
        if !*session.agent_ref_from_hook.lock() {
            // Tier 2: an id the user explicitly passed on the command line
            // (`agy --conversation X`, `claude --resume Y`, ...) IS the
            // conversation running in this pane. Stronger than the shared
            // project cwd-map, which other same-directory panes also follow.
            let explicit = foreground_command
                .as_deref()
                .and_then(agent_resume::explicit_id_from_command);
            if let Some(explicit) = explicit {
                *session.agent_session_ref.lock() = Some(explicit);
                *session.agent_ref_from_hook.lock() = true;
            } else {
                // Tier 3: scan-tier refresh from cwd-map / transcript store so
                // /resume or new conversations stay fresh while the agent runs.
                if let Some(cmd) = &foreground_command {
                    if let Some(captured) = agent_resume::capture_agent_session(cmd, &cwd) {
                        *session.agent_session_ref.lock() = Some(captured);
                    }
                }
            }
        }
        let agent_session = session.agent_session_ref.lock().clone();
        SessionSnapshot {
            session_id: session.id.clone(),
            cwd,
            title: session.title(),
            cols: session.cols(),
            rows: session.rows(),
            persona_id: None,
            scrollback: session.get_snapshot(),
            timestamp: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            foreground_command,
            agent_session,
            worktree_id: session.worktree_id.clone(),
            agent_status: session.agent_status(),
            title_pinned: *session.title_pinned.lock(),
            topic_set: *session.topic_set.lock(),
            idle_title: Some(session.idle_title()),
        }
    }

    /// Cheap idle check over every small checkpoint field EXCEPT the viewport
    /// render. Equal fingerprints prove build_checkpoint would hash
    /// identically, so the task can skip the ~30-400KB transient entirely.
    /// Errs toward rebuilding (extra fields like agent_session only cause
    /// false positives, never a missed save); scrollback changes always bump
    /// seq via the batcher, so no output change slips through.
    pub(crate) fn checkpoint_fingerprint(session: &DaemonSession) -> u64 {
        let mut hasher = DefaultHasher::new();
        session.seq.load(Ordering::SeqCst).hash(&mut hasher);
        session.cols().hash(&mut hasher);
        session.rows().hash(&mut hasher);
        session.cwd().hash(&mut hasher);
        session.foreground_command().hash(&mut hasher);
        session.agent_session_ref.lock().clone().hash(&mut hasher);
        session.title().hash(&mut hasher);
        (*session.title_pinned.lock()).hash(&mut hasher);
        (*session.topic_set.lock()).hash(&mut hasher);
        session.idle_title().hash(&mut hasher);
        session.agent_status().hash(&mut hasher);
        hasher.finish()
    }

    /// Decision gate for the checkpoint task: true when a fresh snapshot may
    /// differ from the last pass (updates `last` on change).
    pub(crate) fn should_checkpoint(last: &mut Option<u64>, session: &DaemonSession) -> bool {
        let fingerprint = Self::checkpoint_fingerprint(session);
        if *last == Some(fingerprint) {
            return false;
        }
        *last = Some(fingerprint);
        true
    }

    // Skip unchanged writes: a quiet pane rewrites identical content forever otherwise
    pub(crate) fn checkpoint_hash(snapshot: &SessionSnapshot) -> u64 {
        let mut hasher = DefaultHasher::new();
        snapshot.scrollback.hash(&mut hasher);
        snapshot.cwd.hash(&mut hasher);
        snapshot.foreground_command.hash(&mut hasher);
        // Title state flips are content changes too, or a fresh pin would
        // wait for the next scrollback change before reaching disk.
        snapshot.title.hash(&mut hasher);
        snapshot.title_pinned.hash(&mut hasher);
        snapshot.topic_set.hash(&mut hasher);
        // State flips are content changes even when scrollback stands still,
        // or a finished pill would stay stale until the next text output.
        snapshot.agent_status.hash(&mut hasher);
        hasher.finish()
    }

    /// Exit hook installed on every spawned session: the watchdog calls it
    /// once the child is gone. Final checkpoint first (tail precedes Exit on
    /// disk for cold restore), then drop the map entry — dead RAM must not
    /// outlive the child. Reattach-after-exit cold-boots from the kept file.
    pub(crate) fn session_reaper(&self) -> SessionReaper {
        let sessions = Arc::clone(&self.sessions);
        let snapshot_dir = self.snapshot_dir.clone();
        Arc::new(move |session: &DaemonSession| {
            if let Some(dir) = snapshot_dir.as_ref() {
                let snapshot = Self::build_checkpoint(session);
                let _ = SnapshotStorage::new(dir.clone()).save_snapshot(&snapshot);
            }
            let _ = sessions.lock().remove(session.id.as_str());
        })
    }

    pub(crate) fn start_checkpoint_task(session: Arc<DaemonSession>, app_data_dir: PathBuf) {
        tokio::spawn(async move {
            let storage = SnapshotStorage::new(app_data_dir);
            let mut last_hash: Option<u64> = None;
            let mut last_fingerprint: Option<u64> = None;
            loop {
                tokio::time::sleep(CHECKPOINT_INTERVAL).await;
                if !session.is_alive() {
                    break;
                }
                // Idle skip: the viewport render below allocates ~30-400KB of
                // transient strings every tick per session even when nothing
                // changed. The fingerprint covers every small checkpoint field,
                // so equality proves build_checkpoint would hash identically.
                if !Self::should_checkpoint(&mut last_fingerprint, &session) {
                    continue;
                }
                let snapshot = Self::build_checkpoint(&session);
                let hash = Self::checkpoint_hash(&snapshot);
                if Some(hash) == last_hash {
                    continue;
                }
                if storage.save_snapshot(&snapshot).is_ok() {
                    last_hash = Some(hash);
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn test_sh_path() -> String {
        if let Some(found) = std::env::var_os("PATH").and_then(|path| {
            std::env::split_paths(&path)
                .map(|dir| dir.join("sh.exe"))
                .find(|candidate| candidate.exists())
        }) {
            return found.to_string_lossy().into_owned();
        }
        "sh".to_string()
    }

    #[tokio::test]
    async fn checkpoint_fingerprint_skips_idle_sessions() {
        let session = DaemonSession::spawn_with_args(
            "fp-idle".into(),
            &test_sh_path(),
            &[],
            None,
            80,
            24,
            None,
            &[],
        )
        .expect("spawn shell");
        let mut last = None;
        assert!(
            DaemonServer::should_checkpoint(&mut last, &session),
            "first pass must checkpoint"
        );
        assert!(
            !DaemonServer::should_checkpoint(&mut last, &session),
            "idle session must skip the viewport render"
        );
        let _ = session.kill();
    }

    #[tokio::test]
    async fn checkpoint_fingerprint_moves_on_output() {
        let session = DaemonSession::spawn_with_args(
            "fp-output".into(),
            &test_sh_path(),
            &[],
            None,
            80,
            24,
            None,
            &[],
        )
        .expect("spawn shell");
        let mut last = None;
        assert!(DaemonServer::should_checkpoint(&mut last, &session));
        assert!(!DaemonServer::should_checkpoint(&mut last, &session));
        session
            .write(b"echo fp-marker-12345\n")
            .expect("write echo");
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if DaemonServer::should_checkpoint(&mut last, &session) {
                break;
            }
            assert!(Instant::now() < deadline, "output must move the fingerprint");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let _ = session.kill();
    }
}

