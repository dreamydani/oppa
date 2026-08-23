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
