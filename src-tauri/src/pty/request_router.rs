use crate::git::commit_message::{sc_generate_commit_message, CommitMessage};
use crate::git::pr_message::sc_generate_pr_message;
use crate::git::comments_store::{
    comment_add, comment_delete, comment_update, comments_list, comments_mark_sent,
};
use crate::git::source_control::{
    sc_branch_compare, sc_checkout, sc_commit, sc_discard, sc_fast_forward, sc_fetch,
    sc_file_diff, sc_history, sc_local_branches, sc_pull, sc_push, sc_stage, sc_status,
    sc_unstage, sc_upstream_refresh,
};
use crate::git::hosted_reviews::{
    create_pull_request_live, create_pull_request_live_with_search_path,
    refresh_pr_status_now, review_eligibility_live, review_eligibility_live_with_search_path, CreateReviewInput,
};
use crate::git::teardown::session_cwd_inside;
use crate::git::worktree_lineage::lineage_list;
use crate::git::worktree_registry::WorktreeRegistry;
use crate::git::worktrees::{
    repo_add, worktree_create, worktree_current, worktree_list, worktree_purge, worktree_remove,
    worktree_set, worktree_show, WorktreeCreateRequest,
};
use crate::pty::daemon_session::DaemonSession;
use crate::pty::ipc_protocol::{
    sanitize_session_title, CreateOrAttachResult, DaemonEvent, DaemonRequest, DaemonResponse, WorktreePsEntry, DAEMON_PROTOCOL_VERSION,
};
use crate::pty::runtime_metadata;
use crate::pty::snapshot::SnapshotStorage;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use crate::pty::daemon_server::{REGISTRY_UNAVAILABLE, DaemonServer};


// DaemonRequest dispatch: routes each protocol request to its owning
// subsystem and shapes responses. Pure move out of daemon_server.rs.

