use oppa_lib::cli::output::{render_json, render_lineage_tree, render_worktree_list};
use oppa_lib::cli::{
    build_repo_add, build_terminal_create, build_terminal_send, build_worktree_create,
    build_worktree_set, decode_agent_handoff, decode_attached, decode_ok, decode_ps_entries,
    decode_read_screen, decode_repo_records, decode_session_ids, decode_wait_result,
    decode_worktree_list, decode_worktree_many, decode_worktree_one, filter_active_only,
    CreateArgs, CliError, ParentUpdate, RuntimeConnection,
};
use oppa_lib::git::worktree_registry::WorktreeStatus;
use oppa_lib::pty::daemon_server::{CancellationToken, DaemonServer};
use oppa_lib::pty::ipc_protocol::{
    DaemonRequest, DaemonResponse, WaitCondition, DAEMON_PROTOCOL_VERSION,
};
use oppa_lib::pty::runtime_metadata;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

fn unique_pipe_path(label: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    if cfg!(windows) {
        format!(r"\\.\pipe\oppa-cli-test-{label}-{nanos}")
    } else {
        format!("/tmp/oppa-cli-test-{label}-{nanos}.sock")
    }
}

fn spawn_listener(
    server: Arc<DaemonServer>,
    path: &str,
) -> (std::thread::JoinHandle<()>, CancellationToken) {
    let cancel = CancellationToken::new();
    let handle = {
        let cancel = cancel.clone();
        let path = path.to_string();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            rt.block_on(async {
                let _ = server.run_listener(&path, cancel).await;
            });
        })
    };
    (handle, cancel)
}

fn temp_data_dir(label: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "oppa-cli-it-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn connect_with_token_lists_sessions_roundtrip() {
    let token = runtime_metadata::generate_auth_token();
    let pipe = unique_pipe_path("ok");
    let mut server = DaemonServer::new();
    server.set_auth_token(Some(token.clone()));
    let (listener, cancel) = spawn_listener(Arc::new(server), &pipe);
    std::thread::sleep(Duration::from_millis(150));

    let dir = temp_data_dir("ok");
    runtime_metadata::write_runtime_metadata(&dir, &pipe, &token).unwrap();

    let mut conn =
        RuntimeConnection::connect_with_data_dir(Some(dir.clone()), Duration::from_secs(5))
            .expect("authed connect");

    // Connection stays open across calls: two sequential requests on one socket.
    let sessions = conn
        .request(oppa_lib::pty::ipc_protocol::DaemonRequest::ListSessions)
        .expect("first request");
    assert_eq!(
        sessions,
        oppa_lib::pty::ipc_protocol::DaemonResponse::SessionList(Vec::new())
    );
    let again = conn
        .request(oppa_lib::pty::ipc_protocol::DaemonRequest::ListSessions)
        .expect("second request");
    assert_eq!(
        again,
        oppa_lib::pty::ipc_protocol::DaemonResponse::SessionList(Vec::new())
    );

    drop(conn);
    cancel.cancel();
    listener.join().unwrap();
    runtime_metadata::remove_runtime_metadata(&dir);
}

#[test]
fn connect_with_wrong_token_is_unauthorized() {
    let token = runtime_metadata::generate_auth_token();
    let pipe = unique_pipe_path("bad");
    let mut server = DaemonServer::new();
    server.set_auth_token(Some(token));
    let (listener, cancel) = spawn_listener(Arc::new(server), &pipe);
    std::thread::sleep(Duration::from_millis(150));

    let dir = temp_data_dir("bad");
    runtime_metadata::write_runtime_metadata(&dir, &pipe, "wrong-token").unwrap();

    let result = RuntimeConnection::connect_with_data_dir(Some(dir.clone()), Duration::from_secs(5));
    match result.map(|_| ()) {
        Err(CliError::Unauthorized) => {}
        other => panic!("expected Unauthorized, got {other:?}"),
    }

    cancel.cancel();
    listener.join().unwrap();
    runtime_metadata::remove_runtime_metadata(&dir);
}

