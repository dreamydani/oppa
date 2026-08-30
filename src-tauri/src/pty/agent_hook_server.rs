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
/// HOOK_SOURCE_BY_PATHNAME (the agents OPPA supports capture for).
fn resolve_agent_source(path: &str) -> Option<&'static str> {
    match path {
        "/hook/claude" => Some("claude"),
        "/hook/codex" => Some("codex"),
        "/hook/gemini" => Some("gemini"),
        "/hook/qwen" => Some("qwen"),
        "/hook/antigravity" => Some("agy"),
        "/hook/opencode" => Some("opencode"),
        "/hook/grok" => Some("grok"),
        "/hook/cursor" => Some("cursor"),
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

    let map = sessions.lock();
    let Some(session) = map.get(pane_key) else {
        return;
    };

    // Status truth runs even when no session id has arrived yet: pane-keyed.
    if let Some(event_name) = extract_event_name(&value, &payload) {
        let prev = session.agent_status();
        if let Some(entry) =
            classify_hook_event(agent, &event_name, &payload, prev.as_ref(), unix_now_ms())
        {
            // Edge-only store+emit; the UI gets whole entries, never inference.
            if session.apply_agent_status(entry.clone()) {
                session.publish_event(crate::pty::ipc_protocol::DaemonEvent::AgentStatusChanged {
                    pane_key: pane_key.to_string(),
                    entry,
                });
            }
        }
    }

    // Field names differ per agent: Claude writes snake_case `session_id`,
    // agy/Antigravity writes camelCase `conversationId`
    let session_id = read_session_id(&payload)
        .unwrap_or_else(|| read_session_id(&value).unwrap_or_default());
    if session_id.is_empty() {
        return;
    }
    let transcript_path = payload
        .get("transcriptPath")
        .or_else(|| payload.get("transcript_path"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    *session.agent_session_ref.lock() = Some(crate::pty::snapshot::AgentSessionRef {
        agent: agent.to_string(),
        id: session_id,
        transcript_path,
    });
    // Hook payloads are authoritative per pane: the scan tier must not
    // overwrite this ref (e.g. agy's project-wide cwd map in a
    // multi-pane-same-directory setup).
    *session.agent_ref_from_hook.lock() = true;
}

// ── Agent status classification (Orca-grade hook truth) ─────────────────
// Event-name aliases differ per CLI; the meaning table is shared per family.

#[derive(Clone, Copy, PartialEq)]
enum HookFamily {
    ClaudeStyle,
    Agy,
    GeminiCli,
}

fn family_of(agent: &str) -> HookFamily {
    match agent {
        "agy" => HookFamily::Agy,
        "gemini" | "qwen" => HookFamily::GeminiCli,
        _ => HookFamily::ClaudeStyle,
    }
}

fn extract_event_name(envelope: &serde_json::Value, payload: &serde_json::Value) -> Option<String> {
    // agy's script writes hook_event_name on the envelope root; Claude-style
    // stdin carries it inside the payload.
    for source in [payload, envelope] {
        if let Some(name) = crate::agents::status::first_string(
            source,
            &["hook_event_name", "hookEventName", "event"],
        ) {
            return Some(name);
        }
    }
    None
}

fn boundary_event(family: HookFamily, event: &str) -> bool {
    match family {
        HookFamily::ClaudeStyle => matches!(event, "SessionStart" | "UserPromptSubmit"),
        HookFamily::Agy => event == "PreInvocation",
        HookFamily::GeminiCli => event == "BeforeAgent",
    }
}

fn stringified_tool_input(payload: &serde_json::Value) -> Option<String> {
    for key in ["tool_input", "toolInput"] {
        match payload.get(key) {
            Some(serde_json::Value::String(s)) => return Some(s.clone()),
            Some(other @ serde_json::Value::Object(_)) => {
                // Object args stringify compactly then clamp like any field.
                return Some(other.to_string());
            }
            _ => {}
        }
    }
    None
}

fn unix_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Pure event→entry derivation implementing the approved mapping table:
/// tool pings ⇒ working, Notification ⇒ waiting(+prompt text), Stop ⇒ done.
/// The done-gate refuses any non-boundary transition once a pane finished.
pub(crate) fn classify_hook_event(
    agent: &str,
    event: &str,
    payload: &serde_json::Value,
    prev: Option<&crate::agents::status::AgentStatusEntry>,
    now_ms: u64,
) -> Option<crate::agents::status::AgentStatusEntry> {
    use crate::agents::status::{normalize_agent_status, AgentStatusState as S};
    let family = family_of(agent);
    let boundary = boundary_event(family, event);

    // Done-gate first: only a boundary event may reopen a finished pane.
    if prev.map(|p| p.state) == Some(S::Done) && !boundary {
        return None;
    }

    let state = match (family, event) {
        (HookFamily::ClaudeStyle,
            "SessionStart" | "UserPromptSubmit" | "PreToolUse"
            | "PostToolUse" | "PostToolUseFailure")
        | (HookFamily::Agy, "PreInvocation" | "PostInvocation") => S::Working,
        (HookFamily::GeminiCli, "BeforeAgent" | "BeforeTool" | "AfterTool") => S::Working,
        (HookFamily::ClaudeStyle, "Notification") => S::Waiting,
        (_, "Stop" | "StopFailure" | "SessionEnd")
        | (HookFamily::GeminiCli, "AfterAgent") => S::Done,
        _ => return None, // Unknown events never disturb a stable pane row.
    };

    let provided_prompt =
        crate::agents::status::first_string(payload, &["prompt", "user_prompt"]);
    // The stuck-on question exists only while waiting; clearing it elsewhere
    // stops an approved prompt from haunting later rows.
    let interactive = (state == S::Waiting)
        .then(|| crate::agents::status::first_string(payload, &["message", "notification", "content"]))
        .flatten();

    // Working rows inherit last-seen tool detail so pills stay informative
    // between pings; done clears them by construction.
    let inherits_tool = (state == S::Working).then_some(prev).flatten();
    let tool_name_local = crate::agents::status::first_string(payload, &["tool_name", "toolName", "tool"])
        .or_else(|| inherits_tool.and_then(|p| p.tool_name.clone()));
    let tool_input_local = stringified_tool_input(payload)
        .or_else(|| inherits_tool.and_then(|p| p.tool_input.clone()));
    // Prompt caching across a turn: later pings omit it, so inherit until replaced.
    let prompt_local = provided_prompt.unwrap_or_else(|| {
        prev.map(|p| p.prompt.clone())
            .filter(|_| state != S::Done && prev.map(|p| !p.prompt.is_empty()).unwrap_or(false))
            .unwrap_or_default()
    });
    // A still-working pane keeps its original anchor so elapsed-time pills
    // measure the turn, not the freshest ping.
    let state_started_at_ms = if !boundary && state == S::Working {
        prev.filter(|p| p.state == S::Working)
            .map(|p| p.state_started_at_ms)
            .unwrap_or(now_ms)
    } else {
        now_ms
    };

    normalize_agent_status(crate::agents::status::NormalizedStatusFields {
        state: state.as_str(),
        prompt: Some(prompt_local.as_str()),
        agent_type: None,
        model: None,
        tool_name: tool_name_local.as_deref(),
        tool_input: tool_input_local.as_deref(),
        interactive_prompt: interactive.as_deref(),
        interrupted: payload.get("is_interrupt").and_then(|v| v.as_bool()).unwrap_or(false),
        turn_completed_at_ms: (state == S::Done).then_some(now_ms),
        state_started_at_ms,
        updated_at_ms: now_ms,
        origin: crate::agents::status::StatusOrigin::Hook,
    })
    .ok()
}

/// Session-id readers across agents' naming conventions (Orca-style dual-key read).
fn read_session_id(payload: &serde_json::Value) -> Option<String> {
    for key in ["session_id", "sessionId", "sessionID", "conversationId"] {
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

    #[test]
    fn claude_lifecycle_maps_events_to_states() {
        let start = classify_hook_event("claude", "SessionStart", &serde_json::json!({}), None, 1000).unwrap();
        assert_eq!(start.state, crate::agents::status::AgentStatusState::Working);

        let tool = classify_hook_event(
            "claude",
            "PreToolUse",
            &serde_json::json!({"tool_name": "Bash", "tool_input": {"cmd": "ls"}}),
            Some(&start),
            1100,
        )
        .unwrap();
        assert_eq!(tool.state, crate::agents::status::AgentStatusState::Working);
        assert_eq!(tool.tool_name.as_deref(), Some("Bash"));
        assert!(tool.tool_input.as_deref().unwrap().contains("cmd"));

        let ask = classify_hook_event(
            "claude",
            "Notification",
            &serde_json::json!({"message": "Allow write?"}),
            Some(&tool),
            1200,
        )
        .unwrap();
        assert_eq!(ask.state, crate::agents::status::AgentStatusState::Waiting);
        assert_eq!(ask.interactive_prompt.as_deref(), Some("Allow write?"));

        let done = classify_hook_event("claude", "Stop", &serde_json::json!({}), Some(&ask), 1300).unwrap();
        assert_eq!(done.state, crate::agents::status::AgentStatusState::Done);
        assert_eq!(done.turn_completed_at_ms, Some(1300));
        assert_eq!(done.tool_name, None, "done clears tool detail");
    }

    #[test]
    fn done_gate_refuses_post_done_pings_and_boundary_reopens() {
        let done = classify_hook_event("claude", "Stop", &serde_json::json!({}), None, 100).unwrap();
        assert_eq!(
            classify_hook_event(
                "claude",
                "PostToolUse",
                &serde_json::json!({"tool_name": "X"}),
                Some(&done),
                200
            ),
            None
        );
        let reopened = classify_hook_event(
            "claude",
            "UserPromptSubmit",
            &serde_json::json!({"prompt": "again"}),
            Some(&done),
            300,
        )
        .unwrap();
        assert_eq!(reopened.state, crate::agents::status::AgentStatusState::Working);
        assert_eq!(reopened.prompt, "again");
        assert_eq!(reopened.turn_completed_at_ms, None);
    }

    #[test]
    fn unknown_events_are_ignored_entirely() {
        assert_eq!(
            classify_hook_event("claude", "MysteryEvent", &serde_json::json!({}), None, 10),
            None
        );
    }

    #[test]
    fn interrupted_flag_flows_only_through_stop_done() {
        let e = classify_hook_event(
            "claude",
            "Stop",
            &serde_json::json!({"is_interrupt": true}),
            None,
            50,
        )
        .unwrap();
        assert_eq!(e.interrupted, Some(true));
    }

    #[test]
    fn oversized_object_tool_input_clamps_to_max_field_length() {
        let big = "y".repeat(5000);
        let e = classify_hook_event(
            "claude",
            "PreToolUse",
            &serde_json::json!({"tool_name": "W", "tool_input": {"blob": big}}),
            None,
            5,
        )
        .unwrap();
        assert!(e
            .tool_input
            .unwrap()
            .chars()
            .count()
            <= crate::agents::status::AGENT_STATUS_MAX_FIELD_LENGTH);
    }

    #[test]
    fn family_mappings_agy_and_gemini_hold() {
        let a1 = classify_hook_event("agy", "PreInvocation", &serde_json::json!({}), None, 1).unwrap();
        let a2 = classify_hook_event("agy", "PostInvocation", &serde_json::json!({}), Some(&a1), 2).unwrap();
        assert_eq!(a2.state, crate::agents::status::AgentStatusState::Working);
        let a3 = classify_hook_event("agy", "Stop", &serde_json::json!({}), Some(&a2), 3).unwrap();
        assert_eq!(a3.state, crate::agents::status::AgentStatusState::Done);

        let g1 = classify_hook_event("gemini", "BeforeAgent", &serde_json::json!({}), None, 4).unwrap();
        let g2 = classify_hook_event("gemini", "AfterTool", &serde_json::json!({}), Some(&g1), 5).unwrap();
        let g3 = classify_hook_event("gemini", "AfterAgent", &serde_json::json!({}), Some(&g2), 6).unwrap();
        assert_eq!(g3.state, crate::agents::status::AgentStatusState::Done);
    }

    #[test]
    fn prompt_caches_across_tool_pings() {
        let p = classify_hook_event(
            "claude",
            "UserPromptSubmit",
            &serde_json::json!({"prompt": "fix login"}),
            None,
            7,
        )
        .unwrap();
        let ping = classify_hook_event(
            "claude",
            "PreToolUse",
            &serde_json::json!({"tool_name": "Edit"}),
            Some(&p),
            8,
        )
        .unwrap();
        assert_eq!(ping.prompt, "fix login");
        assert_eq!(ping.tool_name.as_deref(), Some("Edit"));
    }

    #[test]
    fn working_anchor_survives_pings_and_resets_on_boundary() {
        let p = classify_hook_event("claude", "UserPromptSubmit", &serde_json::json!({}), None, 100).unwrap();
        let ping = classify_hook_event("claude", "PostToolUse", &serde_json::json!({}), Some(&p), 900).unwrap();
        assert_eq!(ping.state_started_at_ms, 100);
        let next_turn =
            classify_hook_event("claude", "UserPromptSubmit", &serde_json::json!({}), Some(&ping), 1000).unwrap();
        assert_eq!(next_turn.state_started_at_ms, 1000);
    }

    #[test]
    fn alias_key_probes_when_snake_case_absent() {
        let envelope = serde_json::json!({"hookEventName": "Notification"});
        assert_eq!(
            extract_event_name(&envelope, &envelope).as_deref(),
            Some("Notification")
        );
    }

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

    fn test_shell_for_hook() -> String {
        #[cfg(target_os = "windows")]
        {
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
            std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
        }
        #[cfg(not(target_os = "windows"))]
        {
            "sh".to_string()
        }
    }

    #[tokio::test]
    async fn test_hook_payload_binds_authoritative_session_id() {
        let sh = test_shell_for_hook();
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
            &[],
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
        let sh = test_shell_for_hook();
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
            &[],
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
