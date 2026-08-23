use crate::git::commit_message::CommitMessage;
use crate::git::comments_store::{DiffComment, NewDiffComment};
use crate::git::source_control::{
    BranchCompare, DiffContent, HistoryResult, LocalBranches, PullOutcome, PushOutcome,
    SourceControlStatus, UpstreamStatus,
};
use crate::git::hosted_reviews::{CreatedReview, Eligibility, PrStatus};
use crate::git::worktree_registry::{RepoRecord, WorktreeRecord, WorktreeStatus};
use crate::git::worktrees::WorktreeListEntry;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const DAEMON_PROTOCOL_VERSION: u32 = 5;

/// How a cold-restored session's foreground work will be brought back.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResumeKind {
    /// Relaunch via the agent's native resume (session id known)
    AgentResume,
    /// Re-execute the captured foreground command (known agent, no session id)
    CommandRelaunch,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResumePlan {
    pub command_line: String,
    pub kind: ResumeKind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateOrAttachResult {
    pub is_new: bool,
    pub pid: u32,
    pub cols: u16,
    pub rows: u16,
    pub cwd: Option<String>,
    pub snapshot: Option<String>,
    #[serde(default)]
    pub resume: Option<ResumePlan>,
    #[serde(default)]
    pub resume_declined_reason: Option<String>,
    // Additive v3 field so `terminal split` can inherit the pane's binding
    #[serde(default)]
    pub worktree_id: Option<String>,
}

// Wire values are kebab-case ("tui-idle"), matching the CLI --for argument verbatim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum WaitCondition {
    Exit,
    TuiIdle,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreePsEntry {
    pub record: WorktreeRecord,
    pub live_sessions: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum DaemonRequest {
    Hello {
        client_version: String,
        protocol_version: u32,
        // v3; older clients omit the field entirely
        #[serde(default)]
        auth_token: Option<String>,
    },
    CreateOrAttach {
        session_id: String,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
        shell: Option<String>,
        #[serde(default)]
        resume_agents: bool,
        #[serde(default)]
        worktree_id: Option<String>,
        #[serde(default)]
        extra_env: Vec<(String, String)>,
    },
    Write {
        session_id: String,
        data: String,
    },
    Resize {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    Ack {
        session_id: String,
        chars: usize,
    },
    Kill {
        session_id: String,
    },
    ReadScreen {
        session_id: String,
    },
    // Long-poll; handled at the client-stream level so the server can emit
    // keepalive frames while blocked. handle_request only sees it on misuse.
    WaitFor {
        session_id: String,
        cond: WaitCondition,
        timeout_ms: u64,
    },
    // Tab-title sync: daemon sanitizes, stores, and broadcasts TitleChanged
    SetSessionTitle {
        session_id: String,
        title: String,
    },
    // CLI-driven focus switch; the GUI decides what "focus" means
    RequestSessionFocus {
        session_id: String,
    },
    ListSessions,
    Disconnect,
    Shutdown,
    RepoAdd { path: String },
    RepoList,
    WorktreeCreate {
        repo_path: String,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        branch: Option<String>,
        #[serde(default)]
        base_ref: Option<String>,
        #[serde(default)]
        parent_worktree_id: Option<String>,
        #[serde(default)]
        workspace_dir: Option<String>,
        #[serde(default)]
        nest_workspaces: Option<bool>,
        // Agent handoff (v3): catalog agent id or raw command, plus first prompt
        #[serde(default)]
        agent: Option<String>,
        #[serde(default)]
        prompt: Option<String>,
        #[serde(default)]
        command: Option<String>,
    },
    WorktreeList,
    WorktreeShow { id: String },
    WorktreeCurrent { cwd: String },
    // set_parent disambiguates "clear parent" from "leave parent untouched",
    // which a bare Option<Option<String>> cannot express over JSON.
    WorktreeSet {
        id: String,
        set_parent: bool,
        #[serde(default)]
        parent_worktree_id: Option<String>,
        #[serde(default)]
        workspace_status: Option<WorktreeStatus>,
        #[serde(default)]
        display_name: Option<String>,
    },
    WorktreeRemove {
        id: String,
        force: bool,
        delete_branch: bool,
    },
    WorktreePurge { id: String },
    WorktreePs,
    WorktreeLineage { id: String },
    // v4 source-control surface: cwd-relative ops delegated to git/source_control.rs
    GitStatus { cwd: String },
    GitStage { cwd: String, paths: Vec<String> },
    GitUnstage { cwd: String, paths: Vec<String> },
    GitDiscard {
        cwd: String,
        paths: Vec<String>,
        include_untracked: bool,
    },
    GitCommit { cwd: String, message: String },
    GitLocalBranches { cwd: String },
    GitCheckout { cwd: String, branch: String },
    GitFileDiff {
        cwd: String,
        path: String,
        staged: bool,
        compare_against_head: bool,
    },
    GitHistory { cwd: String, limit: Option<u32> },
    GitBranchCompare { cwd: String, base_ref: String },
    GitFetch { cwd: String },
    GitPull { cwd: String, ff_only: bool },
    GitFastForward { cwd: String },
    GitPush {
        cwd: String,
        publish: bool,
        force_with_lease: bool,
    },
    GitUpstreamRefresh { cwd: String },
    // Read-only AI commit-message generation; never publishes GitChanged
    GitGenerateCommitMessage { cwd: String },
    DiffCommentsList { worktree_id: String },
    DiffCommentAdd { comment: NewDiffComment },
    DiffCommentUpdate { id: String, body: String },
    DiffCommentDelete { id: String },
    DiffCommentsMarkSent { ids: Vec<String> },
    // v5 hosted-review surface: eligibility, creation, and status refresh
    ReviewEligibility { cwd: String },
    CreateReview {
        cwd: String,
        title: String,
        body: String,
        draft: bool,
    },
    ReviewStatus { cwd: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum DaemonResponse {
    HelloOk { protocol_version: u32 },
    SessionAttached(CreateOrAttachResult),
    SessionList(Vec<String>),
    Ok,
    Error(String),
    // Viewport-only plain text (no scrollback, no ANSI); truncated is
    // reserved for a future raw byte-stream replay mode.
    ScreenText {
        text: String,
        truncated: bool,
    },
    WaitResult {
        satisfied: bool,
        exit_code: Option<i32>,
        waited_ms: u64,
    },
    RepoRecords(Vec<RepoRecord>),
    WorktreeRecords(Vec<WorktreeListEntry>),
    // Single-record replies (show/current/set/create); None means "not found" without erroring
    WorktreeRecordOne(Option<WorktreeRecord>),
    WorktreeRecordsList(Vec<WorktreeRecord>),
    WorktreePsEntries(Vec<WorktreePsEntry>),
    // session_id IS the agent terminal handle: attaching to it opens the agent pane
    AgentHandoff {
        record: WorktreeRecord,
        session_id: String,
    },
    // v4 source-control replies; payload types are the git module's serde structs verbatim
    ScStatus(SourceControlStatus),
    ScCommit(String),
    ScBranches(LocalBranches),
    ScDiff(DiffContent),
    ScHistory(HistoryResult),
    ScCompare(BranchCompare),
    ScPull(PullOutcome),
    ScPush(PushOutcome),
    ScUpstream(UpstreamStatus),
    ScCommitMessage(CommitMessage),
    CommentRecords(Vec<DiffComment>),
    CommentRecordOne(DiffComment),
    // v5 hosted-review replies
    ReviewEligibility(Eligibility),
    CreateReview(CreatedReview),
    ReviewStatus(PrStatus),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event", content = "payload")]
pub enum DaemonEvent {
    Data {
        session_id: String,
        data: String,
        bytes: usize,
        seq: u64,
    },
    Exit {
        session_id: String,
        code: Option<i32>,
    },
    Cwd {
        session_id: String,
        cwd: String,
    },
    WorktreeChanged {
        id: Option<String>,
    },
    // A linked worktree's PR status refreshed (poll tick, push burst, or manual)
    PrChanged {
        worktree_id: Option<String>,
    },
    TitleChanged {
        session_id: String,
        title: String,
    },
    SessionFocusRequested {
        session_id: String,
    },
    // Any successful source-control mutation anywhere; payload-less nudge to refresh panels
    GitChanged,
}

// Tab bars render titles verbatim: control bytes and runaway length never belong there.
pub const MAX_SESSION_TITLE_CHARS: usize = 80;

/// Strip control chars (<0x20, 0x7F-0x9F), trim, then cap at 80 chars on a char boundary.
pub fn sanitize_session_title(raw: &str) -> String {
    let stripped: String = raw.chars().filter(|c| !c.is_control()).collect();
    stripped.trim().chars().take(MAX_SESSION_TITLE_CHARS).collect()
}

pub fn get_daemon_socket_path() -> String {
    if cfg!(windows) {
        let username = std::env::var("USERNAME").unwrap_or_else(|_| "default".into());
        format!(r"\\.\pipe\oppa-daemon-{}", username)
    } else {
        let runtime_dir = std::env::var("XDG_RUNTIME_DIR").unwrap_or_else(|_| "/tmp".into());
        PathBuf::from(runtime_dir)
            .join("oppa-daemon.sock")
            .to_string_lossy()
            .into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_serialize_create_or_attach_roundtrip() {
        let req = DaemonRequest::CreateOrAttach {
            session_id: "test-session-1".into(),
            cols: 80,
            rows: 24,
            cwd: Some("C:\\projects".into()),
            shell: None,
            resume_agents: true,
            worktree_id: Some("repo::C:/ws/feat-a".into()),
            extra_env: vec![("MY_TOOL_FLAG".into(), "verbose".into())],
        };
        let encoded = serde_json::to_string(&req).expect("serialize");
        let decoded: DaemonRequest = serde_json::from_str(&encoded).expect("deserialize");
        assert_eq!(req, decoded);
    }

    #[test]
    fn test_create_or_attach_worktree_fields_roundtrip_and_legacy_defaults() {
        let req = DaemonRequest::CreateOrAttach {
            session_id: "s-wt".into(),
            cols: 80,
            rows: 24,
            cwd: None,
            shell: None,
            resume_agents: false,
            worktree_id: Some("repo::C:/ws/feat-b".into()),
            extra_env: vec![
                ("OPPA_CUSTOM".into(), "1".into()),
                ("MY_TOOL_FLAG".into(), "verbose".into()),
            ],
        };
        let encoded = serde_json::to_string(&req).expect("serialize");
        let decoded: DaemonRequest = serde_json::from_str(&encoded).expect("deserialize");
        assert_eq!(req, decoded);
        match decoded {
            DaemonRequest::CreateOrAttach { worktree_id, extra_env, .. } => {
                assert_eq!(worktree_id.as_deref(), Some("repo::C:/ws/feat-b"));
                assert_eq!(
                    extra_env,
                    vec![
                        ("OPPA_CUSTOM".to_string(), "1".to_string()),
                        ("MY_TOOL_FLAG".to_string(), "verbose".to_string())
                    ]
                );
            }
            other => panic!("expected CreateOrAttach, got {other:?}"),
        }

        // v3 clients predating the binding fields must keep deserializing
        let legacy = r#"{"type":"CreateOrAttach","payload":{"session_id":"legacy","cols":80,"rows":24,"cwd":null,"shell":null,"resume_agents":false}}"#;
        match serde_json::from_str::<DaemonRequest>(legacy).expect("legacy create") {
            DaemonRequest::CreateOrAttach {
                worktree_id,
                extra_env,
                ..
            } => {
                assert_eq!(worktree_id, None);
                assert!(extra_env.is_empty());
            }
            other => panic!("expected CreateOrAttach, got {other:?}"),
        }
    }

    #[test]
    fn test_serialize_daemon_requests_all_variants() {
        let requests = vec![
            DaemonRequest::Hello {
                client_version: "0.1.0".into(),
                protocol_version: DAEMON_PROTOCOL_VERSION,
                auth_token: None,
            },
            DaemonRequest::CreateOrAttach {
                session_id: "s1".into(),
                cols: 120,
                rows: 30,
                cwd: None,
                shell: Some("/bin/bash".into()),
                resume_agents: false,
                worktree_id: None,
                extra_env: Vec::new(),
            },
            DaemonRequest::Write {
                session_id: "s1".into(),
                data: "ls -la\n".into(),
            },
            DaemonRequest::Resize {
                session_id: "s1".into(),
                cols: 100,
                rows: 40,
            },
            DaemonRequest::Ack {
                session_id: "s1".into(),
                chars: 1024,
            },
            DaemonRequest::Kill {
                session_id: "s1".into(),
            },
            DaemonRequest::ReadScreen { session_id: "s1".into() },
            DaemonRequest::WaitFor {
                session_id: "s1".into(),
                cond: WaitCondition::TuiIdle,
                timeout_ms: 5000,
            },
            DaemonRequest::ListSessions,
            DaemonRequest::Disconnect,
            DaemonRequest::Shutdown,
        ];

        for req in requests {
            let json = serde_json::to_string(&req).expect("serialize request");
            let decoded: DaemonRequest = serde_json::from_str(&json).expect("deserialize request");
            assert_eq!(req, decoded);
        }
    }

    #[test]
    fn test_serialize_create_or_attach_response_with_snapshot() {
        let res = DaemonResponse::SessionAttached(CreateOrAttachResult {
            is_new: false,
            pid: 1234,
            cols: 80,
            rows: 24,
            cwd: Some("C:\\projects".into()),
            snapshot: Some("\x1b[32mhello\x1b[0m".into()),
            resume: None,
            resume_declined_reason: None,
            worktree_id: None,
        });
        let encoded = serde_json::to_string(&res).expect("serialize");
        assert!(encoded.contains("\"is_new\":false"));
        assert!(encoded.contains("\"pid\":1234"));
        assert!(encoded.contains("hello"));

        let decoded: DaemonResponse = serde_json::from_str(&encoded).expect("deserialize");
        assert_eq!(res, decoded);
    }

    #[test]
    fn test_serialize_daemon_responses_all_variants() {
        let responses = vec![
            DaemonResponse::HelloOk {
                protocol_version: 1,
            },
            DaemonResponse::SessionAttached(CreateOrAttachResult {
                is_new: true,
                pid: 5678,
                cols: 80,
                rows: 24,
                cwd: None,
                snapshot: None,
                resume: None,
                resume_declined_reason: None,
                worktree_id: None,
            }),
            DaemonResponse::SessionList(vec!["s1".into(), "s2".into()]),
            DaemonResponse::Ok,
            DaemonResponse::Error("session not found".into()),
            DaemonResponse::ScreenText {
                text: "hello\nworld".into(),
                truncated: false,
            },
            DaemonResponse::WaitResult {
                satisfied: true,
                exit_code: Some(0),
                waited_ms: 812,
            },
        ];

        for res in responses {
            let json = serde_json::to_string(&res).expect("serialize response");
            let decoded: DaemonResponse =
                serde_json::from_str(&json).expect("deserialize response");
            assert_eq!(res, decoded);
        }
    }

    #[test]
    fn test_serialize_daemon_events_all_variants() {
        let events = vec![
            DaemonEvent::Data {
                session_id: "s1".into(),
                data: "output line\r\n".into(),
                bytes: 13,
                seq: 42,
            },
            DaemonEvent::Exit {
                session_id: "s1".into(),
                code: Some(0),
            },
            DaemonEvent::Cwd {
                session_id: "s1".into(),
                cwd: "/Users/dev/repo".into(),
            },
            DaemonEvent::WorktreeChanged { id: None },
            DaemonEvent::WorktreeChanged {
                id: Some("repo::C:/ws/feat-a".into()),
            },
            DaemonEvent::PrChanged {
                worktree_id: Some("repo::C:/ws/feat-a".into()),
            },
            DaemonEvent::PrChanged { worktree_id: None },
            DaemonEvent::TitleChanged {
                session_id: "s1".into(),
                title: "build".into(),
            },
            DaemonEvent::SessionFocusRequested {
                session_id: "s1".into(),
            },
        ];

        for event in events {
            let json = serde_json::to_string(&event).expect("serialize event");
            let decoded: DaemonEvent = serde_json::from_str(&json).expect("deserialize event");
            assert_eq!(event, decoded);
        }
    }

    #[test]
    fn test_pr_changed_event_wire_shape() {
        let event =
            DaemonEvent::PrChanged { worktree_id: Some("repo::C:/ws/feat-x".into()) };
        assert_eq!(
            serde_json::to_value(&event).unwrap(),
            serde_json::json!({
                "event": "PrChanged",
                "payload": {"worktree_id": "repo::C:/ws/feat-x"}
            })
        );
        let bare: DaemonEvent =
            serde_json::from_str(r#"{"event":"PrChanged","payload":{"worktree_id":null}}"#)
                .unwrap();
        assert_eq!(bare, DaemonEvent::PrChanged { worktree_id: None });
    }

    #[test]
    fn test_title_sync_requests_roundtrip() {
        let requests = vec![
            DaemonRequest::SetSessionTitle {
                session_id: "s1".into(),
                title: "build".into(),
            },
            DaemonRequest::RequestSessionFocus {
                session_id: "s1".into(),
            },
        ];
        for req in requests {
            let json = serde_json::to_string(&req).expect("serialize request");
            let decoded: DaemonRequest = serde_json::from_str(&json).expect("deserialize request");
            assert_eq!(req, decoded);
        }
    }

    #[test]
    fn test_sanitize_session_title_strips_controls_and_trims() {
        assert_eq!(sanitize_session_title("\x07 My Tab \n"), "My Tab");
        assert_eq!(sanitize_session_title("a\tb\x1b[0mc"), "ab[0mc");
        assert_eq!(sanitize_session_title("del\u{7f}c1\u{85}end"), "delc1end");
    }

    #[test]
    fn test_sanitize_session_title_truncates_multibyte_at_80_chars() {
        // 'é' is 2 bytes in UTF-8: 100 of them are 200 bytes but must cut at 80 chars
        let long = "é".repeat(100);
        let sanitized = sanitize_session_title(&long);
        assert_eq!(sanitized.chars().count(), MAX_SESSION_TITLE_CHARS);
        assert_eq!(sanitized, "é".repeat(MAX_SESSION_TITLE_CHARS));
    }

    #[test]
    fn test_sanitize_session_title_empty_after_strip_rejects() {
        assert_eq!(sanitize_session_title("\x07\x1b\u{7f}"), "");
        assert_eq!(sanitize_session_title("   "), "");
    }

    fn sample_repo_record(repo_id: &str) -> RepoRecord {
        RepoRecord {
            repo_id: repo_id.into(),
            path: PathBuf::from("/tmp/sample-repo"),
            default_base_ref: Some("main".into()),
            worktree_base_path: None,
        }
    }

    fn sample_worktree_record(id: &str) -> WorktreeRecord {
        WorktreeRecord {
            id: id.into(),
            repo_id: "sample".into(),
            name: "feat-a".into(),
            display_name: Some("Feat A".into()),
            branch: "feat-a".into(),
            path: PathBuf::from("/tmp/repo-workspaces/feat-a"),
            base_ref: "main".into(),
            parent_worktree_id: None,
            child_worktree_ids: Vec::new(),
            workspace_status: crate::git::worktree_registry::WorktreeStatus::InProgress,
            retired: false,
            created_at_ms: 1723900000000,
            linked_pr_url: None,
        }
    }

    #[test]
    fn test_serialize_v3_requests_roundtrip() {
        let requests = vec![
            DaemonRequest::Hello {
                client_version: "0.2.0".into(),
                protocol_version: DAEMON_PROTOCOL_VERSION,
                auth_token: Some("deadbeef".into()),
            },
            DaemonRequest::RepoAdd { path: "/tmp/repo".into() },
            DaemonRequest::RepoList,
            DaemonRequest::WorktreeCreate {
                repo_path: "/tmp/repo".into(),
                name: Some("feat-a".into()),
                branch: None,
                base_ref: Some("main".into()),
                parent_worktree_id: None,
                workspace_dir: Some("/tmp/ws".into()),
                nest_workspaces: Some(true),
                agent: None,
                prompt: None,
                command: None,
            },
            DaemonRequest::WorktreeCreate {
                repo_path: "/tmp/repo".into(),
                name: Some("agentized".into()),
                branch: None,
                base_ref: None,
                parent_worktree_id: None,
                workspace_dir: None,
                nest_workspaces: None,
                agent: Some("claude".into()),
                prompt: Some("fix it".into()),
                command: None,
            },
            DaemonRequest::WorktreeList,
            DaemonRequest::WorktreeShow { id: "sample::/tmp/x".into() },
            DaemonRequest::WorktreeCurrent { cwd: "/tmp/x/src".into() },
            DaemonRequest::WorktreeSet {
                id: "wt-1".into(),
                set_parent: true,
                parent_worktree_id: Some("wt-root".into()),
                workspace_status: Some(crate::git::worktree_registry::WorktreeStatus::InProgress),
                display_name: Some("My Feature".into()),
            },
            // set_parent=false must survive the roundtrip even with a stale id present
            DaemonRequest::WorktreeSet {
                id: "wt-1".into(),
                set_parent: false,
                parent_worktree_id: Some("ignored".into()),
                workspace_status: None,
                display_name: None,
            },
            DaemonRequest::WorktreeRemove {
                id: "wt-1".into(),
                force: true,
                delete_branch: false,
            },
            DaemonRequest::WorktreePurge { id: "wt-1".into() },
            DaemonRequest::WorktreePs,
            DaemonRequest::WorktreeLineage { id: "wt-root".into() },
        ];

        for req in requests {
            let json = serde_json::to_string(&req).expect("serialize request");
            let decoded: DaemonRequest = serde_json::from_str(&json).expect("deserialize request");
            assert_eq!(req, decoded);
        }
    }

    #[test]
    fn test_serialize_v3_responses_roundtrip() {
        let responses = vec![
            DaemonResponse::RepoRecords(vec![sample_repo_record("sample")]),
            DaemonResponse::RepoRecords(Vec::new()),
            DaemonResponse::WorktreeRecords(vec![crate::git::worktrees::WorktreeListEntry {
                record: sample_worktree_record("wt-1"),
                missing_on_disk: false,
            }]),
            DaemonResponse::WorktreeRecordOne(Some(sample_worktree_record("wt-1"))),
            DaemonResponse::WorktreeRecordOne(None),
            DaemonResponse::WorktreeRecordsList(vec![
                sample_worktree_record("wt-root"),
                sample_worktree_record("wt-child"),
            ]),
            DaemonResponse::WorktreePsEntries(vec![WorktreePsEntry {
                record: sample_worktree_record("wt-1"),
                live_sessions: 2,
            }]),
            DaemonResponse::AgentHandoff {
                record: sample_worktree_record("wt-agent"),
                session_id: "wt-abc-123".into(),
            },
        ];

        for res in responses {
            let json = serde_json::to_string(&res).expect("serialize response");
            let decoded: DaemonResponse =
                serde_json::from_str(&json).expect("deserialize response");
            assert_eq!(res, decoded);
        }
    }

    #[test]
    fn test_agent_handoff_wire_shape_carries_record_and_session_id() {
        let json = serde_json::to_value(DaemonResponse::AgentHandoff {
            record: sample_worktree_record("wt-x"),
            session_id: "wt-sid".into(),
        })
        .unwrap();
        assert_eq!(json["type"], "AgentHandoff");
        assert_eq!(json["payload"]["session_id"], "wt-sid");
        assert_eq!(json["payload"]["record"]["id"], "wt-x");
    }

    #[test]
    fn test_worktree_create_without_handoff_fields_still_deserializes() {
        let legacy = r#"{"type":"WorktreeCreate","payload":{"repo_path":"/tmp/repo","name":"feat-a"}}"#;
        match serde_json::from_str::<DaemonRequest>(legacy).expect("legacy create") {
            DaemonRequest::WorktreeCreate {
                agent,
                prompt,
                command,
                ..
            } => {
                assert_eq!(agent, None);
                assert_eq!(prompt, None);
                assert_eq!(command, None);
            }
            other => panic!("expected WorktreeCreate, got {other:?}"),
        }
    }

    #[test]
    fn test_hello_without_auth_token_still_deserializes_old_client() {
        let old_client_hello =
            r#"{"type":"Hello","payload":{"client_version":"0.9.0","protocol_version":2}}"#;
        let decoded: DaemonRequest = serde_json::from_str(old_client_hello).expect("old hello");
        match decoded {
            DaemonRequest::Hello {
                client_version,
                protocol_version,
                auth_token,
            } => {
                assert_eq!(client_version, "0.9.0");
                assert_eq!(protocol_version, 2);
                assert_eq!(auth_token, None);
            }
            other => panic!("expected Hello, got {other:?}"),
        }
    }

    #[test]
    fn test_worktree_set_wire_shape_distinguishes_clear_from_untouched() {
        let clear = serde_json::to_value(DaemonRequest::WorktreeSet {
            id: "wt-1".into(),
            set_parent: true,
            parent_worktree_id: None,
            workspace_status: None,
            display_name: None,
        })
        .unwrap();
        let payload = clear.get("payload").unwrap();
        assert_eq!(payload["set_parent"], serde_json::json!(true));
        assert_eq!(payload["parent_worktree_id"], serde_json::Value::Null);

        let untouched = serde_json::to_value(DaemonRequest::WorktreeSet {
            id: "wt-1".into(),
            set_parent: false,
            parent_worktree_id: None,
            workspace_status: None,
            display_name: None,
        })
        .unwrap();
        assert_eq!(untouched.get("payload").unwrap()["set_parent"], serde_json::json!(false));
    }

    #[test]
    fn test_worktree_status_wire_values_survive_request_roundtrip() {
        let json = serde_json::to_string(&DaemonRequest::WorktreeSet {
            id: "wt-1".into(),
            set_parent: false,
            parent_worktree_id: None,
            workspace_status: Some(crate::git::worktree_registry::WorktreeStatus::InProgress),
            display_name: None,
        })
        .unwrap();
        assert!(json.contains("in-progress"), "wire value expected in: {json}");
    }

    #[test]
    fn test_serialize_resume_plan_roundtrip() {
        let res = DaemonResponse::SessionAttached(CreateOrAttachResult {
            is_new: true,
            pid: 1,
            cols: 80,
            rows: 24,
            cwd: None,
            snapshot: None,
            resume: Some(ResumePlan {
                command_line: "claude --resume abc".into(),
                kind: ResumeKind::AgentResume,
            }),
            resume_declined_reason: None,
            worktree_id: None,
        });
        let encoded = serde_json::to_string(&res).expect("serialize");
        let decoded: DaemonResponse = serde_json::from_str(&encoded).expect("deserialize");
        assert_eq!(res, decoded);
    }

    #[test]
    fn test_wait_condition_wire_values_are_kebab_case() {
        let exit = serde_json::to_string(&WaitCondition::Exit).unwrap();
        assert_eq!(exit, r#""exit""#);
        let idle = serde_json::to_string(&WaitCondition::TuiIdle).unwrap();
        assert_eq!(idle, r#""tui-idle""#);
        let decoded: WaitCondition = serde_json::from_str(idle.as_str()).unwrap();
        assert_eq!(decoded, WaitCondition::TuiIdle);
    }

    #[test]
    fn test_daemon_socket_path() {
        let path = get_daemon_socket_path();
        assert!(!path.is_empty());
        if cfg!(windows) {
            assert!(path.starts_with(r"\\.\pipe\oppa-daemon-"));
        } else {
            assert!(path.ends_with("oppa-daemon.sock"));
        }
    }

    // ---- v4 source-control surface ----

    fn sample_status() -> SourceControlStatus {
        serde_json::from_value(serde_json::json!({
            "entries": [{
                "path": "src/lib.rs",
                "index_status": "M",
                "worktree_status": " ",
                "area": "staged",
                "old_path": null
            }],
            "conflict_state": "merge",
            "branch": "main",
            "upstream": {
                "has_upstream": true,
                "ahead": 2,
                "behind": 1,
                "remote_branch": "origin/main"
            },
            "did_hit_limit": false,
            "status_length": 1
        }))
        .unwrap()
    }

    fn sample_comment() -> DiffComment {
        serde_json::from_value(serde_json::json!({
            "id": "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0",
            "worktree_id": "repo::C:/ws/feat-a",
            "file_path": "src/lib.rs",
            "source": "diff",
            "selected_text": null,
            "start_line": null,
            "line_number": 12,
            "body": "why here?",
            "scope": "unstaged",
            "old_path": null,
            "created_at_ms": 1723900000000u64,
            "updated_at_ms": null,
            "sent_at": null
        }))
        .unwrap()
    }

    fn sample_new_comment() -> NewDiffComment {
        NewDiffComment {
            worktree_id: "repo::C:/ws/feat-a".into(),
            file_path: "src/lib.rs".into(),
            source: crate::git::comments_store::DiffCommentSource::Diff,
            selected_text: Some("let x".into()),
            start_line: Some(10),
            line_number: 12,
            body: "why here?".into(),
            scope: crate::git::comments_store::DiffCommentScope::Unstaged,
            old_path: None,
        }
    }

    #[test]
    fn test_serialize_v4_git_requests_roundtrip() {
        let requests = vec![
            DaemonRequest::GitStatus { cwd: "/r".into() },
            DaemonRequest::GitStage { cwd: "/r".into(), paths: vec!["a.txt".into()] },
            DaemonRequest::GitUnstage { cwd: "/r".into(), paths: Vec::new() },
            DaemonRequest::GitDiscard {
                cwd: "/r".into(),
                paths: vec!["a.txt".into()],
                include_untracked: true,
            },
            DaemonRequest::GitCommit { cwd: "/r".into(), message: "feat: x".into() },
            DaemonRequest::GitLocalBranches { cwd: "/r".into() },
            DaemonRequest::GitCheckout { cwd: "/r".into(), branch: "main".into() },
            DaemonRequest::GitFileDiff {
                cwd: "/r".into(),
                path: "a.txt".into(),
                staged: true,
                compare_against_head: false,
            },
            DaemonRequest::GitHistory { cwd: "/r".into(), limit: Some(20) },
            DaemonRequest::GitHistory { cwd: "/r".into(), limit: None },
            DaemonRequest::GitBranchCompare { cwd: "/r".into(), base_ref: "main".into() },
            DaemonRequest::GitFetch { cwd: "/r".into() },
            DaemonRequest::GitPull { cwd: "/r".into(), ff_only: true },
            DaemonRequest::GitFastForward { cwd: "/r".into() },
            DaemonRequest::GitPush {
                cwd: "/r".into(),
                publish: true,
                force_with_lease: false,
            },
            DaemonRequest::GitUpstreamRefresh { cwd: "/r".into() },
            DaemonRequest::GitGenerateCommitMessage { cwd: "/r".into() },
        ];
        for req in requests {
            let json = serde_json::to_string(&req).expect("serialize request");
            let decoded: DaemonRequest = serde_json::from_str(&json).expect("deserialize request");
            assert_eq!(req, decoded);
        }
    }

    #[test]
    fn test_serialize_v4_comment_requests_roundtrip() {
        let requests = vec![
            DaemonRequest::DiffCommentsList { worktree_id: "wt-1".into() },
            DaemonRequest::DiffCommentAdd { comment: sample_new_comment() },
            DaemonRequest::DiffCommentUpdate { id: "c-1".into(), body: "edited".into() },
            DaemonRequest::DiffCommentDelete { id: "c-1".into() },
            DaemonRequest::DiffCommentsMarkSent { ids: vec!["c-1".into(), "c-2".into()] },
        ];
        for req in requests {
            let json = serde_json::to_string(&req).expect("serialize request");
            let decoded: DaemonRequest = serde_json::from_str(&json).expect("deserialize request");
            assert_eq!(req, decoded);
        }
        // Optional fields stay optional on the wire for older-style payloads
        let legacy =
            r#"{"type":"DiffCommentAdd","payload":{"comment":{"worktree_id":"w","file_path":"f","source":"markdown","line_number":3,"body":"b","scope":"branch"}}}"#;
        match serde_json::from_str::<DaemonRequest>(legacy).expect("legacy add") {
            DaemonRequest::DiffCommentAdd { comment } => {
                assert_eq!(comment.selected_text, None);
                assert_eq!(comment.start_line, None);
                assert_eq!(comment.old_path, None);
                assert_eq!(
                    comment.source,
                    crate::git::comments_store::DiffCommentSource::Markdown
                );
            }
            other => panic!("expected DiffCommentAdd, got {other:?}"),
        }
    }

    #[test]
    fn test_serialize_v4_responses_roundtrip() {
        let responses = vec![
            DaemonResponse::ScStatus(sample_status()),
            DaemonResponse::ScCommit("abc1234".into()),
            DaemonResponse::ScBranches(crate::git::source_control::LocalBranches {
                branches: vec!["main".into(), "feature".into()],
                current: Some("main".into()),
            }),
            DaemonResponse::ScDiff(crate::git::source_control::DiffContent {
                kind: crate::git::source_control::DiffKind::Binary,
                original_content: String::new(),
                modified_content: String::new(),
                truncated: false,
            }),
            DaemonResponse::ScHistory(HistoryResult {
                items: Vec::new(),
                has_more: true,
            }),
            DaemonResponse::ScCompare(BranchCompare {
                base_ref: "main".into(),
                ahead: 3,
                behind: 0,
                changed_files: Vec::new(),
            }),
            DaemonResponse::ScPull(PullOutcome {
                status: crate::git::source_control::PullStatus::FastForward,
                new_head: Some("def5678".into()),
            }),
            DaemonResponse::ScPush(PushOutcome {
                pushed_to: "origin/main".into(),
                was_publish: true,
            }),
            DaemonResponse::ScUpstream(UpstreamStatus {
                has_upstream: false,
                ahead: 0,
                behind: 0,
                remote_branch: None,
            }),
            DaemonResponse::ScCommitMessage(CommitMessage {
                message: "feat: generated".into(),
            }),
            DaemonResponse::CommentRecords(vec![sample_comment()]),
            DaemonResponse::CommentRecordOne(sample_comment()),
        ];
        for res in responses {
            let json = serde_json::to_string(&res).expect("serialize response");
            let decoded: DaemonResponse =
                serde_json::from_str(&json).expect("deserialize response");
            assert_eq!(res, decoded);
        }
    }

    #[test]
    fn test_v4_wire_shapes_use_tagged_envelopes_and_git_changed_has_no_payload() {
        let status = serde_json::to_value(DaemonResponse::ScStatus(sample_status())).unwrap();
        assert_eq!(status["type"], "ScStatus");
        assert_eq!(status["payload"]["branch"], "main");

        let comment =
            serde_json::to_value(DaemonResponse::CommentRecordOne(sample_comment())).unwrap();
        assert_eq!(comment["payload"]["line_number"], 12);
        assert_eq!(comment["payload"]["scope"], "unstaged");

        let changed = serde_json::to_value(DaemonEvent::GitChanged).unwrap();
        assert_eq!(changed, serde_json::json!({"event":"GitChanged"}));
        let decoded: DaemonEvent = serde_json::from_str(r#"{"event":"GitChanged"}"#).unwrap();
        assert_eq!(decoded, DaemonEvent::GitChanged);
    }
}