#[test]
fn status_report_in_returns_protocol_and_sessions() {
    let pipe = unique_pipe_path("status");
    let server = DaemonServer::new();
    let (listener, cancel) = spawn_listener(Arc::new(server), &pipe);
    std::thread::sleep(Duration::from_millis(150));

    let dir = temp_data_dir("status");
    runtime_metadata::write_runtime_metadata(&dir, &pipe, "unused").unwrap();

    let report = RuntimeConnection::status_report_in(Some(dir.clone()), Duration::from_secs(5))
        .expect("status report");
    assert_eq!(report.protocol_version, 3);
    assert!(report.sessions.is_empty());

    cancel.cancel();
    listener.join().unwrap();
    runtime_metadata::remove_runtime_metadata(&dir);
}

// ---- task 8: repo + worktree verb families over the wire ----

fn run_git(cwd: &Path, args: &[&str]) {
    let mut cmd = std::process::Command::new("git");
    cmd.args(args).current_dir(cwd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().expect("git spawn");
    assert!(
        output.status.success(),
        "git {args:?} failed in {}: {}",
        cwd.display(),
        String::from_utf8_lossy(&output.stderr)
    );
}

fn init_git_repo(root: &Path, name: &str) -> PathBuf {
    let repo = root.join(name);
    std::fs::create_dir_all(&repo).unwrap();
    run_git(&repo, &["init", "-b", "main"]);
    run_git(&repo, &["config", "user.email", "test@oppa.dev"]);
    run_git(&repo, &["config", "user.name", "Oppa Test"]);
    std::fs::write(repo.join("README.md"), "# init").unwrap();
    run_git(&repo, &["add", "-A"]);
    run_git(&repo, &["commit", "-m", "initial"]);
    repo
}

type TestDaemon = (RuntimeConnection, PathBuf, JoinHandle<()>, CancellationToken);

fn start_registry_daemon(label: &str) -> TestDaemon {
    // with_snapshot_storage points the daemon's worktree registry at root/worktrees.json.
    let token = runtime_metadata::generate_auth_token();
    let pipe = unique_pipe_path(label);
    let root = temp_data_dir(label);
    let mut server = DaemonServer::with_snapshot_storage(root.clone());
    server.set_auth_token(Some(token.clone()));
    let (listener, cancel) = spawn_listener(Arc::new(server), &pipe);
    std::thread::sleep(Duration::from_millis(150));
    runtime_metadata::write_runtime_metadata(&root, &pipe, &token).unwrap();
    let conn = RuntimeConnection::connect_with_data_dir(Some(root.clone()), Duration::from_secs(10))
        .expect("authed connect");
    (conn, root, listener, cancel)
}

fn shutdown_daemon(daemon: TestDaemon) {
    let (conn, root, listener, cancel) = daemon;
    drop(conn);
    cancel.cancel();
    listener.join().unwrap();
    std::fs::remove_dir_all(&root).ok();
}

fn create_wt(conn: &mut RuntimeConnection, repo_path: &Path, name: &str, parent: Option<&str>) -> oppa_lib::cli::output::CliWorktreeRecord {
    let request = build_worktree_create(CreateArgs {
        repo_path: repo_path.to_string_lossy().as_ref(),
        name,
        branch: None,
        base_ref: None,
        parent_worktree_id: parent,
        workspace_dir: None,
        nest_workspaces: false,
        agent: None,
        prompt: None,
        command: None,
    });
    decode_worktree_one(conn.request(request).expect("create roundtrip"))
        .expect("decode create")
        .expect("worktree created")
}

#[test]
fn repo_and_worktree_verbs_roundtrip_against_live_registry() {
    let (mut conn, root, listener, cancel) = start_registry_daemon("verbs");
    let repo_dir = init_git_repo(&root, "repo");
    let repo_path_str = repo_dir.to_string_lossy().into_owned();

    // repo add -> list -> show
    let added =
        decode_repo_records(conn.request(build_repo_add(&repo_path_str)).expect("repo add"))
            .expect("decode repo add");
    assert_eq!(added.len(), 1);
    assert_eq!(added[0].repo_id, "repo");

    let listed = decode_repo_records(conn.request(DaemonRequest::RepoList).expect("repo list"))
        .expect("decode repo list");
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].repo_id, "repo");

    // worktree create (top-level + child)
    let created = create_wt(&mut conn, &repo_dir, "feat-a", None);
    assert_eq!(created.branch, "feat-a");
    assert_eq!(created.status, "todo");
    let sub = create_wt(&mut conn, &repo_dir, "sub", Some(created.id.as_str()));
    assert_eq!(sub.parent_worktree_id.as_deref(), Some(created.id.as_str()));

    // list shows both active entries; human + json renderers stay well-formed
    let entries =
        decode_worktree_list(conn.request(DaemonRequest::WorktreeList).expect("list")).expect("decode list");
    assert_eq!(entries.len(), 2);
    assert!(entries.iter().all(|e| !e.missing_on_disk));
    let visible = filter_active_only(entries);
    assert_eq!(visible.len(), 2);

    let human = render_worktree_list(&visible);
    assert!(human.contains("BRANCH"), "header missing: {human}");
    assert!(human.contains("feat-a"), "{human}");
    assert!(human.contains("in-progress") || human.contains("todo"), "{human}");
    let parsed: serde_json::Value = serde_json::from_str(&render_json(&visible)).expect("json");
    assert_eq!(parsed.as_array().unwrap().len(), 2);

    // show by id
    let shown = decode_worktree_one(
        conn.request(DaemonRequest::WorktreeShow {
            id: created.id.clone(),
        })
        .expect("show"),
    )
    .expect("decode show")
    .expect("shown record");
    assert_eq!(shown.id, created.id);

    // current resolves by cwd inside the worktree
    let current = decode_worktree_one(
        conn.request(DaemonRequest::WorktreeCurrent {
            cwd: created.path.clone(),
        })
        .expect("current"),
    )
    .expect("decode current")
    .expect("current record");
    assert_eq!(current.id, created.id);

    // set status + display name persists
    let updated = decode_worktree_one(
        conn.request(build_worktree_set(
            &created.id,
            Some(WorktreeStatus::InProgress),
            Some("Feat A"),
            ParentUpdate::Untouched,
        ))
        .expect("set"),
    )
    .expect("decode set")
    .expect("updated record");
    assert_eq!(updated.status, "in-progress");
    assert_eq!(updated.display_name.as_deref(), Some("Feat A"));

    // ps live counts are zero before any session attaches
    let ps = decode_ps_entries(conn.request(DaemonRequest::WorktreePs).expect("ps")).expect("decode ps");
    assert_eq!(ps.len(), 2);
    assert!(ps.iter().all(|e| e.live_sessions == 0));

    // lineage walks the parent/child tree breadth-first
    let lineage = decode_worktree_many(
        conn.request(DaemonRequest::WorktreeLineage {
            id: created.id.clone(),
        })
        .expect("lineage"),
    )
    .expect("decode lineage");
    assert_eq!(lineage.len(), 2);
    assert_eq!(
        render_lineage_tree(&lineage),
        format!("feat-a (feat-a)\n  sub (sub)")
    );

    shutdown_daemon((conn, root, listener, cancel));
}

