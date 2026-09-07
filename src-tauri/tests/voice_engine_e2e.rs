// Voice engine end-to-end (Slice 5 acceptance). Gated behind
// `OPPA_VOICE_E2E_MODELS_DIR` pointing at a models dir laid out as
// `<dir>/<model-id>/<files>` (e.g. produced by the Slice 4 downloader), and
// `#[ignore]`d so normal `cargo test` never needs ~1 GB of models or a mic.
// Run: `OPPA_VOICE_E2E_MODELS_DIR=<dir> cargo test -p oppa --test
// voice_engine_e2e -- --ignored --nocapture`.
//
// The fixtureClip: 6.6 s of 16 kHz English speech is embedded? No — audio
// comes from `OPPA_VOICE_E2E_WAV` (16-bit PCM mono WAV, any rate; the loader
// under test only accepts 16 kHz, so use a 16 kHz file).

use oppa_lib::voice::stt_engine::{EngineLoader, SherpaEngineLoader, SttEvent};
use oppa_lib::voice::stt_service::{SttEmitter, SttService};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

fn models_dir() -> PathBuf {
    std::env::var("OPPA_VOICE_E2E_MODELS_DIR")
        .map(PathBuf::from)
        .expect("OPPA_VOICE_E2E_MODELS_DIR must point at downloaded models")
}

fn wav_samples() -> (u32, Vec<f32>) {
    let path =
        std::env::var("OPPA_VOICE_E2E_WAV").expect("OPPA_VOICE_E2E_WAV must point at a 16 kHz WAV");
    let mut reader = hound::WavReader::open(&path).expect("open wav");
    let spec = reader.spec();
    assert_eq!(spec.channels, 1, "mono fixture expected");
    assert_eq!(spec.sample_rate, 16000, "16 kHz fixture expected");
    // hound 1.x reads integer PCM only — fixtures are 16/32-bit int wavs.
    let samples: Vec<f32> = match spec.bits_per_sample {
        16 => reader
            .samples::<i16>()
            .map(|s| s.expect("sample") as f32 / 32768.0)
            .collect(),
        32 => reader
            .samples::<i32>()
            .map(|s| s.expect("sample") as f32 / 2147483648.0)
            .collect(),
        bits => panic!("unsupported fixture depth: {bits} bits"),
    };
    (spec.sample_rate, samples)
}

#[derive(Default)]
struct Collected {
    events: Mutex<Vec<SttEvent>>,
}

impl Collected {
    fn emitter(self: &Arc<Self>) -> SttEmitter {
        let sink = self.clone();
        SttEmitter::new(move |event| {
            if matches!(event, SttEvent::Partial(_)) {
                // Partials stream per feed; log the first only to keep output readable.
                let events = sink.events.lock().expect("lock");
                if !events.iter().any(|e| matches!(e, SttEvent::Partial(_))) {
                    drop(events);
                    println!("e2e first partial: {event:?}");
                }
            }
            sink.events.lock().expect("lock").push(event);
        })
    }

    fn texts(&self, kind: &str) -> Vec<String> {
        self.events
            .lock()
            .expect("lock")
            .iter()
            .filter_map(|e| match (e, kind) {
                (SttEvent::Partial(t), "partial") | (SttEvent::Final(t), "final") => {
                    Some(t.clone())
                }
                _ => None,
            })
            .collect()
    }

    fn has(&self, kind: &str) -> bool {
        self.events.lock().expect("lock").iter().any(|e| {
            matches!(
                (e, kind),
                (SttEvent::Ready, "ready")
                    | (SttEvent::Partial(_), "partial")
                    | (SttEvent::Final(_), "final")
                    | (SttEvent::Stopped, "stopped")
                    | (SttEvent::Error(_), "error")
            )
        })
    }
}

/// Slice 5 acceptance #1: streaming zipformer transcribes live speech.
#[tokio::test]
#[ignore]
async fn e2e_streaming_zipformer_transcribes() {
    let dir = models_dir();
    let (_rate, samples) = wav_samples();
    let loader = SherpaEngineLoader;
    let engine = loader
        .load(&dir, "zipformer-streaming-en-20m", None)
        .expect("streaming engine loads");
    let collected = Arc::new(Collected::default());
    let emitter = collected.emitter();
    let mut session = engine.new_session(16000);

    for chunk in samples.chunks(3200) {
        session.accept(chunk, &|e| emitter.emit(e)).expect("accept");
    }
    session.finish(&|e| emitter.emit(e)).expect("finish");

    let finals = collected.texts("final");
    println!("e2e streaming finals: {finals:?}");
    assert!(!finals.is_empty(), "streaming produced no final");
    assert!(
        finals.join(" ").to_uppercase().contains("YELLOW"),
        "unexpected transcript: {finals:?}"
    );
}

