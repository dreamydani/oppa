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
    render_worktree_list, render_worktree_show, CliRepoRecord, CliWorktreeListEntry,
    CliWorktreePsEntry, CliWorktreeRecord,
};
use super::vocabulary::{normalize_verb, validate_verb, CANONICAL_COMMANDS};
use super::{
    build_worktree_create, build_worktree_set, decode_ps_entries, decode_repo_records,
    decode_ok, decode_worktree_list, decode_worktree_many, decode_worktree_one,
    filter_active_only, parse_status, CreateArgs, ParentUpdate,
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
        } => {
            assert_eq!(repo_path, "/r");
            assert_eq!(name.as_deref(), Some("n"));
            assert_eq!(branch.as_deref(), Some("b"));
            assert_eq!(base_ref.as_deref(), Some("main"));
            assert_eq!(parent_worktree_id.as_deref(), Some("p"));
            assert_eq!(workspace_dir.as_deref(), Some("/w"));
            assert_eq!(nest_workspaces, Some(true));
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
