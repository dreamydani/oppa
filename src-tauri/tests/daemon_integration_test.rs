use oppa_lib::pty::daemon_client::DaemonClient;
use oppa_lib::pty::daemon_server::{CancellationToken, DaemonServer};
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
        .create_or_attach(session_id, 80, 24, None, None, false, None)
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
        .create_or_attach(session_id, 80, 24, None, None, false, None)
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
        .create_or_attach(session_id, 80, 24, None, None, false, None)
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
        .create_or_attach(session_id, 80, 24, None, None, false, None)
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
        .create_or_attach(session_id, 80, 24, None, None, false, None)
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
        .create_or_attach(session_id, 80, 24, None, None, false, None)
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
