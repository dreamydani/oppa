// Localhost receiver for agent CLI lifecycle hooks (Claude Code style):
// the agent's managed hook pipes its stdin JSON here; the payload carries
// the authoritative session_id + transcript_path for the running conversation.

use crate::pty::daemon_session::DaemonSession;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub struct AgentHookServer {
    pub port: u16,
    pub token: String,
}

// Process-wide endpoint coordinates, set once at daemon startup and injected
// into every spawned PTY so managed hooks know where to POST.
static HOOK_ENV: std::sync::OnceLock<(u16, String)> = std::sync::OnceLock::new();

/// The daemon's agent-hook endpoint, when running.
pub fn hook_env() -> Option<(u16, String)> {
    HOOK_ENV.get().cloned()
}

fn store_hook_env(port: u16, token: &str) {
    let _ = HOOK_ENV.set((port, token.to_string()));
}

/// Persists port + token so the installed hook scripts (which run in agent
/// processes without our env) can reach the daemon. Best-effort.
pub fn write_endpoint_files(app_data_dir: Option<&std::path::Path>, port: u16, token: &str) {
    let Some(dir) = app_data_dir else {
        return;
    };
    let hook_dir = dir.join("agent-hooks");
    if std::fs::create_dir_all(&hook_dir).is_err() {
        return;
    }
    let _ = std::fs::write(hook_dir.join("port"), port.to_string());
    let _ = std::fs::write(hook_dir.join("token"), token);
}

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Binds 127.0.0.1 on a free ephemeral port.
async fn bind_free_port() -> std::io::Result<(TcpListener, u16)> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    Ok((listener, port))
}

impl AgentHookServer {
    /// Starts the listener and a task routing payloads to live sessions.
    /// Returns the port/token other components must know (env injection,
    /// port file for the hook scripts).
    pub async fn start(sessions: Arc<Mutex<HashMap<String, Arc<DaemonSession>>>>) -> Option<Self> {
        let (listener, port) = match bind_free_port().await {
            Ok(v) => v,
            Err(_) => return None,
        };
        // Random-ish token: hooks echo it from PTY env; blocks unrelated
        // local processes from posting bogus session ids.
        let token = format!(
            "oppa-{}-{}",
            std::process::id(),
            TMP_SEQ.fetch_add(1, Ordering::Relaxed) + rand_suffix()
        );
        store_hook_env(port, &token);
        let token_for_task = token.clone();

        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                let sessions = Arc::clone(&sessions);
                let token = token_for_task.clone();
                tokio::spawn(async move {
                    handle_connection(stream, &sessions, &token).await;
                });
            }
        });

        Some(Self { port, token })
    }
}

fn rand_suffix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos() as u64)
        .unwrap_or(0)
}

/// Minimal HTTP/1.1 request reader: we only ever need method, path and body;
/// a real parser is unnecessary for a loopback-only endpoint.
async fn read_http_request(stream: &mut (impl tokio::io::AsyncRead + Unpin)) -> Option<(String, String, Vec<u8>)> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    let header_end = loop {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = find_subslice(&buf, b"\r\n\r\n") {
            break pos + 4;
        }
        if buf.len() > 64 * 1024 {
            return None;
        }
    };

    let head = String::from_utf8_lossy(&buf[..header_end]).into_owned();
    let mut lines = head.split("\r\n");
    let request_line = lines.next()?.to_string();
    let content_length = lines
        .filter_map(|l| {
            let (name, value) = l.split_once(':')?;
            name.trim()
                .eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())?
        })
        .next()
        .unwrap_or(0);

    let mut body = buf[header_end..].to_vec();
    while body.len() < content_length {
        let n = stream.read(&mut chunk).await.ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    body.truncate(content_length);

    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    Some((method, path, body))
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

async fn handle_connection(
    mut stream: tokio::net::TcpStream,
    sessions: &Arc<Mutex<HashMap<String, Arc<DaemonSession>>>>,
    token: &str,
) {
    let Some((method, path, body)) = read_http_request(&mut stream).await else {
        return;
    };

    // Always answer promptly: agent CLIs block on the hook with a timeout.
    // Payload authenticity (token) is checked when applying, not here —
    // the connection must be released fast regardless.
    let response = if method != "POST" || resolve_agent_source(&path).is_none() {
        http_response(404, "not found")
    } else {
        http_response(200, "ok")
    };
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.flush().await;

    if let Some(agent) = resolve_agent_source(&path) {
        apply_hook_payload(&body, sessions, token, agent);
    }
}

/// Maps hook endpoints to the agent CLI they report for. Mirrors Orca's
/// HOOK_SOURCE_BY_PATHNAME.
fn resolve_agent_source(path: &str) -> Option<&'static str> {
    match path {
        "/hook/claude" => Some("claude"),
        "/hook/antigravity" => Some("agy"),
        _ => None,
    }
}

