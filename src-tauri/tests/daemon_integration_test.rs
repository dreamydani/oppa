use oppa_lib::agents::status::{AgentStatusEntry, AgentStatusState, StatusOrigin};
use oppa_lib::git::hosted_reviews::{GhClient, PrStatus};
use oppa_lib::git::worktree_registry::{
    worktree_record_id, WorktreeRecord, WorktreeRegistry, WorktreeStatus,
};
use oppa_lib::pty::daemon_client::DaemonClient;
use oppa_lib::pty::daemon_server::{CancellationToken, DaemonServer};
use oppa_lib::pty::snapshot::{AgentSessionRef, SessionSnapshot, SnapshotStorage};
use std::collections::HashMap;
use std::sync::mpsc::channel;
use std::sync::Arc;
use std::time::Duration;

fn generate_test_socket_path(label: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();

    #[cfg(target_os = "windows")]
    {
        format!(r"\\.\pipe\oppa-int-{label}-{nanos}")
    }

    #[cfg(not(target_os = "windows"))]
    {
        format!("/tmp/oppa-int-{label}-{nanos}.sock")
    }
}

fn start_test_daemon(
    socket_path: &str,
) -> (
    Arc<DaemonServer>,
    CancellationToken,
    std::thread::JoinHandle<()>,
) {
    let server = Arc::new(DaemonServer::new());
    let cancel_token = CancellationToken::new();
    let srv_clone = Arc::clone(&server);
    let cancel_clone = cancel_token.clone();
    let path_clone = socket_path.to_string();

    let server_thread = std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build test daemon tokio runtime");
        rt.block_on(async move {
            let _ = srv_clone.run_listener(&path_clone, cancel_clone).await;
        });
    });

    // Wait for the named pipe or unix socket listener to bind
    std::thread::sleep(Duration::from_millis(150));

    (server, cancel_token, server_thread)
}

#[test]
fn test_e2e_daemon_spawn_and_data_flow() {
    let socket_path = generate_test_socket_path("dataflow");
    let (_server, cancel_token, server_thread) = start_test_daemon(&socket_path);

    let client = DaemonClient::connect(&socket_path).expect("failed to connect DaemonClient");

    let (data_tx, data_rx) = channel::<String>();
    let session_id = "e2e-dataflow-session";

    client.register_callbacks(
        session_id,
        Some(Box::new(move |_id, bytes| {
            let _ = data_tx.send(String::from_utf8_lossy(bytes).into_owned());
        })),
        None,
        None,
    );

    let attach_res = client
        .create_or_attach(session_id, 80, 24, None, None, false, None, None)
        .expect("create_or_attach failed");

    assert!(
        attach_res.is_new,
        "expected new session to have is_new = true"
    );
    assert_eq!(attach_res.cols, 80);
    assert_eq!(attach_res.rows, 24);

    // Send a command to the spawned shell
    client
        .write(session_id, "echo e2e_stream_data_test\n")
        .expect("write to session failed");

    // Collect streamed data events until the echoed output is observed
    let deadline = std::time::Instant::now() + Duration::from_secs(6);
    let mut output = String::new();
    while std::time::Instant::now() < deadline {
        if let Ok(chunk) = data_rx.recv_timeout(Duration::from_millis(200)) {
            output.push_str(&chunk);
            if output.contains("e2e_stream_data_test") {
                break;
            }
        }
    }

    assert!(
        output.contains("e2e_stream_data_test"),
        "expected streamed pty:data output to contain 'e2e_stream_data_test', received: {output}"
    );

    client.disconnect().expect("disconnect failed");
    cancel_token.cancel();
    let _ = server_thread.join();
}

// Process-global idle override; Drop restores it even on assertion failure.
struct IdleMsGuard;
impl IdleMsGuard {
    fn set(ms: &str) -> Self {
        std::env::set_var("OPPA_IDLE_MS", ms);
        Self
    }
}
impl Drop for IdleMsGuard {
    fn drop(&mut self) {
        std::env::remove_var("OPPA_IDLE_MS");
    }
}

fn sh_path_for_working_test() -> String {
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
    "sh".to_string()
}