#[test]
fn tombstone_lifecycle_with_dup_name_and_blocked_remove() {
    let (mut conn, root, listener, cancel) = start_registry_daemon("tomb");
    let repo_dir = init_git_repo(&root, "repo");
    decode_repo_records(conn.request(build_repo_add(repo_dir.to_string_lossy().as_ref())).unwrap())
        .unwrap();
    let created = create_wt(&mut conn, &repo_dir, "feat-a", None);

    // duplicate names are rejected by the daemon and surface verbatim
    let dup = build_worktree_create(CreateArgs {
        repo_path: repo_dir.to_string_lossy().as_ref(),
        name: "feat-a",
        branch: None,
        base_ref: None,
        parent_worktree_id: None,
        workspace_dir: None,
        nest_workspaces: false,
        agent: None,
        prompt: None,
        command: None,
    });
    match decode_worktree_one(conn.request(dup).expect("dup roundtrip")) {
        Err(CliError::Daemon(msg)) => assert_eq!(msg, "worktree name already in use"),
        other => panic!("expected dup-name daemon error, got {other:?}"),
    }

    // a live session inside the worktree blocks removal and is named in the error
    let session_id = "it-live-session";
    let attach = conn
        .request(DaemonRequest::CreateOrAttach {
            session_id: session_id.into(),
            cols: 80,
            rows: 24,
            cwd: Some(created.path.clone()),
            shell: None,
            resume_agents: false,
            worktree_id: None,
            extra_env: Vec::new(),
        })
        .expect("attach roundtrip");
    assert!(matches!(attach, DaemonResponse::SessionAttached(_)));

    let ps = decode_ps_entries(conn.request(DaemonRequest::WorktreePs).unwrap()).unwrap();
    assert_eq!(ps[0].live_sessions, 1);

    match decode_ok(conn.request(DaemonRequest::WorktreeRemove {
        id: created.id.clone(),
        force: false,
        delete_branch: false,
    }).unwrap()) {
        Err(CliError::Daemon(msg)) => assert!(msg.contains(session_id), "error must name session: {msg}"),
        other => panic!("expected blocked removal, got {other:?}"),
    }

    // once the session dies, rm tombstones; --all still surfaces it
    decode_ok(
        conn.request(DaemonRequest::Kill {
            session_id: session_id.into(),
        })
        .unwrap(),
    )
    .unwrap();
    decode_ok(conn.request(DaemonRequest::WorktreeRemove {
        id: created.id.clone(),
        force: false,
        delete_branch: false,
    }).unwrap())
    .unwrap();

    let tombstone = decode_worktree_one(
        conn.request(DaemonRequest::WorktreeShow {
            id: created.id.clone(),
        })
        .unwrap(),
    )
    .unwrap()
    .expect("tombstone kept");
    assert!(tombstone.retired);

    let entries = decode_worktree_list(conn.request(DaemonRequest::WorktreeList).unwrap()).unwrap();
    assert_eq!(filter_active_only(entries.clone()).len(), 0);
    assert_eq!(entries.len(), 1);

    // purge drops the record entirely
    decode_ok(
        conn.request(DaemonRequest::WorktreePurge {
            id: created.id.clone(),
        })
        .unwrap(),
    )
    .unwrap();
    match decode_worktree_one(
        conn.request(DaemonRequest::WorktreeShow {
            id: created.id.clone(),
        })
        .unwrap(),
    ) {
        Err(CliError::Daemon(msg)) => assert!(msg.contains("not found"), "got: {msg}"),
        other => panic!("expected purged record to be gone, got {other:?}"),
    }
    let after = decode_worktree_list(conn.request(DaemonRequest::WorktreeList).unwrap()).unwrap();
    assert!(after.is_empty());

    shutdown_daemon((conn, root, listener, cancel));
}