/// Slice 5 acceptance #2 (shape): offline whisper decodes a >30 s utterance
/// into chunked finals.
#[tokio::test]
#[ignore]
async fn e2e_offline_whisper_chunked_finals() {
    let dir = models_dir();
    let (_rate, samples) = wav_samples();
    // ~40 s of audio by looping the fixture clip (chunker behavior is what
    // matters here, not novel speech content).
    let long: Vec<f32> = samples.iter().cycle().take(40 * 16000).cloned().collect();
    let loader = SherpaEngineLoader;
    let engine = loader
        .load(&dir, "whisper-tiny", None)
        .expect("offline engine loads");
    let collected = Arc::new(Collected::default());
    let emitter = collected.emitter();
    let mut session = engine.new_session(16000);

    for chunk in long.chunks(4096) {
        session.accept(chunk, &|e| emitter.emit(e)).expect("accept");
    }
    session.finish(&|e| emitter.emit(e)).expect("finish");

    let finals = collected.texts("final");
    println!("e2e offline finals ({}): {finals:?}", finals.len());
    assert!(finals.len() >= 2, "expected chunked finals, got {finals:?}");
}

/// Slice 5 acceptance #2 (recommended model): offline parakeet transducer
/// decodes the fixture clip.
#[tokio::test]
#[ignore]
async fn e2e_offline_parakeet_transcribes() {
    let dir = models_dir();
    let (_rate, samples) = wav_samples();
    let loader = SherpaEngineLoader;
    let engine = loader
        .load(&dir, "parakeet-tdt-0.6b-v3-int8", None)
        .expect("parakeet engine loads");
    let collected = Arc::new(Collected::default());
    let emitter = collected.emitter();
    let mut session = engine.new_session(16000);

    for chunk in samples.chunks(4096) {
        session.accept(chunk, &|e| emitter.emit(e)).expect("accept");
    }
    session.finish(&|e| emitter.emit(e)).expect("finish");

    let finals = collected.texts("final");
    println!("e2e parakeet finals: {finals:?}");
    assert_eq!(finals.len(), 1, "single short clip → single final");
    assert!(
        finals.join(" ").to_uppercase().contains("YELLOW"),
        "unexpected transcript: {finals:?}"
    );
}

/// Streaming paraformer path (second streaming family): loads and produces
/// a final on the fixture clip (Chinese+English model on English audio —
/// assert decode health, not wording).
#[tokio::test]
#[ignore]
async fn e2e_streaming_paraformer_decodes() {
    let dir = models_dir();
    let (_rate, samples) = wav_samples();
    let loader = SherpaEngineLoader;
    let engine = loader
        .load(&dir, "paraformer-bilingual-zh-en", None)
        .expect("paraformer engine loads");
    let collected = Arc::new(Collected::default());
    let emitter = collected.emitter();
    let mut session = engine.new_session(16000);

    for chunk in samples.chunks(3200) {
        session.accept(chunk, &|e| emitter.emit(e)).expect("accept");
    }
    session.finish(&|e| emitter.emit(e)).expect("finish");

    let finals = collected.texts("final");
    println!("e2e paraformer finals: {finals:?}");
    assert!(!finals.is_empty(), "paraformer produced no final");
}

/// Slice 5 acceptance #1/#3 through the real service: start → ready,
/// live partials, warm-reuse fast path, stop → stopped.
#[tokio::test]
#[ignore]
async fn e2e_service_start_feed_stop_with_reuse() {
    let dir = models_dir();
    let (_rate, samples) = wav_samples();
    let service = SttService::new(dir);
    let collected = Arc::new(Collected::default());

    let cold = std::time::Instant::now();
    service
        .start_dictation(
            "zipformer-streaming-en-20m",
            "desktop:e2e".into(),
            None,
            collected.emitter(),
        )
        .await
        .expect("cold start");
    let cold_elapsed = cold.elapsed();
    assert!(collected.has("ready"));

    for chunk in samples.chunks(4096) {
        service.feed_audio(chunk.to_vec(), 16000, "desktop:e2e");
    }
    service.stop_dictation("desktop:e2e").await.expect("stop");
    assert!(collected.has("stopped"));
    assert!(!collected.texts("final").is_empty());

    let warm = std::time::Instant::now();
    service
        .start_dictation(
            "zipformer-streaming-en-20m",
            "desktop:e2e2".into(),
            None,
            collected.emitter(),
        )
        .await
        .expect("warm start");
    let warm_elapsed = warm.elapsed();
    println!("e2e cold start: {cold_elapsed:?}, warm start: {warm_elapsed:?}");
    assert!(
        warm_elapsed < cold_elapsed,
        "warm reuse should beat cold load"
    );
    service
        .stop_dictation("desktop:e2e2")
        .await
        .expect("stop 2");
}