#[test]
fn test_e2e_daemon_session_working_state_events_over_pipe() {
    let _idle_guard = IdleMsGuard::set("250");
    let socket_path = generate_test_socket_path("working");
    let (_server, cancel_token, server_thread) = start_test_daemon(&socket_path);

    let client = DaemonClient::connect(&socket_path).expect("connect client failed");
    let session_id = "e2e-working-session";

    // Callback must be installed before attach so no flip is missed
    let (work_tx, work_rx) = channel::<bool>();
    client.set_working_state_callback(Arc::new(move |_id, working| {
        let _ = work_tx.send(working);
    }));

    let sh = sh_path_for_working_test();
    let attach_res = client
        .create_or_attach(session_id, 80, 24, None, Some(sh), false, None, None)
        .expect("create_or_attach failed");
    assert!(attach_res.is_new);

    // Attach snapshot carries the current dot for warm reattach hydration
    assert!(attach_res.working, "fresh session must report working");

    // Baseline event rides the seeded subscriber stream
    let baseline = work_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("initial SessionWorking event within 2s");

    // C marker: foreground command → working flip
    client
        .write(session_id, "printf '\\033]133;C;e2e-work\\007'\n")
        .expect("write C marker");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut saw_working_after_start = baseline;
    while std::time::Instant::now() < deadline {
        match work_rx.recv_timeout(Duration::from_millis(200)) {
            Ok(true) => {
                saw_working_after_start = true;
                break;
            }
            Ok(false) => saw_working_after_start = false,
            Err(_) => continue,
        }
    }
    assert!(
        saw_working_after_start,
        "expected SessionWorking(true) after OSC133 C marker"
    );

    // D marker + quiet past OPPA_IDLE_MS → idle flip
    client
        .write(session_id, "printf '\\033]133;D\\007'\n")
        .expect("write D marker");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let mut saw_idle = false;
    while std::time::Instant::now() < deadline {
        match work_rx.recv_timeout(Duration::from_millis(200)) {
            Ok(false) => {
                saw_idle = true;
                break;
            }
            Ok(true) | Err(_) => continue,
        }
    }
    assert!(saw_idle, "expected SessionWorking(false) after D marker + quiet");

    // Edge-triggered over the pipe: within the settle window the stream must
    // never repeat the same state back-to-back (per-tick flooding would).
    let mut last_seen = false;
    let mut repeated_state = false;
    let window = std::time::Instant::now() + Duration::from_millis(900);
    while std::time::Instant::now() < window {
        match work_rx.recv_timeout(Duration::from_millis(150)) {
            Ok(working) => {
                if working == last_seen {
                    repeated_state = true;
                }
                last_seen = working;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    assert!(
        !repeated_state,
        "steady state must not re-emit unchanged SessionWorking events"
    );

    client.kill(session_id).expect("kill session failed");
    client.disconnect().expect("disconnect failed");
    cancel_token.cancel();
    let _ = server_thread.join();
}

#[test]
fn test_e2e_daemon_warm_reattach_and_snapshot() {
    let socket_path = generate_test_socket_path("reattach");
    let (_server, cancel_token, server_thread) = start_test_daemon(&socket_path);

    let session_id = "e2e-reattach-session";

    // 1. First client connects and spawns session
    let client1 = DaemonClient::connect(&socket_path).expect("connect client 1 failed");
    let (data_tx1, data_rx1) = channel::<String>();

    client1.register_callbacks(
        session_id,
        Some(Box::new(move |_id, bytes| {
            let _ = data_tx1.send(String::from_utf8_lossy(bytes).into_owned());
        })),
        None,
        None,
    );

    let attach1 = client1
        .create_or_attach(session_id, 80, 24, None, None, false, None, None)
        .expect("client 1 create_or_attach failed");
    assert!(attach1.is_new, "first connection must be a new session");

    // Write distinctive output to the session
    client1
        .write(session_id, "echo warm_snapshot_payload\n")
        .expect("client 1 write failed");

    // Ensure output reached client 1
    let deadline = std::time::Instant::now() + Duration::from_secs(6);
    let mut output1 = String::new();
    while std::time::Instant::now() < deadline {
        if let Ok(chunk) = data_rx1.recv_timeout(Duration::from_millis(200)) {
            output1.push_str(&chunk);
            if output1.contains("warm_snapshot_payload") {
                break;
            }
        }
    }
    assert!(
        output1.contains("warm_snapshot_payload"),
        "expected client 1 to receive 'warm_snapshot_payload', got: {output1}"
    );

    // Give the in-daemon screen mirror a short moment to apply formatted VT100 escapes
    std::thread::sleep(Duration::from_millis(200));

    // Client 1 disconnects (leaving the daemon and its session running)
    client1.disconnect().expect("client 1 disconnect failed");
    drop(client1);

    // 2. Second client connects and reattaches to the existing session
    let client2 = DaemonClient::connect(&socket_path).expect("connect client 2 failed");
    let attach2 = client2
        .create_or_attach(session_id, 80, 24, None, None, false, None, None)
        .expect("client 2 reattach failed");

    assert!(
        !attach2.is_new,
        "reattached session must report is_new = false"
    );
    assert!(
        attach2.snapshot.is_some(),
        "reattached session must provide an ANSI screen snapshot"
    );

    let snapshot_content = attach2.snapshot.unwrap();
    assert!(
        snapshot_content.contains("warm_snapshot_payload"),
        "expected snapshot to contain 'warm_snapshot_payload', but got:\n{snapshot_content}"
    );

    // Clean up
    client2.kill(session_id).expect("kill session failed");
    client2.disconnect().expect("client 2 disconnect failed");
    cancel_token.cancel();
    let _ = server_thread.join();
}

#[test]
fn test_e2e_daemon_session_kill_lifecycle() {
    let socket_path = generate_test_socket_path("kill");
    let (_server, cancel_token, server_thread) = start_test_daemon(&socket_path);

    let client = DaemonClient::connect(&socket_path).expect("connect client failed");
    let session_id = "e2e-kill-session";

    let attach_res = client
        .create_or_attach(session_id, 80, 24, None, None, false, None, None)
        .expect("create_or_attach failed");
    assert!(attach_res.is_new);

    // Verify session is listed in the daemon
    let active_sessions = client.list_sessions().expect("list_sessions failed");
    assert!(
        active_sessions.contains(&session_id.to_string()),
        "expected session {session_id} to be present in active sessions list"
    );

    // Kill the session
    client.kill(session_id).expect("kill failed");

    // Allow process termination and daemon cleanup
    std::thread::sleep(Duration::from_millis(150));

    // Verify session is no longer active in the daemon
    let remaining_sessions = client.list_sessions().expect("list_sessions failed");
    assert!(
        !remaining_sessions.contains(&session_id.to_string()),
        "expected session {session_id} to be removed after kill"
    );

    client.disconnect().expect("disconnect failed");
    cancel_token.cancel();
    let _ = server_thread.join();
}

#[test]
fn test_e2e_daemon_cwd_env_injection() {
    let socket_path = generate_test_socket_path("cwd_env");
    let (_server, cancel_token, server_thread) = start_test_daemon(&socket_path);

    let client = DaemonClient::connect(&socket_path).expect("connect client failed");
    let session_id = "e2e-cwd-session";
    let (data_tx, data_rx) = channel::<String>();

    client.register_callbacks(
        session_id,
        Some(Box::new(move |_id, bytes| {
            let _ = data_tx.send(String::from_utf8_lossy(bytes).into_owned());
        })),
        None,
        None,
    );

    let attach_res = client
        .create_or_attach(
            session_id,
            80,
            24,
            Some("test_ws_cwd".into()),
            None,
            false,
            None,
            None,
        )
        .expect("create_or_attach with cwd failed");
    assert!(attach_res.is_new);

    #[cfg(target_os = "windows")]
    client
        .write(session_id, "Write-Output \"c=$env:OPPA_WORKSPACE_CWD\"\r\n")
        .expect("write failed");

    #[cfg(not(target_os = "windows"))]
    client
        .write(session_id, "echo c=$OPPA_WORKSPACE_CWD\n")
        .expect("write failed");

    let deadline = std::time::Instant::now() + Duration::from_secs(6);
    let mut output = String::new();
    while std::time::Instant::now() < deadline {
        if let Ok(chunk) = data_rx.recv_timeout(Duration::from_millis(200)) {
            output.push_str(&chunk);
            if output.contains("c=test_ws_cwd") {
                break;
            }
        }
    }

    assert!(
        output.contains("c=test_ws_cwd"),
        "expected output to contain 'c=test_ws_cwd', got: {output}"
    );

    client.kill(session_id).expect("kill failed");
    client.disconnect().expect("disconnect failed");
    cancel_token.cancel();
    let _ = server_thread.join();
}

#[test]
fn test_e2e_daemon_high_throughput_zero_drop_stream() {
    let socket_path = generate_test_socket_path("zero_drop");
    let (_server, cancel_token, server_thread) = start_test_daemon(&socket_path);

    let client = Arc::new(DaemonClient::connect(&socket_path).expect("connect client failed"));
    let session_id = "e2e-zero-drop-session";
    let (data_tx, data_rx) = channel::<String>();

    let client_for_cb = Arc::clone(&client);
    client.register_callbacks(
        session_id,
        Some(Box::new(move |id, bytes| {
            let _ = data_tx.send(String::from_utf8_lossy(bytes).into_owned());
            let _ = client_for_cb.ack(id, bytes.len());
        })),
        None,
        None,
    );

    let attach_res = client
        .create_or_attach(session_id, 80, 24, None, None, false, None, None)
        .expect("create_or_attach failed");
    assert!(attach_res.is_new);

    #[cfg(target_os = "windows")]
    client
        .write(
            session_id,
            "1..10000 | ForEach-Object { [Console]::WriteLine(\"SEQ_$_\") }\r\n",
        )
        .expect("write failed");

    #[cfg(not(target_os = "windows"))]
    client
        .write(
            session_id,
            "awk 'BEGIN { for (i=1; i<=10000; i++) print \"SEQ_\" i }'\n",
        )
        .expect("write failed");

    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    let mut collected = String::new();
    while std::time::Instant::now() < deadline {
        if let Ok(chunk) = data_rx.recv_timeout(Duration::from_millis(200)) {
            collected.push_str(&chunk);
            if collected.contains("SEQ_10000") {
                break;
            }
        }
    }

    assert!(
        collected.contains("SEQ_10000"),
        "expected to receive SEQ_10000 within deadline, received {} bytes",
        collected.len()
    );

    // Verify key sequence checkpoints to ensure zero drop
    for i in [1, 2, 50, 100, 500, 1000, 2500, 5000, 7500, 9999, 10000] {
        let expected = format!("SEQ_{i}");
        assert!(
            collected.contains(&expected),
            "expected output to contain {expected}"
        );
    }

    client.kill(session_id).expect("kill failed");
    client.disconnect().expect("disconnect failed");
    cancel_token.cancel();
    let _ = server_thread.join();
}

#[test]
fn test_e2e_daemon_session_kill_process_tree() {
    let socket_path = generate_test_socket_path("kill_tree");
    let (_server, cancel_token, server_thread) = start_test_daemon(&socket_path);

    let client = DaemonClient::connect(&socket_path).expect("connect client failed");
    let session_id = "e2e-kill-tree-session";

    let attach_res = client
        .create_or_attach(session_id, 80, 24, None, None, false, None, None)
        .expect("create_or_attach failed");
    assert!(attach_res.is_new);

    // Spawn a background subprocess inside the shell
    #[cfg(target_os = "windows")]
    client
        .write(
            session_id,
            "powershell -Command \"Start-Sleep -Seconds 30\"\r\n",
        )
        .expect("write failed");

    #[cfg(not(target_os = "windows"))]
    client
        .write(session_id, "sleep 30\n")
        .expect("write failed");

    std::thread::sleep(Duration::from_millis(300));

    // Terminate session and process tree
    client.kill(session_id).expect("kill session failed");

    std::thread::sleep(Duration::from_millis(300));

    let remaining_sessions = client.list_sessions().expect("list_sessions failed");
    assert!(
        !remaining_sessions.contains(&session_id.to_string()),
        "expected session {session_id} to be removed after process tree kill"
    );

    client.disconnect().expect("disconnect failed");
    cancel_token.cancel();
    let _ = server_thread.join();
}

fn run_git_in(dir: &std::path::Path, args: &[&str]) {
    let mut cmd = std::process::Command::new("git");
    cmd.args(args).current_dir(dir);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().expect("git spawn");
    assert!(
        output.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn test_e2e_daemon_worktree_changed_event_and_client_requests() {
    use oppa_lib::git::worktree_registry::WorktreeStatus;

    let repo_dir = tempfile::tempdir().expect("temp repo dir");
    let app_data_dir = tempfile::tempdir().expect("temp app data dir");
    run_git_in(repo_dir.path(), &["init"]);
    run_git_in(repo_dir.path(), &["config", "user.email", "test@oppa.dev"]);
    run_git_in(repo_dir.path(), &["config", "user.name", "Oppa Test"]);
    std::fs::write(repo_dir.path().join("README.md"), "seed").expect("write seed file");
    run_git_in(repo_dir.path(), &["add", "."]);
    run_git_in(repo_dir.path(), &["commit", "-m", "init"]);

    let socket_path = generate_test_socket_path("worktree");
    let server = Arc::new(DaemonServer::with_snapshot_storage(
        app_data_dir.path().to_path_buf(),
    ));
    let cancel_token = CancellationToken::new();
    let srv_clone = Arc::clone(&server);
    let cancel_clone = cancel_token.clone();
    let path_clone = socket_path.clone();
    let server_thread = std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build test daemon tokio runtime");
        rt.block_on(async move {
            let _ = srv_clone.run_listener(&path_clone, cancel_clone).await;
        });
    });
    std::thread::sleep(Duration::from_millis(150));

    // Client A listens for global worktree events; client B performs mutations.
    let listener = DaemonClient::connect(&socket_path).expect("connect listener client");
    let (wt_tx, wt_rx) = channel::<Option<String>>();
    listener.set_worktree_changed_callback(Arc::new(move |id| {
        let _ = wt_tx.send(id.map(str::to_string));
    }));

    let mutator = DaemonClient::connect(&socket_path).expect("connect mutator client");

    let repo_path = repo_dir.path().to_string_lossy().into_owned();
    let repos = mutator.repo_add(&repo_path).expect("repo_add");
    assert_eq!(repos.len(), 1);

    let created = mutator
        .worktree_create(
            &repo_path,
            Some("feat-card".to_string()),
            None,
            None,
            None,
            None,
            None,
        )
        .expect("worktree_create");
    assert!(created.id.contains("feat-card"), "got id: {}", created.id);
    assert_eq!(created.name, "feat-card");

    let changed_id = wt_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("WorktreeChanged callback must fire after create");
    assert_eq!(changed_id.as_deref(), Some(created.id.as_str()));

    let entries = listener.worktree_list().expect("worktree_list");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].record.id, created.id);
    assert!(!entries[0].missing_on_disk);

    let ps_entries = listener.worktree_ps().expect("worktree_ps");
    assert_eq!(ps_entries.len(), 1);
    assert_eq!(ps_entries[0].live_sessions, 0);

    let lineage = listener
        .worktree_lineage(&created.id)
        .expect("worktree_lineage");
    assert_eq!(lineage.len(), 1);

    let updated = listener
        .worktree_set(
            &created.id,
            false,
            None,
            Some(WorktreeStatus::InProgress),
            None,
        )
        .expect("worktree_set");
    assert_eq!(updated.workspace_status, WorktreeStatus::InProgress);
    let set_event = wt_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("WorktreeChanged callback must fire after set");
    assert_eq!(set_event.as_deref(), Some(created.id.as_str()));

    let current = listener
        .worktree_current(&created.path.to_string_lossy())
        .expect("worktree_current");
    assert_eq!(current.map(|r| r.id), Some(created.id.clone()));

    mutator
        .worktree_remove(&created.id, false, false)
        .expect("worktree_remove");
    let removed_event = wt_rx
        .recv_timeout(Duration::from_secs(5))
        .expect("WorktreeChanged callback must fire after remove");
    assert_eq!(removed_event.as_deref(), Some(created.id.as_str()));
    mutator.worktree_purge(&created.id).expect("worktree_purge");

    let shown = listener.worktree_show(&created.id);
    // Purged record is gone; engine answers "not found" which must surface as Err.
    assert!(shown.is_err(), "expected error after purge, got {shown:?}");

    listener.disconnect().expect("disconnect listener");
    mutator.disconnect().expect("disconnect mutator");
    cancel_token.cancel();
    let _ = server_thread.join();
}

#[test]
fn test_e2e_daemon_v4_git_status_stage_commit_and_comment_crud_over_pipe() {
    use oppa_lib::git::comments_store::{DiffCommentScope, DiffCommentSource, NewDiffComment};

    fn write_repo_file(dir: &std::path::Path, name: &str, content: &str) {
        std::fs::write(dir.join(name), content).expect("write repo file");
    }

    let repo_dir = tempfile::tempdir().expect("temp repo dir");
    let app_data_dir = tempfile::tempdir().expect("temp app data dir");
    run_git_in(repo_dir.path(), &["init", "-b", "main"]);
    run_git_in(repo_dir.path(), &["config", "user.email", "test@oppa.dev"]);
    run_git_in(repo_dir.path(), &["config", "user.name", "Oppa Test"]);
    write_repo_file(repo_dir.path(), "README.md", "# seed");
    run_git_in(repo_dir.path(), &["add", "."]);
    run_git_in(repo_dir.path(), &["commit", "-m", "init"]);
    write_repo_file(repo_dir.path(), "flow.txt", "v1");

    let socket_path = generate_test_socket_path("v4git");
    let server = Arc::new(DaemonServer::with_snapshot_storage(
        app_data_dir.path().to_path_buf(),
    ));
    let cancel_token = CancellationToken::new();
    let srv_clone = Arc::clone(&server);
    let cancel_clone = cancel_token.clone();
    let path_clone = socket_path.clone();
    let server_thread = std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build test daemon tokio runtime");
        rt.block_on(async move {
            let _ = srv_clone.run_listener(&path_clone, cancel_clone).await;
        });
    });
    std::thread::sleep(Duration::from_millis(150));

    // Peer listens for GitChanged while the mutator drives the full workflow.
    let listener = DaemonClient::connect(&socket_path).expect("connect listener client");
    let (git_tx, git_rx) = channel::<()>();
    listener.set_git_changed_callback(Arc::new(move || {
        let _ = git_tx.send(());
    }));
    let mutator = DaemonClient::connect(&socket_path).expect("connect mutator client");

    let cwd = repo_dir.path().to_string_lossy().into_owned();
    let area_of = |status: &oppa_lib::git::source_control::SourceControlStatus, want: &str| {
        status
            .entries
            .iter()
            .find(|e| e.path == want)
            .map(|e| e.area.clone())
    };
    use oppa_lib::git::source_control::GitArea;

    let before = mutator.sc_status(&cwd).expect("sc_status");
    assert_eq!(area_of(&before, "flow.txt"), Some(GitArea::Untracked));

    mutator
        .sc_stage(&cwd, &["flow.txt".to_string()])
        .expect("sc_stage");
    assert_eq!(
        git_rx.recv_timeout(Duration::from_secs(5)).is_ok(),
        true,
        "stage must fire the peer's GitChanged callback"
    );

    let staged = listener.sc_status(&cwd).expect("peer sc_status");
    assert_eq!(area_of(&staged, "flow.txt"), Some(GitArea::Staged));

    let commit_id = mutator.sc_commit(&cwd, "feat: v4 flow").expect("sc_commit");
    assert!(!commit_id.is_empty());
    assert_eq!(
        git_rx.recv_timeout(Duration::from_secs(5)).is_ok(),
        true,
        "commit must fire the peer's GitChanged callback"
    );
    let clean = mutator.sc_status(&cwd).expect("clean sc_status");
    assert!(clean.entries.is_empty());

    let history = mutator.sc_history(&cwd, Some(10)).expect("sc_history");
    assert_eq!(history.items.len(), 2);
    assert_eq!(history.items[0].subject, "feat: v4 flow");

    let branches = mutator.sc_local_branches(&cwd).expect("sc_branches");
    assert_eq!(branches.current.as_deref(), Some("main"));

    // Comment CRUD rides the same pipe and persists into the snapshot dir.
    let comment = mutator
        .diff_comment_add(NewDiffComment {
            worktree_id: "wt-v4".into(),
            file_path: "flow.txt".into(),
            source: DiffCommentSource::Diff,
            selected_text: None,
            start_line: Some(1),
            line_number: 1,
            body: "check this".into(),
            scope: DiffCommentScope::Unstaged,
            old_path: None,
        })
        .expect("diff_comment_add");
    assert!(!comment.id.is_empty());

    let listed = listener.diff_comments_list("wt-v4").expect("comments_list");
    assert_eq!(listed.len(), 1);

    let updated = mutator
        .diff_comment_update(&comment.id, "updated body")
        .expect("diff_comment_update");
    assert_eq!(updated.body, "updated body");

    let stamped = mutator
        .diff_comments_mark_sent(&[comment.id.clone()])
        .expect("mark_sent");
    assert_eq!(stamped.len(), 1);
    assert!(stamped[0].sent_at.unwrap_or(0) > 0);

    mutator
        .diff_comment_delete(&comment.id)
        .expect("diff_comment_delete");
    assert!(
        listener.diff_comments_list("wt-v4").unwrap().is_empty(),
        "delete must remove the record"
    );

    listener.disconnect().expect("disconnect listener");
    mutator.disconnect().expect("disconnect mutator");
    cancel_token.cancel();
    let _ = server_thread.join();
}