// ---- task 9: terminal verbs end-to-end over a real pipe ----

const PROBE: &str = "oppa_it_probe_9137";

fn attach_request(session_id: &str) -> DaemonRequest {
    DaemonRequest::CreateOrAttach {
        session_id: session_id.into(),
        cols: 80,
        rows: 24,
        cwd: None,
        shell: None,
        resume_agents: false,
        worktree_id: None,
        extra_env: Vec::new(),
    }
}

// cmd.exe has no bootstrap or PSReadLine: typed input is never eaten, so
// roundtrips stay deterministic; its idles go through the fallback path.
fn cmd_attach_request(session_id: &str) -> DaemonRequest {
    DaemonRequest::CreateOrAttach {
        session_id: session_id.into(),
        cols: 80,
        rows: 24,
        cwd: None,
        shell: Some("cmd.exe".into()),
        resume_agents: false,
        worktree_id: None,
        extra_env: Vec::new(),
    }
}

#[test]
fn terminal_send_wait_idle_read_screen_roundtrip() {
    let (mut conn, _root, listener, cancel) = start_registry_daemon("term");

    let attached =
        decode_attached(conn.request(cmd_attach_request("term-probe-s")).expect("create session"))
            .expect("session created");
    assert!(attached.is_new);

    // First wait absorbs shell boot noise so the typed command is not eaten
    let booted = decode_wait_result(
        conn.request(DaemonRequest::WaitFor {
            session_id: "term-probe-s".into(),
            cond: WaitCondition::TuiIdle,
            timeout_ms: 20_000,
        })
        .expect("boot wait"),
    )
    .expect("decode boot wait");
    assert!(booted.satisfied, "shell must settle after boot");
    assert_eq!(booted.exit_code, None);

    decode_ok(
        conn.request(build_terminal_send("term-probe-s", &format!("echo {PROBE}"), true, false))
            .expect("send roundtrip"),
    )
    .unwrap();

    // cmd.exe emits no OSC133 markers: this exercises the fallback idle path
    let idle = decode_wait_result(
        conn.request(DaemonRequest::WaitFor {
            session_id: "term-probe-s".into(),
            cond: WaitCondition::TuiIdle,
            timeout_ms: 20_000,
        })
        .expect("idle wait"),
    )
    .expect("decode idle wait");
    assert!(idle.satisfied, "echoed command must reach tui-idle");

    let screen = decode_read_screen(
        conn.request(DaemonRequest::ReadScreen {
            session_id: "term-probe-s".into(),
        })
        .expect("read roundtrip"),
    )
    .expect("decode screen");
    assert!(!screen.truncated);
    assert!(
        screen.text.to_lowercase().contains(PROBE),
        "screen text must contain probe (case/spacing tolerant): {:?}",
        screen.text
    );

    decode_ok(
        conn.request(DaemonRequest::Kill {
            session_id: "term-probe-s".into(),
        })
        .unwrap(),
    )
    .unwrap();
    cancel.cancel();
    listener.join().unwrap();
}

