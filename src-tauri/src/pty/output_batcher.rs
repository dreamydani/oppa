// Coalesces PTY read chunks into larger Data events: emit at MAX_BATCH_BYTES
// or after the flush window, whichever comes first. Cuts IPC message rate
// under bursty output; byte accounting stays exact (event bytes = sum of
// chunk bytes) and UTF-8 decode runs once per accumulated batch so code
// points split across chunks survive.

use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::pty::utf8_decoder::Utf8ChunkDecoder;
use parking_lot::Mutex;

pub const MAX_BATCH_BYTES: usize = 32 * 1024;
pub const DEFAULT_FLUSH_INTERVAL_MS: u64 = 8;
// Bounded tail drain so a wedged reader can never hang session teardown.
const FINISH_TIMEOUT: Duration = Duration::from_millis(500);

pub enum BatchCommand {
    Chunk(Vec<u8>),
    /// Close the input: flush remaining bytes, signal drained, exit.
    Close,
}

/// Handle shared with the reader thread (chunks in) and the watchdog
/// (bounded tail drain before Exit may be emitted).
#[derive(Clone)]
pub struct OutputDrain {
    inner: Arc<DrainInner>,
}

struct DrainInner {
    tx: Mutex<Option<Sender<BatchCommand>>>,
    drained_rx: Mutex<Option<Receiver<()>>>,
}

impl OutputDrain {
    pub fn send_chunk(&self, bytes: Vec<u8>) {
        if let Some(tx) = self.inner.tx.lock().as_ref() {
            let _ = tx.send(BatchCommand::Chunk(bytes));
        }
    }

    /// Close the input and block until the tail has been emitted (idempotent,
    /// bounded). After this returns, no further Data events will be emitted.
    pub fn finish(&self) {
        self.inner.tx.lock().take();
        let guard = self.inner.drained_rx.lock();
        if let Some(rx) = guard.as_ref() {
            let _ = rx.recv_timeout(FINISH_TIMEOUT);
        }
    }
}

/// Creates the drain handle and hands back the receiver the batcher thread
/// consumes.
pub fn new_drain() -> (OutputDrain, Receiver<BatchCommand>, Sender<()>) {
    let (tx, rx) = channel::<BatchCommand>();
    let (drained_tx, drained_rx) = channel::<()>();
    let drain = OutputDrain {
        inner: Arc::new(DrainInner {
            tx: Mutex::new(Some(tx)),
            drained_rx: Mutex::new(Some(drained_rx)),
        }),
    };
    (drain, rx, drained_tx)
}

/// Batcher thread body. `emit` receives (decoded_text, raw_byte_count).
pub fn run_batcher<F>(
    rx: Receiver<BatchCommand>,
    drained_tx: Sender<()>,
    flush_interval_ms: u64,
    mut emit: F,
) where
    F: FnMut(String, usize),
{
    let interval = Duration::from_millis(flush_interval_ms.max(1));
    // Idle waits wake instantly on Chunk/Close; the long cap only bounds the
    // pathological empty-timeout reschedule path.
    let idle_wait = Duration::from_secs(3600);
    let mut buf: Vec<u8> = Vec::with_capacity(MAX_BATCH_BYTES);
    let mut decoder = Utf8ChunkDecoder::new();
    let mut batch_first_at: Option<Instant> = None;

    loop {
        if buf.len() >= MAX_BATCH_BYTES {
            flush_batch(&mut buf, &mut decoder, &mut batch_first_at, &mut emit);
            continue;
        }
        let timeout = match batch_first_at {
            None => idle_wait,
            Some(start) => {
                let remaining = interval.saturating_sub(start.elapsed());
                if remaining.is_zero() {
                    flush_batch(&mut buf, &mut decoder, &mut batch_first_at, &mut emit);
                    continue;
                }
                remaining
            }
        };
        match rx.recv_timeout(timeout) {
            Ok(BatchCommand::Chunk(bytes)) => {
                if buf.is_empty() {
                    batch_first_at = Some(Instant::now());
                }
                buf.extend_from_slice(&bytes);
                if buf.len() >= MAX_BATCH_BYTES {
                    flush_batch(&mut buf, &mut decoder, &mut batch_first_at, &mut emit);
                }
            }
            Ok(BatchCommand::Close) => {
                flush_batch(&mut buf, &mut decoder, &mut batch_first_at, &mut emit);
                let tail = decoder.flush();
                if !tail.is_empty() {
                    let tail_bytes = tail.len();
                    emit(tail, tail_bytes);
                }
                break;
            }
            Err(RecvTimeoutError::Timeout) => {
                flush_batch(&mut buf, &mut decoder, &mut batch_first_at, &mut emit);
            }
            Err(RecvTimeoutError::Disconnected) => {
                flush_batch(&mut buf, &mut decoder, &mut batch_first_at, &mut emit);
                let tail = decoder.flush();
                if !tail.is_empty() {
                    let tail_bytes = tail.len();
                    emit(tail, tail_bytes);
                }
                break;
            }
        }
    }

    // Tail flushed: release any finish() waiter, then exit (drops rx).
    let _ = drained_tx.send(());
}

