use super::{CliError, RuntimeConnection, StatusReport, DATA_DIR_ENV};
use std::sync::Mutex;
use std::time::Duration;

// Serializes env-var mutation; cargo runs module tests on parallel threads.
static ENV_LOCK: Mutex<()> = Mutex::new(());

#[test]
fn cli_error_display_is_human_single_line() {
    let unavailable = CliError::RuntimeUnavailable("Start the Oppa app first.".into());
    assert_eq!(unavailable.to_string(), "Start the Oppa app first.");
    assert_eq!(CliError::Unauthorized.to_string(), "daemon rejected the client auth token");
    assert_eq!(CliError::Timeout.to_string(), "timed out talking to the oppa daemon");
    assert_eq!(
        CliError::Protocol("bad hello".into()).to_string(),
        "protocol error: bad hello"
    );
    assert_eq!(
        CliError::Io("pipe broke".into()).to_string(),
        "io error: pipe broke"
    );

    let rendered = format!("{} {}", unavailable, CliError::Unauthorized);
    assert!(!rendered.contains('\n'), "display must stay single-line");
}

#[test]
fn cli_error_exit_codes_are_one_for_m1() {
    // 75 stays reserved for EX_TEMPFAIL in a later milestone.
    for err in [
        CliError::RuntimeUnavailable("x".into()),
        CliError::Unauthorized,
        CliError::Timeout,
        CliError::Protocol("p".into()),
        CliError::Io("i".into()),
    ] {
        assert_eq!(err.exit_code(), 1, "{err:?} must exit 1 in M1");
    }
}

#[test]
fn data_dir_resolution_prefers_oppa_data_dir_env() {
    let _guard = ENV_LOCK.lock().unwrap();
    std::env::set_var(DATA_DIR_ENV, r"C:\oppa-test-data-dir");
    let resolved = super::resolve_data_dir();
    std::env::remove_var(DATA_DIR_ENV);
    assert_eq!(resolved, Some(std::path::PathBuf::from(r"C:\oppa-test-data-dir")));
}

#[test]
fn data_dir_resolution_falls_back_to_app_data_dir() {
    let _guard = ENV_LOCK.lock().unwrap();
    std::env::remove_var(DATA_DIR_ENV);
    let resolved = super::resolve_data_dir();
    std::env::remove_var(DATA_DIR_ENV);
    let expected = crate::pty::snapshot::resolve_app_data_dir();
    assert_eq!(resolved, expected);
    assert!(resolved.is_some(), "dirs::data_dir must resolve on CI/dev machines");
}

