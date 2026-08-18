use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const DAEMON_PROTOCOL_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateOrAttachResult {
    pub is_new: bool,
    pub pid: u32,
    pub cols: u16,
    pub rows: u16,
    pub cwd: Option<String>,
    pub snapshot: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum DaemonRequest {
    Hello {
        client_version: String,
        protocol_version: u32,
    },
    CreateOrAttach {
        session_id: String,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
        shell: Option<String>,
        #[serde(default)]
        persona_id: Option<String>,
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
    ListSessions,
    Disconnect,
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum DaemonResponse {
    HelloOk { protocol_version: u32 },
    SessionAttached(CreateOrAttachResult),
    SessionList(Vec<String>),
    Ok,
    Error(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "event", content = "payload")]
pub enum DaemonEvent {
    Data {
        session_id: String,
        data: String,
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
            persona_id: Some("architect".into()),
        };
        let encoded = serde_json::to_string(&req).expect("serialize");
        let decoded: DaemonRequest = serde_json::from_str(&encoded).expect("deserialize");
        assert_eq!(req, decoded);
    }

    #[test]
    fn test_serialize_daemon_requests_all_variants() {
        let requests = vec![
            DaemonRequest::Hello {
                client_version: "0.1.0".into(),
                protocol_version: DAEMON_PROTOCOL_VERSION,
            },
            DaemonRequest::CreateOrAttach {
                session_id: "s1".into(),
                cols: 120,
                rows: 30,
                cwd: None,
                shell: Some("/bin/bash".into()),
                persona_id: None,
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
            }),
            DaemonResponse::SessionList(vec!["s1".into(), "s2".into()]),
            DaemonResponse::Ok,
            DaemonResponse::Error("session not found".into()),
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
        ];

        for event in events {
            let json = serde_json::to_string(&event).expect("serialize event");
            let decoded: DaemonEvent = serde_json::from_str(&json).expect("deserialize event");
            assert_eq!(event, decoded);
        }
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