fn flush_batch<F: FnMut(String, usize)>(
    buf: &mut Vec<u8>,
    decoder: &mut Utf8ChunkDecoder,
    first_at: &mut Option<Instant>,
    emit: &mut F,
) {
    if buf.is_empty() {
        return;
    }
    let bytes = buf.len();
    let text = decoder.decode(buf);
    emit(text, bytes);
    buf.clear();
    *first_at = None;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn spawn_with(interval_ms: u64) -> (
        OutputDrain,
        mpsc::Receiver<(String, usize)>,
        std::thread::JoinHandle<()>,
    ) {
        let (drain, rx, drained_tx) = new_drain();
        let (event_tx, event_rx) = mpsc::channel();
        let handle = std::thread::spawn(move || {
            run_batcher(rx, drained_tx, interval_ms, move |text, bytes| {
                let _ = event_tx.send((text, bytes));
            });
        });
        (drain, event_rx, handle)
    }

    #[test]
    fn coalesces_rapid_chunks_into_one_event_with_summed_bytes() {
        let (drain, events, handle) = spawn_with(50);
        for i in 0..5 {
            drain.send_chunk(vec![b'a' + i]);
        }
        let first = events
            .recv_timeout(Duration::from_millis(300))
            .expect("expected one batch");
        assert_eq!(first.1, 5);
        assert!(events.try_recv().is_err(), "must be exactly one event");
        let _ = drain.finish();
        let _ = handle.join();
    }

    #[test]
    fn emits_immediately_when_size_threshold_crossed() {
        let (drain, events, handle) = spawn_with(60_000);
        let big = vec![b'x'; MAX_BATCH_BYTES];
        drain.send_chunk(big);
        let first = events
            .recv_timeout(Duration::from_secs(2))
            .expect("threshold flush");
        assert_eq!(first.1, MAX_BATCH_BYTES);
        let _ = drain.finish();
        let _ = handle.join();
    }

    #[test]
    fn emits_partial_batch_after_flush_interval() {
        let (drain, events, handle) = spawn_with(20);
        drain.send_chunk(b"hello".to_vec());
        let first = events
            .recv_timeout(Duration::from_secs(2))
            .expect("interval flush");
        assert_eq!(first.0, "hello");
        assert_eq!(first.1, 5);
        let _ = drain.finish();
        let _ = handle.join();
    }

    #[test]
    fn utf8_codepoint_split_across_chunks_decodes_intact_in_one_event() {
        let (drain, events, handle) = spawn_with(50);
        let rocket = "🚀";
        let bytes = rocket.as_bytes();
        drain.send_chunk(bytes[..2].to_vec());
        drain.send_chunk(bytes[2..].to_vec());
        let first = events
            .recv_timeout(Duration::from_secs(2))
            .expect("batch with emoji");
        assert_eq!(first.0, "🚀");
        assert_eq!(first.1, 4);
        let _ = drain.finish();
        let _ = handle.join();
    }

    #[test]
    fn finish_flushes_tail_before_returning() {
        let (drain, events, handle) = spawn_with(60_000);
        drain.send_chunk(b"tail-bytes".to_vec());
        drain.finish();
        // finish() must not return until the tail event was emitted.
        let first = events
            .recv_timeout(Duration::from_millis(100))
            .expect("tail flushed before finish returned");
        assert_eq!(first.0, "tail-bytes");
        let _ = handle.join();
    }

    #[test]
    fn close_command_flushes_residual_decoder_state() {
        // Residual incomplete sequence at Close time becomes replacement char.
        // The raw bytes are still accounted (first event), then flushed lossily.
        let (drain, events, handle) = spawn_with(60_000);
        let sparkles = "✨";
        let partial = sparkles.as_bytes()[..2].to_vec();
        drain.send_chunk(partial);
        drain.finish();
        let first = events
            .recv_timeout(Duration::from_millis(100))
            .expect("residual flushed");
        assert_eq!(first.0, "");
        assert_eq!(first.1, 2);
        let second = events
            .recv_timeout(Duration::from_millis(100))
            .expect("replacement char event");
        assert_eq!(second.0, "\u{FFFD}");
        // Never-drop accounting: non-empty tail carries its byte count.
        assert!(second.1 > 0);
        let _ = handle.join();
    }

    #[test]
    fn close_tail_emit_carries_real_byte_count() {
        let (drain, rx, drained_tx) = new_drain();
        let (event_tx, event_rx) = std::sync::mpsc::channel();
        let handle = std::thread::spawn(move || {
            run_batcher(rx, drained_tx, 60_000, move |text, bytes| {
                let _ = event_tx.send((text, bytes));
            });
        });
        // "✨" is 3 bytes in UTF-8; send first 2 bytes then close.
        drain.send_chunk(vec![0xE2, 0x9C]);
        drain.finish();
        // First event: decoded "" with 2 bytes accounted.
        let first = event_rx.recv_timeout(std::time::Duration::from_millis(200)).expect("first event");
        assert_eq!(first.1, 2);
        // Second event (replacement char) must carry its own byte length, never 0 with non-empty text.
        let second = event_rx.recv_timeout(std::time::Duration::from_millis(200)).expect("tail event");
        if !second.0.is_empty() {
            assert!(second.1 > 0, "non-empty tail must carry byte count, got {:?}", second);
        }
        let _ = handle.join();
    }

    #[test]
    fn finish_is_idempotent() {
        let (drain, _events, handle) = spawn_with(20);
        drain.send_chunk(b"z".to_vec());
        drain.finish();
        drain.finish();
        let _ = handle.join();
    }
}
