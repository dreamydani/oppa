use oppa_lib::cli::{CliError, RuntimeConnection};
use oppa_lib::pty::daemon_server::{CancellationToken, DaemonServer};
use oppa_lib::pty::runtime_metadata;
use std::sync::Arc;
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