#[test]
fn wait_for_exit_satisfied_when_session_killed_midwait() {
    let (mut conn, root, listener, cancel) = start_registry_daemon("exit-wait");
    decode_attached(conn.request(attach_request("exit-wait-s")).expect("create")).expect("new");

    let waiter_root = root.clone();
    let waiter = std::thread::spawn(move || {
        let mut wait_conn =
            RuntimeConnection::connect_with_data_dir(Some(waiter_root), Duration::from_secs(15))
                .ok()?;
        Some(
            decode_wait_result(
                wait_conn
                    .request(DaemonRequest::WaitFor {
                        session_id: "exit-wait-s".into(),
                        cond: WaitCondition::Exit,
                        timeout_ms: 10_000,
                    })
                    .expect("exit wait"),
            )
            .expect("decode exit wait"),
        )
    });

    std::thread::sleep(Duration::from_millis(300));
    decode_ok(
        conn.request(DaemonRequest::Kill {
            session_id: "exit-wait-s".into(),
        })
        .unwrap(),
    )
    .unwrap();

    let result = waiter.join().unwrap().expect("waiter connection succeeded");
    assert!(result.satisfied, "kill during WaitFor must satisfy Exit");
    assert!(result.exit_code.is_some(), "kill must surface an exit code");
    assert!(result.waited_ms < 10_000);

    cancel.cancel();
    listener.join().unwrap();
}

#[test]
fn read_screen_unknown_session_is_daemon_error() {
    let (mut conn, _root, listener, cancel) = start_registry_daemon("unknown");
    match conn.request(DaemonRequest::ReadScreen { session_id: "nope".into() }) {
        Ok(DaemonResponse::Error(msg)) => assert_eq!(msg, "session not found"),
        other => panic!("expected session-not-found error, got {other:?}"),
    }
    drop(conn);
    cancel.cancel();
    listener.join().unwrap();
}