#[test]
fn test_e2e_daemon_sc_merge_to_base_over_pipe_fires_git_changed() {
    let repo_dir = tempfile::tempdir().expect("temp repo dir");
    let app_data_dir = tempfile::tempdir().expect("temp app data dir");
    run_git_in(repo_dir.path(), &["init", "-b", "main"]);
    run_git_in(repo_dir.path(), &["config", "user.email", "test@oppa.dev"]);
    run_git_in(repo_dir.path(), &["config", "user.name", "Oppa Test"]);
    std::fs::write(repo_dir.path().join("README.md"), "# seed").expect("write seed file");
    run_git_in(repo_dir.path(), &["add", "."]);
    run_git_in(repo_dir.path(), &["commit", "-m", "init"]);

    let socket_path = generate_test_socket_path("mergebase");
    let server = Arc::new(DaemonServer::with_snapshot_storage(
        app_data_dir.path().to_path_buf(),
    ));
    let cancel_token = CancellationToken::new();
    let srv_clone = Arc::clone(&server);
    let cancel_clone = cancel_token.clone();
    let path_clone = socket_path.clone();
    let server_thread = std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build test daemon tokio runtime");
        rt.block_on(async move {
            let _ = srv_clone.run_listener(&path_clone, cancel_clone).await;
        });
    });
    std::thread::sleep(Duration::from_millis(150));

    let listener = DaemonClient::connect(&socket_path).expect("connect listener client");
    let (git_tx, git_rx) = channel::<()>();
    listener.set_git_changed_callback(Arc::new(move || {
        let _ = git_tx.send(());
    }));
    let client = DaemonClient::connect(&socket_path).expect("connect merge client");

    let repo_path = repo_dir.path().to_string_lossy().into_owned();
    client.repo_add(&repo_path).expect("repo_add");
    let record = client
        .worktree_create(
            &repo_path,
            Some("agent-one".to_string()),
            None,
            Some("main".to_string()),
            None,
            None,
            None,
        )
        .expect("worktree_create");

    // Agent commits land in the worktree; the main checkout stays clean on main.
    std::fs::write(record.path.join("feat.txt"), "feature work\n").expect("write feature file");
    run_git_in(&record.path, &["add", "."]);
    run_git_in(&record.path, &["commit", "-m", "feat adds"]);

    let worktree_cwd = record.path.to_string_lossy().into_owned();
    let outcome = client
        .sc_merge_to_base(&worktree_cwd, "squash")
        .expect("sc_merge_to_base");
    assert_eq!(outcome.mode, "squash");
    assert_eq!(outcome.files_changed, 1);
    assert!(!outcome.merged_commit.is_empty());
    assert_eq!(
        std::fs::read_to_string(repo_dir.path().join("feat.txt")).unwrap().replace('\r', ""),
        "feature work\n"
    );
    assert!(
        git_rx.recv_timeout(Duration::from_secs(5)).is_ok(),
        "successful merge must fire the peer's GitChanged callback"
    );

    // Guard refusals ride the same pipe as plain-language errors.
    std::fs::write(repo_dir.path().join("dirty.txt"), "uncommitted").expect("write dirty file");
    let err = client
        .sc_merge_to_base(&worktree_cwd, "merge")
        .expect_err("dirty main checkout must block the merge");
    assert!(
        err.contains("main checkout has uncommitted changes"),
        "got: {err}"
    );
    assert!(
        client
            .sc_merge_to_base(&repo_path, "squash")
            .err()
            .map(|e| e.contains("not inside a registered agent worktree"))
            .unwrap_or(false),
        "cwd outside any worktree must be rejected"
    );

    listener.disconnect().expect("disconnect listener");
    client.disconnect().expect("disconnect merge client");
    cancel_token.cancel();
    let _ = server_thread.join();
}

