use crate::pty::agent_resume;
use crate::pty::daemon_session::DaemonSession;
use crate::pty::ipc_protocol::{
    ResumeKind, ResumePlan,
};
use crate::pty::snapshot::{SessionSnapshot, SnapshotStorage};
use parking_lot::Mutex;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::Arc;
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
        }
    }

    // Skip unchanged writes: a quiet pane rewrites identical content forever otherwise
    pub(crate) fn checkpoint_hash(snapshot: &SessionSnapshot) -> u64 {
        let mut hasher = DefaultHasher::new();
        snapshot.scrollback.hash(&mut hasher);
        snapshot.cwd.hash(&mut hasher);
        snapshot.foreground_command.hash(&mut hasher);
        hasher.finish()
    }

    pub(crate) fn start_checkpoint_task(session: Arc<DaemonSession>, app_data_dir: PathBuf) {
        tokio::spawn(async move {
            let storage = SnapshotStorage::new(app_data_dir);
            let mut last_hash: Option<u64> = None;
            loop {
                tokio::time::sleep(CHECKPOINT_INTERVAL).await;
                if !session.is_alive() {
                    break;
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