// Raw-pipe client so keepalive frames stay observable (RuntimeConnection hides them).
#[test]
fn keepalive_frames_flow_on_long_wait() {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    #[cfg(windows)]
    fn open_client(pipe: &str) -> Option<tokio::net::windows::named_pipe::NamedPipeClient> {
        tokio::net::windows::named_pipe::ClientOptions::new()
            .open(pipe)
            .ok()
    }
    #[cfg(not(windows))]
    fn open_client(pipe: &str) -> Option<tokio::net::UnixStream> {
        match std::os::unix::net::UnixStream::connect(pipe) {
            Ok(stream) => tokio::net::UnixStream::from_std(stream).ok(),
            Err(_) => None,
        }
    }

    let pipe = unique_pipe_path("keepalive");
    let server = DaemonServer::new();
    let (listener, cancel) = spawn_listener(Arc::new(server), &pipe);
    std::thread::sleep(Duration::from_millis(150));

    let observed = std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        rt.block_on(async move {
            let mut client = None;
            for _ in 0..40 {
                if let Some(c) = open_client(&pipe) {
                    client = Some(c);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            let client = client.expect("raw connect");
            let (read_half, mut write_half) = tokio::io::split(client);
            let mut reader = BufReader::new(read_half);
            let mut line = String::new();

            async fn send_req<W: tokio::io::AsyncWrite + Unpin>(
                write_half: &mut W,
                req: &DaemonRequest,
            ) {
                let json = serde_json::to_string(req).unwrap();
                write_half.write_all(json.as_bytes()).await.unwrap();
                write_half.write_all(b"\n").await.unwrap();
                write_half.flush().await.unwrap();
            }

            send_req(
                &mut write_half,
                &DaemonRequest::Hello {
                    client_version: "test".into(),
                    protocol_version: DAEMON_PROTOCOL_VERSION,
                    auth_token: None,
                },
            )
            .await;
            line.clear();
            reader.read_line(&mut line).await.unwrap();

            send_req(&mut write_half, &attach_request("ka-session")).await;
            line.clear();
            reader.read_line(&mut line).await.unwrap();
            assert!(line.contains("SessionAttached"), "attach first: {line}");

            // Healthy shell never exits on its own: the wait runs to timeout
            send_req(
                &mut write_half,
                &DaemonRequest::WaitFor {
                    session_id: "ka-session".into(),
                    cond: WaitCondition::Exit,
                    timeout_ms: 3_500,
                },
            )
            .await;

            let started = std::time::Instant::now();
            let mut keepalives = 0u32;
            loop {
                line.clear();
                let n = reader.read_line(&mut line).await.unwrap();
                assert!(n > 0, "daemon closed mid-wait");
                // Attach wired per-session forwarding, so output events stream by
                if line.contains("\"event\"") || line.contains("_keepalive") {
                    if line.contains("_keepalive") {
                        keepalives += 1;
                    }
                    continue;
                }
                match serde_json::from_str::<DaemonResponse>(line.trim()).unwrap() {
                    DaemonResponse::WaitResult {
                        satisfied,
                        waited_ms,
                        ..
                    } => break (satisfied, waited_ms, keepalives, started.elapsed()),
                    other => panic!("unexpected frame during wait: {other:?}"),
                }
            }
        })
    });

    let (satisfied, waited_ms, keepalives, elapsed) = observed.join().unwrap();
    assert!(!satisfied, "alive session must time out");
    assert!(waited_ms >= 3_000, "waited_ms={waited_ms}");
    assert!(elapsed >= Duration::from_secs(3));
    assert!(
        keepalives >= 1,
        "expected at least one keepalive frame in >2s wait"
    );

    cancel.cancel();
    listener.join().unwrap();
}

#[test]
fn split_inherits_cwd_over_pipe() {
    let (mut conn, root, listener, cancel) = start_registry_daemon("split");
    decode_attached(
        conn.request(DaemonRequest::CreateOrAttach {
            session_id: "split-src".into(),
            cols: 80,
            rows: 24,
            cwd: Some(root.to_string_lossy().into_owned()),
            shell: None,
            resume_agents: false,
            worktree_id: None,
            extra_env: Vec::new(),
        })
        .expect("create source"),
    )
    .expect("source created");

    // The CLI split does list-check + warm attach + create; exercised here
    // directly over the wire.
    let attached = decode_attached(
        conn.request(DaemonRequest::CreateOrAttach {
            session_id: "split-src".into(),
            cols: 0,
            rows: 0,
            cwd: None,
            shell: None,
            resume_agents: false,
            worktree_id: None,
            extra_env: Vec::new(),
        })
        .expect("attach source"),
    )
    .expect("warm attach");
    assert!(!attached.is_new);
    assert_eq!(attached.cwd.as_deref(), Some(root.to_string_lossy().as_ref()));

    let new_handle = oppa_lib::cli::new_session_handle();
    let created = decode_attached(
        conn.request(build_terminal_create(
            &new_handle,
            attached.cwd.as_deref(),
            attached.worktree_id.as_deref(),
        ))
        .expect("split create"),
    )
    .expect("split created");
    assert!(created.is_new);
    assert_eq!(created.cwd, attached.cwd);

    for id in ["split-src", new_handle.as_str()] {
        decode_ok(
            conn.request(DaemonRequest::Kill { session_id: id.into() })
                .unwrap(),
        )
        .unwrap();
    }
    cancel.cancel();
    listener.join().unwrap();
}

// ---- task 12: worktree create --agent full handoff ----

fn write_fake_agent_script(dir: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let script = dir.join("fake-agent.cmd");
        std::fs::write(&script, "@echo off\r\necho AGENT-GOT-PROMPT %*\r\n").unwrap();
        script
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.join("fake-agent.sh");
        std::fs::write(&script, "#!/bin/sh\necho \"AGENT-GOT-PROMPT $*\"\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        script
    }
}

