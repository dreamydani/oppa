use crate::git::teardown::{session_cwd_inside, LiveSession};
use crate::git::worktree_lineage::lineage_list;
use crate::git::worktree_registry::WorktreeRegistry;
use crate::git::worktrees::{
    repo_add, worktree_create, worktree_current, worktree_list, worktree_purge, worktree_remove,
    worktree_set, worktree_show, WorktreeCreateRequest,
};
use crate::pty::agent_resume;
use crate::pty::daemon_session::DaemonSession;
use crate::pty::ipc_protocol::{
    CreateOrAttachResult, DaemonEvent, DaemonRequest, DaemonResponse, ResumeKind, ResumePlan,
    WorktreePsEntry, DAEMON_PROTOCOL_VERSION,
};
use crate::pty::runtime_metadata;
use crate::pty::snapshot::{SessionSnapshot, SnapshotStorage};
use parking_lot::Mutex;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::sync::{broadcast, Notify};

const CHECKPOINT_INTERVAL: Duration = Duration::from_secs(3);
// Bounded so a stalled client cannot grow memory; lagged receivers resync by design
const GLOBAL_EVENT_CAPACITY: usize = 64;
const REGISTRY_UNAVAILABLE: &str = "registry unavailable";

/// Simple cancellation token for graceful shutdown of async listeners and sessions.
#[derive(Clone, Default)]
pub struct CancellationToken {
    notify: Arc<Notify>,
    cancelled: Arc<AtomicBool>,
}

impl CancellationToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }
        self.notify.notified().await;
    }
}

/// Detached Daemon Server managing active terminal sessions and IPC request routing.
pub struct DaemonServer {
    sessions: Arc<Mutex<HashMap<String, Arc<DaemonSession>>>>,
    // App data dir for periodic session checkpoints; None skips persistence (tests)
    snapshot_dir: Option<PathBuf>,
    // Conversation ids already resumed since this daemon booted: a conversation
    // may be open in at most one pane (second claimant falls back to relaunch)
    resumed_agent_ids: Arc<Mutex<std::collections::HashSet<String>>>,
    // Some(snapshot_dir/worktrees.json) enables the repo/worktree request surface
    worktree_registry_path: Option<PathBuf>,
    // Set only when the discovery file was written; None keeps the pipe unauthenticated
    auth_token: Option<String>,
    global_events: broadcast::Sender<DaemonEvent>,
}

impl Default for DaemonServer {
    fn default() -> Self {
        Self::new()
    }
}

