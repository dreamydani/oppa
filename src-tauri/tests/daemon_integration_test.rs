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

fn start_test_daemon(socket_path: &str) -> (Arc<DaemonServer>, CancellationToken, std::thread::JoinHandle<()>) {
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
        .create_or_attach(session_id, 80, 24, None, None, None)
        .expect("create_or_attach failed");

    assert!(attach_res.is_new, "expected new session to have is_new = true");
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
        .create_or_attach(session_id, 80, 24, None, None, None)
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
        .create_or_attach(session_id, 80, 24, None, None, None)
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
        .create_or_attach(session_id, 80, 24, None, None, None)
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
fn test_e2e_daemon_persona_and_cwd_env_injection() {
    let socket_path = generate_test_socket_path("persona_env");
    let (_server, cancel_token, server_thread) = start_test_daemon(&socket_path);

    let client = DaemonClient::connect(&socket_path).expect("connect client failed");
    let session_id = "e2e-persona-session";
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
            Some("engineer".into()),
        )
        .expect("create_or_attach with persona failed");
    assert!(attach_res.is_new);

    #[cfg(target_os = "windows")]
    client
        .write(session_id, "Write-Output \"p=$env:OPPA_PERSONA c=$env:OPPA_WORKSPACE_CWD\"\r\n")
        .expect("write failed");

    #[cfg(not(target_os = "windows"))]
    client
        .write(session_id, "echo p=$OPPA_PERSONA c=$OPPA_WORKSPACE_CWD\n")
        .expect("write failed");

    let deadline = std::time::Instant::now() + Duration::from_secs(6);
    let mut output = String::new();
    while std::time::Instant::now() < deadline {
        if let Ok(chunk) = data_rx.recv_timeout(Duration::from_millis(200)) {
            output.push_str(&chunk);
            if output.contains("p=engineer") {
                break;
            }
        }
    }

    assert!(
        output.contains("p=engineer"),
        "expected output to contain 'p=engineer', got: {output}"
    );
    assert!(
        output.contains("c=test_ws_cwd"),
        "expected output to contain 'c=test_ws_cwd', got: {output}"
    );

    client.kill(session_id).expect("kill failed");
    client.disconnect().expect("disconnect failed");
    cancel_token.cancel();
    let _ = server_thread.join();
}