impl DaemonServer {
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
                        worktree_id: session.worktree_id().map(str::to_string),
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
                            let worktree_id = session.worktree_id().map(str::to_string);
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
                                worktree_id,
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
            DaemonRequest::ReadScreen { session_id } => {
                let session = self.sessions.lock().get(&session_id).cloned();
                match session {
                    Some(session) => DaemonResponse::ScreenText {
                        text: session.get_screen_text(),
                        truncated: false,
                    },
                    None => DaemonResponse::Error("session not found".into()),
                }
            }
            // Long-poll waits run at the client-stream level (keepalives need
            // the writer handle); this arm only catches direct callers.
            DaemonRequest::WaitFor { .. } => {
                DaemonResponse::Error("WaitFor requires the client-stream handler".into())
            }
            DaemonRequest::SetSessionTitle { session_id, title } => {
                // Validate before lookup: a garbage title is rejected even for dead ids
                let sanitized = sanitize_session_title(&title);
                if sanitized.is_empty() {
                    return DaemonResponse::Error("title required".into());
                }
                let session = self.sessions.lock().get(&session_id).cloned();
                match session {
                    Some(session) => {
                        session.set_title(sanitized.clone());
                        self.publish_global(DaemonEvent::TitleChanged {
                            session_id,
                            title: sanitized,
                        });
                        DaemonResponse::Ok
                    }
                    None => DaemonResponse::Error("session not found".into()),
                }
            }
            DaemonRequest::RequestSessionFocus { session_id } => {
                let exists = self.sessions.lock().contains_key(&session_id);
                if !exists {
                    return DaemonResponse::Error("session not found".into());
                }
                self.publish_global(DaemonEvent::SessionFocusRequested { session_id });
                DaemonResponse::Ok
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
                agent,
                prompt,
                command,
            } => match self.worktree_registry_path.as_deref() {
                Some(registry_path) => {
                    if agent.is_some() || command.is_some() {
                        return self.create_worktree_with_agent(
                            registry_path,
                            &repo_path,
                            name,
                            branch,
                            base_ref,
                            parent_worktree_id,
                            workspace_dir,
                            nest_workspaces.unwrap_or(false),
                            agent.as_deref(),
                            prompt.as_deref(),
                            command.as_deref(),
                        );
                    }
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
            // ---- v4 source-control surface ----
            DaemonRequest::GitStatus { cwd } => {
                self.sc_response(|| sc_status(Path::new(&cwd)), DaemonResponse::ScStatus)
            }
            DaemonRequest::GitStage { cwd, paths } => {
                let resp = self.sc_response(|| sc_stage(Path::new(&cwd), &paths), |_| DaemonResponse::Ok);
                self.publish_git_changed_if_success(&resp);
                resp
            }
            DaemonRequest::GitUnstage { cwd, paths } => {
                let resp = self.sc_response(|| sc_unstage(Path::new(&cwd), &paths), |_| DaemonResponse::Ok);
                self.publish_git_changed_if_success(&resp);
                resp
            }
            DaemonRequest::GitDiscard {
                cwd,
                paths,
                include_untracked,
            } => {
                let resp = self.sc_response(
                    || sc_discard(Path::new(&cwd), &paths, include_untracked),
                    |_| DaemonResponse::Ok,
                );
                self.publish_git_changed_if_success(&resp);
                resp
            }
            DaemonRequest::GitCommit { cwd, message } => {
                let resp = self.sc_response(|| sc_commit(Path::new(&cwd), &message), DaemonResponse::ScCommit);
                self.publish_git_changed_if_success(&resp);
                resp
            }
            DaemonRequest::GitLocalBranches { cwd } => {
                self.sc_response(|| sc_local_branches(Path::new(&cwd)), DaemonResponse::ScBranches)
            }
            DaemonRequest::GitCheckout { cwd, branch } => {
                let resp = self.sc_response(
                    || sc_checkout(Path::new(&cwd), &branch),
                    |_| DaemonResponse::Ok,
                );
                self.publish_git_changed_if_success(&resp);
                resp
            }
            DaemonRequest::GitFileDiff {
                cwd,
                path,
                staged,
                compare_against_head,
            } => self.sc_response(
                || sc_file_diff(Path::new(&cwd), &path, staged, compare_against_head),
                DaemonResponse::ScDiff,
            ),
            DaemonRequest::GitHistory { cwd, limit } => {
                let limit = limit.map(|l| l as usize).unwrap_or(0);
                self.sc_response(|| sc_history(Path::new(&cwd), limit), DaemonResponse::ScHistory)
            }
            DaemonRequest::GitBranchCompare { cwd, base_ref } => {
                self.sc_response(
                    || sc_branch_compare(Path::new(&cwd), &base_ref),
                    DaemonResponse::ScCompare,
                )
            }
            DaemonRequest::GitFetch { cwd } => {
                self.sc_response(|| sc_fetch(Path::new(&cwd)), |_| DaemonResponse::Ok)
            }
            DaemonRequest::GitPull { cwd, ff_only } => {
                let resp = self.sc_response(|| sc_pull(Path::new(&cwd), ff_only), DaemonResponse::ScPull);
                self.publish_git_changed_if_success(&resp);
                resp
            }
            DaemonRequest::GitFastForward { cwd } => {
                let resp = self.sc_response(
                    || sc_fast_forward(Path::new(&cwd)),
                    DaemonResponse::ScPull,
                );
                self.publish_git_changed_if_success(&resp);
                resp
            }
            DaemonRequest::GitPush {
                cwd,
                publish,
                force_with_lease,
            } => {
                let resp = self.sc_response(
                    || sc_push(Path::new(&cwd), publish, force_with_lease),
                    DaemonResponse::ScPush,
                );
                self.publish_git_changed_if_success(&resp);
                // Post-push burst: checks can move seconds after a push lands.
                if !matches!(resp, DaemonResponse::Error(_)) {
                    self.pr_push_burst.notify_one();
                }
                resp
            }
            DaemonRequest::GitUpstreamRefresh { cwd } => self.sc_response(
                || Ok(sc_upstream_refresh(Path::new(&cwd))),
                DaemonResponse::ScUpstream,
            ),
            DaemonRequest::GitGenerateCommitMessage { cwd } => self.sc_response(
                || sc_generate_commit_message(Path::new(&cwd))
                    .map(|message| CommitMessage { message }),
                DaemonResponse::ScCommitMessage,
            ),
            DaemonRequest::GitGeneratePrMessage { cwd } => self.sc_response(
                || sc_generate_pr_message(Path::new(&cwd)),
                DaemonResponse::ScPrMessage,
            ),
            DaemonRequest::DiffCommentsList { worktree_id } => self.comment_response(
                |store| comments_list(&store, &worktree_id),
                DaemonResponse::CommentRecords,
            ),
            DaemonRequest::DiffCommentAdd { comment } => {
                let resp = self.comment_response(
                    |store| comment_add(&store, comment),
                    DaemonResponse::CommentRecordOne,
                );
                self.publish_git_changed_if_success(&resp);
                resp
            }
            DaemonRequest::DiffCommentUpdate { id, body } => {
                let resp = self.comment_response(
                    |store| comment_update(&store, &id, &body),
                    DaemonResponse::CommentRecordOne,
                );
                self.publish_git_changed_if_success(&resp);
                resp
            }
            DaemonRequest::DiffCommentDelete { id } => {
                let resp = self.comment_response(|store| comment_delete(&store, &id), |_| DaemonResponse::Ok);
                self.publish_git_changed_if_success(&resp);
                resp
            }
            DaemonRequest::DiffCommentsMarkSent { ids } => {
                let resp = self.comment_response(
                    |store| comments_mark_sent(&store, &ids),
                    DaemonResponse::CommentRecords,
                );
                self.publish_git_changed_if_success(&resp);
                resp
            }
            DaemonRequest::ReviewEligibility { cwd } => {
                let eligibility = if let Some(dir) = self.gh_search_path.as_deref() {
                    review_eligibility_live_with_search_path(Path::new(&cwd), Some(dir))
                } else {
                    review_eligibility_live(Path::new(&cwd))
                };
                DaemonResponse::ReviewEligibility(eligibility)
            }
            DaemonRequest::CreateReview {
                cwd,
                title,
                body,
                draft,
            } => {
                let Some(registry_path) = self.worktree_registry_path.clone() else {
                    return DaemonResponse::Error(REGISTRY_UNAVAILABLE.into());
                };
                let input = CreateReviewInput { title, body, draft };
                let result = if let Some(dir) = self.gh_search_path.as_deref() {
                    create_pull_request_live_with_search_path(
                        Path::new(&cwd),
                        &registry_path,
                        input,
                        Some(dir),
                    )
                } else {
                    create_pull_request_live(Path::new(&cwd), &registry_path, input)
                };
                match result {
                    Ok(created) => DaemonResponse::CreateReview(created),
                    Err(e) => DaemonResponse::Error(e),
                }
            }
            DaemonRequest::ReviewStatus { cwd } => {
                let Some(registry_path) = self.worktree_registry_path.clone() else {
                    return DaemonResponse::Error(REGISTRY_UNAVAILABLE.into());
                };
                let mut published: Vec<Option<String>> = Vec::new();
                let resp = match refresh_pr_status_now(
                    Path::new(&cwd),
                    &registry_path,
                    self.pr_client.as_ref(),
                    &mut |wid| published.push(wid),
                ) {
                    Ok(status) => DaemonResponse::ReviewStatus(status),
                    Err(e) => DaemonResponse::Error(e),
                };
                for wid in published.into_iter().flatten() {
                    self.publish_global(DaemonEvent::PrChanged {
                        worktree_id: Some(wid),
                    });
                }
                resp
            }
        }
    }