impl DaemonServer {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            snapshot_dir: None,
            resumed_agent_ids: Arc::new(Mutex::new(std::collections::HashSet::new())),
            worktree_registry_path: None,
            auth_token: None,
            global_events: broadcast::channel(GLOBAL_EVENT_CAPACITY).0,
        }
    }

    pub fn with_snapshot_storage(app_data_dir: PathBuf) -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            snapshot_dir: Some(app_data_dir.clone()),
            resumed_agent_ids: Arc::new(Mutex::new(std::collections::HashSet::new())),
            worktree_registry_path: Some(app_data_dir.join("worktrees.json")),
            auth_token: None,
            global_events: broadcast::channel(GLOBAL_EVENT_CAPACITY).0,
        }
    }

    pub fn set_auth_token(&mut self, token: Option<String>) {
        self.auth_token = token;
    }

    pub fn subscribe_global_events(&self) -> broadcast::Receiver<DaemonEvent> {
        self.global_events.subscribe()
    }

    #[allow(dead_code)]
    pub fn sessions(&self) -> Arc<Mutex<HashMap<String, Arc<DaemonSession>>>> {
        Arc::clone(&self.sessions)
    }

    /// Dispatch a single DaemonRequest to the session registry.
    pub fn handle_request(&self, req: DaemonRequest) -> DaemonResponse {
        match req {
            DaemonRequest::Hello { auth_token, .. } => {
                let supplied = auth_token.unwrap_or_default();
                // M1: only a mismatching non-empty token rejects — pre-v3
                // renderers (task 6 wires token sending) must keep connecting.
                let rejected = self
                    .auth_token
                    .as_deref()
                    .is_some_and(|expected| !supplied.is_empty() && supplied != expected);
                if rejected {
                    DaemonResponse::Error("unauthorized".into())
                } else {
                    DaemonResponse::HelloOk {
                        protocol_version: DAEMON_PROTOCOL_VERSION,
                    }
                }
            }
            DaemonRequest::CreateOrAttach {
                session_id,
                cols,
                rows,
                cwd,
                shell,
                resume_agents,
                worktree_id,
                extra_env,
            } => {
                let mut sessions = self.sessions.lock();
                if let Some(session) = sessions.get(&session_id) {
                    if cols > 0 && rows > 0 && (session.cols() != cols || session.rows() != rows) {
                        let _ = session.resize(cols, rows);
                    }
                    let snapshot = session.get_snapshot();
                    DaemonResponse::SessionAttached(CreateOrAttachResult {
                        is_new: false,
                        pid: session.pid(),
                        cols: session.cols(),
                        rows: session.rows(),
                        cwd: session.cwd(),
                        snapshot: Some(snapshot),
                        resume: None,
                        resume_declined_reason: None,
                    })
                } else {
                    // Cold restore: consult the disk checkpoint for agent resume state
                    let checkpoint = self.snapshot_dir.as_ref().and_then(|dir| {
                        SnapshotStorage::new(dir.clone())
                            .load_snapshot(&session_id)
                            .ok()
                            .flatten()
                    });
                    let (resume, declined, initial_command) = if resume_agents {
                        let planned = Self::plan_resume_from_checkpoint(&checkpoint);
                        Self::finalize_resume_plan(&planned, &checkpoint, &self.resumed_agent_ids)
                    } else {
                        (None, None, None)
                    };
                    let spawn_cwd = cwd.or_else(|| {
                        checkpoint
                            .as_ref()
                            .map(|s| s.cwd.clone())
                            .filter(|c| !c.is_empty())
                    });
                    let worktree_bindings = match self.resolve_worktree_bindings(
                        &checkpoint,
                        worktree_id.as_deref(),
                        &session_id,
                    ) {
                        Ok(bindings) => bindings,
                        Err(e) => return DaemonResponse::Error(e),
                    };
                    let mut env_bindings = worktree_bindings;
                    env_bindings.extend(extra_env);
                    match DaemonSession::spawn(
                        session_id.clone(),
                        shell,
                        spawn_cwd,
                        cols,
                        rows,
                        initial_command.as_deref(),
                        &env_bindings,
                    ) {
                        Ok(session) => {
                            let pid = session.pid();
                            let session_cols = session.cols();
                            let session_rows = session.rows();
                            let session_cwd = session.cwd();
                            if let Some(dir) = &self.snapshot_dir {
                                Self::start_checkpoint_task(Arc::clone(&session), dir.clone());
                            }
                            sessions.insert(session_id, Arc::clone(&session));
                            DaemonResponse::SessionAttached(CreateOrAttachResult {
                                is_new: true,
                                pid,
                                cols: session_cols,
                                rows: session_rows,
                                cwd: session_cwd,
                                snapshot: None,
                                resume,
                                resume_declined_reason: declined,
                            })
                        }
                        Err(e) => DaemonResponse::Error(e),
                    }
                }
            }
            DaemonRequest::Write { session_id, data } => {
                let session = self.sessions.lock().get(&session_id).cloned();
                if let Some(session) = session {
                    match session.write(data.as_bytes()) {
                        Ok(()) => DaemonResponse::Ok,
                        Err(e) => DaemonResponse::Error(e.to_string()),
                    }
                } else {
                    DaemonResponse::Error(format!("session {session_id} not found"))
                }
            }
            DaemonRequest::Resize {
                session_id,
                cols,
                rows,
            } => {
                let session = self.sessions.lock().get(&session_id).cloned();
                if let Some(session) = session {
                    match session.resize(cols, rows) {
                        Ok(()) => DaemonResponse::Ok,
                        Err(e) => DaemonResponse::Error(e),
                    }
                } else {
                    DaemonResponse::Error(format!("session {session_id} not found"))
                }
            }
            DaemonRequest::Ack { session_id, chars } => {
                let session = self.sessions.lock().get(&session_id).cloned();
                if let Some(session) = session {
                    match session.ack(chars) {
                        Ok(()) => DaemonResponse::Ok,
                        Err(e) => DaemonResponse::Error(e),
                    }
                } else {
                    DaemonResponse::Error(format!("session {session_id} not found"))
                }
            }
            DaemonRequest::Kill { session_id } => {
                let mut sessions = self.sessions.lock();
                if let Some(session) = sessions.remove(&session_id) {
                    let _ = session.kill();
                    DaemonResponse::Ok
                } else {
                    DaemonResponse::Error(format!("session {session_id} not found"))
                }
            }
            DaemonRequest::ListSessions => {
                let sessions = self.sessions.lock();
                let keys: Vec<String> = sessions.keys().cloned().collect();
                DaemonResponse::SessionList(keys)
            }
            DaemonRequest::Disconnect => DaemonResponse::Ok,
            DaemonRequest::Shutdown => {
                // Flush final checkpoints before killing: after drain the mirror is gone
                if let Some(dir) = &self.snapshot_dir {
                    let storage = SnapshotStorage::new(dir.clone());
                    for (_, session) in self.sessions.lock().iter() {
                        let _ = storage.save_snapshot(&Self::build_checkpoint(session));
                    }
                    // Best-effort: a stale discovery file must not outlive the daemon
                    runtime_metadata::remove_runtime_metadata(dir);
                }
                let mut sessions = self.sessions.lock();
                for (_, session) in sessions.drain() {
                    let _ = session.kill();
                }
                DaemonResponse::Ok
            }
            DaemonRequest::RepoAdd { path } => match self.worktree_registry_path.as_deref() {
                Some(registry_path) => match repo_add(registry_path, Path::new(&path)) {
                    Ok(record) => DaemonResponse::RepoRecords(vec![record]),
                    Err(e) => DaemonResponse::Error(e),
                },
                None => DaemonResponse::Error(REGISTRY_UNAVAILABLE.into()),
            },
            DaemonRequest::RepoList => match self.worktree_registry_path.as_deref() {
                Some(registry_path) => {
                    let mut repos: Vec<_> =
                        WorktreeRegistry::load(registry_path).repos.into_values().collect();
                    repos.sort_by(|a, b| a.repo_id.cmp(&b.repo_id));
                    DaemonResponse::RepoRecords(repos)
                }
                None => DaemonResponse::Error(REGISTRY_UNAVAILABLE.into()),
            },
            DaemonRequest::WorktreeCreate {
                repo_path,
                name,
                branch,
                base_ref,
                parent_worktree_id,
                workspace_dir,
                nest_workspaces,
            } => match self.worktree_registry_path.as_deref() {
                Some(registry_path) => {
                    let req = WorktreeCreateRequest {
                        repo_path: PathBuf::from(repo_path),
                        name,
                        branch,
                        base_ref,
                        parent_worktree_id,
                        workspace_dir_override: workspace_dir.map(PathBuf::from),
                        nest_workspaces: nest_workspaces.unwrap_or(false),
                    };
                    match worktree_create(registry_path, req) {
                        Ok((record, _warnings)) => {
                            self.publish_global(DaemonEvent::WorktreeChanged {
                                id: Some(record.id.clone()),
                            });
                            DaemonResponse::WorktreeRecordOne(Some(record))
                        }
                        Err(e) => DaemonResponse::Error(e),
                    }
                }
                None => DaemonResponse::Error(REGISTRY_UNAVAILABLE.into()),
            },
            DaemonRequest::WorktreeList => match self.worktree_registry_path.as_deref() {
                Some(registry_path) => DaemonResponse::WorktreeRecords(worktree_list(registry_path)),
                None => DaemonResponse::Error(REGISTRY_UNAVAILABLE.into()),
            },
            DaemonRequest::WorktreeShow { id } => match self.worktree_registry_path.as_deref() {
                Some(registry_path) => match worktree_show(registry_path, &id) {
                    Ok(record) => DaemonResponse::WorktreeRecordOne(Some(record)),
                    Err(e) => DaemonResponse::Error(e),
                },
                None => DaemonResponse::Error(REGISTRY_UNAVAILABLE.into()),
            },
            DaemonRequest::WorktreeCurrent { cwd } => match self.worktree_registry_path.as_deref()
            {
                Some(registry_path) => DaemonResponse::WorktreeRecordOne(worktree_current(
                    registry_path,
                    Path::new(&cwd),
                )),
                None => DaemonResponse::Error(REGISTRY_UNAVAILABLE.into()),
            },
            DaemonRequest::WorktreeSet {
                id,
                set_parent,
                parent_worktree_id,
                workspace_status,
                display_name,
            } => match self.worktree_registry_path.as_deref() {
                Some(registry_path) => {
                    let parent = if set_parent { Some(parent_worktree_id) } else { None };
                    match worktree_set(registry_path, &id, parent, workspace_status, display_name) {
                        Ok(record) => {
                            self.publish_global(DaemonEvent::WorktreeChanged {
                                id: Some(record.id.clone()),
                            });
                            DaemonResponse::WorktreeRecordOne(Some(record))
                        }
                        Err(e) => DaemonResponse::Error(e),
                    }
                }
                None => DaemonResponse::Error(REGISTRY_UNAVAILABLE.into()),
            },
            DaemonRequest::WorktreeRemove {
                id,
                force,
                delete_branch,
            } => match self.worktree_registry_path.as_deref() {
                Some(registry_path) => {
                    let live_sessions = self.live_sessions();
                    match worktree_remove(registry_path, &id, force, delete_branch, &live_sessions)
                    {
                        Ok(_warnings) => {
                            self.publish_global(DaemonEvent::WorktreeChanged { id: Some(id) });
                            DaemonResponse::Ok
                        }
                        Err(e) => DaemonResponse::Error(e),
                    }
                }
                None => DaemonResponse::Error(REGISTRY_UNAVAILABLE.into()),
            },
            DaemonRequest::WorktreePurge { id } => match self.worktree_registry_path.as_deref() {
                Some(registry_path) => match worktree_purge(registry_path, &id) {
                    Ok(()) => {
                        self.publish_global(DaemonEvent::WorktreeChanged { id: Some(id) });
                        DaemonResponse::Ok
                    }
                    Err(e) => DaemonResponse::Error(e),
                },
                None => DaemonResponse::Error(REGISTRY_UNAVAILABLE.into()),
            },
            DaemonRequest::WorktreePs => match self.worktree_registry_path.as_deref() {
                Some(registry_path) => {
                    let live_sessions = self.live_sessions();
                    let mut entries: Vec<WorktreePsEntry> = WorktreeRegistry::load(registry_path)
                        .worktrees
                        .into_values()
                        .filter(|record| !record.retired)
                        .map(|record| {
                            let live_count = live_sessions
                                .iter()
                                .filter(|session| {
                                    session.worktree_id.as_deref() == Some(record.id.as_str())
                                        || session
                                            .cwd
                                            .as_deref()
                                            .map(|cwd| session_cwd_inside(cwd, &record))
                                            .unwrap_or(false)
                                })
                                .count() as u32;
                            WorktreePsEntry {
                                record,
                                live_sessions: live_count,
                            }
                        })
                        .collect();
                    entries.sort_by(|a, b| {
                        a.record.created_at_ms.cmp(&b.record.created_at_ms).then(a.record.id.cmp(&b.record.id))
                    });
                    DaemonResponse::WorktreePsEntries(entries)
                }
                None => DaemonResponse::Error(REGISTRY_UNAVAILABLE.into()),
            },
            DaemonRequest::WorktreeLineage { id } => match self.worktree_registry_path.as_deref() {
                Some(registry_path) => {
                    let registry = WorktreeRegistry::load(registry_path);
                    match lineage_list(&registry, &id) {
                        Ok(records) => DaemonResponse::WorktreeRecordsList(records),
                        Err(e) => DaemonResponse::Error(e),
                    }
                }
                None => DaemonResponse::Error(REGISTRY_UNAVAILABLE.into()),
            },
        }
    }

    fn publish_global(&self, event: DaemonEvent) {
        let _ = self.global_events.send(event);
    }

    // Requested id is strict (unknown id errors); a checkpoint id restores
    // identity even if the registry no longer holds the record.
    fn resolve_worktree_bindings(
        &self,
        checkpoint: &Option<SessionSnapshot>,
        requested: Option<&str>,
        session_id: &str,
    ) -> Result<Vec<(String, String)>, String> {
        let effective = match requested {
            Some(id) => Some((id.to_string(), true)),
            None => checkpoint
                .as_ref()
                .and_then(|s| s.worktree_id.clone())
                .map(|id| (id, false)),
        };
        let Some((worktree_id, strict)) = effective else {
            return Ok(Vec::new());
        };
        let record = self.worktree_registry_path.as_deref().and_then(|path| {
            WorktreeRegistry::load(path)
                .worktrees
                .get(&worktree_id)
                .cloned()
        });
        if record.is_none() && strict && self.worktree_registry_path.is_some() {
            return Err(format!("worktree not found: {worktree_id}"));
        }
        let mut bindings = vec![("OPPA_WORKTREE_ID".to_string(), worktree_id)];
        if let Some(record) = record {
            bindings.push(("OPPA_WORKTREE_BRANCH".to_string(), record.branch));
            bindings.push((
                "OPPA_WORKTREE_PATH".to_string(),
                record.path.to_string_lossy().into_owned(),
            ));
        }
        bindings.push(("OPPA_TAB_ID".to_string(), session_id.to_string()));
        Ok(bindings)
    }

    fn live_sessions(&self) -> Vec<LiveSession> {
        self.sessions
            .lock()
            .iter()
            .map(|(session_id, session)| LiveSession {
                session_id: session_id.clone(),
                cwd: session.cwd(),
                worktree_id: session.worktree_id.clone(),
            })
            .collect()
    }

    /// Run the server listener on the designated platform socket.
    pub async fn run_listener(
        &self,
        socket_path: &str,
        cancel_token: CancellationToken,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        let server = Arc::new(Self {
            sessions: Arc::clone(&self.sessions),
            snapshot_dir: self.snapshot_dir.clone(),
            resumed_agent_ids: Arc::clone(&self.resumed_agent_ids),
            worktree_registry_path: self.worktree_registry_path.clone(),
            auth_token: self.auth_token.clone(),
            global_events: self.global_events.clone(),
        });
        run_server_listener(server, socket_path, cancel_token).await
    }

    fn snapshot_foreground(checkpoint: &Option<SessionSnapshot>) -> Option<String> {
        checkpoint
            .as_ref()
            .and_then(|s| s.foreground_command.clone())
    }

    /// Enforces one-conversation-per-pane at restore. On an id collision the
    /// pane receives the next most recent unclaimed conversation for that
    /// agent (several same-project panes are common) rather than a fresh
    /// shell; only when no alternative exists does it fall back to relaunch.
    fn finalize_resume_plan(
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
    fn plan_resume_from_checkpoint(        checkpoint: &Option<SessionSnapshot>,
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
            title: None,
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
    fn checkpoint_hash(snapshot: &SessionSnapshot) -> u64 {
        let mut hasher = DefaultHasher::new();
        snapshot.scrollback.hash(&mut hasher);
        snapshot.cwd.hash(&mut hasher);
        snapshot.foreground_command.hash(&mut hasher);
        hasher.finish()
    }

    fn start_checkpoint_task(session: Arc<DaemonSession>, app_data_dir: PathBuf) {
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

/// Handle bidirectional JSON communication with a single connected client stream.
pub async fn handle_client_stream<S>(
    stream: S,
    server: Arc<DaemonServer>,
    cancel_token: CancellationToken,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (read_half, mut write_half) = tokio::io::split(stream);
    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel::<String>(256);
    // Global events (worktree mutations etc.) fan out to every connected client,
    // alongside the per-session subscriber streams wired up below.
    let mut global_rx = server.subscribe_global_events();
    let mut global_open = true;

    let writer_task = tokio::spawn(async move {
        while let Some(msg) = out_rx.recv().await {
            if write_half.write_all(msg.as_bytes()).await.is_err() {
                break;
            }
            if write_half.flush().await.is_err() {
                break;
            }
        }
    });

    let mut reader = BufReader::new(read_half);
    let mut line = String::new();
    let mut subscribed_sessions: HashMap<String, tokio::task::JoinHandle<()>> = HashMap::new();

    loop {
        line.clear();
        tokio::select! {
            _ = cancel_token.cancelled() => {
                break;
            }
            global_res = global_rx.recv(), if global_open => {
                match global_res {
                    Ok(event) => {
                        if let Ok(json) = serde_json::to_string(&event) {
                            let _ = out_tx.send(format!("{json}\n")).await;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => global_open = false,
                }
            }
            read_res = reader.read_line(&mut line) => {
                match read_res {
                    Ok(0) => break, // EOF
                    Ok(_) => {
                        let trimmed = line.trim();
                        if trimmed.is_empty() {
                            continue;
                        }
                        let req: DaemonRequest = match serde_json::from_str(trimmed) {
                            Ok(r) => r,
                            Err(e) => {
                                let err_resp = DaemonResponse::Error(format!("invalid request JSON: {e}"));
                                if let Ok(json) = serde_json::to_string(&err_resp) {
                                    let _ = out_tx.send(format!("{json}\n")).await;
                                }
                                continue;
                            }
                        };

                        let is_disconnect = matches!(req, DaemonRequest::Disconnect);
                        let is_shutdown = matches!(req, DaemonRequest::Shutdown);
                        let is_ack = matches!(req, DaemonRequest::Ack { .. });

                        let session_to_sub = match &req {
                            DaemonRequest::CreateOrAttach { session_id, .. } => Some(session_id.clone()),
                            _ => None,
                        };

                        let resp = server.handle_request(req);

                        // If CreateOrAttach succeeded, wire up subscriber task if not already streaming to this client
                        if let Some(session_id) = session_to_sub {
                            if matches!(resp, DaemonResponse::SessionAttached(_)) && !subscribed_sessions.contains_key(&session_id) {
                                let session = server.sessions.lock().get(&session_id).cloned();
                                if let Some(session) = session {
                                    let mut rx = session.subscribe();
                                    let out_tx_sub = out_tx.clone();
                                    let sub_task = tokio::spawn(async move {
                                        while let Some(event) = rx.recv().await {
                                            if let Ok(json) = serde_json::to_string(&event) {
                                                if out_tx_sub.send(format!("{json}\n")).await.is_err() {
                                                    break;
                                                }
                                            }
                                        }
                                    });
                                    subscribed_sessions.insert(session_id, sub_task);
                                }
                            }
                        }

                        if !is_ack {
                            if let Ok(json) = serde_json::to_string(&resp) {
                                let _ = out_tx.send(format!("{json}\n")).await;
                            }
                        }

                        if is_disconnect {
                            break;
                        }
                        if is_shutdown {
                            cancel_token.cancel();
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        }
    }

    for (_, handle) in subscribed_sessions {
        handle.abort();
    }
    writer_task.abort();

    Ok(())
}

/// Platform-specific listener runner
pub async fn run_server_listener(
    server: Arc<DaemonServer>,
    socket_path: &str,
    cancel_token: CancellationToken,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    #[cfg(target_os = "windows")]
    {
        use tokio::net::windows::named_pipe::ServerOptions;

        let mut is_first = true;
        loop {
            if cancel_token.is_cancelled() {
                break;
            }

            let pipe_server = match ServerOptions::new()
                .first_pipe_instance(is_first)
                .max_instances(254)
                .create(socket_path)
            {
                Ok(server) => {
                    is_first = false;
                    server
                }
                Err(_) => {
                    if cancel_token.is_cancelled() {
                        break;
                    }
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    continue;
                }
            };

            tokio::select! {
                _ = cancel_token.cancelled() => {
                    break;
                }
                conn_res = pipe_server.connect() => {
                    match conn_res {
                        Ok(()) => {
                            let server_clone = Arc::clone(&server);
                            let cancel_clone = cancel_token.clone();
                            tokio::spawn(async move {
                                let _ = handle_client_stream(pipe_server, server_clone, cancel_clone).await;
                            });
                        }
                        Err(_) => {
                            if cancel_token.is_cancelled() {
                                break;
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }

    #[cfg(not(target_os = "windows"))]
    {
        use tokio::net::UnixListener;

        let _ = std::fs::remove_file(socket_path);
        if let Some(parent) = std::path::Path::new(socket_path).parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let listener = UnixListener::bind(socket_path)?;

        loop {
            tokio::select! {
                _ = cancel_token.cancelled() => {
                    break;
                }
                res = listener.accept() => {
                    match res {
                        Ok((stream, _)) => {
                            let server_clone = Arc::clone(&server);
                            let cancel_clone = cancel_token.clone();
                            tokio::spawn(async move {
                                let _ = handle_client_stream(stream, server_clone, cancel_clone).await;
                            });
                        }
                        Err(_) => {
                            if cancel_token.is_cancelled() {
                                break;
                            }
                        }
                    }
                }
            }
        }
        let _ = std::fs::remove_file(socket_path);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::ipc_protocol::DaemonEvent;
    use std::time::Duration;
    use std::time::Instant;

    #[tokio::test]
    async fn test_daemon_server_handle_request_lifecycle() {
        let server = DaemonServer::new();

        // 1. Hello
        let resp = server.handle_request(DaemonRequest::Hello {
            client_version: "0.1.0".into(),
            protocol_version: DAEMON_PROTOCOL_VERSION,
            auth_token: None,
        });
        assert_eq!(
            resp,
            DaemonResponse::HelloOk {
                protocol_version: DAEMON_PROTOCOL_VERSION
            }
        );

        // 2. CreateOrAttach (new)
        let resp = server.handle_request(DaemonRequest::CreateOrAttach {
            session_id: "req-test-1".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: None,
            resume_agents: false,
            worktree_id: None,
            extra_env: Vec::new(),
        });
        match resp {
            DaemonResponse::SessionAttached(res) => {
                assert!(res.is_new);
                assert_eq!(res.cols, 80);
                assert_eq!(res.rows, 24);
                assert!(res.snapshot.is_none());
            }
            other => panic!("expected SessionAttached, got {other:?}"),
        }

        // 3. Write
        let resp = server.handle_request(DaemonRequest::Write {
            session_id: "req-test-1".into(),
            data: "echo hello\n".into(),
        });
        assert_eq!(resp, DaemonResponse::Ok);

        // 4. Resize
        let resp = server.handle_request(DaemonRequest::Resize {
            session_id: "req-test-1".into(),
            cols: 120,
            rows: 40,
        });
        assert_eq!(resp, DaemonResponse::Ok);

        // 5. Ack
        let resp = server.handle_request(DaemonRequest::Ack {
            session_id: "req-test-1".into(),
            chars: 100,
        });
        assert_eq!(resp, DaemonResponse::Ok);

        // 6. ListSessions
        let resp = server.handle_request(DaemonRequest::ListSessions);
        match resp {
            DaemonResponse::SessionList(sessions) => {
                assert_eq!(sessions, vec!["req-test-1".to_string()]);
            }
            other => panic!("expected SessionList, got {other:?}"),
        }

        // 7. CreateOrAttach (attach existing)
        let resp = server.handle_request(DaemonRequest::CreateOrAttach {
            session_id: "req-test-1".into(),
            cols: 120,
            rows: 40,
            cwd: None,
            shell: None,
            resume_agents: false,
            worktree_id: None,
            extra_env: Vec::new(),
        });
        match resp {
            DaemonResponse::SessionAttached(res) => {
                assert!(!res.is_new);
                assert_eq!(res.cols, 120);
                assert_eq!(res.rows, 40);
                assert!(res.snapshot.is_some());
            }
            other => panic!("expected SessionAttached, got {other:?}"),
        }

        // 8. Kill
        let resp = server.handle_request(DaemonRequest::Kill {
            session_id: "req-test-1".into(),
        });
        assert_eq!(resp, DaemonResponse::Ok);

        // 9. ListSessions is empty
        let resp = server.handle_request(DaemonRequest::ListSessions);
        match resp {
            DaemonResponse::SessionList(list) => {
                assert!(list.is_empty());
            }
            other => panic!("expected empty SessionList, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_daemon_server_socket_ipc_roundtrip() {
        let server = Arc::new(DaemonServer::new());
        let cancel_token = CancellationToken::new();

        #[cfg(target_os = "windows")]
        let socket_path = format!(
            r"\\.\pipe\oppa-test-daemon-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );

        #[cfg(not(target_os = "windows"))]
        let socket_path = format!(
            "/tmp/oppa-test-daemon-{}.sock",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );

        let srv_clone = Arc::clone(&server);
        let cancel_clone = cancel_token.clone();
        let path_clone = socket_path.clone();

        tokio::spawn(async move {
            let _ = srv_clone.run_listener(&path_clone, cancel_clone).await;
        });

        // Small wait for server listener to bind
        tokio::time::sleep(Duration::from_millis(100)).await;

        // 1. Connect Client 1
        #[cfg(target_os = "windows")]
        let client_stream = {
            use tokio::net::windows::named_pipe::ClientOptions;
            let mut client = None;
            for _ in 0..20 {
                if let Ok(c) = ClientOptions::new().open(&socket_path) {
                    client = Some(c);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            client.expect("connect to test named pipe")
        };

        #[cfg(not(target_os = "windows"))]
        let client_stream = {
            use tokio::net::UnixStream;
            let mut client = None;
            for _ in 0..20 {
                if let Ok(c) = UnixStream::connect(&socket_path).await {
                    client = Some(c);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            client.expect("connect to test unix socket")
        };

        let (read_half, mut write_half) = tokio::io::split(client_stream);
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();

        // Client 1: Hello
        let hello_req = DaemonRequest::Hello {
            client_version: "0.1.0".into(),
            protocol_version: DAEMON_PROTOCOL_VERSION,
            auth_token: None,
        };
        let mut hello_str = serde_json::to_string(&hello_req).unwrap();
        hello_str.push('\n');
        write_half.write_all(hello_str.as_bytes()).await.unwrap();

        line.clear();
        reader.read_line(&mut line).await.unwrap();
        let hello_resp: DaemonResponse = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(
            hello_resp,
            DaemonResponse::HelloOk {
                protocol_version: DAEMON_PROTOCOL_VERSION
            }
        );

        // Client 1: CreateOrAttach
        let create_req = DaemonRequest::CreateOrAttach {
            session_id: "ipc-test-session".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: None,
            resume_agents: false,
            worktree_id: None,
            extra_env: Vec::new(),
        };
        let mut create_str = serde_json::to_string(&create_req).unwrap();
        create_str.push('\n');
        write_half.write_all(create_str.as_bytes()).await.unwrap();

        line.clear();
        reader.read_line(&mut line).await.unwrap();
        let create_resp: DaemonResponse = serde_json::from_str(line.trim()).unwrap();
        match create_resp {
            DaemonResponse::SessionAttached(res) => {
                assert!(res.is_new);
            }
            other => panic!("expected SessionAttached, got {other:?}"),
        }

        // Client 1: Write command
        let write_req = DaemonRequest::Write {
            session_id: "ipc-test-session".into(),
            data: "echo persistent_ipc_content\n".into(),
        };
        let mut write_str = serde_json::to_string(&write_req).unwrap();
        write_str.push('\n');
        write_half.write_all(write_str.as_bytes()).await.unwrap();

        // Read response for Write or streaming events
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut found_content = false;
        while std::time::Instant::now() < deadline {
            line.clear();
            if let Ok(Ok(n)) = tokio::time::timeout(Duration::from_millis(500), reader.read_line(&mut line)).await {
                if n == 0 {
                    break;
                }
                if let Ok(DaemonEvent::Data { data, .. }) = serde_json::from_str::<DaemonEvent>(line.trim()) {
                    if data.contains("persistent_ipc_content") {
                        found_content = true;
                        break;
                    }
                }
            }
        }
        assert!(found_content, "expected to receive output event containing 'persistent_ipc_content'");

        // Client 1: Disconnect (leaves session intact)
        let disc_req = DaemonRequest::Disconnect;
        let mut disc_str = serde_json::to_string(&disc_req).unwrap();
        disc_str.push('\n');
        write_half.write_all(disc_str.as_bytes()).await.unwrap();
        drop(write_half);
        drop(reader);

        // 2. Connect Client 2 (Reattach test)
        tokio::time::sleep(Duration::from_millis(100)).await;

        #[cfg(target_os = "windows")]
        let client_stream2 = {
            use tokio::net::windows::named_pipe::ClientOptions;
            let mut client = None;
            for _ in 0..20 {
                if let Ok(c) = ClientOptions::new().open(&socket_path) {
                    client = Some(c);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            client.expect("connect client 2 to test named pipe")
        };

        #[cfg(not(target_os = "windows"))]
        let client_stream2 = {
            use tokio::net::UnixStream;
            let mut client = None;
            for _ in 0..20 {
                if let Ok(c) = UnixStream::connect(&socket_path).await {
                    client = Some(c);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            client.expect("connect client 2 to test unix socket")
        };

        let (read_half2, mut write_half2) = tokio::io::split(client_stream2);
        let mut reader2 = BufReader::new(read_half2);

        // Client 2: Reattach to the same session
        let reattach_req = DaemonRequest::CreateOrAttach {
            session_id: "ipc-test-session".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: None,
            resume_agents: false,
            worktree_id: None,
            extra_env: Vec::new(),
        };
        let mut reattach_str = serde_json::to_string(&reattach_req).unwrap();
        reattach_str.push('\n');
        write_half2.write_all(reattach_str.as_bytes()).await.unwrap();

        line.clear();
        reader2.read_line(&mut line).await.unwrap();
        let reattach_resp: DaemonResponse = serde_json::from_str(line.trim()).unwrap();
        match reattach_resp {
            DaemonResponse::SessionAttached(res) => {
                assert!(!res.is_new, "expected reattached session to have is_new: false");
                let snapshot = res.snapshot.expect("expected reattached session snapshot");
                assert!(
                    snapshot.contains("persistent_ipc_content"),
                    "expected snapshot to contain 'persistent_ipc_content', got: {snapshot}"
                );
            }
            other => panic!("expected SessionAttached, got {other:?}"),
        }

        // Clean up: Shutdown
        let shutdown_req = DaemonRequest::Shutdown;
        let mut shutdown_str = serde_json::to_string(&shutdown_req).unwrap();
        shutdown_str.push('\n');
        write_half2.write_all(shutdown_str.as_bytes()).await.unwrap();

        cancel_token.cancel();
    }

    #[tokio::test]
    async fn test_daemon_server_ack_one_way_no_response_frame() {
        let server = Arc::new(DaemonServer::new());
        let cancel_token = CancellationToken::new();

        #[cfg(target_os = "windows")]
        let socket_path = format!(
            r"\\.\pipe\oppa-test-ack-srv-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );

        #[cfg(not(target_os = "windows"))]
        let socket_path = format!(
            "/tmp/oppa-test-ack-srv-{}.sock",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );

        let srv_clone = Arc::clone(&server);
        let cancel_clone = cancel_token.clone();
        let path_clone = socket_path.clone();

        tokio::spawn(async move {
            let _ = srv_clone.run_listener(&path_clone, cancel_clone).await;
        });

        tokio::time::sleep(Duration::from_millis(100)).await;

        #[cfg(target_os = "windows")]
        let client_stream = {
            use tokio::net::windows::named_pipe::ClientOptions;
            let mut client = None;
            for _ in 0..20 {
                if let Ok(c) = ClientOptions::new().open(&socket_path) {
                    client = Some(c);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            client.expect("connect named pipe")
        };

        #[cfg(not(target_os = "windows"))]
        let client_stream = {
            use tokio::net::UnixStream;
            let mut client = None;
            for _ in 0..20 {
                if let Ok(c) = UnixStream::connect(&socket_path).await {
                    client = Some(c);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            client.expect("connect unix socket")
        };

        let (read_half, mut write_half) = tokio::io::split(client_stream);
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();

        // 1. Hello
        let hello = serde_json::to_string(&DaemonRequest::Hello {
            client_version: "0.1.0".into(),
            protocol_version: DAEMON_PROTOCOL_VERSION,
            auth_token: None,
        })
        .unwrap()
            + "\n";
        write_half.write_all(hello.as_bytes()).await.unwrap();
        reader.read_line(&mut line).await.unwrap();

        // 2. CreateOrAttach
        let create = serde_json::to_string(&DaemonRequest::CreateOrAttach {
            session_id: "ack-srv-test".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: None,
            resume_agents: false,
            worktree_id: None,
            extra_env: Vec::new(),
        })
        .unwrap()
            + "\n";
        write_half.write_all(create.as_bytes()).await.unwrap();
        line.clear();
        reader.read_line(&mut line).await.unwrap();

        // Send ACK over stream
        let ack_msg = serde_json::to_string(&DaemonRequest::Ack {
            session_id: "ack-srv-test".into(),
            chars: 50,
        })
        .unwrap()
            + "\n";
        write_half.write_all(ack_msg.as_bytes()).await.unwrap();

        // Send ListSessions request immediately after ACK.
        // If Ack is one-way (no response frame), the very next response MUST be SessionList, not Ok!
        let list_req = serde_json::to_string(&DaemonRequest::ListSessions).unwrap() + "\n";
        write_half.write_all(list_req.as_bytes()).await.unwrap();

        line.clear();
        reader.read_line(&mut line).await.unwrap();
        let resp: DaemonResponse = serde_json::from_str(line.trim()).unwrap();
        match resp {
            DaemonResponse::SessionList(sessions) => {
                assert!(sessions.contains(&"ack-srv-test".to_string()));
            }
            DaemonResponse::Ok => {
                panic!("received unexpected Ok response from Ack request; Ack should be one-way!")
            }
            other => panic!("expected SessionList, got {other:?}"),
        }

        // Clean up
        cancel_token.cancel();
    }

    #[tokio::test]
    async fn test_create_or_attach_resizes_before_taking_snapshot() {
        let server = DaemonServer::new();

        // 1. Initial create at 80x24
        let resp = server.handle_request(DaemonRequest::CreateOrAttach {
            session_id: "resize-reattach-test".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: None,
            resume_agents: false,
            worktree_id: None,
            extra_env: Vec::new(),
        });
        match resp {
            DaemonResponse::SessionAttached(res) => {
                assert!(res.is_new);
                assert_eq!(res.cols, 80);
                assert_eq!(res.rows, 24);
            }
            other => panic!("expected SessionAttached, got {other:?}"),
        }

        // 2. Reattach with 50x14
        let resp = server.handle_request(DaemonRequest::CreateOrAttach {
            session_id: "resize-reattach-test".into(),
            cols: 50,
            rows: 14,
            cwd: None,
            shell: None,
            resume_agents: false,
            worktree_id: None,
            extra_env: Vec::new(),
        });
        match resp {
            DaemonResponse::SessionAttached(res) => {
                assert!(!res.is_new);
                assert_eq!(res.cols, 50);
                assert_eq!(res.rows, 14);
                assert!(res.snapshot.is_some());
            }
            other => panic!("expected SessionAttached, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_cold_restore_returns_resume_plan_and_injects_command() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let storage = SnapshotStorage::new(temp_dir.path().to_path_buf());
        storage
            .save_snapshot(&SessionSnapshot {
                session_id: "resume-test".into(),
                cwd: String::new(),
                title: None,
                cols: 80,
                rows: 24,
                persona_id: None,
                scrollback: "old screen".into(),
                timestamp: 1,
                foreground_command: Some("claude --resume abc123".into()),
                agent_session: None,
                worktree_id: None,
            })
            .expect("seed checkpoint");

        let server = DaemonServer::with_snapshot_storage(temp_dir.path().to_path_buf());
        let resp = server.handle_request(DaemonRequest::CreateOrAttach {
            session_id: "resume-test".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: None,
            resume_agents: true,
            worktree_id: None,
            extra_env: Vec::new(),
        });
        match resp {
            DaemonResponse::SessionAttached(res) => {
                assert!(res.is_new);
                assert_eq!(
                    res.resume,
                    Some(ResumePlan {
                        // No captured session ref: plain relaunch of the known
                        // agent's original command line
                        command_line: "claude --resume abc123".into(),
                        kind: ResumeKind::CommandRelaunch,
                    })
                );
                assert_eq!(
                    res.resume_declined_reason,
                    Some("no verified resume command for this agent".into())
                );
            }
            other => panic!("expected SessionAttached, got {other:?}"),
        }

        // Marker-triggered injection: feed the ready marker, expect the resumed
        // command written into the PTY (echoed back in the data stream)
        let session = server
            .sessions()
            .lock()
            .get("resume-test")
            .cloned()
            .expect("session live");
        let mut rx = session.subscribe();
        session.write(b"\x1b]633;oppa-ready\x07").expect("marker");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let mut collected = String::new();
        while std::time::Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(300), rx.recv()).await {
                Ok(Some(DaemonEvent::Data { data, .. })) => {
                    collected.push_str(&data);
                    if collected.contains("claude") {
                        break;
                    }
                }
                _ => continue,
            }
        }
        assert!(
            collected.contains("claude"),
            "expected injected resume command echoed, got: {collected}"
        );
        let _ = server.handle_request(DaemonRequest::Kill {
            session_id: "resume-test".into(),
        });
    }

    #[tokio::test]
    async fn test_cold_restore_without_resume_flag_stays_plain() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let storage = SnapshotStorage::new(temp_dir.path().to_path_buf());
        storage
            .save_snapshot(&SessionSnapshot {
                session_id: "no-resume-test".into(),
                cwd: String::new(),
                title: None,
                cols: 80,
                rows: 24,
                persona_id: None,
                scrollback: "old screen".into(),
                timestamp: 1,
                foreground_command: Some("claude --resume abc123".into()),
                agent_session: None,
                worktree_id: None,
            })
            .expect("seed checkpoint");

        let server = DaemonServer::with_snapshot_storage(temp_dir.path().to_path_buf());
        let resp = server.handle_request(DaemonRequest::CreateOrAttach {
            session_id: "no-resume-test".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: None,
            resume_agents: false,
            worktree_id: None,
            extra_env: Vec::new(),
        });
        match resp {
            DaemonResponse::SessionAttached(res) => {
                assert!(res.is_new);
                assert!(res.resume.is_none());
                assert!(res.resume_declined_reason.is_none());
            }
            other => panic!("expected SessionAttached, got {other:?}"),
        }
        let _ = server.handle_request(DaemonRequest::Kill {
            session_id: "no-resume-test".into(),
        });
    }

    #[tokio::test]
    async fn test_same_conversation_claimed_by_second_pane_downgrades_to_relaunch() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let storage = SnapshotStorage::new(temp_dir.path().to_path_buf());
        // Two panes ran the same conversation (e.g. same cwd). Claude is used
        // here because its transcript dir for this cwd has no alternatives on
        // the test machine, making the fallback deterministic.
        for sid in ["dedup-a", "dedup-b"] {
            storage
                .save_snapshot(&SessionSnapshot {
                    session_id: sid.into(),
                    cwd: r"C:\shared\project".into(),
                    title: None,
                    cols: 80,
                    rows: 24,
                    persona_id: None,
                    scrollback: "old screen".into(),
                    timestamp: 1,
                    foreground_command: Some("claude".into()),
                    agent_session: Some(crate::pty::snapshot::AgentSessionRef {
                        agent: "claude".into(),
                        id: "same-conv-1".into(),
                        transcript_path: None,
                    }),
                    worktree_id: None,
                })
                .expect("seed checkpoint");
        }

        let server = DaemonServer::with_snapshot_storage(temp_dir.path().to_path_buf());

        // First pane wins the conversation
        let resp = server.handle_request(DaemonRequest::CreateOrAttach {
            session_id: "dedup-a".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: None,
            resume_agents: true,
            worktree_id: None,
            extra_env: Vec::new(),
        });
        match resp {
            DaemonResponse::SessionAttached(res) => {
                assert!(matches!(
                    res.resume,
                    Some(ResumePlan { kind: ResumeKind::AgentResume, .. })
                ));
            }
            other => panic!("expected SessionAttached, got {other:?}"),
        }

        // Second pane must NOT reopen the same conversation
        let resp = server.handle_request(DaemonRequest::CreateOrAttach {
            session_id: "dedup-b".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: None,
            resume_agents: true,
            worktree_id: None,
            extra_env: Vec::new(),
        });
        match resp {
            DaemonResponse::SessionAttached(res) => {
                assert!(matches!(
                    res.resume,
                    Some(ResumePlan {
                        command_line: ref cmd,
                        kind: ResumeKind::CommandRelaunch,
                    }) if cmd == "claude"
                ));
                assert_eq!(
                    res.resume_declined_reason,
                    Some("conversation already resumed in another pane".into())
                );
            }
            other => panic!("expected SessionAttached, got {other:?}"),
        }
        let _ = server.handle_request(DaemonRequest::Kill {
            session_id: "dedup-a".into(),
        });
        let _ = server.handle_request(DaemonRequest::Kill {
            session_id: "dedup-b".into(),
        });
    }

    #[tokio::test]
    async fn test_checkpoint_task_writes_snapshot_within_debounce_window() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let server = DaemonServer::with_snapshot_storage(temp_dir.path().to_path_buf());

        let resp = server.handle_request(DaemonRequest::CreateOrAttach {
            session_id: "checkpoint-test".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: None,
            resume_agents: false,
            worktree_id: None,
            extra_env: Vec::new(),
        });
        match resp {
            DaemonResponse::SessionAttached(res) => assert!(res.is_new),
            other => panic!("expected SessionAttached, got {other:?}"),
        }

        tokio::time::sleep(Duration::from_secs(4)).await;

        let storage = SnapshotStorage::new(temp_dir.path().to_path_buf());
        let snap = storage
            .load_snapshot("checkpoint-test")
            .expect("load succeeds")
            .expect("checkpoint file written within debounce window");
        assert_eq!(snap.session_id, "checkpoint-test");
        assert!(snap.timestamp > 0);

        let _ = server.handle_request(DaemonRequest::Kill {
            session_id: "checkpoint-test".into(),
        });
    }

    #[tokio::test]
    async fn test_shutdown_flushes_final_snapshot_for_live_sessions() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let server = DaemonServer::with_snapshot_storage(temp_dir.path().to_path_buf());

        let resp = server.handle_request(DaemonRequest::CreateOrAttach {
            session_id: "flush-test".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: None,
            resume_agents: false,
            worktree_id: None,
            extra_env: Vec::new(),
        });
        match resp {
            DaemonResponse::SessionAttached(res) => assert!(res.is_new),
            other => panic!("expected SessionAttached, got {other:?}"),
        }

        // Shutdown must flush synchronously before draining/killing
        let resp = server.handle_request(DaemonRequest::Shutdown);
        assert_eq!(resp, DaemonResponse::Ok);

        let storage = SnapshotStorage::new(temp_dir.path().to_path_buf());
        let snap = storage
            .load_snapshot("flush-test")
            .expect("load succeeds")
            .expect("shutdown flushed final snapshot");
        assert_eq!(snap.session_id, "flush-test");
    }

    fn hello(token: Option<&str>) -> DaemonRequest {
        DaemonRequest::Hello {
            client_version: "test".into(),
            protocol_version: DAEMON_PROTOCOL_VERSION,
            auth_token: token.map(str::to_string),
        }
    }

    #[tokio::test]
    async fn test_hello_auth_rejects_mismatch_but_grants_missing_and_matching() {
        let mut server = DaemonServer::new();
        server.set_auth_token(Some("secret".into()));

        match server.handle_request(hello(Some("wrong"))) {
            DaemonResponse::Error(e) => assert!(e.contains("unauthorized"), "got: {e}"),
            other => panic!("expected unauthorized error, got {other:?}"),
        }
        // M1 grace: renderers before task 6 send no token at all
        assert!(matches!(
            server.handle_request(hello(None)),
            DaemonResponse::HelloOk { .. }
        ));
        assert!(matches!(
            server.handle_request(hello(Some("secret"))),
            DaemonResponse::HelloOk { .. }
        ));

        let open_server = DaemonServer::new();
        assert!(matches!(
            open_server.handle_request(hello(Some("anything"))),
            DaemonResponse::HelloOk { .. }
        ));
    }

    #[tokio::test]
    async fn test_worktree_requests_error_without_registry() {
        let server = DaemonServer::new();
        for req in [
            DaemonRequest::RepoAdd { path: "/tmp/x".into() },
            DaemonRequest::RepoList,
            DaemonRequest::WorktreeList,
            DaemonRequest::WorktreePs,
        ] {
            match server.handle_request(req) {
                DaemonResponse::Error(e) => assert!(e.contains("registry unavailable"), "got: {e}"),
                other => panic!("expected registry-unavailable error, got {other:?}"),
            }
        }
    }

    fn v3_create_request(repo_path: &Path, name: &str) -> DaemonRequest {
        DaemonRequest::WorktreeCreate {
            repo_path: repo_path.to_string_lossy().into_owned(),
            name: Some(name.into()),
            branch: None,
            base_ref: None,
            parent_worktree_id: None,
            workspace_dir: None,
            nest_workspaces: None,
        }
    }

    fn expect_record_one(resp: DaemonResponse, what: &str) -> crate::git::worktree_registry::WorktreeRecord {
        match resp {
            DaemonResponse::WorktreeRecordOne(Some(record)) => record,
            other => panic!("expected WorktreeRecordOne for {what}, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_v3_worktree_surface_create_show_set_remove_purge_end_to_end() {
        let s = crate::git::test_support::sandbox("v3-surface");
        let server = DaemonServer::with_snapshot_storage(s.root.clone());

        // RepoAdd
        let resp = server.handle_request(DaemonRequest::RepoAdd {
            path: s.repo.to_string_lossy().into_owned(),
        });
        let repo = match resp {
            DaemonResponse::RepoRecords(repos) => repos.into_iter().next().expect("repo record"),
            other => panic!("expected RepoRecords, got {other:?}"),
        };
        assert_eq!(repo.repo_id, "repo");

        // WorktreeCreate
        let created = expect_record_one(
            server.handle_request(v3_create_request(&s.repo, "feat-a")),
            "create",
        );
        assert_eq!(created.branch, "feat-a");

        // WorktreeList shows the entry with its branch and live directory
        match server.handle_request(DaemonRequest::WorktreeList) {
            DaemonResponse::WorktreeRecords(entries) => {
                assert_eq!(entries.len(), 1);
                assert_eq!(entries[0].record.branch, "feat-a");
                assert!(!entries[0].missing_on_disk);
            }
            other => panic!("expected WorktreeRecords, got {other:?}"),
        }

        // WorktreeShow by id + WorktreeCurrent by cwd
        let shown = expect_record_one(
            server.handle_request(DaemonRequest::WorktreeShow { id: created.id.clone() }),
            "show",
        );
        assert_eq!(shown.id, created.id);
        match server.handle_request(DaemonRequest::WorktreeCurrent {
            cwd: created.path.to_string_lossy().into_owned(),
        }) {
            DaemonResponse::WorktreeRecordOne(Some(current)) => assert_eq!(current.id, created.id),
            other => panic!("expected current worktree, got {other:?}"),
        }

        // WorktreeSet persists the status change
        let updated = expect_record_one(
            server.handle_request(DaemonRequest::WorktreeSet {
                id: created.id.clone(),
                set_parent: false,
                parent_worktree_id: None,
                workspace_status: Some(crate::git::worktree_registry::WorktreeStatus::InProgress),
                display_name: Some("Feat A".into()),
            }),
            "set",
        );
        assert_eq!(
            updated.workspace_status,
            crate::git::worktree_registry::WorktreeStatus::InProgress
        );
        assert_eq!(
            crate::git::worktrees::worktree_show(&s.root.join("worktrees.json"), &created.id)
                .unwrap()
                .workspace_status,
            crate::git::worktree_registry::WorktreeStatus::InProgress
        );

        // Remove is gated while a live session sits inside the worktree
        let session_id = "wt-live-session";
        let attach = server.handle_request(DaemonRequest::CreateOrAttach {
            session_id: session_id.into(),
            cols: 80,
            rows: 24,
            cwd: Some(created.path.to_string_lossy().into_owned()),
            shell: None,
            resume_agents: false,
            worktree_id: None,
            extra_env: Vec::new(),
        });
        assert!(matches!(attach, DaemonResponse::SessionAttached(_)));
        let blocked = server.handle_request(DaemonRequest::WorktreeRemove {
            id: created.id.clone(),
            force: false,
            delete_branch: false,
        });
        match blocked {
            DaemonResponse::Error(e) => {
                assert!(e.contains(session_id), "error must name the session: {e}");
            }
            other => panic!("expected blocked removal, got {other:?}"),
        }

        // With the session gone, removal tombstones and purge drops the record
        assert_eq!(
            server.handle_request(DaemonRequest::Kill { session_id: session_id.into() }),
            DaemonResponse::Ok
        );
        assert_eq!(
            server.handle_request(DaemonRequest::WorktreeRemove {
                id: created.id.clone(),
                force: false,
                delete_branch: false,
            }),
            DaemonResponse::Ok
        );
        let tombstone = expect_record_one(
            server.handle_request(DaemonRequest::WorktreeShow { id: created.id.clone() }),
            "tombstone show",
        );
        assert!(tombstone.retired);

        assert_eq!(
            server.handle_request(DaemonRequest::WorktreePurge { id: created.id.clone() }),
            DaemonResponse::Ok
        );
        match server.handle_request(DaemonRequest::WorktreeShow { id: created.id.clone() }) {
            DaemonResponse::Error(e) => assert!(e.contains("not found"), "got: {e}"),
            other => panic!("expected purged record to be gone, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn test_successful_mutations_publish_worktree_changed_events() {
        use crate::git::worktree_registry::WorktreeStatus;

        let s = crate::git::test_support::sandbox("v3-events");
        let server = DaemonServer::with_snapshot_storage(s.root.clone());
        let mut rx = server.subscribe_global_events();

        let created = expect_record_one(
            server.handle_request(v3_create_request(&s.repo, "evented")),
            "create",
        );
        async fn next_changed_id(rx: &mut broadcast::Receiver<DaemonEvent>) -> Option<String> {
            let deadline = Instant::now() + Duration::from_secs(2);
            while Instant::now() < deadline {
                match tokio::time::timeout(Duration::from_millis(300), rx.recv()).await {
                    Ok(Ok(DaemonEvent::WorktreeChanged { id })) => return id,
                    Ok(_) | Err(_) => continue,
                }
            }
            None
        }

        assert_eq!(
            next_changed_id(&mut rx).await.as_deref(),
            Some(created.id.as_str()),
            "create must publish WorktreeChanged"
        );

        server.handle_request(DaemonRequest::WorktreeSet {
            id: created.id.clone(),
            set_parent: false,
            parent_worktree_id: None,
            workspace_status: Some(WorktreeStatus::Completed),
            display_name: None,
        });
        assert_eq!(
            next_changed_id(&mut rx).await.as_deref(),
            Some(created.id.as_str()),
            "set must publish WorktreeChanged"
        );

        server.handle_request(DaemonRequest::WorktreeRemove {
            id: created.id.clone(),
            force: false,
            delete_branch: false,
        });
        assert_eq!(
            next_changed_id(&mut rx).await.as_deref(),
            Some(created.id.as_str()),
            "remove must publish WorktreeChanged"
        );

        // Read-only requests never publish
        let _ = server.handle_request(DaemonRequest::WorktreeList);
        assert!(next_changed_id(&mut rx).await.is_none(), "list must stay silent");
    }

    #[tokio::test]
    async fn test_shutdown_removes_runtime_metadata_file() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        runtime_metadata::write_runtime_metadata(temp_dir.path(), "/tmp/pipe", "tok").unwrap();
        assert!(runtime_metadata::metadata_path(temp_dir.path()).exists());

        let server = DaemonServer::with_snapshot_storage(temp_dir.path().to_path_buf());
        assert_eq!(server.handle_request(DaemonRequest::Shutdown), DaemonResponse::Ok);
        assert!(!runtime_metadata::metadata_path(temp_dir.path()).exists());
    }

    #[tokio::test]
    async fn test_pipe_level_v3_repo_add_create_list_roundtrip_with_event_fanout() {
        let s = crate::git::test_support::sandbox("v3-pipe");
        let server = Arc::new(DaemonServer::with_snapshot_storage(s.root.clone()));
        let cancel_token = CancellationToken::new();

        #[cfg(target_os = "windows")]
        let socket_path = format!(
            r"\\.\pipe\oppa-test-v3-{}",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        );
        #[cfg(not(target_os = "windows"))]
        let socket_path = format!(
            "/tmp/oppa-test-v3-{}.sock",
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        );

        let srv_clone = Arc::clone(&server);
        let cancel_clone = cancel_token.clone();
        let path_clone = socket_path.clone();
        tokio::spawn(async move {
            let _ = srv_clone.run_listener(&path_clone, cancel_clone).await;
        });
        tokio::time::sleep(Duration::from_millis(150)).await;

        #[cfg(target_os = "windows")]
        let client_stream = {
            use tokio::net::windows::named_pipe::ClientOptions;
            let mut client = None;
            for _ in 0..20 {
                if let Ok(c) = ClientOptions::new().open(&socket_path) {
                    client = Some(c);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            client.expect("connect named pipe")
        };
        #[cfg(not(target_os = "windows"))]
        let client_stream = {
            use tokio::net::UnixStream;
            let mut client = None;
            for _ in 0..20 {
                if let Ok(c) = UnixStream::connect(&socket_path).await {
                    client = Some(c);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            client.expect("connect unix socket")
        };

        let (read_half, mut write_half) = tokio::io::split(client_stream);
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();

        let send = |req: &DaemonRequest| {
            let mut json = serde_json::to_string(req).unwrap();
            json.push('\n');
            json
        };

        write_half.write_all(send(&hello(None)).as_bytes()).await.unwrap();
        line.clear();
        reader.read_line(&mut line).await.unwrap();
        assert!(matches!(
            serde_json::from_str::<DaemonResponse>(line.trim()).unwrap(),
            DaemonResponse::HelloOk { .. }
        ));

        write_half
            .write_all(send(&DaemonRequest::RepoAdd {
                path: s.repo.to_string_lossy().into_owned(),
            }).as_bytes())
            .await
            .unwrap();
        line.clear();
        reader.read_line(&mut line).await.unwrap();
        assert!(matches!(
            serde_json::from_str::<DaemonResponse>(line.trim()).unwrap(),
            DaemonResponse::RepoRecords(_)
        ));

        // Create over the pipe; the response frame precedes the broadcast event on this stream
        write_half.write_all(send(&v3_create_request(&s.repo, "feat-pipe")).as_bytes()).await.unwrap();
        let mut created_id = String::new();
        let mut saw_event = false;
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            line.clear();
            if reader.read_line(&mut line).await.unwrap() == 0 {
                break;
            }
            if let Ok(resp) = serde_json::from_str::<DaemonResponse>(line.trim()) {
                if let DaemonResponse::WorktreeRecordOne(Some(record)) = resp {
                    created_id = record.id.clone();
                    assert_eq!(record.branch, "feat-pipe");
                    continue;
                }
            }
            if let Ok(DaemonEvent::WorktreeChanged { id: Some(ref id) }) =
                serde_json::from_str::<DaemonEvent>(line.trim())
            {
                if !created_id.is_empty() && *id == created_id {
                    saw_event = true;
                    break;
                }
            }
        }
        assert!(!created_id.is_empty(), "create response never arrived");
        assert!(saw_event, "WorktreeChanged never fanned out to the client stream");

        // List over the pipe reflects the new worktree
        write_half.write_all(send(&DaemonRequest::WorktreeList).as_bytes()).await.unwrap();
        line.clear();
        reader.read_line(&mut line).await.unwrap();
        match serde_json::from_str::<DaemonResponse>(line.trim()).unwrap() {
            DaemonResponse::WorktreeRecords(entries) => {
                assert_eq!(entries.len(), 1);
                assert_eq!(entries[0].record.branch, "feat-pipe");
            }
            other => panic!("expected WorktreeRecords, got {other:?}"),
        }

        cancel_token.cancel();
    }

    #[tokio::test]
    async fn test_worktree_bound_pane_blocks_removal_by_id_without_cwd() {
        let s = crate::git::test_support::sandbox("v3-bind-id");
        let server = DaemonServer::with_snapshot_storage(s.root.clone());

        match server.handle_request(DaemonRequest::RepoAdd {
            path: s.repo.to_string_lossy().into_owned(),
        }) {
            DaemonResponse::RepoRecords(repos) => assert_eq!(repos.len(), 1),
            other => panic!("expected RepoRecords, got {other:?}"),
        }
        let created = expect_record_one(
            server.handle_request(v3_create_request(&s.repo, "bound")),
            "create",
        );

        // cwd: None — only the id-match gate can block removal
        match server.handle_request(DaemonRequest::CreateOrAttach {
            session_id: "bound-pane".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: None,
            resume_agents: false,
            worktree_id: Some(created.id.clone()),
            extra_env: vec![("MY_TOOL_FLAG".to_string(), "verbose".to_string())],
        }) {
            DaemonResponse::SessionAttached(res) => assert!(res.is_new),
            other => panic!("expected SessionAttached, got {other:?}"),
        }

        let session = server
            .sessions()
            .lock()
            .get("bound-pane")
            .cloned()
            .expect("session live");
        assert_eq!(session.worktree_id(), Some(created.id.as_str()));
        assert_eq!(
            session.env_bindings(),
            &[
                ("OPPA_WORKTREE_ID".to_string(), created.id.clone()),
                ("OPPA_WORKTREE_BRANCH".to_string(), created.branch.clone()),
                (
                    "OPPA_WORKTREE_PATH".to_string(),
                    created.path.to_string_lossy().into_owned()
                ),
                ("OPPA_TAB_ID".to_string(), "bound-pane".to_string()),
                ("MY_TOOL_FLAG".to_string(), "verbose".to_string()),
            ]
        );

        match server.handle_request(DaemonRequest::WorktreePs) {
            DaemonResponse::WorktreePsEntries(entries) => {
                let entry = entries
                    .iter()
                    .find(|e| e.record.id == created.id)
                    .expect("ps entry for bound worktree");
                assert_eq!(entry.live_sessions, 1, "id-match must count the pane");
            }
            other => panic!("expected WorktreePsEntries, got {other:?}"),
        }

        match server.handle_request(DaemonRequest::WorktreeRemove {
            id: created.id.clone(),
            force: false,
            delete_branch: false,
        }) {
            DaemonResponse::Error(e) => assert!(e.contains("bound-pane"), "got: {e}"),
            other => panic!("expected blocked removal, got {other:?}"),
        }
        assert_eq!(
            server.handle_request(DaemonRequest::Kill {
                session_id: "bound-pane".into()
            }),
            DaemonResponse::Ok
        );
        assert_eq!(
            server.handle_request(DaemonRequest::WorktreeRemove {
                id: created.id.clone(),
                force: false,
                delete_branch: false,
            }),
            DaemonResponse::Ok
        );
    }

    #[tokio::test]
    async fn test_unknown_requested_worktree_id_errors_before_spawn() {
        let s = crate::git::test_support::sandbox("v3-bind-miss");
        let server = DaemonServer::with_snapshot_storage(s.root.clone());

        match server.handle_request(DaemonRequest::CreateOrAttach {
            session_id: "miss-pane".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: None,
            resume_agents: false,
            worktree_id: Some("repo::C:/ws/ghost".into()),
            extra_env: Vec::new(),
        }) {
            DaemonResponse::Error(e) => {
                assert!(e.contains("worktree not found"), "got: {e}");
                assert!(e.contains("repo::C:/ws/ghost"), "got: {e}");
            }
            other => panic!("expected not-found error, got {other:?}"),
        }
        assert!(server.sessions().lock().is_empty(), "nothing spawned");
    }

    #[tokio::test]
    async fn test_cold_restore_rebuilds_worktree_binding_from_checkpoint() {
        let s = crate::git::test_support::sandbox("v3-bind-cold");
        let server = DaemonServer::with_snapshot_storage(s.root.clone());

        assert!(matches!(
            server.handle_request(DaemonRequest::RepoAdd {
                path: s.repo.to_string_lossy().into_owned(),
            }),
            DaemonResponse::RepoRecords(_)
        ));
        let created = expect_record_one(
            server.handle_request(v3_create_request(&s.repo, "feat-cold")),
            "create",
        );

        let storage = SnapshotStorage::new(s.root.clone());
        storage
            .save_snapshot(&SessionSnapshot {
                session_id: "cold-wt".into(),
                cwd: String::new(),
                title: None,
                cols: 80,
                rows: 24,
                persona_id: None,
                scrollback: "old screen".into(),
                timestamp: 1,
                foreground_command: None,
                agent_session: None,
                worktree_id: Some(created.id.clone()),
            })
            .expect("seed checkpoint");

        // No request.worktree_id: the checkpoint restores the binding
        match server.handle_request(DaemonRequest::CreateOrAttach {
            session_id: "cold-wt".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: None,
            resume_agents: false,
            worktree_id: None,
            extra_env: Vec::new(),
        }) {
            DaemonResponse::SessionAttached(res) => assert!(res.is_new),
            other => panic!("expected SessionAttached, got {other:?}"),
        }

        let session = server
            .sessions()
            .lock()
            .get("cold-wt")
            .cloned()
            .expect("cold-restored session live");
        assert_eq!(session.worktree_id(), Some(created.id.as_str()));
        let bindings = session.env_bindings();
        assert!(bindings.contains(&("OPPA_WORKTREE_ID".to_string(), created.id.clone())));
        assert!(bindings.contains(&("OPPA_TAB_ID".to_string(), "cold-wt".to_string())));
        assert!(bindings.contains(&(
            "OPPA_WORKTREE_BRANCH".to_string(),
            created.branch.clone()
        )));

        // And the restored identity alone gates teardown
        match server.handle_request(DaemonRequest::WorktreeRemove {
            id: created.id.clone(),
            force: false,
            delete_branch: false,
        }) {
            DaemonResponse::Error(e) => assert!(e.contains("cold-wt"), "got: {e}"),
            other => panic!("expected blocked removal, got {other:?}"),
        }
        let _ = server.handle_request(DaemonRequest::Kill {
            session_id: "cold-wt".into(),
        });
    }
}