fn http_response(status: u16, reason: &str) -> String {
    format!("HTTP/1.1 {status} {reason}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
}

/// Extracts `{session_id, transcript_path}` from a hook payload and stores it
/// on the pane identified by `OPPA_PANE_KEY` (embedded in the payload by the
/// hook script, since the hook inherits the PTY's environment).
fn apply_hook_payload(
    body: &[u8],
    sessions: &Arc<Mutex<HashMap<String, Arc<DaemonSession>>>>,
    token: &str,
    agent: &'static str,
) {
    let Ok(text) = std::str::from_utf8(body) else {
        return;
    };
    // Hook scripts send JSON: {"pane_key": ..., "token": ..., "payload": {<raw hook stdin>}}
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return;
    };
    if value.get("token").and_then(|t| t.as_str()) != Some(token) {
        return;
    }
    let Some(pane_key) = value.get("pane_key").and_then(|v| v.as_str()) else {
        return;
    };
    let payload = value.get("payload").cloned().unwrap_or(value.clone());
    // Field names differ per agent: Claude writes snake_case `session_id`,
    // agy/Antigravity writes camelCase `conversationId`
    let session_id = read_session_id(&payload).unwrap_or_else(|| {
        read_session_id(&value).unwrap_or_default()
    });
    if session_id.is_empty() {
        return;
    }
    let transcript_path = payload
        .get("transcriptPath")
        .or_else(|| payload.get("transcript_path"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let map = sessions.lock();
    if let Some(session) = map.get(pane_key) {
        *session.agent_session_ref.lock() = Some(crate::pty::snapshot::AgentSessionRef {
            agent: agent.to_string(),
            id: session_id,
            transcript_path,
        });
    }
}

/// Session-id readers across agents' naming conventions (Orca-style dual-key read).
fn read_session_id(payload: &serde_json::Value) -> Option<String> {
    for key in ["session_id", "sessionId", "conversationId"] {
        if let Some(id) = payload.get(key).and_then(|v| v.as_str()) {
            let trimmed = id.trim();
            // Same sanity rules as Orca: non-empty, no leading dash, no control chars
            if !trimmed.is_empty()
                && !trimmed.starts_with('-')
                && !trimmed.chars().any(|c| c.is_control() || c == '\u{7f}')
            {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::snapshot::AgentSessionRef;

    async fn post(path: &str, body: &str, port: u16) -> std::io::Result<()> {
        use tokio::io::AsyncReadExt;
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await?;
        let req = format!(
            "POST {} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            path,
            body.len(),
            body
        );
        stream.write_all(req.as_bytes()).await?;
        stream.flush().await?;
        let mut buf = Vec::new();
        // Read until server closes the connection
        let _ = stream.read_to_end(&mut buf).await;
        Ok(())
    }

    #[tokio::test]
    async fn test_hook_payload_binds_authoritative_session_id() {        // Same resolution logic as daemon_session's test helper
        let sh = std::env::var_os("PATH")
            .and_then(|path| {
                std::env::split_paths(&path)
                    .map(|dir| dir.join("sh.exe"))
                    .find(|candidate| candidate.exists())
            })
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| "sh".to_string());
        let sessions: Arc<Mutex<HashMap<String, Arc<DaemonSession>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let session = DaemonSession::spawn_with_args(
            "hook-pane-1".into(),
            &sh,
            &[],
            None,
            80,
            24,
            None,
        )
        .expect("spawn session for hook test");
        sessions
            .lock()
            .insert("hook-pane-1".into(), Arc::clone(&session));

        let server = AgentHookServer::start(Arc::clone(&sessions))
            .await
            .expect("server started");

        // Wrong token must be ignored
        let bad = serde_json::json!({
            "pane_key": "hook-pane-1",
            "token": "wrong-token",
            "payload": { "session_id": "spoofed-id" }
        });
        post("/hook/claude", &bad.to_string(), server.port)
            .await
            .expect("post");
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert!(session.agent_session_ref.lock().is_none(), "bad token rejected");

        // Correct token binds the authoritative id + transcript path
        let good = serde_json::json!({
            "pane_key": "hook-pane-1",
            "token": server.token,
            "payload": {
                "session_id": "authoritative-conv-9",
                "transcript_path": "/home/x/.claude/projects/p/conv-9.jsonl",
                "hook_event_name": "Stop"
            }
        });
        post("/hook/claude", &good.to_string(), server.port)
            .await
            .expect("post");
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let bound = session.agent_session_ref.lock().clone();
            match bound {
                Some(r) => {
                    assert_eq!(
                        r,
                        AgentSessionRef {
                            agent: "claude".into(),
                            id: "authoritative-conv-9".into(),
                            transcript_path: Some(
                                "/home/x/.claude/projects/p/conv-9.jsonl".into()
                            ),
                        }
                    );
                    break;
                }
                None => {
                    assert!(
                        tokio::time::Instant::now() < deadline,
                        "expected authoritative ref bound within deadline"
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
            }
        }
        let _ = session.kill();
    }

    #[tokio::test]
    async fn test_antigravity_route_binds_camelcase_conversation_id() {
        let sh = std::env::var_os("PATH")
            .and_then(|path| {
                std::env::split_paths(&path)
                    .map(|dir| dir.join("sh.exe"))
                    .find(|candidate| candidate.exists())
            })
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| "sh".to_string());
        let sessions: Arc<Mutex<HashMap<String, Arc<DaemonSession>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let session = DaemonSession::spawn_with_args(
            "agy-pane-1".into(),
            &sh,
            &[],
            None,
            80,
            24,
            None,
        )
        .expect("spawn session for agy hook test");
        sessions
            .lock()
            .insert("agy-pane-1".into(), Arc::clone(&session));

        let server = AgentHookServer::start(Arc::clone(&sessions))
            .await
            .expect("server started");

        // Antigravity payload: camelCase keys, nested under payload like the script sends
        let body = serde_json::json!({
            "pane_key": "agy-pane-1",
            "token": server.token,
            "hook_event_name": "PreInvocation",
            "payload": {
                "conversationId": "ec33ebf9-0cba-4100-8142-c61503f6c587",
                "workspacePaths": ["C:\\proj"],
                "transcriptPath": "C:\\proj\\.gemini\\antigravity-cli\\transcript.jsonl",
                "modelName": "auto"
            }
        });
        post("/hook/antigravity", &body.to_string(), server.port)
            .await
            .expect("post");

        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let bound = session.agent_session_ref.lock().clone();
            match bound {
                Some(r) => {
                    assert_eq!(r.agent, "agy");
                    assert_eq!(r.id, "ec33ebf9-0cba-4100-8142-c61503f6c587");
                    assert_eq!(
                        r.transcript_path,
                        Some("C:\\proj\\.gemini\\antigravity-cli\\transcript.jsonl".into())
                    );
                    break;
                }
                None => {
                    assert!(
                        tokio::time::Instant::now() < deadline,
                        "expected agy conversation bound within deadline"
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
            }
        }
        let _ = session.kill();
    }
}