    // Shared gate + result envelope so every git.* handler stays a one-liner.
    pub(crate) fn sc_response<T>(
        &self,
        op: impl FnOnce() -> Result<T, String>,
        ok: impl FnOnce(T) -> DaemonResponse,
    ) -> DaemonResponse {
        if self.worktree_registry_path.is_none() {
            return DaemonResponse::Error(REGISTRY_UNAVAILABLE.into());
        }
        match op() {
            Ok(value) => ok(value),
            Err(e) => DaemonResponse::Error(e),
        }
    }

    pub(crate) fn comment_response<T>(
        &self,
        op: impl FnOnce(PathBuf) -> Result<T, String>,
        ok: impl FnOnce(T) -> DaemonResponse,
    ) -> DaemonResponse {
        let Some(store_path) = self.comments_store_path.clone() else {
            return DaemonResponse::Error(REGISTRY_UNAVAILABLE.into());
        };
        match op(store_path) {
            Ok(value) => ok(value),
            Err(e) => DaemonResponse::Error(e),
        }
    }

    // Any successful source-control mutation nudges every client's panel to refresh.
    pub(crate) fn publish_git_changed_if_success(&self, resp: &DaemonResponse) {
        if !matches!(resp, DaemonResponse::Error(_)) {
            self.publish_global(DaemonEvent::GitChanged);
        }
    }

    // Requested id is strict (unknown id errors); a checkpoint id restores
    // identity even if the registry no longer holds the record.
}