#[test]
fn status_report_fails_runtime_unavailable_when_metadata_missing() {
    let dir = std::env::temp_dir().join(format!("oppa-cli-missing-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let result = RuntimeConnection::status_report_in(Some(dir), Duration::from_secs(2));
    match result {
        Err(CliError::RuntimeUnavailable(msg)) => {
            assert!(msg.contains("Start the Oppa app"), "got: {msg}");
        }
        other => panic!("expected RuntimeUnavailable, got {other:?}"),
    }
}

#[test]
fn status_report_type_shape_roundtrips_json() {
    let report = StatusReport {
        protocol_version: 3,
        sessions: vec!["s1".into()],
    };
    let json = serde_json::to_value(&report).unwrap();
    assert_eq!(json["protocol_version"], serde_json::json!(3));
    assert_eq!(json["sessions"], serde_json::json!(["s1"]));
}

// ---- task 8: vocabulary policy, output renderers, arg->request/response mapping ----

use super::output::{
    render_json, render_lineage_tree, render_ps_rows, render_repo_detail, render_repo_table,
    render_screen_text, render_session_detail, render_session_list, render_wait_result,
    render_worktree_list, render_worktree_show, CliRenameResult, CliRepoRecord,
    CliWorktreeListEntry, CliWorktreePsEntry, CliWorktreeRecord,
};
use super::vocabulary::{normalize_verb, validate_verb, CANONICAL_COMMANDS};
use super::{
    build_terminal_create, build_terminal_send, build_worktree_create, build_worktree_set,
    decode_attached, decode_agent_handoff, decode_ok, decode_ps_entries, decode_read_screen,
    decode_repo_records, decode_session_ids, decode_wait_result, decode_worktree_list,
    decode_worktree_many, decode_worktree_one, filter_active_only, new_session_handle,
    parse_status, parse_wait_condition, validate_create_handoff, CreateArgs, ParentUpdate,
    WAIT_GRACE_MS,
};
use crate::git::worktree_registry::{RepoRecord, WorktreeRecord, WorktreeStatus};
use crate::git::worktrees::WorktreeListEntry;
use crate::pty::ipc_protocol::{DaemonRequest, DaemonResponse, WorktreePsEntry};
use std::path::PathBuf;

fn cli_repo(repo_id: &str) -> CliRepoRecord {
    CliRepoRecord {
        repo_id: repo_id.into(),
        path: "/tmp/sample-repo".into(),
        default_base_ref: Some("main".into()),
        worktree_base_path: None,
    }
}

fn cli_wt(id: &str, name: &str) -> CliWorktreeRecord {
    CliWorktreeRecord {
        id: id.into(),
        repo_id: "sample".into(),
        name: name.into(),
        display_name: None,
        branch: format!("br-{name}"),
        path: format!("C:/ws/{name}"),
        base_ref: "main".into(),
        parent_worktree_id: None,
        child_worktree_ids: Vec::new(),
        status: "todo".into(),
        retired: false,
        created_at_ms: 1723900000000,
        linked_pr_url: None,
    }
}

fn internal_repo() -> RepoRecord {
    RepoRecord {
        repo_id: "sample".into(),
        path: PathBuf::from("/tmp/sample-repo"),
        default_base_ref: Some("main".into()),
        worktree_base_path: None,
    }
}

fn internal_wt(status: WorktreeStatus) -> WorktreeRecord {
    WorktreeRecord {
        id: "sample::C:/ws/feat-a".into(),
        repo_id: "sample".into(),
        name: "feat-a".into(),
        display_name: None,
        branch: "feat-a".into(),
        path: PathBuf::from("C:\\ws\\feat-a"),
        base_ref: "main".into(),
        parent_worktree_id: None,
        child_worktree_ids: Vec::new(),
        workspace_status: status,
        retired: false,
        created_at_ms: 1723900000000,
        linked_pr_url: None,
    }
}

#[test]
fn vocabulary_accepts_canonical_verbs_and_rejects_the_rest() {
    assert_eq!(validate_verb("repo", "add"), Ok(()));
    assert_eq!(validate_verb("repo", "list"), Ok(()));
    assert_eq!(validate_verb("repo", "show"), Ok(()));
    assert_eq!(validate_verb("worktree", "rm"), Ok(()));
    assert_eq!(validate_verb("worktree", "ps"), Ok(()));
    assert_eq!(validate_verb("worktree", "lineage"), Ok(()));

    let destructive_alias = validate_verb("worktree", "delete");
    assert!(destructive_alias.is_err());
    assert!(destructive_alias.unwrap_err().contains("'rm'"));

    let get_attempt = validate_verb("repo", "get");
    assert!(get_attempt.is_err());
    assert!(get_attempt.unwrap_err().contains("'show'"));

    assert!(validate_verb("browser", "open").is_err());
    assert!(validate_verb("storage", "get").is_err());
    assert!(validate_verb("repo", "frobnicate").is_err());
    assert!(validate_verb("status", "").is_err());
}

#[test]
fn vocabulary_normalize_maps_destructive_aliases_to_rm() {
    assert_eq!(normalize_verb("delete"), "rm");
    assert_eq!(normalize_verb("remove"), "rm");
    assert_eq!(normalize_verb("rm"), "rm");
    assert_eq!(normalize_verb("list"), "list");
    assert_eq!(normalize_verb("show"), "show");
}

#[test]
fn canonical_commands_table_covers_shipped_surface() {
    let families: Vec<&str> = CANONICAL_COMMANDS.iter().map(|(f, _)| *f).collect();
    for expected in ["status", "open", "agent-context", "repo", "worktree"] {
        assert!(families.contains(&expected), "missing family: {expected}");
    }
    let repo_verbs = CANONICAL_COMMANDS
        .iter()
        .find(|(f, _)| *f == "repo")
        .unwrap()
        .1;
    assert_eq!(repo_verbs, &["add", "list", "show"][..]);
    let wt_verbs = CANONICAL_COMMANDS
        .iter()
        .find(|(f, _)| *f == "worktree")
        .unwrap()
        .1;
    assert_eq!(
        wt_verbs,
        &[
            "list", "show", "current", "create", "set", "rm", "purge", "ps", "lineage"
        ][..]
    );
}

#[test]
fn repo_table_render_is_aligned_and_stable() {
    let second = CliRepoRecord {
        repo_id: "oppa".into(),
        path: "/long/path/repo".into(),
        default_base_ref: None,
        worktree_base_path: None,
    };
    let rendered = render_repo_table(&[cli_repo("sample"), second]);
    assert_eq!(
        rendered,
        "REPO    PATH              BASE\n\
         sample  /tmp/sample-repo  main\n\
         oppa    /long/path/repo   -"
    );
    assert_eq!(render_repo_table(&[]), "no repos registered");
}

#[test]
fn repo_detail_block_is_stable() {
    assert_eq!(
        render_repo_detail(&cli_repo("sample")),
        "repo: sample\npath: /tmp/sample-repo\nbase: main"
    );
    let mut with_ws_base = cli_repo("sample");
    with_ws_base.worktree_base_path = Some("/ws".into());
    let rendered = render_repo_detail(&with_ws_base);
    assert!(rendered.ends_with("\nworktree-base: /ws"), "got: {rendered}");
}

#[test]
fn worktree_list_columns_are_aligned_with_flags() {
    let alpha = CliWorktreeListEntry {
        record: cli_wt("sample::C:/ws/alpha", "alpha"),
        missing_on_disk: true,
    };
    let mut gone = cli_wt("sample::C:/ws/gone", "gone");
    gone.retired = true;
    gone.status = "completed".into();
    let tombstone = CliWorktreeListEntry {
        record: gone,
        missing_on_disk: false,
    };

    let rendered = render_worktree_list(&[alpha, tombstone]);
    assert_eq!(
        rendered,
        "ID      NAME   BRANCH    STATUS     LIVE  MISSING\n\
         sample  alpha  br-alpha  todo       yes   yes\n\
         sample  gone   br-gone   completed  -     -"
    );
    assert_eq!(render_worktree_list(&[]), "no worktrees");
}

#[test]
fn worktree_show_block_is_stable_and_hides_absent_fields() {
    let mut full = cli_wt("sample::C:/ws/feat-a", "feat-a");
    full.display_name = Some("Feat A".into());
    full.linked_pr_url = Some("https://example.com/pr/1".into());
    full.created_at_ms = 0;
    assert_eq!(
        render_worktree_show(&full),
        "id:       sample::C:/ws/feat-a\n\
         repo:     sample\n\
         name:     feat-a\n\
         display:  Feat A\n\
         branch:   br-feat-a\n\
         status:   todo\n\
         path:     C:/ws/feat-a\n\
         base:     main\n\
         parent:   -\n\
         children: -\n\
         retired:  no\n\
         created:  1970-01-01T00:00:00Z\n\
         pr:       https://example.com/pr/1"
    );

    let mut minimal = cli_wt("x", "y");
    minimal.created_at_ms = 0;
    let rendered = render_worktree_show(&minimal);
    assert!(!rendered.contains("display:"), "got: {rendered}");
    assert!(!rendered.contains("pr:"), "got: {rendered}");
    assert!(rendered.contains("parent:   -"), "got: {rendered}");
}

#[test]
fn ps_rows_use_placeholder_counters_in_m1() {
    let mut first = cli_wt("a", "feat-a");
    first.branch = "feat-a".into();
    let mut second = cli_wt("b", "two");
    second.branch = "two".into();
    let entries = vec![
        CliWorktreePsEntry {
            record: first,
            live_sessions: 2,
        },
        CliWorktreePsEntry {
            record: second,
            live_sessions: 0,
        },
    ];
    assert_eq!(
        render_ps_rows(&entries),
        "feat-a feat-a pty:2 unread-skipped:- last-screen-skipped:-\n\
         two two pty:0 unread-skipped:- last-screen-skipped:-"
    );
    assert_eq!(render_ps_rows(&[]), "no worktrees");
}

#[test]
fn lineage_tree_indents_by_depth_and_marks_retired() {
    let mut root = cli_wt("r", "root");
    root.branch = "main".into();
    let mut mid = cli_wt("m", "mid");
    mid.branch = "m".into();
    mid.parent_worktree_id = Some("r".into());
    let mut leaf = cli_wt("lf", "leaf");
    leaf.branch = "l".into();
    leaf.parent_worktree_id = Some("m".into());
    leaf.retired = true;
    assert_eq!(
        render_lineage_tree(&[root, mid, leaf]),
        "root (main)\n  mid (m)\n    leaf (l) [retired]"
    );
}

#[test]
fn json_rendering_is_compact_single_line() {
    let rendered = render_json(&serde_json::json!({"a": 1, "b": [2, 3]}));
    assert_eq!(rendered, r#"{"a":1,"b":[2,3]}"#);
    assert!(!rendered.contains('\n'));
}

#[test]
fn status_parsing_maps_wire_values_and_lists_valid_on_error() {
    assert_eq!(parse_status("todo"), Ok(WorktreeStatus::Todo));
    assert_eq!(parse_status("in-progress"), Ok(WorktreeStatus::InProgress));
    assert_eq!(parse_status("in-review"), Ok(WorktreeStatus::InReview));
    assert_eq!(parse_status("completed"), Ok(WorktreeStatus::Completed));
    let err = parse_status("shipped").unwrap_err();
    for expected in ["todo", "in-progress", "in-review", "completed"] {
        assert!(err.to_string().contains(expected), "error must list {expected}: {err}");
    }
}

#[test]
fn worktree_set_builder_encodes_parent_tri_state() {
    match build_worktree_set(
        "w1",
        Some(WorktreeStatus::InProgress),
        Some("N"),
        ParentUpdate::Set("p".into()),
    ) {
        DaemonRequest::WorktreeSet {
            id,
            set_parent,
            parent_worktree_id,
            workspace_status,
            display_name,
        } => {
            assert_eq!(id, "w1");
            assert!(set_parent);
            assert_eq!(parent_worktree_id.as_deref(), Some("p"));
            assert_eq!(workspace_status, Some(WorktreeStatus::InProgress));
            assert_eq!(display_name.as_deref(), Some("N"));
        }
        other => panic!("expected WorktreeSet, got {other:?}"),
    }

    match build_worktree_set("w1", None, None, ParentUpdate::Untouched) {
        DaemonRequest::WorktreeSet { set_parent, .. } => assert!(!set_parent),
        other => panic!("expected WorktreeSet, got {other:?}"),
    }

    match build_worktree_set("w1", None, None, ParentUpdate::Clear) {
        DaemonRequest::WorktreeSet {
            set_parent,
            parent_worktree_id,
            ..
        } => {
            assert!(set_parent);
            assert_eq!(parent_worktree_id, None);
        }
        other => panic!("expected WorktreeSet, got {other:?}"),
    }
}

#[test]
fn worktree_create_builder_maps_every_flag() {
    let full = build_worktree_create(CreateArgs {
        repo_path: "/r",
        name: "n",
        branch: Some("b"),
        base_ref: Some("main"),
        parent_worktree_id: Some("p"),
        workspace_dir: Some("/w"),
        nest_workspaces: true,
        agent: Some("claude"),
        prompt: Some("fix it"),
        command: None,
    });
    match full {
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
        } => {
            assert_eq!(repo_path, "/r");
            assert_eq!(name.as_deref(), Some("n"));
            assert_eq!(branch.as_deref(), Some("b"));
            assert_eq!(base_ref.as_deref(), Some("main"));
            assert_eq!(parent_worktree_id.as_deref(), Some("p"));
            assert_eq!(workspace_dir.as_deref(), Some("/w"));
            assert_eq!(nest_workspaces, Some(true));
            assert_eq!(agent.as_deref(), Some("claude"));
            assert_eq!(prompt.as_deref(), Some("fix it"));
            assert_eq!(command, None);
        }
        other => panic!("expected WorktreeCreate, got {other:?}"),
    }

    let defaults = build_worktree_create(CreateArgs {
        repo_path: "/r",
        name: "n",
        branch: None,
        base_ref: None,
        parent_worktree_id: None,
        workspace_dir: None,
        nest_workspaces: false,
        agent: None,
        prompt: None,
        command: None,
    });
    match defaults {
        DaemonRequest::WorktreeCreate {
            branch,
            base_ref,
            parent_worktree_id,
            workspace_dir,
            nest_workspaces,
            ..
        } => {
            assert_eq!(branch, None);
            assert_eq!(base_ref, None);
            assert_eq!(parent_worktree_id, None);
            assert_eq!(workspace_dir, None);
            assert_eq!(nest_workspaces, Some(false));
        }
        other => panic!("expected WorktreeCreate, got {other:?}"),
    }
}

#[test]
fn create_handoff_flags_enforce_mutual_exclusion_and_target_requirement() {
    assert_eq!(validate_create_handoff(Some("claude"), Some("p"), None), Ok(()));
    assert_eq!(validate_create_handoff(None, Some("p"), Some("x")), Ok(()));
    assert_eq!(validate_create_handoff(Some("claude"), None, None), Ok(()));
    assert_eq!(validate_create_handoff(None, None, None), Ok(()));

    match validate_create_handoff(Some("claude"), None, Some("x")) {
        Err(CliError::Usage(msg)) => assert!(msg.contains("mutually exclusive"), "{msg}"),
        other => panic!("agent+command must be Usage error, got {other:?}"),
    }
    match validate_create_handoff(None, Some("p"), None) {
        Err(CliError::Usage(msg)) => assert!(msg.contains("--agent or --command"), "{msg}"),
        other => panic!("prompt without target must be Usage error, got {other:?}"),
    }
}

#[test]
fn agent_handoff_decoder_flattens_record_with_session_id() {
    let handoff =
        decode_agent_handoff(DaemonResponse::AgentHandoff {
            record: internal_wt(WorktreeStatus::Todo),
            session_id: "agent-abc".into(),
        })
        .unwrap();
    assert_eq!(handoff.session_id, "agent-abc");
    assert_eq!(handoff.record.id, "sample::C:/ws/feat-a");

    let json = render_json(&handoff);
    let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed["session_id"], "agent-abc");
    assert_eq!(parsed["name"], "feat-a", "record payload stays top-level");

    match decode_agent_handoff(DaemonResponse::Error("boom".into())) {
        Err(CliError::Daemon(msg)) => assert_eq!(msg, "boom"),
        other => panic!("expected Daemon error, got {other:?}"),
    }
    match decode_agent_handoff(DaemonResponse::Ok) {
        Err(CliError::Protocol(msg)) => assert!(msg.contains("unexpected agent handoff"), "{msg}"),
        other => panic!("expected Protocol error, got {other:?}"),
    }
}

#[test]
fn decoders_map_daemon_payloads_into_cli_dtos() {
    let repos = decode_repo_records(DaemonResponse::RepoRecords(vec![internal_repo()])).unwrap();
    assert_eq!(repos[0].repo_id, "sample");
    assert_eq!(repos[0].path, "/tmp/sample-repo");

    let mut wt = internal_wt(WorktreeStatus::InProgress);
    wt.child_worktree_ids = vec!["kid".into()];
    let one = decode_worktree_one(DaemonResponse::WorktreeRecordOne(Some(wt)))
        .unwrap()
        .unwrap();
    assert_eq!(one.status, "in-progress");
    assert_eq!(one.child_worktree_ids, vec!["kid".to_string()]);
    assert!(
        decode_worktree_one(DaemonResponse::WorktreeRecordOne(None))
            .unwrap()
            .is_none()
    );

    let entries = decode_worktree_list(DaemonResponse::WorktreeRecords(vec![WorktreeListEntry {
        record: internal_wt(WorktreeStatus::Todo),
        missing_on_disk: true,
    }]))
    .unwrap();
    assert_eq!(entries[0].record.status, "todo");
    assert!(entries[0].missing_on_disk);

    let ps = decode_ps_entries(DaemonResponse::WorktreePsEntries(vec![WorktreePsEntry {
        record: internal_wt(WorktreeStatus::Todo),
        live_sessions: 3,
    }]))
    .unwrap();
    assert_eq!(ps[0].live_sessions, 3);

    let many = decode_worktree_many(DaemonResponse::WorktreeRecordsList(vec![internal_wt(
        WorktreeStatus::Todo,
    )]))
    .unwrap();
    assert_eq!(many.len(), 1);

    decode_ok(DaemonResponse::Ok).unwrap();
}

#[test]
fn decoders_map_daemon_errors_and_wrong_variants() {
    match decode_ok(DaemonResponse::Error("boom".into())) {
        Err(CliError::Daemon(msg)) => assert_eq!(msg, "boom"),
        other => panic!("expected Daemon error, got {other:?}"),
    }
    match decode_repo_records(DaemonResponse::Ok) {
        Err(CliError::Protocol(msg)) => assert!(msg.contains("unexpected repo"), "{msg}"),
        other => panic!("expected Protocol error, got {other:?}"),
    }
}

#[test]
fn filter_active_only_drops_retired_tombstones() {
    let mut gone = cli_wt("g", "gone");
    gone.retired = true;
    let entries = vec![
        CliWorktreeListEntry {
            record: cli_wt("a", "alpha"),
            missing_on_disk: false,
        },
        CliWorktreeListEntry {
            record: gone,
            missing_on_disk: false,
        },
    ];
    let active = filter_active_only(entries);
    assert_eq!(active.len(), 1);
    assert_eq!(active[0].record.name, "alpha");
}

// ---- task 9: terminal verb builders, decoders, renderers ----

use super::output::{CliScreenText, CliSessionDetail, CliSplitHandles, CliWaitResult};
use crate::pty::ipc_protocol::{CreateOrAttachResult, WaitCondition};

#[test]
fn vocabulary_covers_terminal_family() {
    let terminal = CANONICAL_COMMANDS
        .iter()
        .find(|(f, _)| *f == "terminal")
        .expect("terminal family registered")
        .1;
    assert_eq!(
        terminal,
        &[
            "list", "show", "read", "send", "wait", "create", "close", "switch", "rename",
            "split"
        ][..]
    );
    for verb in terminal {
        assert_eq!(validate_verb("terminal", verb), Ok(()));
    }
    assert!(validate_verb("terminal", "kill").is_err());
}

#[test]
fn wait_condition_parsing_maps_cli_words_and_lists_valid_on_error() {
    assert_eq!(parse_wait_condition("exit"), Ok(WaitCondition::Exit));
    assert_eq!(parse_wait_condition("tui-idle"), Ok(WaitCondition::TuiIdle));
    let err = parse_wait_condition("forever").unwrap_err();
    for expected in ["exit", "tui-idle"] {
        assert!(err.to_string().contains(expected), "error must list {expected}: {err}");
    }
}

#[test]
fn terminal_send_builder_encodes_interrupt_prefix_and_enter_suffix() {
    match build_terminal_send("s1", "echo hi", true, false) {
        DaemonRequest::Write { session_id, data } => {
            assert_eq!(session_id, "s1");
            assert_eq!(data, "echo hi\r");
        }
        other => panic!("expected Write, got {other:?}"),
    }

    match build_terminal_send("s1", "echo hi", false, true) {
        DaemonRequest::Write { data, .. } => {
            assert!(data.starts_with('\x03'), "interrupt must precede text: {data:?}");
            assert!(!data.ends_with('\r'));
        }
        other => panic!("expected Write, got {other:?}"),
    }

    match build_terminal_send("s1", "q", true, true) {
        DaemonRequest::Write { data, .. } => assert_eq!(data, "\x03q\r"),
        other => panic!("expected Write, got {other:?}"),
    }

    match build_terminal_send("s1", "ls", false, false) {
        DaemonRequest::Write { data, .. } => assert_eq!(data, "ls"),
        other => panic!("expected Write, got {other:?}"),
    }
}

#[test]
fn terminal_create_builder_defaults_size_and_maps_flags() {
    match build_terminal_create("abc", Some("/tmp/ws"), Some("wt-1")) {
        DaemonRequest::CreateOrAttach {
            session_id,
            cols,
            rows,
            cwd,
            shell,
            resume_agents,
            worktree_id,
            extra_env,
            initial_command,
        } => {
            assert_eq!(session_id, "abc");
            assert_eq!((cols, rows), (80, 24));
            assert_eq!(cwd.as_deref(), Some("/tmp/ws"));
            assert_eq!(shell, None);
            assert!(!resume_agents);
            assert_eq!(worktree_id.as_deref(), Some("wt-1"));
            assert!(extra_env.is_empty());
            assert_eq!(initial_command, None);
        }
        other => panic!("expected CreateOrAttach, got {other:?}"),
    }

    match build_terminal_create("abc", None, None) {
        DaemonRequest::CreateOrAttach { cwd, worktree_id, .. } => {
            assert_eq!(cwd, None);
            assert_eq!(worktree_id, None);
        }
        other => panic!("expected CreateOrAttach, got {other:?}"),
    }
}

#[test]
fn new_session_handle_is_prefixed_and_unique() {
    let a = new_session_handle();
    let b = new_session_handle();
    assert!(a.starts_with("cli-"));
    assert_ne!(a, b, "generated handles must be unique");
}

#[test]
fn terminal_decoders_map_payloads_errors_and_wrong_variants() {
    let ids =
        decode_session_ids(DaemonResponse::SessionList(vec!["a".into(), "b".into()])).unwrap();
    assert_eq!(ids, vec!["a".to_string(), "b".to_string()]);
    match decode_session_ids(DaemonResponse::Error("session not found".into())) {
        Err(CliError::Daemon(msg)) => assert_eq!(msg, "session not found"),
        other => panic!("expected Daemon error, got {other:?}"),
    }
    match decode_session_ids(DaemonResponse::Ok) {
        Err(CliError::Protocol(msg)) => assert!(msg.contains("unexpected session list"), "{msg}"),
        other => panic!("expected Protocol error, got {other:?}"),
    }

    let screen = decode_read_screen(DaemonResponse::ScreenText {
        text: "hello\nworld".into(),
        truncated: false,
    })
    .unwrap();
    assert_eq!(
        screen,
        CliScreenText {
            text: "hello\nworld".into(),
            truncated: false
        }
    );
    match decode_read_screen(DaemonResponse::Error("session not found".into())) {
        Err(CliError::Daemon(msg)) => assert_eq!(msg, "session not found"),
        other => panic!("expected Daemon error, got {other:?}"),
    }

    let wait = decode_wait_result(DaemonResponse::WaitResult {
        satisfied: true,
        exit_code: Some(7),
        waited_ms: 812,
    })
    .unwrap();
    assert_eq!(
        wait,
        CliWaitResult {
            satisfied: true,
            exit_code: Some(7),
            waited_ms: 812
        }
    );
    match decode_wait_result(DaemonResponse::Ok) {
        Err(CliError::Protocol(msg)) => assert!(msg.contains("unexpected wait"), "{msg}"),
        other => panic!("expected Protocol error, got {other:?}"),
    }

    let attached = decode_attached(DaemonResponse::SessionAttached(sample_attached())).unwrap();
    assert_eq!(attached.pid, 42);
    match decode_attached(DaemonResponse::Ok) {
        Err(CliError::Protocol(msg)) => assert!(msg.contains("unexpected attach"), "{msg}"),
        other => panic!("expected Protocol error, got {other:?}"),
    }
}

fn sample_attached() -> CreateOrAttachResult {
    CreateOrAttachResult {
        is_new: false,
        pid: 42,
        cols: 80,
        rows: 24,
        cwd: Some("C:\\ws".into()),
        snapshot: None,
        resume: None,
        resume_declined_reason: None,
        worktree_id: Some("repo::C:/ws/feat-a".into()),
        working: true,
        agent_status: None,
        title: None,
    }
}

#[test]
fn terminal_renderers_are_stable() {
    assert_eq!(render_session_list(&[]), "no sessions");
    assert_eq!(
        render_session_list(&["a".into(), "b".into()]),
        "a\nb"
    );

    assert_eq!(render_screen_text("hello\r\nworld"), "hello\nworld\n");
    assert_eq!(render_screen_text(""), "\n");

    let detail = CliSessionDetail {
        id: "cli-x".into(),
        pid: 9,
        cols: 120,
        rows: 40,
        cwd: Some("C:\\ws".into()),
        worktree_id: None,
    };
    let rendered = render_session_detail(&detail);
    for expected in ["id:       cli-x", "pid:      9", "size:     120x40", "cwd:      C:\\ws", "worktree: -"] {
        assert!(rendered.contains(expected), "missing '{expected}' in:\n{rendered}");
    }

    assert_eq!(
        render_wait_result(&CliWaitResult { satisfied: true, exit_code: Some(0), waited_ms: 1234 }),
        "satisfied · exit 0 · 1234ms"
    );
    assert_eq!(
        render_wait_result(&CliWaitResult { satisfied: false, exit_code: None, waited_ms: 30000 }),
        "not satisfied · 30000ms"
    );
    assert_eq!(
        render_json(&CliRenameResult { ok: true, title: "build".into() }),
        r#"{"ok":true,"title":"build"}"#
    );
    assert_eq!(
        render_json(&CliSplitHandles { primary: "p".into(), secondary: "s".into() }),
        r#"{"primary":"p","secondary":"s"}"#
    );
}

#[test]
fn wait_grace_gives_keepalives_headroom_over_daemon_deadline() {
    assert_eq!(WAIT_GRACE_MS, 2000);
}

// ---- task 10: agent-context machine-readable command catalog ----

use super::output::render_agent_context;
use super::vocabulary::{agent_context_document, build_catalog};

fn clap_leaf_paths() -> Vec<(String, String)> {
    let root = crate::cli::command_tree::build_root_command();
    let mut paths: Vec<(String, String)> = Vec::new();
    for family_cmd in root.get_subcommands() {
        if family_cmd.has_subcommands() {
            for verb_cmd in family_cmd.get_subcommands() {
                paths.push((
                    family_cmd.get_name().to_string(),
                    verb_cmd.get_name().to_string(),
                ));
            }
        } else {
            paths.push((family_cmd.get_name().to_string(), String::new()));
        }
    }
    paths
}

#[test]
fn agent_context_catalog_matches_clap_tree_and_vocabulary_table() {
    let mut clap_paths = clap_leaf_paths();
    let mut catalog_paths: Vec<(String, String)> =
        build_catalog().into_iter().map(|c| (c.family, c.verb)).collect();
    clap_paths.sort();
    catalog_paths.sort();
    assert_eq!(
        catalog_paths, clap_paths,
        "catalog must list exactly the clap tree's family/verb paths"
    );

    // The parse-level table feeds validate_verb; if it drifts from clap, parsing drifts too.
    let table_pairs: usize = CANONICAL_COMMANDS
        .iter()
        .map(|(_, verbs)| verbs.len().max(1))
        .sum();
    assert_eq!(
        table_pairs,
        clap_paths.len(),
        "CANONICAL_COMMANDS must cover exactly the clap surface"
    );
    for (family, verb) in &clap_paths {
        let (_, verbs) = CANONICAL_COMMANDS
            .iter()
            .find(|(f, _)| f == family)
            .unwrap_or_else(|| panic!("family '{family}' missing from CANONICAL_COMMANDS"));
        if verb.is_empty() {
            assert!(verbs.is_empty(), "family '{family}' must stay verb-less");
        } else {
            assert!(
                verbs.contains(&verb.as_str()),
                "verb '{family} {verb}' missing from CANONICAL_COMMANDS"
            );
        }
    }
}

#[test]
fn agent_context_document_meets_machine_contract() {
    let doc = agent_context_document();
    assert!(doc.commands.len() >= 20, "shipped surface has >= 20 verbs");
    assert_eq!(doc.version, env!("CARGO_PKG_VERSION"));
    assert_eq!(doc.protocol, crate::pty::ipc_protocol::DAEMON_PROTOCOL_VERSION);
    assert!(doc.notes.len() >= 3);

    let line = render_json(&doc);
    assert!(!line.contains('\n'), "json must stay compact single-line");
    let parsed: serde_json::Value = serde_json::from_str(&line).expect("document parses");
    assert_eq!(
        parsed["commands"].as_array().map(Vec::len),
        Some(doc.commands.len())
    );
    assert_eq!(
        parsed["protocol"],
        serde_json::json!(crate::pty::ipc_protocol::DAEMON_PROTOCOL_VERSION)
    );
    let notes = parsed["notes"].as_array().expect("notes array");
    assert!(notes.len() >= 3);
    for topic in ["exit codes", "auth", "vocabulary policy"] {
        assert!(
            notes.iter().any(|n| n.as_str().unwrap_or("").contains(topic)),
            "notes must mention {topic}"
        );
    }

    let send = parsed["commands"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["family"] == "terminal" && c["verb"] == "send")
        .expect("terminal send entry");
    assert_eq!(send["summary"], "Send text to a session's input");
    assert_eq!(
        send["example"],
        r#"oppa terminal send <id> --text "cargo test" --enter"#
    );
    let flag_names: Vec<&str> = send["flags"]
        .as_array()
        .expect("flags array")
        .iter()
        .map(|f| f["name"].as_str().expect("flag name"))
        .collect();
    assert_eq!(
        flag_names,
        ["<id>", "--text", "--enter", "--interrupt", "--json", "--timeout-ms"]
    );
}

#[test]
fn agent_context_human_output_groups_by_family_with_examples_and_notes() {
    let rendered = render_agent_context(&agent_context_document());
    for header in ["STATUS", "OPEN", "AGENT-CONTEXT", "REPO", "WORKTREE", "TERMINAL"] {
        assert!(
            rendered.lines().any(|line| line.trim_end() == header),
            "missing {header} family header:\n{rendered}"
        );
    }
    assert!(
        rendered.contains("usage: oppa worktree create feat-a"),
        "examples render under their verb:\n{rendered}"
    );
    // Worktree verb width is 7, so continuations align 11 columns in.
    assert!(
        rendered.contains("\n           usage: oppa worktree create feat-a"),
        "continuation lines align with the summary column:\n{rendered}"
    );
    assert!(rendered.contains("NOTES"));
    assert!(rendered.contains("destructive verbs are rm"));
}

#[test]
fn agent_context_terminal_send_entry_snapshot_is_stable() {
    let doc = agent_context_document();
    let send = doc
        .commands
        .iter()
        .find(|c| c.family == "terminal" && c.verb == "send")
        .expect("terminal send entry");
    assert_eq!(
        render_json(send),
        r#"{"family":"terminal","verb":"send","summary":"Send text to a session's input","flags":[{"name":"<id>","takes_value":true},{"name":"--text","takes_value":true},{"name":"--enter","takes_value":false},{"name":"--interrupt","takes_value":false,"help":"Prefix a Ctrl-C byte before the text"},{"name":"--json","takes_value":false},{"name":"--timeout-ms","takes_value":true}],"example":"oppa terminal send <id> --text \"cargo test\" --enter"}"#
    );
}

// ---- task 6: git verb builders, decoders, renderers ----

use super::{
    build_git_branches, build_git_checkout, build_git_commit, build_git_compare, build_git_discard,
    build_git_fetch, build_git_ff, build_git_file_diff, build_git_history, build_git_pull,
    build_git_push, build_git_stage, build_git_status, build_git_unstage, decode_sc_branches,
    decode_sc_commit, decode_sc_compare, decode_sc_diff, decode_sc_history, decode_sc_pull,
    decode_sc_push, decode_sc_status,
};
use crate::git::comments_store::{DiffComment, NewDiffComment};
use crate::git::source_control::{
    BranchCompare, CommitStats, DiffContent, DiffKind, HistoryItem, HistoryResult, LocalBranches,
    PullOutcome, PullStatus, PushOutcome, SourceControlStatus, StatusEntry, UpstreamStatus,
};
use super::output::{
    render_sc_branches, render_sc_compare, render_sc_diff, render_sc_history, render_sc_pull,
    render_sc_push, render_sc_status,
};

#[test]
fn vocabulary_covers_git_family() {
    let git = CANONICAL_COMMANDS
        .iter()
        .find(|(f, _)| *f == "git")
        .expect("git family registered")
        .1;
    assert_eq!(
        git,
        &[
            "status", "stage", "unstage", "discard", "commit", "branches", "checkout", "diff",
            "history", "compare", "fetch", "pull", "ff", "push"
        ][..]
    );
    for verb in git {
        assert_eq!(validate_verb("git", verb), Ok(()));
    }
    assert!(validate_verb("git", "rebase").is_err());
}

#[test]
fn git_builders_map_every_verb_and_flag() {
    assert_eq!(
        build_git_status("/r"),
        DaemonRequest::GitStatus { cwd: "/r".into() }
    );
    match build_git_stage("/r", &["a.txt", "b.txt"]) {
        DaemonRequest::GitStage { cwd, paths } => {
            assert_eq!(cwd, "/r");
            assert_eq!(paths, vec!["a.txt".to_string(), "b.txt".to_string()]);
        }
        other => panic!("expected GitStage, got {other:?}"),
    }
    match build_git_unstage("/r", &["a.txt"]) {
        DaemonRequest::GitUnstage { cwd, paths } => {
            assert_eq!(cwd, "/r");
            assert_eq!(paths, vec!["a.txt".to_string()]);
        }
        other => panic!("expected GitUnstage, got {other:?}"),
    }
    match build_git_discard("/r", &["u.txt"], true) {
        DaemonRequest::GitDiscard {
            cwd,
            paths,
            include_untracked,
        } => {
            assert_eq!(cwd, "/r");
            assert_eq!(paths, vec!["u.txt".to_string()]);
            assert!(include_untracked);
        }
        other => panic!("expected GitDiscard, got {other:?}"),
    }
    match build_git_commit("/r", "feat: x") {
        DaemonRequest::GitCommit { cwd, message } => {
            assert_eq!(cwd, "/r");
            assert_eq!(message, "feat: x");
        }
        other => panic!("expected GitCommit, got {other:?}"),
    }
    assert_eq!(
        build_git_branches("/r"),
        DaemonRequest::GitLocalBranches { cwd: "/r".into() }
    );
    match build_git_checkout("/r", "feat-a") {
        DaemonRequest::GitCheckout { cwd, branch } => {
            assert_eq!((cwd.as_str(), branch.as_str()), ("/r", "feat-a"));
        }
        other => panic!("expected GitCheckout, got {other:?}"),
    }
    match build_git_file_diff("/r", "p.txt", true, false) {
        DaemonRequest::GitFileDiff {
            cwd,
            path,
            staged,
            compare_against_head,
        } => {
            assert_eq!(cwd, "/r");
            assert_eq!(path, "p.txt");
            assert!(staged);
            assert!(!compare_against_head);
        }
        other => panic!("expected GitFileDiff, got {other:?}"),
    }
    for (limit_in, limit_out) in [
        (None, None),
        (Some(0), Some(0)),
        (Some(20), Some(20)),
    ] {
        match build_git_history("/r", limit_in) {
            DaemonRequest::GitHistory { cwd, limit } => {
                assert_eq!(cwd, "/r");
                assert_eq!(limit, limit_out);
            }
            other => panic!("expected GitHistory, got {other:?}"),
        }
    }
    match build_git_compare("/r", "main") {
        DaemonRequest::GitBranchCompare { cwd, base_ref } => {
            assert_eq!(cwd, "/r");
            assert_eq!(base_ref, "main");
        }
        other => panic!("expected GitBranchCompare, got {other:?}"),
    }
    assert_eq!(
        build_git_fetch("/r"),
        DaemonRequest::GitFetch { cwd: "/r".into() }
    );
    // pull defaults to ff-only; --merge flips it
    match build_git_pull("/r", false) {
        DaemonRequest::GitPull { ff_only, .. } => assert!(ff_only),
        other => panic!("expected GitPull, got {other:?}"),
    }
    match build_git_pull("/r", true) {
        DaemonRequest::GitPull { ff_only, .. } => assert!(!ff_only),
        other => panic!("expected GitPull merge, got {other:?}"),
    }
    assert_eq!(
        build_git_ff("/r"),
        DaemonRequest::GitFastForward { cwd: "/r".into() }
    );
    match build_git_push("/r", true, true) {
        DaemonRequest::GitPush {
            cwd,
            publish,
            force_with_lease,
        } => {
            assert_eq!(cwd, "/r");
            assert!(publish);
            assert!(force_with_lease);
        }
        other => panic!("expected GitPush, got {other:?}"),
    }
}

fn sample_sc_status() -> SourceControlStatus {
    SourceControlStatus {
        entries: vec![
            StatusEntry {
                path: "staged.rs".into(),
                index_status: "M".into(),
                worktree_status: " ".into(),
                area: crate::git::source_control::GitArea::Staged,
                old_path: None,
            },
            StatusEntry {
                path: "renamed.rs".into(),
                index_status: "R".into(),
                worktree_status: " ".into(),
                area: crate::git::source_control::GitArea::Staged,
                old_path: Some("old.rs".into()),
            },
            StatusEntry {
                path: "dirty.rs".into(),
                index_status: " ".into(),
                worktree_status: "M".into(),
                area: crate::git::source_control::GitArea::Unstaged,
                old_path: None,
            },
            StatusEntry {
                path: "fresh.rs".into(),
                index_status: "?".into(),
                worktree_status: "?".into(),
                area: crate::git::source_control::GitArea::Untracked,
                old_path: None,
            },
        ],
        conflict_state: crate::git::source_control::ConflictState::Merge,
        branch: "main".into(),
        upstream: UpstreamStatus {
            has_upstream: true,
            ahead: 2,
            behind: 1,
            remote_branch: Some("origin/main".into()),
        },
        did_hit_limit: false,
        status_length: 4,
    }
}

#[test]
fn sc_status_renderer_groups_areas_into_sections_with_summary() {
    assert_eq!(
        render_sc_status(&sample_sc_status()),
        [
            "main · staged 2 · unstaged 1 · untracked 1 · conflicts 0 · merging · ↑2 ↓1",
            "STAGED",
            "M  staged.rs",
            "R  renamed.rs <- old.rs",
            "UNSTAGED",
            " M dirty.rs",
            "UNTRACKED",
            "?? fresh.rs",
        ]
        .join("\n")
    );

    let mut detached = sample_sc_status();
    detached.branch = "".into();
    detached.conflict_state = crate::git::source_control::ConflictState::None;
    detached.upstream = UpstreamStatus {
        has_upstream: false,
        ahead: 0,
        behind: 0,
        remote_branch: None,
    };
    detached.entries.clear();
    let rendered = render_sc_status(&detached);
    assert!(
        rendered.starts_with("(detached) · staged 0 · unstaged 0 · untracked 0 · conflicts 0 · no upstream"),
        "{rendered}"
    );
}

#[test]
fn git_payload_decoders_extract_variants_map_errors_and_reject_wrong_variants() {
    let status = decode_sc_status(DaemonResponse::ScStatus(sample_sc_status())).unwrap();
    assert_eq!(status.branch, "main");

    assert_eq!(
        decode_sc_commit(DaemonResponse::ScCommit("abc1234".into())).unwrap(),
        "abc1234"
    );
    let branches = decode_sc_branches(DaemonResponse::ScBranches(LocalBranches {
        branches: vec!["main".into()],
        current: Some("main".into()),
    }))
    .unwrap();
    assert_eq!(branches.current.as_deref(), Some("main"));
    let diff = decode_sc_diff(DaemonResponse::ScDiff(DiffContent {
        kind: DiffKind::Text,
        original_content: "a".into(),
        modified_content: "b".into(),
        truncated: false,
    }))
    .unwrap();
    assert_eq!(diff.kind, DiffKind::Text);
    let history = decode_sc_history(DaemonResponse::ScHistory(HistoryResult {
        items: Vec::new(),
        has_more: false,
    }))
    .unwrap();
    assert!(!history.has_more);
    let compare = decode_sc_compare(DaemonResponse::ScCompare(BranchCompare {
        base_ref: "main".into(),
        ahead: 1,
        behind: 0,
        changed_files: Vec::new(),
    }))
    .unwrap();
    assert_eq!(compare.ahead, 1);
    let pull = decode_sc_pull(DaemonResponse::ScPull(PullOutcome {
        status: PullStatus::Merged,
        new_head: Some("def5678".into()),
    }))
    .unwrap();
    assert_eq!(pull.status, PullStatus::Merged);
    let push = decode_sc_push(DaemonResponse::ScPush(PushOutcome {
        pushed_to: "origin/main".into(),
        was_publish: false,
    }))
    .unwrap();
    assert_eq!(push.pushed_to, "origin/main");

    // Daemon errors pass through bare; wrong variants are protocol errors
    match decode_sc_status(DaemonResponse::Error("not a repo".into())) {
        Err(CliError::Daemon(msg)) => assert_eq!(msg, "not a repo"),
        other => panic!("expected Daemon error, got {other:?}"),
    }
    match decode_sc_commit(DaemonResponse::Ok) {
        Err(CliError::Protocol(msg)) => assert!(msg.contains("unexpected git commit"), "{msg}"),
        other => panic!("expected Protocol error, got {other:?}"),
    }
}

#[test]
fn git_renderers_are_deterministic_single_lines_or_blocks() {
    assert_eq!(
        render_sc_branches(&LocalBranches {
            branches: vec!["main".into(), "feature".into()],
            current: Some("feature".into()),
        }),
        "  main\n* feature"
    );
    assert_eq!(
        render_sc_diff(&DiffContent {
            kind: DiffKind::Binary,
            original_content: String::new(),
            modified_content: String::new(),
            truncated: true,
        }),
        "binary (truncated)"
    );
    assert_eq!(
        render_sc_diff(&DiffContent {
            kind: DiffKind::Text,
            original_content: "v0".into(),
            modified_content: "v1".into(),
            truncated: false,
        }),
        "--- originalv0\n+++ modifiedv1"
    );

    let item = |id: &str, subject: &str| HistoryItem {
        id: id.into(),
        parent_ids: Vec::new(),
        subject: subject.into(),
        message_body: String::new(),
        author_name: "A".into(),
        author_email: "a@x".into(),
        timestamp_secs: 1,
        stats: CommitStats {
            files: 2,
            insertions: 5,
            deletions: 1,
        },
    };
    assert_eq!(
        render_sc_history(&HistoryResult {
            items: vec![item("abcdef1234567890", "first"), item("1234567890abcdef", "second")],
            has_more: true,
        }),
        "abcdef12 first (+5 -1, 2 files)\n12345678 second (+5 -1, 2 files)"
    );
    assert_eq!(
        render_sc_history(&HistoryResult {
            items: Vec::new(),
            has_more: false,
        }),
        "no commits"
    );

    assert_eq!(
        render_sc_compare(&BranchCompare {
            base_ref: "main".into(),
            ahead: 2,
            behind: 3,
            changed_files: vec![crate::git::source_control::CompareEntry {
                path: "moved.txt".into(),
                change_kind: "R".into(),
                old_path: Some("extra.txt".into()),
            }],
        }),
        "ahead 2 · behind 3 vs main\nR moved.txt <- extra.txt"
    );
    assert_eq!(
        render_sc_compare(&BranchCompare {
            base_ref: "main".into(),
            ahead: 0,
            behind: 1,
            changed_files: Vec::new(),
        }),
        "ahead 0 · behind 1 vs main"
    );

    for (outcome, want) in [
        (
            PullOutcome { status: PullStatus::UpToDate, new_head: None },
            "already up to date",
        ),
        (
            PullOutcome { status: PullStatus::FastForward, new_head: Some("aaa".into()) },
            "fast-forwarded to aaa",
        ),
        (
            PullOutcome { status: PullStatus::Merged, new_head: Some("bbb".into()) },
            "merged at bbb",
        ),
    ] {
        assert_eq!(render_sc_pull(&outcome), want);
    }

    assert_eq!(
        render_sc_push(&PushOutcome {
            pushed_to: "origin/feat".into(),
            was_publish: true,
        }),
        "pushed origin/feat · published"
    );
    assert_eq!(
        render_sc_push(&PushOutcome {
            pushed_to: "origin/main".into(),
            was_publish: false,
        }),
        "pushed origin/main"
    );
}

#[test]
fn comment_wire_types_roundtrip_through_serde_for_cli_json() {
    let comment: DiffComment = serde_json::from_value(serde_json::json!({
        "id": "c-1",
        "worktree_id": "wt-1",
        "file_path": "src/lib.rs",
        "source": "markdown",
        "selected_text": null,
        "start_line": null,
        "line_number": 4,
        "body": "note",
        "scope": "branch",
        "old_path": null,
        "created_at_ms": 1723900000000u64,
        "updated_at_ms": null,
        "sent_at": null
    }))
    .unwrap();
    let json = render_json(&comment);
    assert!(json.contains("\"scope\":\"branch\""));
    assert!(json.contains("\"sent_at\":null"));

    let new_comment: NewDiffComment = serde_json::from_value(serde_json::json!({
        "worktree_id": "wt-1",
        "file_path": "src/lib.rs",
        "source": "diff",
        "line_number": 4,
        "body": "note",
        "scope": "staged"
    }))
    .unwrap();
    assert_eq!(new_comment.scope, crate::git::comments_store::DiffCommentScope::Staged);
}