// Restores the process PATH on every exit path; the daemon resolves agents from it.
struct PathRestoreGuard(Option<std::ffi::OsString>);

impl Drop for PathRestoreGuard {
    fn drop(&mut self) {
        if let Some(old) = self.0.take() {
            std::env::set_var("PATH", old);
        }
    }
}

#[test]
fn test_e2e_daemon_v4_git_generate_commit_message_over_pipe_uses_fake_agent() {
    let repo_dir = tempfile::tempdir().expect("temp repo dir");
    run_git_in(repo_dir.path(), &["init", "-b", "main"]);
    run_git_in(repo_dir.path(), &["config", "user.email", "test@oppa.dev"]);
    run_git_in(repo_dir.path(), &["config", "user.name", "Oppa Test"]);
    std::fs::write(repo_dir.path().join("flow.txt"), "v1").expect("write staged file");
    run_git_in(repo_dir.path(), &["add", "."]);

    // Fake agent dir is PREPENDED so it shadows any real claude/codex install.
    let fake_dir = tempfile::tempdir().expect("fake agent dir");
    #[cfg(windows)]
    {
        std::fs::write(fake_dir.path().join("claude.cmd"), "@echo off\r\necho feat: fake subject\r\n")
            .unwrap();
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        let script = fake_dir.path().join("claude");
        std::fs::write(&script, "#!/bin/sh\necho \"feat: fake subject\"\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let old_path_raw = std::env::var_os("PATH");
    let guard = PathRestoreGuard(old_path_raw.clone());
    let injected = std::env::join_paths(
        std::iter::once(fake_dir.path().to_path_buf()).chain(
            old_path_raw
                .as_deref()
                .map(std::env::split_paths)
                .into_iter()
                .flatten(),
        ),
    )
    .expect("join paths");
    std::env::set_var("PATH", &injected);

    let app_data_dir = tempfile::tempdir().expect("temp app data dir");
    let socket_path = generate_test_socket_path("v4aimsg");
    let server = Arc::new(DaemonServer::with_snapshot_storage(
        app_data_dir.path().to_path_buf(),
    ));
    let cancel_token = CancellationToken::new();
    let srv_clone = Arc::clone(&server);
    let cancel_clone = cancel_token.clone();
    let path_clone = socket_path.clone();
    let server_thread = std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build test daemon tokio runtime");
        rt.block_on(async move {
            let _ = srv_clone.run_listener(&path_clone, cancel_clone).await;
        });
    });
    std::thread::sleep(Duration::from_millis(150));

    let client = DaemonClient::connect(&socket_path).expect("connect client");
    let cwd = repo_dir.path().to_string_lossy().into_owned();

    let result = client.sc_generate_commit_message(&cwd).expect("ai message over pipe");
    assert_eq!(result.message, "feat: fake subject");

    drop(client);
    cancel_token.cancel();
    let _ = server_thread.join();
    drop(guard);
}

// PrChanged must fan out over the live pipe (not just the broadcast) using an
// injected mock GhClient so no real gh process is spawned during the test.
#[test]
fn test_pr_changed_event_roundtrips_over_pipe_with_mock_client() {
    let app_data_dir = tempfile::tempdir().expect("temp app data dir");
    let registry_path = app_data_dir.path().join("worktrees.json");
    let wt_path = app_data_dir.path().to_path_buf();
    std::fs::create_dir_all(&wt_path).unwrap();
    let pr_url = "https://github.com/owner/repo/pull/7".to_string();
    let id = worktree_record_id("repo", &wt_path);

    {
        let mut registry = WorktreeRegistry::load(&registry_path);
        registry.upsert_worktree(WorktreeRecord {
            id: id.clone(),
            repo_id: "repo".into(),
            name: "wt".into(),
            display_name: None,
            branch: "feature".into(),
            path: wt_path.clone(),
            base_ref: "main".into(),
            parent_worktree_id: None,
            child_worktree_ids: vec![],
            workspace_status: WorktreeStatus::Todo,
            retired: false,
            created_at_ms: 0,
            linked_pr_url: Some(pr_url.clone()),
        });
        registry.save(&registry_path).unwrap();
    }

    struct MockPr {
        url: String,
    }
    impl GhClient for MockPr {
        fn status(&self, _cwd: &std::path::Path, _url: &str) -> Result<PrStatus, String> {
            Ok(PrStatus {
                number: 7,
                title: "t".into(),
                url: self.url.clone(),
                state: "open".into(),
                draft: false,
                mergeable: "unknown".into(),
                base_ref_name: "main".into(),
                head_ref_name: "feature".into(),
                checks: vec![],
                fetched_at_ms: 0,
            })
        }
    }

    let socket_path = generate_test_socket_path("prchanged");
    let server = Arc::new(
        DaemonServer::with_snapshot_storage(app_data_dir.path().to_path_buf())
            .with_pr_client(Arc::new(MockPr { url: pr_url.clone() })),
    );
    let cancel_token = CancellationToken::new();
    let srv_clone = Arc::clone(&server);
    let cancel_clone = cancel_token.clone();
    let path_clone = socket_path.clone();
    let server_thread = std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build test daemon tokio runtime");
        rt.block_on(async move {
            let _ = srv_clone.run_listener(&path_clone, cancel_clone).await;
        });
    });
    std::thread::sleep(Duration::from_millis(150));

    let client = DaemonClient::connect(&socket_path).expect("connect client");
    let (pr_tx, pr_rx) = channel::<Option<String>>();
    client.set_pr_changed_callback(Arc::new(move |wid| {
        let _ = pr_tx.send(wid.map(str::to_string));
    }));
    std::thread::sleep(Duration::from_millis(100));

    assert_eq!(server.run_pr_poll_pass(), 1, "mock client must fetch the linked PR");

    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    let mut received = None;
    while std::time::Instant::now() < deadline {
        if let Ok(w) = pr_rx.recv_timeout(Duration::from_millis(200)) {
            received = Some(w);
            break;
        }
    }
    assert_eq!(
        received,
        Some(Some(id.clone())),
        "PrChanged must round-trip over the pipe with a mock client"
    );

    drop(client);
    cancel_token.cancel();
    let _ = server_thread.join();
}

// ---------- hosted-review e2e with stateful fake gh (real daemon pipe, no mocks) ----------

