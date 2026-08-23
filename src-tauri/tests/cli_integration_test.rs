use oppa_lib::cli::output::{render_json, render_lineage_tree, render_worktree_list};
use oppa_lib::cli::{
    build_repo_add, build_worktree_create, build_worktree_set, decode_ok, decode_ps_entries,
    decode_repo_records, decode_worktree_list, decode_worktree_many, decode_worktree_one,
    filter_active_only, CreateArgs, CliError, ParentUpdate, RuntimeConnection,
};
use oppa_lib::git::worktree_registry::WorktreeStatus;
use oppa_lib::pty::daemon_server::{CancellationToken, DaemonServer};
use oppa_lib::pty::ipc_protocol::{DaemonRequest, DaemonResponse};
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
