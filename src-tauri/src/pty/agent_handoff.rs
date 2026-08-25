use crate::agents::catalog::{self, build_launch_command, resolve_command, AgentProfile, PromptDelivery};
use crate::agents::shell_line::join_argv;
use crate::git::worktree_registry::WorktreeRegistry;
use crate::git::worktrees::{
    worktree_create, WorktreeCreateRequest,
};
use crate::pty::daemon_session::DaemonSession;
use crate::pty::ipc_protocol::{
    DaemonEvent, DaemonResponse,
};
use crate::pty::snapshot::SessionSnapshot;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::{Duration, Instant};
use crate::pty::daemon_server::{HANDOFF_COLS, HANDOFF_ROWS, PROMPT_DELIVERY_TIMEOUT, DaemonServer};


// Worktree-bound agent pane handoff: env bindings, profile resolution,
// executable checks, and post-ready prompt injection. Pure move.

impl DaemonServer {
    pub(crate) fn resolve_worktree_bindings(
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

    // Orca-parity full handoff: create the worktree, then launch the agent as an
    // ordinary daemon session bound to it so warm reattach and ACK backpressure apply.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn create_worktree_with_agent(
        &self,
        registry_path: &Path,
        repo_path: &str,
        name: Option<String>,
        branch: Option<String>,
        base_ref: Option<String>,
        parent_worktree_id: Option<String>,
        workspace_dir: Option<String>,
        nest_workspaces: bool,
        agent: Option<&str>,
        prompt: Option<&str>,
        command: Option<&str>,
    ) -> DaemonResponse {
        if let Err(msg) = Self::validate_handoff(agent, prompt, command) {
            return DaemonResponse::Error(msg);
        }
        let profile = match Self::resolve_handoff_profile(agent, command) {
            Ok(profile) => profile,
            Err(msg) => return DaemonResponse::Error(msg),
        };
        if let Err(msg) = Self::ensure_executable(profile) {
            return DaemonResponse::Error(msg);
        }
        let req = WorktreeCreateRequest {
            repo_path: PathBuf::from(repo_path),
            name,
            branch,
            base_ref,
            parent_worktree_id,
            workspace_dir_override: workspace_dir.map(PathBuf::from),
            nest_workspaces,
        };
        let record = match worktree_create(registry_path, req) {
            Ok((record, _warnings)) => record,
            Err(e) => return DaemonResponse::Error(e),
        };
        self.publish_global(DaemonEvent::WorktreeChanged {
            id: Some(record.id.clone()),
        });

        let session_id = format!("agent-{}", uuid::Uuid::new_v4());
        let mut env_bindings = match self.resolve_worktree_bindings(&None, Some(&record.id), &session_id)
        {
            Ok(bindings) => bindings,
            Err(e) => return DaemonResponse::Error(e),
        };
        env_bindings.extend(
            profile
                .env
                .iter()
                .map(|(k, v)| ((*k).to_string(), (*v).to_string())),
        );
        env_bindings.push(("OPPA_AGENT_ID".to_string(), profile.id.to_string()));

        let argv_prompt = (profile.prompt_delivery == PromptDelivery::Arg)
            .then_some(prompt)
            .flatten();
        let launch_argv = build_launch_command(profile, argv_prompt);
        // The agent line rides the login shell like a typed command: ConPTY
        // semantics stay uniform with every other pane.
        let launch_line = join_argv(&launch_argv);

        match DaemonSession::spawn(
            session_id.clone(),
            None,
            Some(record.path.to_string_lossy().into_owned()),
            HANDOFF_COLS,
            HANDOFF_ROWS,
            Some(&launch_line),
            &env_bindings,
        ) {
            Ok(session) => {
                if profile.prompt_delivery != PromptDelivery::Arg {
                    if let Some(prompt) = prompt {
                        Self::spawn_post_ready_prompt(&session, prompt.to_string());
                    }
                }
                if let Some(dir) = &self.snapshot_dir {
                    Self::start_checkpoint_task(Arc::clone(&session), dir.clone());
                    if Self::hook_install_allowed() {
                        if let Some(home) = dirs::home_dir() {
                            // Status capture is progressive enhancement: install failures must not block handoff.
                            let _ = crate::pty::agent_hook_installer::install(dir, &home);
                        }
                    }
                }
                self.sessions.lock().insert(session_id.clone(), session);
                DaemonResponse::AgentHandoff { record, session_id }
            }
            Err(e) => DaemonResponse::Error(e),
        }
    }

    pub(crate) fn validate_handoff(
        agent: Option<&str>,
        prompt: Option<&str>,
        command: Option<&str>,
    ) -> Result<(), String> {
        if agent.is_some() && command.is_some() {
            return Err("--agent and --command are mutually exclusive".into());
        }
        if prompt.is_some() && agent.is_none() && command.is_none() {
            return Err("--prompt requires --agent or --command".into());
        }
        Ok(())
    }

    pub(crate) fn resolve_handoff_profile(
        agent: Option<&str>,
        command: Option<&str>,
    ) -> Result<&'static AgentProfile, String> {
        match (agent, command) {
            (Some(id), _) => catalog::lookup(id).ok_or_else(|| format!("unknown agent: {id}")),
            (None, Some(cmd)) => Ok(Self::generic_profile(cmd)),
            (None, None) => Ok(catalog::lookup("generic").expect("generic profile exists")),
        }
    }

    // Raw commands become an ephemeral generic profile; leaking keeps &'static
    // fields without growing the static catalog.
    pub(crate) fn generic_profile(command_line: &str) -> &'static AgentProfile {
        let mut parts = command_line.split_whitespace();
        let program = parts.next().unwrap_or_default();
        let args: &'static [&'static str] = Box::leak(
            parts
                .map(|part| Box::leak(part.to_string().into_boxed_str()) as &'static str)
                .collect::<Vec<_>>()
                .into_boxed_slice(),
        );
        Box::leak(Box::new(AgentProfile {
            id: "generic",
            display_name: "Custom command",
            command: Box::leak(program.to_string().into_boxed_str()),
            default_args: args,
            env: &[],
            prompt_delivery: PromptDelivery::Arg,
            prompt_arg: None,
            prompt_argv_separator: None,
            trust_preapproval_args: &[],
        }))
    }

    pub(crate) fn ensure_executable(profile: &AgentProfile) -> Result<(), String> {
        resolve_command(profile.command)
            .map(|_| ())
            .ok_or_else(|| format!("agent executable not found on PATH: {}", profile.command))
    }

    pub(crate) fn hook_install_allowed() -> bool {
        std::env::var_os("OPPA_SKIP_HOOK_INSTALL").is_none()
    }

    // M1 deviation: PasteOnReady rides Stdin timing — both write once the
    // shell reports ready (initial-command injection doubles as that signal).
    pub(crate) fn spawn_post_ready_prompt(session: &Arc<DaemonSession>, prompt: String) {
        let session = Arc::clone(session);
        tokio::spawn(async move {
            let deadline = Instant::now() + PROMPT_DELIVERY_TIMEOUT;
            while Instant::now() < deadline
                && !session.initial_command_written.load(Ordering::SeqCst)
            {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            let _ = session.write(format!("{prompt}\r").as_bytes());
        });
    }
}