#[test]
fn agent_handoff_spawns_fake_agent_and_delivers_prompt_in_new_worktree() {
    // The daemon runs in-process; keep the best-effort hook installer off real agent configs.
    std::env::set_var("OPPA_SKIP_HOOK_INSTALL", "1");
    let (mut conn, root, listener, cancel) = start_registry_daemon("handoff");
    let repo_dir = init_git_repo(&root, "agentrepo");
    let repo_path_str = repo_dir.to_string_lossy().into_owned();

    decode_repo_records(
        conn.request(build_repo_add(&repo_path_str))
            .expect("repo add"),
    )
    .expect("decode repo add");

    let script = write_fake_agent_script(&root);
    let resp = conn
        .request(build_worktree_create(CreateArgs {
            repo_path: &repo_path_str,
            name: "agentized",
            branch: None,
            base_ref: None,
            parent_worktree_id: None,
            workspace_dir: None,
            nest_workspaces: false,
            agent: None,
            prompt: Some("hello"),
            command: Some(script.to_string_lossy().as_ref()),
        }))
        .expect("handoff roundtrip");
    let handoff = decode_agent_handoff(resp).expect("decode handoff");
    assert!(!handoff.session_id.is_empty(), "handle must be nonempty");

    let idle = decode_wait_result(
        conn.request(DaemonRequest::WaitFor {
            session_id: handoff.session_id.clone(),
            cond: WaitCondition::TuiIdle,
            timeout_ms: 40_000,
        })
        .expect("idle wait"),
    )
    .expect("decode idle wait");
    assert!(idle.satisfied, "fake agent run must reach tui-idle");

    let screen = decode_read_screen(
        conn.request(DaemonRequest::ReadScreen {
            session_id: handoff.session_id.clone(),
        })
        .expect("read screen"),
    )
    .expect("decode screen");
    assert!(
        screen.text.contains("AGENT-GOT-PROMPT"),
        "agent screen must show the run output: {:?}",
        screen.text
    );

    let ids = decode_session_ids(conn.request(DaemonRequest::ListSessions).expect("list"))
        .expect("decode session ids");
    assert!(
        ids.iter().any(|id| id == &handoff.session_id),
        "agent terminal handle must appear in ListSessions: {ids:?}"
    );

    decode_ok(
        conn.request(DaemonRequest::Kill {
            session_id: handoff.session_id,
        })
        .unwrap(),
    )
    .unwrap();
    shutdown_daemon((conn, root, listener, cancel));
}

#[test]
fn agent_handoff_unknown_agent_and_missing_binary_are_clean_errors_without_orphans() {
    std::env::set_var("OPPA_SKIP_HOOK_INSTALL", "1");
    let (mut conn, root, listener, cancel) = start_registry_daemon("handoff-bad");
    let repo_dir = init_git_repo(&root, "repo");
    let repo_path_str = repo_dir.to_string_lossy().into_owned();

    let unknown = conn
        .request(build_worktree_create(CreateArgs {
            repo_path: &repo_path_str,
            name: "bad-agent",
            branch: None,
            base_ref: None,
            parent_worktree_id: None,
            workspace_dir: None,
            nest_workspaces: false,
            agent: Some("not-an-agent"),
            prompt: Some("hi"),
            command: None,
        }))
        .expect("unknown-agent roundtrip");
    match decode_agent_handoff(unknown) {
        Err(CliError::Daemon(msg)) => assert!(msg.contains("unknown agent"), "{msg}"),
        other => panic!("expected clean unknown-agent error, got {other:?}"),
    }

    let missing_bin = conn
        .request(build_worktree_create(CreateArgs {
            repo_path: &repo_path_str,
            name: "missing-bin",
            branch: None,
            base_ref: None,
            parent_worktree_id: None,
            workspace_dir: None,
            nest_workspaces: false,
            agent: None,
            prompt: Some("hi"),
            command: Some("definitely-not-a-tool-xyz"),
        }))
        .expect("missing-binary roundtrip");
    match decode_agent_handoff(missing_bin) {
        Err(CliError::Daemon(msg)) => assert!(
            msg.contains("agent executable not found on PATH"),
            "{msg}"
        ),
        other => panic!("expected clean PATH-miss error, got {other:?}"),
    }

    let entries = decode_worktree_list(conn.request(DaemonRequest::WorktreeList).unwrap())
        .unwrap();
    assert_eq!(
        filter_active_only(entries).len(),
        0,
        "failed handoffs must not leave worktree records"
    );
    shutdown_daemon((conn, root, listener, cancel));
}
