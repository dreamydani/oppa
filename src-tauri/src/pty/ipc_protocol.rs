use crate::git::worktree_registry::{RepoRecord, WorktreeRecord, WorktreeStatus};
use crate::git::worktrees::WorktreeListEntry;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const DAEMON_PROTOCOL_VERSION: u32 = 3;

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
        ];

        for event in events {
            let json = serde_json::to_string(&event).expect("serialize event");
            let decoded: DaemonEvent = serde_json::from_str(&json).expect("deserialize event");
            assert_eq!(event, decoded);
        }
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
        ];

        for res in responses {
            let json = serde_json::to_string(&res).expect("serialize response");
            let decoded: DaemonResponse = serde_json::from_str(&json).expect("deserialize response");
            assert_eq!(res, decoded);
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
}