fn setup_eligible_repo_for_e2e(
    tag: &str,
) -> (tempfile::TempDir, tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
    // Returns (repo_root, app_data_dir, repo_path, bare_path) with feature pushed and github origin set.
    let repo_root = tempfile::tempdir().expect("repo_root temp");
    let app_data_dir = tempfile::tempdir().expect("app_data temp");
    let repo_path = repo_root.path().join("repo");
    std::fs::create_dir_all(&repo_path).unwrap();
    run_git_in(&repo_path, &["init", "-b", "main"]);
    run_git_in(&repo_path, &["config", "user.email", "test@oppa.dev"]);
    run_git_in(&repo_path, &["config", "user.name", "Oppa Test"]);
    std::fs::write(repo_path.join("README.md"), "# init").unwrap();
    run_git_in(&repo_path, &["add", "."]);
    run_git_in(&repo_path, &["commit", "-m", "init"]);
    let bare_path = repo_root.path().join("origin.git");
    run_git_in(
        repo_root.path(),
        &[
            "clone",
            "--bare",
            &repo_path.to_string_lossy().into_owned(),
            &bare_path.to_string_lossy().into_owned(),
        ],
    );
    run_git_in(
        &repo_path,
        &["remote", "add", "origin", &bare_path.to_string_lossy().into_owned()],
    );
    run_git_in(&repo_path, &["push", "-u", "origin", "main"]);
    run_git_in(&repo_path, &["checkout", "-b", "feature"]);
    std::fs::write(repo_path.join("f.txt"), "f").unwrap();
    run_git_in(&repo_path, &["add", "."]);
    run_git_in(&repo_path, &["commit", "-m", "feature work"]);
    run_git_in(&repo_path, &["push", "-u", "origin", "feature"]);
    run_git_in(
        &repo_path,
        &[
            "remote",
            "set-url",
            "origin",
            "https://github.com/oppa-tests/review-eligibility.git",
        ],
    );
    (repo_root, app_data_dir, repo_path, bare_path)
}

fn register_worktree_for_e2e(
    registry_path: &std::path::Path,
    repo_path: &std::path::Path,
) -> String {
    let id = worktree_record_id("test-repo", repo_path);
    let mut registry = WorktreeRegistry::load(registry_path);
    registry.upsert_worktree(WorktreeRecord {
        id: id.clone(),
        repo_id: "test-repo".into(),
        name: "feature-wt".into(),
        display_name: None,
        branch: "feature".into(),
        path: repo_path.to_path_buf(),
        base_ref: "main".into(),
        parent_worktree_id: None,
        child_worktree_ids: vec![],
        workspace_status: WorktreeStatus::Todo,
        retired: false,
        created_at_ms: 0,
        linked_pr_url: None,
    });
    registry.save(registry_path).unwrap();
    id
}

#[test]
fn test_hosted_review_e2e_eligibility_create_status_diverge_clears_over_pipe_with_fake_gh() {
    let fake_gh_dir = oppa_lib::git::test_support::fake_gh_stateful_dir();
    let (repo_root, app_data_dir, repo_path, _bare) = setup_eligible_repo_for_e2e("e2e-full");
    let registry_path = app_data_dir.path().join("worktrees.json");
    let worktree_id = register_worktree_for_e2e(&registry_path, &repo_path);

    let socket_path = generate_test_socket_path("e2e-full");
    let server = Arc::new(
        DaemonServer::with_snapshot_storage(app_data_dir.path().to_path_buf())
            .with_fake_gh_dir(fake_gh_dir.clone()),
    );
    let cancel_token = CancellationToken::new();
    let srv_clone = Arc::clone(&server);
    let cancel_clone = cancel_token.clone();
    let path_clone = socket_path.clone();
    let server_thread = std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build test daemon tokio runtime");
        rt.block_on(async move {
            let _ = srv_clone.run_listener(&path_clone, cancel_clone).await;
        });
    });
    std::thread::sleep(Duration::from_millis(200));

    let client = DaemonClient::connect(&socket_path).expect("connect client");
    let (pr_tx, pr_rx) = channel::<Option<String>>();
    client.set_pr_changed_callback(Arc::new(move |wid| {
        let _ = pr_tx.send(wid.map(str::to_string));
    }));
    std::thread::sleep(Duration::from_millis(100));

    let repo_str = repo_path.to_string_lossy().into_owned();

    // 1. Eligibility before any PR: eligible true, no existing_pr_url
    let elig_before = client
        .review_eligibility(&repo_str)
        .expect("eligibility before");
    assert!(elig_before.eligible, "expected eligible before PR: {elig_before:?}");
    assert_eq!(elig_before.existing_pr_url, None);
    assert_eq!(elig_before.base_ref.as_deref(), Some("main"));
    assert_eq!(
        elig_before.owner_repo.as_deref(),
        Some("oppa-tests/review-eligibility")
    );

    // 2. Create PR over pipe
    let created = client
        .create_review(&repo_str, "Test PR", "body text", false)
        .expect("create_review");
    assert!(created.pr_url.contains("/pull/"), "got {}", created.pr_url);
    assert_eq!(created.pr_number, Some(9));
    assert_eq!(created.base_ref, "main");
    assert_eq!(created.owner_repo, "oppa-tests/review-eligibility");

    // Registry must be stamped
    let reg = WorktreeRegistry::load(&registry_path);
    assert_eq!(
        reg.worktrees[&worktree_id].linked_pr_url.as_deref(),
        Some(created.pr_url.as_str())
    );

    // 3. Eligibility after creation should now show existing_pr_url
    let elig_after = client
        .review_eligibility(&repo_str)
        .expect("eligibility after");
    assert!(elig_after.eligible);
    assert_eq!(
        elig_after.existing_pr_url.as_deref(),
        Some(created.pr_url.as_str()),
        "after create, eligibility must surface existing_pr_url"
    );

    // 4. Status refresh over pipe: parses checks, publishes PrChanged
    let status = client.review_status(&repo_str).expect("review_status");
    assert_eq!(status.url, created.pr_url);
    assert_eq!(status.state, "open");
    assert_eq!(status.head_ref_name, "feature");
    assert_eq!(status.checks.len(), 4, "mixed rollup must yield 4 checks");
    let has_passing = status.checks.iter().any(|c| c.state == oppa_lib::git::hosted_reviews::CheckState::Passing);
    let has_failing = status.checks.iter().any(|c| c.state == oppa_lib::git::hosted_reviews::CheckState::Failing);
    let has_pending = status.checks.iter().any(|c| c.state == oppa_lib::git::hosted_reviews::CheckState::Pending);
    let has_skipping = status.checks.iter().any(|c| c.state == oppa_lib::git::hosted_reviews::CheckState::Skipping);
    assert!(has_passing && has_failing && has_pending && has_skipping, "checks: {:?}", status.checks);

    // PrChanged must have fired for the status refresh
    let pr_event = pr_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("PrChanged after status");
    assert_eq!(pr_event.as_deref(), Some(worktree_id.as_str()));

    // Second refresh still succeeds (no regression)
    let status2 = client.review_status(&repo_str).expect("second status");
    assert_eq!(status2.url, created.pr_url);
    let _ = pr_rx.recv_timeout(Duration::from_secs(2)).expect("second PrChanged");

    // 5. Simulate diverge: mutate registry branch to mismatch headRefName
    {
        let mut reg = WorktreeRegistry::load(&registry_path);
        if let Some(w) = reg.worktrees.get_mut(&worktree_id) {
            w.branch = "other-branch".into();
        }
        reg.save(&registry_path).unwrap();
    }
    // Drain any pending events
    while pr_rx.recv_timeout(Duration::from_millis(100)).is_ok() {}
    let diverged_status = client.review_status(&repo_str).expect("diverged status");
    assert_eq!(diverged_status.head_ref_name, "feature");
    // PrChanged must fire even though link is cleared
    let diverge_event = pr_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("PrChanged after diverge");
    assert_eq!(diverge_event.as_deref(), Some(worktree_id.as_str()));

    // Link must be cleared by reconcile
    let reg_after = WorktreeRegistry::load(&registry_path);
    assert!(
        reg_after.worktrees[&worktree_id].linked_pr_url.is_none(),
        "diverge must clear linked_pr_url, got {:?}", reg_after.worktrees[&worktree_id].linked_pr_url
    );

    // After diverge, eligibility should be eligible again with no existing_pr (lookup still finds old PR but diverge cleared link)
    // The second create should short-circuit or create anew; we just verify status now errors without link
    let err_after = client.review_status(&repo_str).unwrap_err();
    assert!(
        err_after.contains("no linked pull request"),
        "after diverge, status without link must error, got: {err_after}"
    );

    drop(client);
    cancel_token.cancel();
    let _ = server_thread.join();
    drop(repo_root);
    drop(app_data_dir);
}

#[test]
fn test_hosted_review_e2e_ambiguous_stdout_recovers_via_probe() {
    let fake_gh_dir = oppa_lib::git::test_support::fake_gh_stateful_blank_dir();
    let (repo_root, app_data_dir, repo_path, _bare) = setup_eligible_repo_for_e2e("e2e-blank");
    let registry_path = app_data_dir.path().join("worktrees.json");
    let worktree_id = register_worktree_for_e2e(&registry_path, &repo_path);

    let socket_path = generate_test_socket_path("e2e-blank");
    let server = Arc::new(
        DaemonServer::with_snapshot_storage(app_data_dir.path().to_path_buf())
            .with_fake_gh_dir(fake_gh_dir.clone()),
    );
    let cancel_token = CancellationToken::new();
    let srv_clone = Arc::clone(&server);
    let cancel_clone = cancel_token.clone();
    let path_clone = socket_path.clone();
    let server_thread = std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build test daemon tokio runtime");
        rt.block_on(async move {
            let _ = srv_clone.run_listener(&path_clone, cancel_clone).await;
        });
    });
    std::thread::sleep(Duration::from_millis(200));

    let client = DaemonClient::connect(&socket_path).expect("connect client");
    let repo_str = repo_path.to_string_lossy().into_owned();

    // Create with blank stdout must recover via probe and still stamp
    let created = client
        .create_review(&repo_str, "Blank PR", "body", false)
        .expect("blank create must recover via probe");
    assert!(created.pr_url.contains("/pull/9"));
    assert_eq!(created.pr_number, Some(9));

    let reg = WorktreeRegistry::load(&registry_path);
    assert_eq!(
        reg.worktrees[&worktree_id].linked_pr_url.as_deref(),
        Some(created.pr_url.as_str())
    );

    drop(client);
    cancel_token.cancel();
    let _ = server_thread.join();
    drop(repo_root);
    drop(app_data_dir);
}

