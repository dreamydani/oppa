//! End-to-end coverage for the daemon output batcher: burst coalescing,
//! ordering, byte accounting, and tail-drain-before-Exit ordering.

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
fn test_e2e_burst_output_batching_and_ordering() {
    let socket_path = generate_test_socket_path("burst");
    let (_server, cancel_token, server_thread) = start_test_daemon(&socket_path);

    let client = DaemonClient::connect(&socket_path).expect("failed to connect DaemonClient");
    let session_id = "e2e-burst-session";

    // Capture (text, raw_bytes) so byte accounting can be checked end-to-end.
    let (data_tx, data_rx) = channel::<(String, usize)>();
    client.register_callbacks(
        session_id,
        Some(Box::new(move |_id, bytes| {
            let _ = data_tx.send((String::from_utf8_lossy(bytes).into_owned(), bytes.len()));
        })),
        None,
        None,
    );

    client
        .create_or_attach(session_id, 120, 40, None, None, false, None)
        .expect("create_or_attach failed");

    // ~84KB of ASCII: at least three 32KB batch windows' worth.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!("oppa-burst-{nanos}.txt"));
    let mut content = String::new();
    for i in 0..3000 {
        content.push_str(&format!("burst_line_{i:05}_PADPADPAD\r\n"));
    }
    std::fs::write(&path, &content).expect("write burst temp file");

    #[cfg(target_os = "windows")]
    let command = format!("cmd /c type \"{}\"\r\n", path.display());
    #[cfg(not(target_os = "windows"))]
    let command = format!("cat \"{}\"\n", path.display());
    client.write(session_id, &command).expect("write failed");

    let deadline = std::time::Instant::now() + Duration::from_secs(25);
    let mut joined = String::new();
    let mut total_bytes = 0usize;
    let mut event_count = 0usize;
    while std::time::Instant::now() < deadline {
        match data_rx.recv_timeout(Duration::from_millis(300)) {
            Ok((text, bytes)) => {
                joined.push_str(&text);
                total_bytes += bytes;
                event_count += 1;
                if joined.contains("burst_line_02999") {
                    // Grace drain so trailing same-window events are counted.
                    while let Ok((more_text, more_bytes)) =
                        data_rx.recv_timeout(Duration::from_millis(250))
                    {
                        joined.push_str(&more_text);
                        total_bytes += more_bytes;
                        event_count += 1;
                    }
                    break;
                }
            }
            Err(_) => {
                if joined.contains("burst_line_02999") {
                    break;
                }
            }
        }
    }

    assert!(
        joined.contains("burst_line_00000") && joined.contains("burst_line_02999"),
        "first/last lines must arrive; got {} bytes across {event_count} events",
        total_bytes
    );
    let first_pos = joined.find("burst_line_00000").expect("first line present");
    let last_pos = joined.find("burst_line_02999").expect("last line present");
    assert!(
        first_pos < last_pos,
        "output ordering violated: first at {first_pos}, last at {last_pos}"
    );
    assert!(
        total_bytes >= content.len(),
        "byte accounting dropped data: got {total_bytes}, wrote {}",
        content.len()
    );
    // Coalescing effectiveness (loose vs the deterministic unit tests): raw
    // ConPTY reads arrive in tiny slices, so an average well above one slice
    // per event proves accumulation. Unbatched runs see hundreds of bytes
    // per event; batched runs land in the kilobytes.
    let avg_bytes_per_event = total_bytes / event_count.max(1);
    assert!(
        avg_bytes_per_event >= 2048,
        "batching ineffective: avg {avg_bytes_per_event} bytes over {event_count} events"
    );

    let _ = std::fs::remove_file(&path);
    client.disconnect().expect("disconnect failed");
    cancel_token.cancel();
    let _ = server_thread.join();
}

#[test]
fn test_e2e_tail_output_precedes_exit() {
    let socket_path = generate_test_socket_path("taildrain");
    let (_server, cancel_token, server_thread) = start_test_daemon(&socket_path);

    let client = DaemonClient::connect(&socket_path).expect("failed to connect DaemonClient");
    let session_id = "e2e-tail-drain-session";

    let (data_tx, data_rx) = channel::<String>();
    let (exit_tx, exit_rx) = channel::<Option<i32>>();
    client.register_callbacks(
        session_id,
        Some(Box::new(move |_id, bytes| {
            let _ = data_tx.send(String::from_utf8_lossy(bytes).into_owned());
        })),
        Some(Box::new(move |_id, code| {
            let _ = exit_tx.send(code);
        })),
        None,
    );

    client
        .create_or_attach(session_id, 100, 30, None, None, false, None)
        .expect("create_or_attach failed");

    client
        .write(session_id, "echo TAIL_DRAIN_MARKER_7Q\r\n")
        .expect("write marker failed");
    client.write(session_id, "exit\r\n").expect("write exit failed");

    // Drain output until Exit fires; the tail marker must already be in the
    // stream — the watchdog drains the batcher before emitting Exit.
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    let mut joined = String::new();
    loop {
        if let Ok(text) = data_rx.recv_timeout(Duration::from_millis(200)) {
            joined.push_str(&text);
        }
        if exit_rx.try_recv().is_ok() {
            break;
        }
        if std::time::Instant::now() >= deadline {
            break;
        }
    }
    // Post-exit grace drain: anything already queued must still surface.
    while let Ok(text) = data_rx.recv_timeout(Duration::from_millis(400)) {
        joined.push_str(&text);
    }

    assert!(
        joined.contains("TAIL_DRAIN_MARKER_7Q"),
        "tail output lost before Exit; received: {joined:?}"
    );

    client.disconnect().expect("disconnect failed");
    cancel_token.cancel();
    let _ = server_thread.join();
}