#[test]
#[ignore]
fn test_hosted_review_live_smoke_requires_gh_authed() {
    // Gate: only run when OPPA_LIVE_SMOKE=1 or when gh is present and authed; otherwise gracefully skip.
    let live_requested = std::env::var("OPPA_LIVE_SMOKE").as_deref() == Ok("1");
    let gh_program = oppa_lib::agents::catalog::resolve_command_with_path(
        "gh",
        None,
    );
    let Some(gh_path) = gh_program else {
        eprintln!("live smoke skipped: gh not on PATH");
        return;
    };
    // Check auth
    let mut cmd = std::process::Command::new(&gh_path);
    cmd.args(["auth", "status"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let auth_ok = cmd.status().map(|s| s.success()).unwrap_or(false);
    if !auth_ok {
        eprintln!("live smoke skipped: gh not authed");
        return;
    }
    if !live_requested {
        eprintln!("live smoke skipped: set OPPA_LIVE_SMOKE=1 to run fully (gh authed)");
        return;
    }

    // Real smoke: create a temp bare-backed repo and run live eligibility (local bare is unsupported provider, so just check gh path wiring doesn't panic)
    let repo_root = tempfile::tempdir().expect("smoke repo_root");
    let repo_path = repo_root.path().join("repo");
    std::fs::create_dir_all(&repo_path).unwrap();
    run_git_in(&repo_path, &["init", "-b", "main"]);
    run_git_in(&repo_path, &["config", "user.email", "test@oppa.dev"]);
    run_git_in(&repo_path, &["config", "user.name", "Oppa Test"]);
    std::fs::write(repo_path.join("README.md"), "init").unwrap();
    run_git_in(&repo_path, &["add", "."]);
    run_git_in(&repo_path, &["commit", "-m", "init"]);
    let bare_path = repo_root.path().join("origin.git");
    run_git_in(
        repo_root.path(),
        &[
            "clone",
            "--bare",
            &repo_path.to_string_lossy().into_owned(),
            &bare_path.to_string_lossy().into_owned(),
        ],
    );
    run_git_in(
        &repo_path,
        &["remote", "add", "origin", &bare_path.to_string_lossy().into_owned()],
    );
    run_git_in(&repo_path, &["push", "-u", "origin", "main"]);
    run_git_in(&repo_path, &["checkout", "-b", "feature"]);
    std::fs::write(repo_path.join("f.txt"), "f").unwrap();
    run_git_in(&repo_path, &["add", "."]);
    run_git_in(&repo_path, &["commit", "-m", "feat"]);
    run_git_in(&repo_path, &["push", "-u", "origin", "feature"]);
    // Point at real github for eligibility ladder (will be eligible if gh authed)
    run_git_in(
        &repo_path,
        &[
            "remote",
            "set-url",
            "origin",
            "https://github.com/oppa-tests/review-eligibility.git",
        ],
    );
    let elig = oppa_lib::git::hosted_reviews::review_eligibility_live(&repo_path);
    assert!(
        elig.eligible || elig.blocked_reason.is_some(),
        "live eligibility must return a decision, got {elig:?}"
    );
}

// Posts a hook envelope to the loopback agent-hook endpoint the way the
// installed scripts do: JSON body, token echo, pane_key routing, /hook/<family>.
fn post_hook(path: &str, body: &str, port: u16) {
    use std::io::{Read, Write};
    let mut stream =
        std::net::TcpStream::connect(("127.0.0.1", port)).expect("connect hook endpoint");
    let request = format!(
        "POST {} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        path,
        body.len(),
        body
    );
    stream
        .write_all(request.as_bytes())
        .expect("write hook request");
    let mut response = String::new();
    let _ = stream.read_to_string(&mut response);
}

fn hook_wait_until(deadline: std::time::Instant, mut cond: impl FnMut() -> bool, label: &str) {
    while !cond() {
        assert!(std::time::Instant::now() < deadline, "timed out waiting for {label}");
        std::thread::sleep(Duration::from_millis(30));
    }
}

#[test]
fn test_e2e_daemon_agent_status_hook_lifecycle_over_http() {
    // Build a real PTY session so the hook payload has a pane to route to.
    let sessions: Arc<
        parking_lot::Mutex<HashMap<String, Arc<oppa_lib::pty::daemon_session::DaemonSession>>>,
    > = Arc::new(parking_lot::Mutex::new(HashMap::new()));
    let sh = sh_path_for_working_test();
    let session = oppa_lib::pty::daemon_session::DaemonSession::spawn_with_args(
        "e2e-agent-status-session".into(),
        &sh,
        &[],
        None,
        80,
        24,
        None,
        &[],
    )
    .expect("spawn session for hook lifecycle");
    sessions
        .lock()
        .insert("e2e-agent-status-session".into(), Arc::clone(&session));

    // tokio runtime: the hook server is async; drive it on a background runtime.
    let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
    let server = rt
        .block_on(oppa_lib::pty::agent_hook_server::AgentHookServer::start(
            Arc::clone(&sessions),
        ))
        .expect("agent hook server started");
    let port = server.port;
    let token = server.token.clone();

    let envelope = |payload: serde_json::Value| {
        serde_json::json!({
            "pane_key": "e2e-agent-status-session",
            "token": token,
            "payload": payload,
        })
        .to_string()
    };
    let status = || session.agent_status();

    // Wrong token is rejected: no status change.
    post_hook(
        "/hook/claude",
        &serde_json::json!({
            "pane_key": "e2e-agent-status-session",
            "token": "wrong-token",
            "payload": { "hook_event_name": "Stop" }
        })
        .to_string(),
        port,
    );
    std::thread::sleep(Duration::from_millis(200));
    assert!(status().is_none(), "bad token must be ignored");

    // 1. SessionStart (boundary): working + prompt capture
    post_hook(
        "/hook/claude",
        &envelope(serde_json::json!({
            "hook_event_name": "SessionStart",
            "prompt": "refactor the login flow",
        })),
        port,
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    hook_wait_until(deadline, || status().is_some(), "SessionStart entry");
    let start_entry = status().unwrap();
    assert_eq!(
        start_entry.state,
        oppa_lib::agents::status::AgentStatusState::Working
    );
    assert_eq!(start_entry.prompt, "refactor the login flow");

    // 2. PreToolUse: tool activity rides the working state
    post_hook(
        "/hook/claude",
        &envelope(serde_json::json!({
            "hook_event_name": "PreToolUse",
            "tool_name": "Edit",
            "tool_input": { "file_path": "src/login.ts" },
        })),
        port,
    );
    hook_wait_until(
        deadline,
        || matches!(status(), Some(s) if s.tool_name.as_deref() == Some("Edit")),
        "PreToolUse entry",
    );
    let tool_entry = status().unwrap();
    assert_eq!(
        tool_entry.state,
        oppa_lib::agents::status::AgentStatusState::Working
    );

    // 3. Notification: waiting + the literal question the agent is stuck on
    post_hook(
        "/hook/claude",
        &envelope(serde_json::json!({
            "hook_event_name": "Notification",
            "message": "Allow write access to /tmp?",
        })),
        port,
    );
    hook_wait_until(
        deadline,
        || matches!(status(), Some(s) if s.interactive_prompt.as_deref() == Some("Allow write access to /tmp?")),
        "waiting entry",
    );
    let waiting_entry = status().unwrap();
    assert_eq!(
        waiting_entry.state,
        oppa_lib::agents::status::AgentStatusState::Waiting
    );

    // 4. Stop: done with a completion timestamp
    post_hook(
        "/hook/claude",
        &envelope(serde_json::json!({ "hook_event_name": "Stop" })),
        port,
    );
    hook_wait_until(
        deadline,
        || matches!(status(), Some(s) if s.state == oppa_lib::agents::status::AgentStatusState::Done),
        "done entry",
    );
    let done_entry = status().unwrap();
    assert_eq!(done_entry.state, oppa_lib::agents::status::AgentStatusState::Done);
    assert!(done_entry.turn_completed_at_ms.is_some());

    // 5. Done-gate: non-boundary events are refused after done (no flip)
    let done_updated = done_entry.updated_at_ms;
    post_hook(
        "/hook/claude",
        &envelope(serde_json::json!({
            "hook_event_name": "PreToolUse",
            "tool_name": "Bash",
        })),
        port,
    );
    std::thread::sleep(Duration::from_millis(250));
    assert_eq!(
        status().unwrap().updated_at_ms,
        done_updated,
        "done-gate must refuse non-boundary events after Stop"
    );

    // 6. Truncation: a boundary event after done resets state and clamps the
    //    oversized prompt to the shared field cap.
    let oversized_prompt = "x".repeat(3000);
    post_hook(
        "/hook/claude",
        &envelope(serde_json::json!({
            "hook_event_name": "SessionStart",
            "prompt": oversized_prompt,
        })),
        port,
    );
    hook_wait_until(
        deadline,
        || matches!(status(), Some(s) if s.state == oppa_lib::agents::status::AgentStatusState::Working),
        "post-done boundary entry",
    );
    let clamped = status().unwrap();
    assert_eq!(
        clamped.prompt.len(),
        oppa_lib::agents::status::AGENT_STATUS_MAX_FIELD_LENGTH,
        "oversized prompt must clamp to the shared field cap"
    );

    let _ = session.kill();
}

// Latency guard: a hook POST must land on the session event stream — the same
// stream the GUI client subscribes to on attach — fast enough that sidebar
// indicators feel instant. Guards against regressions that reclassify status
// on a timer instead of edge-triggered hook delivery.
#[test]
fn test_agent_status_event_delivery_is_instant_not_polled() {
    let sessions: Arc<
        parking_lot::Mutex<HashMap<String, Arc<oppa_lib::pty::daemon_session::DaemonSession>>>,
    > = Arc::new(parking_lot::Mutex::new(HashMap::new()));
    let sh = sh_path_for_working_test();
    let session = oppa_lib::pty::daemon_session::DaemonSession::spawn_with_args(
        "agent-status-latency-session".into(),
        &sh,
        &[],
        None,
        80,
        24,
        None,
        &[],
    )
    .expect("spawn session for latency guard");
    sessions
        .lock()
        .insert("agent-status-latency-session".into(), Arc::clone(&session));

    let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
    let server = rt
        .block_on(oppa_lib::pty::agent_hook_server::AgentHookServer::start(
            Arc::clone(&sessions),
        ))
        .expect("agent hook server started");

    // Subscribe before the POST, mirroring the GUI wiring: the client is
    // subscribed via session.subscribe() the moment a pane attaches.
    let mut rx = session.subscribe();

    let started = std::time::Instant::now();
    post_hook(
        "/hook/claude",
        &serde_json::json!({
            "pane_key": "agent-status-latency-session",
            "token": server.token,
            "payload": { "hook_event_name": "UserPromptSubmit", "prompt": "ship it" },
        })
        .to_string(),
        server.port,
    );

    let deadline = started + Duration::from_secs(5);
    let mut delivered = None;
    while std::time::Instant::now() < deadline {
        match rx.try_recv() {
            Ok(event) => {
                if let oppa_lib::pty::ipc_protocol::DaemonEvent::AgentStatusChanged {
                    pane_key,
                    entry,
                } = event.as_ref()
                {
                    assert_eq!(pane_key, "agent-status-latency-session");
                    assert_eq!(
                        entry.state,
                        oppa_lib::agents::status::AgentStatusState::Working
                    );
                    delivered = Some(started.elapsed());
                    break;
                }
            }
            Err(tokio::sync::mpsc::error::TryRecvError::Empty) => {
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => break,
        }
    }
    let elapsed = delivered.expect("AgentStatusChanged must arrive on the session stream");
    assert!(
        elapsed < Duration::from_millis(1000),
        "hook status must reach the event stream instantly, took {elapsed:?}"
    );

    let _ = session.kill();
}

// Update restarts drop every GUI client while the daemon lives on. These
// tests prove sessions survive that shape. They extend (not duplicate)
// test_e2e_daemon_warm_reattach_and_snapshot, which covers only a
// single-client handoff with no continuity, ack, or cold-restore assertions.

// Highest TICK_<n> counter value visible in captured output.
fn max_tick_in(output: &str) -> Option<u64> {
    let mut max: Option<u64> = None;
    for (idx, _) in output.match_indices("TICK_") {
        let digits: String = output[idx + "TICK_".len()..]
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if let Ok(n) = digits.parse::<u64>() {
            max = Some(max.map_or(n, |m| m.max(n)));
        }
    }
    max
}

#[test]
fn test_e2e_update_restart_full_client_drop_keeps_session_alive() {
    let socket_path = generate_test_socket_path("update_restart");
    let (_server, cancel_token, server_thread) = start_test_daemon(&socket_path);
    let session_id = "e2e-update-restart-session";

    // GUI before the update: spawn a session with a shell counter proving liveness.
    let client1 = DaemonClient::connect(&socket_path).expect("connect pre-restart client");
    let (data_tx1, data_rx1) = channel::<String>();
    client1.register_callbacks(
        session_id,
        Some(Box::new(move |_id, bytes| {
            let _ = data_tx1.send(String::from_utf8_lossy(bytes).into_owned());
        })),
        None,
        None,
    );
    let attach1 = client1
        .create_or_attach(session_id, 80, 24, None, None, false, None, None)
        .expect("pre-restart create_or_attach failed");
    assert!(attach1.is_new);

    #[cfg(target_os = "windows")]
    client1
        .write(
            session_id,
            "$i=0; while($true){$i++; Write-Output \"TICK_$i\"; Start-Sleep -Seconds 1}\r\n",
        )
        .expect("start counter failed");

    #[cfg(not(target_os = "windows"))]
    client1
        .write(
            session_id,
            "i=0; while true; do i=$((i+1)); echo TICK_$i; sleep 1; done\n",
        )
        .expect("start counter failed");

    // Output must be flowing before the drop.
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    let mut pre_output = String::new();
    while std::time::Instant::now() < deadline {
        if let Ok(chunk) = data_rx1.recv_timeout(Duration::from_millis(200)) {
            pre_output.push_str(&chunk);
            if max_tick_in(&pre_output).is_some_and(|n| n >= 2) {
                break;
            }
        }
    }
    let pre_max =
        max_tick_in(&pre_output).expect("counter must tick before the client drop");

    // The update-restart shape: EVERY client gone, daemon alive.
    client1.disconnect().expect("pre-restart disconnect failed");
    drop(client1);
    drop(data_rx1);

    // Post-update GUI: the session is still listed, reattaches warm, same child.
    let client2 = DaemonClient::connect(&socket_path).expect("connect post-restart client");
    let live = client2.list_sessions().expect("list_sessions failed");
    assert!(
        live.contains(&session_id.to_string()),
        "daemon must retain the session across a full client drop, got: {live:?}"
    );

    let (data_tx2, data_rx2) = channel::<String>();
    client2.register_callbacks(
        session_id,
        Some(Box::new(move |_id, bytes| {
            let _ = data_tx2.send(String::from_utf8_lossy(bytes).into_owned());
        })),
        None,
        None,
    );
    let attach2 = client2
        .create_or_attach(session_id, 80, 24, None, None, false, None, None)
        .expect("post-restart reattach failed");
    assert!(
        !attach2.is_new,
        "reattach after a full client drop must be warm"
    );
    assert_eq!(
        attach2.pid, attach1.pid,
        "warm reattach must keep the same child (no restart)"
    );
    let snapshot = attach2
        .snapshot
        .expect("warm reattach must carry an ANSI screen snapshot");
    assert!(
        snapshot.contains("TICK_"),
        "snapshot must carry pre-drop output, got:\n{snapshot}"
    );

    // Continuity: the SAME shell counter keeps incrementing across the drop.
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    let mut post_output = String::new();
    let mut post_max: Option<u64> = None;
    while std::time::Instant::now() < deadline {
        if let Ok(chunk) = data_rx2.recv_timeout(Duration::from_millis(200)) {
            post_output.push_str(&chunk);
            post_max = max_tick_in(&post_output).filter(|n| *n > pre_max);
            if post_max.is_some() {
                break;
            }
        }
    }
    assert!(
        post_max.is_some_and(|n| n > pre_max),
        "counter must keep incrementing across the drop (pre_max={pre_max}), got: {post_output}"
    );

    client2.kill(session_id).expect("kill session failed");
    client2.disconnect().expect("disconnect failed");
    cancel_token.cancel();
    let _ = server_thread.join();
}

#[test]
fn test_e2e_update_restart_ack_sane_across_reattach() {
    let socket_path = generate_test_socket_path("update_ack");
    let (_server, cancel_token, server_thread) = start_test_daemon(&socket_path);
    let session_id = "e2e-update-restart-ack-session";

    // Pre-restart GUI streams a flood it never acks (killed mid-render).
    let client1 = DaemonClient::connect(&socket_path).expect("connect pre-restart client");
    let (data_tx1, data_rx1) = channel::<String>();
    client1.register_callbacks(
        session_id,
        Some(Box::new(move |_id, bytes| {
            let _ = data_tx1.send(String::from_utf8_lossy(bytes).into_owned());
        })),
        None,
        None,
    );
    let attach1 = client1
        .create_or_attach(session_id, 80, 24, None, None, false, None, None)
        .expect("pre-restart create_or_attach failed");
    assert!(attach1.is_new);

    // ~300KB of fat lines with zero acks: the reader MUST park at the 256KB
    // high watermark mid-flood (delivery stalls at ~256KB while the child
    // blocks). Collect until that stall: substantial flow, then silence.
    // (Thin 10000-line floods never park the reader, so they cannot wedge it.)
    #[cfg(target_os = "windows")]
    client1
        .write(
            session_id,
            "1..600 | ForEach-Object { [Console]::WriteLine(\"FLOOD_$_\" + \"x\"*500) }\r\n",
        )
        .expect("flood write failed");

    #[cfg(not(target_os = "windows"))]
    client1
        .write(
            session_id,
            "awk 'BEGIN { pad=sprintf(\"%500s\", \" \"); for (i=1; i<=600; i++) print \"FLOOD_\" i pad }'\n",
        )
        .expect("flood write failed");

    let deadline = std::time::Instant::now() + Duration::from_secs(25);
    let mut flooded = String::new();
    let mut last_receive = std::time::Instant::now();
    while std::time::Instant::now() < deadline {
        match data_rx1.recv_timeout(Duration::from_millis(200)) {
            Ok(chunk) => {
                flooded.push_str(&chunk);
                last_receive = std::time::Instant::now();
            }
            Err(_) => {
                if flooded.len() > 128 * 1024
                    && last_receive.elapsed() > Duration::from_millis(1500)
                {
                    break; // parked: volume flowed, then silence
                }
            }
        }
    }
    assert!(
        flooded.len() > 128 * 1024,
        "flood must engage the reader pre-drop ({} bytes received)",
        flooded.len()
    );

    // Drop without acking anything, like a GUI killed mid-render.
    client1.disconnect().expect("pre-restart disconnect failed");
    drop(client1);
    drop(data_rx1);

    // Post-restart GUI: warm reattach, ack the snapshot, reader must not wedge.
    let client2 = DaemonClient::connect(&socket_path).expect("connect post-restart client");
    let (data_tx2, data_rx2) = channel::<String>();
    client2.register_callbacks(
        session_id,
        Some(Box::new(move |_id, bytes| {
            let _ = data_tx2.send(String::from_utf8_lossy(bytes).into_owned());
        })),
        None,
        None,
    );
    let attach2 = client2
        .create_or_attach(session_id, 80, 24, None, None, false, None, None)
        .expect("post-restart reattach failed");
    assert!(!attach2.is_new, "reattach must be warm");
    let snapshot_len = attach2.snapshot.as_deref().map(str::len).unwrap_or(0);
    client2
        .ack(session_id, snapshot_len)
        .expect("ack of snapshot bytes failed");

    // Fresh output must still flow: the reader never wedged on stale pending.
    #[cfg(target_os = "windows")]
    client2
        .write(session_id, "Write-Output \"ack_continuity_ok\"\r\n")
        .expect("continuity write failed");

    #[cfg(not(target_os = "windows"))]
    client2
        .write(session_id, "echo ack_continuity_ok\n")
        .expect("continuity write failed");

    // The parked reader must resume: the stuck flood tail unblocks AND fresh
    // output flows after acking the snapshot. (A small post-reattach backlog
    // drains first, so allow the file's max deadline.)
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    let mut output = String::new();
    while std::time::Instant::now() < deadline {
        if let Ok(chunk) = data_rx2.recv_timeout(Duration::from_millis(200)) {
            output.push_str(&chunk);
            if output.contains("FLOOD_600") && output.contains("ack_continuity_ok") {
                break;
            }
        }
    }
    assert!(
        output.contains("FLOOD_600"),
        "stuck flood tail must unblock after reattach + ack, got {} bytes",
        output.len()
    );
    assert!(
        output.contains("ack_continuity_ok"),
        "post-reattach output must flow after acking the snapshot, got: {output}"
    );

    client2.kill(session_id).expect("kill session failed");
    client2.disconnect().expect("disconnect failed");
    cancel_token.cancel();
    let _ = server_thread.join();
}

fn restart_seed_status() -> AgentStatusEntry {
    // Last hook-classified truth a checkpoint would carry across the restart.
    AgentStatusEntry {
        state: AgentStatusState::Working,
        prompt: "refactor the login flow".into(),
        agent_type: Some("claude".into()),
        model: None,
        tool_name: Some("Edit".into()),
        tool_input: None,
        interactive_prompt: None,
        interrupted: None,
        turn_completed_at_ms: None,
        state_started_at_ms: 1724050000000,
        updated_at_ms: 1724050001000,
        origin: StatusOrigin::Hook,
    }
}

#[test]
fn test_update_restart_checkpoint_disk_roundtrip_preserves_restore_state() {
    // Disk layer must preserve every field a cold restore rehydrates from.
    let dir = tempfile::tempdir().expect("temp snapshot dir");
    let storage = SnapshotStorage::new(dir.path().to_path_buf());
    let seeded = SessionSnapshot {
        session_id: "e2e-update-restart-cold".into(),
        cwd: dir.path().to_string_lossy().into_owned(),
        title: Some("release pane".into()),
        cols: 100,
        rows: 30,
        persona_id: None,
        scrollback: "TICK_41 mid-update screen".into(),
        timestamp: 1724050000000,
        foreground_command: None,
        agent_session: Some(AgentSessionRef {
            agent: "claude".into(),
            id: "conv-1".into(),
            transcript_path: None,
        }),
        worktree_id: Some("repo::C:/ws/feat-a".into()),
        agent_status: Some(restart_seed_status()),
    };
    storage.save_snapshot(&seeded).expect("seed checkpoint");
    let loaded = storage
        .load_snapshot("e2e-update-restart-cold")
        .expect("load succeeds")
        .expect("checkpoint found");
    assert_eq!(loaded.cwd, seeded.cwd, "cold restore must recover cwd");
    assert_eq!(loaded.title, seeded.title, "cold restore must recover title");
    assert_eq!(
        loaded.agent_status, seeded.agent_status,
        "cold restore must recover last-known agent status"
    );
    assert_eq!(loaded, seeded, "checkpoint must round-trip intact");
}

#[test]
fn test_e2e_update_restart_cold_boot_restores_checkpoint_state() {
    // "Pre-restart": a checkpoint as the periodic task / Shutdown flush writes it.
    let app_data_dir = tempfile::tempdir().expect("temp app data dir");
    let storage = SnapshotStorage::new(app_data_dir.path().to_path_buf());
    let seeded_cwd = app_data_dir.path().to_string_lossy().into_owned();
    let seeded_status = restart_seed_status();
    storage
        .save_snapshot(&SessionSnapshot {
            session_id: "e2e-update-restart-cold-live".into(),
            cwd: seeded_cwd.clone(),
            title: Some("release pane".into()),
            cols: 100,
            rows: 30,
            persona_id: None,
            scrollback: "TICK_41 mid-update screen".into(),
            timestamp: 1724050000000,
            // Idle shell: an honest cold boot restores no resume plan for it.
            foreground_command: None,
            agent_session: None,
            worktree_id: None,
            agent_status: Some(seeded_status.clone()),
        })
        .expect("seed checkpoint");

    // "Post-restart": a fresh daemon on the same snapshot dir cold-boots the pane.
    let socket_path = generate_test_socket_path("update_cold");
    let server = Arc::new(DaemonServer::with_snapshot_storage(
        app_data_dir.path().to_path_buf(),
    ));
    let cancel_token = CancellationToken::new();
    let srv_clone = Arc::clone(&server);
    let cancel_clone = cancel_token.clone();
    let path_clone = socket_path.clone();
    let server_thread = std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("build test daemon tokio runtime");
        rt.block_on(async move {
            let _ = srv_clone.run_listener(&path_clone, cancel_clone).await;
        });
    });
    std::thread::sleep(Duration::from_millis(150));

    let client = DaemonClient::connect(&socket_path).expect("connect post-restart client");
    let attach = client
        .create_or_attach(
            "e2e-update-restart-cold-live",
            80,
            24,
            None,
            None,
            false,
            None,
            None,
        )
        .expect("cold attach failed");

    // Cold boot honestly reports a NEW child with no warm snapshot...
    assert!(
        attach.is_new,
        "no live session exists post-restart: attach must be cold"
    );
    assert!(
        attach.snapshot.is_none(),
        "a fresh child has no warm snapshot to hydrate from"
    );
    // ...relaunched in the checkpointed cwd, carrying last-known agent truth...
    assert_eq!(
        attach.cwd.as_deref(),
        Some(seeded_cwd.as_str()),
        "cold boot must relaunch in the checkpointed cwd"
    );
    assert_eq!(
        attach.agent_status,
        Some(seeded_status),
        "cold boot must carry last-known agent status"
    );
    // ...and invents no resume plan for an idle shell.
    assert!(
        attach.resume.is_none(),
        "an idle checkpoint must not invent a resume plan"
    );
    assert!(attach.resume_declined_reason.is_none());

    client
        .kill("e2e-update-restart-cold-live")
        .expect("kill session failed");
    client.disconnect().expect("disconnect failed");
    cancel_token.cancel();
    let _ = server_thread.join();
}
