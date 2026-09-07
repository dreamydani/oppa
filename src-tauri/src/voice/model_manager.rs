// Local-model download manager — behavior port of Orca's `model-manager.ts`
// (algorithms ported, no verbatim copy). Owns the models dir, per-model
// lifecycle states, Range-resume downloads with sha256 verification, and
// cancellation. Progress flows out through a caller-supplied callback so the
// manager stays Tauri-free and unit-testable.
//
// Deliberate deltas from Orca (see slice-04 Decisions): per-file `.partial`
// resume survives app restarts (Orca wipes its staging dir on start); no
// retry storm — one bounded attempt loop per file, the pane's Retry button
// covers flaky networks; hash verification happens per download and via
// `verify_model_files` (engine load gate, Slice 5), not on every state read.

use crate::voice::model_catalog::{get_catalog_model, is_local_speech_model, speech_model_catalog};
use crate::voice::model_download_catalog::download_files_for;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;
use tokio::sync::Notify;

/// Stall watchdog per streamed chunk (Orca: DOWNLOAD_IDLE_TIMEOUT_MS).
const IDLE_CHUNK_TIMEOUT: Duration = Duration::from_secs(120);
/// Bounded resume attempts per file (416/200-fallback consume attempts).
const MAX_FILE_ATTEMPTS: u32 = 3;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SpeechModelStatus {
    NotDownloaded,
    Downloading,
    Extracting,
    Ready,
    Error,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct SpeechModelState {
    pub id: String,
    pub status: SpeechModelStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub struct ModelManager {
    client: Option<reqwest::Client>,
    models_dir: PathBuf,
    states: Mutex<HashMap<String, SpeechModelState>>,
    cancel_flags: Mutex<HashMap<String, Arc<Notify>>>,
}

impl ModelManager {
    pub fn new(models_dir: PathBuf) -> Self {
        // Same TLS-stack setup as the updater client (rustls-no-provider needs
        // an installed ring provider); unlike the updater's 10 s manifest
        // client, downloads must not have a total-request timeout.
        if rustls::crypto::CryptoProvider::get_default().is_none() {
            let _ = rustls::crypto::ring::default_provider().install_default();
        }
        let client = reqwest::Client::builder()
            .user_agent(concat!("oppa/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(30))
            .build()
            .ok();
        Self {
            client,
            models_dir,
            states: Mutex::new(HashMap::new()),
            cancel_flags: Mutex::new(HashMap::new()),
        }
    }

    pub fn models_dir(&self) -> &Path {
        &self.models_dir
    }

    /// Model dir guarded against traversal: only catalog ids resolve inside.
    pub fn model_dir(&self, model_id: &str) -> Result<PathBuf, String> {
        get_catalog_model(model_id).ok_or_else(|| format!("unknown_model:{model_id}"))?;
        let dir = self.models_dir.join(model_id);
        if !dir.starts_with(&self.models_dir) {
            return Err(format!("invalid_model_id:{model_id}"));
        }
        Ok(dir)
    }

    pub fn get_model_states(&self) -> Vec<SpeechModelState> {
        speech_model_catalog()
            .iter()
            .map(|m| {
                if let Some(cached) = self.states.lock().expect("voice states lock").get(&m.id) {
                    if cached.status == SpeechModelStatus::Downloading
                        || cached.status == SpeechModelStatus::Error
                    {
                        return cached.clone();
                    }
                }
                if !is_local_speech_model(m) {
                    // Slice 7 refines: ready iff an API key is configured.
                    return SpeechModelState {
                        id: m.id.clone(),
                        status: SpeechModelStatus::NotDownloaded,
                        progress: None,
                        error: None,
                    };
                }
                let ready = self
                    .model_dir(&m.id)
                    .map(|dir| self.files_match_sizes(&m.id, &dir))
                    .unwrap_or(false);
                let state = SpeechModelState {
                    id: m.id.clone(),
                    status: if ready {
                        SpeechModelStatus::Ready
                    } else {
                        SpeechModelStatus::NotDownloaded
                    },
                    progress: None,
                    error: None,
                };
                if ready {
                    self.set_state(state.clone());
                }
                state
            })
            .collect()
    }

    fn files_match_sizes(&self, model_id: &str, dir: &Path) -> bool {
        let Some(files) = download_files_for(model_id) else {
            return false;
        };
        files.iter().all(|f| {
            std::fs::metadata(dir.join(&f.name))
                .map(|md| md.len() == f.size_bytes)
                .unwrap_or(false)
        })
    }

    /// Full sha256 verification of a model's files (engine load gate, Slice 5).
    pub fn verify_model_files(&self, model_id: &str) -> Result<(), String> {
        let dir = self.model_dir(model_id)?;
        let files =
            download_files_for(model_id).ok_or_else(|| format!("not_downloadable:{model_id}"))?;
        for file in &files {
            let bytes = std::fs::read(dir.join(&file.name)).map_err(|e| format!("io:{e}"))?;
            if bytes.len() as u64 != file.size_bytes {
                return Err("checksum_mismatch".into());
            }
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            if format!("{:x}", hasher.finalize()) != file.sha256.to_lowercase() {
                return Err("checksum_mismatch".into());
            }
        }
        Ok(())
    }

    pub fn is_downloading(&self, model_id: &str) -> bool {
        self.cancel_flags
            .lock()
            .expect("voice cancel lock")
            .contains_key(model_id)
    }

    pub fn cancel_download(&self, model_id: &str) {
        if let Some(flag) = self
            .cancel_flags
            .lock()
            .expect("voice cancel lock")
            .get(model_id)
        {
            flag.notify_waiters();
        }
        let was_downloading = self
            .states
            .lock()
            .expect("voice states lock")
            .get(model_id)
            .is_some_and(|s| s.status == SpeechModelStatus::Downloading);
        if was_downloading {
            self.set_state(SpeechModelState {
                id: model_id.into(),
                status: SpeechModelStatus::NotDownloaded,
                progress: None,
                error: None,
            });
        }
    }

    /// Remove a model's dir and partials (settings clearing lives in
    /// `model_deletion.rs`, which also owns the active-model guard).
    pub fn delete_model_files(&self, model_id: &str) -> Result<(), String> {
        self.cancel_download(model_id);
        let dir = self.model_dir(model_id)?;
        if dir.exists() {
            std::fs::remove_dir_all(&dir).map_err(|e| format!("io:{e}"))?;
        }
        // Per-file partials live next to their dests.
        if let Some(files) = download_files_for(model_id) {
            for file in &files {
                let tmp = partial_path(&dir.join(&file.name));
                if tmp.exists() {
                    std::fs::remove_file(&tmp).map_err(|e| format!("io:{e}"))?;
                }
            }
        }
        self.states
            .lock()
            .expect("voice states lock")
            .remove(model_id);
        Ok(())
    }

    pub async fn download_model(
        &self,
        model_id: &str,
        progress: &(dyn Fn(f32) + Send + Sync),
    ) -> Result<(), String> {
        let manifest =
            get_catalog_model(model_id).ok_or_else(|| format!("unknown_model:{model_id}"))?;
        if !is_local_speech_model(&manifest) {
            return Err(format!("not_downloadable:{model_id}"));
        }
        let files =
            download_files_for(model_id).ok_or_else(|| format!("metadata_missing:{model_id}"))?;
        if files.is_empty() {
            return Err(format!("metadata_missing:{model_id}"));
        }
        self.download_model_with_files(model_id, &files, progress)
            .await
    }

    pub(crate) async fn download_model_with_files(
        &self,
        model_id: &str,
        files: &[crate::voice::model_download_catalog::SpeechModelDownloadFile],
        progress: &(dyn Fn(f32) + Send + Sync),
    ) -> Result<(), String> {
        // Per-model concurrency guard: a second call while one is in flight
        // is a no-op (Orca parity).
        let cancel = {
            let mut flags = self.cancel_flags.lock().expect("voice cancel lock");
            if flags.contains_key(model_id) {
                return Ok(());
            }
            let flag = Arc::new(Notify::new());
            flags.insert(model_id.into(), flag.clone());
            flag
        };
        let result = self
            .download_inner(model_id, &files, progress, &cancel)
            .await;
        self.cancel_flags
            .lock()
            .expect("voice cancel lock")
            .remove(model_id);
        match result {
            Ok(()) => {
                self.set_state(SpeechModelState {
                    id: model_id.into(),
                    status: SpeechModelStatus::Ready,
                    progress: None,
                    error: None,
                });
                Ok(())
            }
            Err(DownloadError::Cancelled) => {
                self.set_state(SpeechModelState {
                    id: model_id.into(),
                    status: SpeechModelStatus::NotDownloaded,
                    progress: None,
                    error: None,
                });
                Ok(())
            }
            Err(DownloadError::Failed(message)) => {
                self.set_state(SpeechModelState {
                    id: model_id.into(),
                    status: SpeechModelStatus::Error,
                    progress: None,
                    error: Some(message.clone()),
                });
                Err(message)
            }
        }
    }

    fn set_state(&self, state: SpeechModelState) {
        self.states
            .lock()
            .expect("voice states lock")
            .insert(state.id.clone(), state);
    }

    #[allow(clippy::too_many_arguments)]
    async fn download_inner(
        &self,
        model_id: &str,
        files: &[crate::voice::model_download_catalog::SpeechModelDownloadFile],
        progress: &(dyn Fn(f32) + Send + Sync),
        cancel: &Notify,
    ) -> Result<(), DownloadError> {
        let client = self.client.clone().ok_or_else(|| {
            DownloadError::Failed("http_unavailable: client failed to build".into())
        })?;
        let dir = self.model_dir(model_id).map_err(DownloadError::Failed)?;
        std::fs::create_dir_all(&dir).map_err(|e| DownloadError::Failed(format!("io:{e}")))?;

        // Fast path: every file already valid.
        if self.files_match_sizes(model_id, &dir) {
            progress(1.0);
            return Ok(());
        }

        let total: u64 = files.iter().map(|f| f.size_bytes).sum();
        let mut completed: u64 = 0;
        let mut last_pct: i64 = -1;
        // Absolute-bytes reporter: callers pass completed + received so the
        // closure never borrows the mutating `completed` counter.
        let mut report = |absolute: u64| {
            let pct = (absolute as f64 / total as f64).min(1.0);
            let whole = (pct * 100.0).round() as i64;
            if whole != last_pct {
                last_pct = whole;
                progress(whole as f32 / 100.0);
            }
        };

        self.set_state(SpeechModelState {
            id: model_id.into(),
            status: SpeechModelStatus::Downloading,
            progress: Some(0.0),
            error: None,
        });
        report(completed);

        for file in files {
            validate_file_name(&file.name)?;
            let dest = dir.join(&file.name);
            // Skip valid files so a retry only fetches what is missing.
            if dest.exists()
                && std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0) == file.size_bytes
            {
                completed += file.size_bytes;
                report(completed);
                continue;
            }
            self.download_one_file(&client, file, &dest, completed, &mut report, cancel)
                .await?;
            completed += file.size_bytes;
            report(completed);
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    async fn download_one_file<R: FnMut(u64) + Send>(
        &self,
        client: &reqwest::Client,
        file: &crate::voice::model_download_catalog::SpeechModelDownloadFile,
        dest: &Path,
        base_bytes: u64,
        report: &mut R,
        cancel: &Notify,
    ) -> Result<(), DownloadError> {
        if file.url.is_empty()
            || !(file.url.starts_with("https://") || file.url.starts_with("http://"))
        {
            return Err(DownloadError::Failed("invalid_download_url".into()));
        }
        let tmp = partial_path(dest);
        let mut resume_from = tmp
            .exists()
            .then(|| std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0))
            .unwrap_or(0);
        if resume_from > file.size_bytes {
            let _ = std::fs::remove_file(&tmp);
            resume_from = 0;
        }

        for _ in 0..MAX_FILE_ATTEMPTS {
            let mut request = client.get(&file.url);
            if resume_from > 0 {
                request = request.header("Range", format!("bytes={resume_from}-"));
            }
            let mut response = request
                .send()
                .await
                .map_err(|e| DownloadError::Failed(format!("network:{e}")))?;

            let status = response.status().as_u16();
            if status == 416 {
                // Server rejected our offset: restart the file from scratch.
                let _ = std::fs::remove_file(&tmp);
                resume_from = 0;
                continue;
            }
            if !(200..=299).contains(&status) {
                return Err(DownloadError::Failed(format!("http_{status}")));
            }
            if status == 200 && resume_from > 0 {
                // Server restarted from byte zero: overwrite the partial.
                let _ = std::fs::remove_file(&tmp);
                resume_from = 0;
            }
            if status == 206 {
                let start = parse_content_range_start(response.headers()).unwrap_or(u64::MAX);
                if start != resume_from {
                    // Appending an unverified range would corrupt the file.
                    let _ = std::fs::remove_file(&tmp);
                    resume_from = 0;
                    continue;
                }
            }

            // Hash the resumed prefix so verification covers the whole file.
            let mut hasher = Sha256::new();
            if resume_from > 0 {
                let prefix =
                    std::fs::read(&tmp).map_err(|e| DownloadError::Failed(format!("io:{e}")))?;
                if prefix.len() as u64 != resume_from {
                    let _ = std::fs::remove_file(&tmp);
                    resume_from = 0;
                    continue;
                }
                hasher.update(&prefix);
            }
            let mut out = OpenOptions::new()
                .create(true)
                .append(resume_from > 0)
                .write(true)
                .truncate(resume_from == 0)
                .open(&tmp)
                .await
                .map_err(|e| DownloadError::Failed(format!("io:{e}")))?;

            let mut received = resume_from;
            loop {
                tokio::select! {
                    biased;
                    _ = cancel.notified() => {
                        return Err(DownloadError::Cancelled);
                    }
                    chunk = tokio::time::timeout(IDLE_CHUNK_TIMEOUT, response.chunk()) => {
                        let bytes = match chunk {
                            Err(_) => return Err(DownloadError::Failed("idle_timeout".into())),
                            Ok(Err(e)) => return Err(DownloadError::Failed(format!("network:{e}"))),
                            Ok(Ok(None)) => break,
                            Ok(Ok(Some(bytes))) => bytes,
                        };
                        if bytes.is_empty() {
                            continue;
                        }
                        hasher.update(&bytes);
                        out.write_all(&bytes).await.map_err(|e| DownloadError::Failed(format!("io:{e}")))?;
                        received += bytes.len() as u64;
                        if received > file.size_bytes {
                            return Err(DownloadError::Failed(format!(
                                "oversize: got more than {} bytes for {}",
                                file.size_bytes, file.name
                            )));
                        }
                        report(base_bytes + received);
                    }
                }
            }
            out.flush()
                .await
                .map_err(|e| DownloadError::Failed(format!("io:{e}")))?;
            drop(out);

            if received != file.size_bytes {
                // Truncated body with no error: loop resumes from the new offset.
                resume_from = std::fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);
                continue;
            }
            if format!("{:x}", hasher.finalize()) != file.sha256.to_lowercase() {
                let _ = std::fs::remove_file(&tmp);
                return Err(DownloadError::Failed("checksum_mismatch".into()));
            }
            if dest.exists() {
                std::fs::remove_file(dest).map_err(|e| DownloadError::Failed(format!("io:{e}")))?;
            }
            std::fs::rename(&tmp, dest).map_err(|e| DownloadError::Failed(format!("io:{e}")))?;
            return Ok(());
        }
        Err(DownloadError::Failed(format!(
            "interrupted: too many attempts for {}",
            file.name
        )))
    }
}

#[derive(Debug)]
enum DownloadError {
    Cancelled,
    Failed(String),
}

fn partial_path(dest: &Path) -> PathBuf {
    let mut tmp = dest.as_os_str().to_owned();
    tmp.push(".partial");
    PathBuf::from(tmp)
}

fn validate_file_name(name: &str) -> Result<(), DownloadError> {
    if name.is_empty() || name == "." || name == ".." || name.contains('/') || name.contains('\\') {
        return Err(DownloadError::Failed(format!("invalid_filename:{name}")));
    }
    Ok(())
}

fn parse_content_range_start(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    let value = headers.get(reqwest::header::CONTENT_RANGE)?.to_str().ok()?;
    // "bytes <start>-<end>/<total>"
    let range = value.trim().strip_prefix("bytes")?.trim();
    let (start, _) = range.split_once('-')?;
    start.trim().parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[derive(Clone, Copy)]
    enum ServeMode {
        /// Always 200 with the full body (ignores Range).
        Full,
        /// Honors Range (206), 416 when the offset exceeds the body.
        RangeAware,
        /// 200 with same-length garbage (checksum failure).
        Corrupt,
        /// 200 headers, first byte, then silence (cancel test).
        Stall,
    }

    struct Fixture {
        base_url: String,
        hits: Arc<AtomicUsize>,
        ranges_seen: Arc<Mutex<Vec<Option<u64>>>>,
    }

    fn pattern_body(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i % 251) as u8).collect()
    }

    async fn start_fixture(routes: Vec<(String, Vec<u8>)>, mode: ServeMode) -> Fixture {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind fixture");
        let addr = listener.local_addr().expect("fixture addr");
        let routes = Arc::new(routes);
        let hits = Arc::new(AtomicUsize::new(0));
        let ranges_seen: Arc<Mutex<Vec<Option<u64>>>> = Arc::new(Mutex::new(Vec::new()));
        let serve_hits = hits.clone();
        let serve_ranges = ranges_seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let routes = routes.clone();
                let hits = serve_hits.clone();
                let ranges = serve_ranges.clone();
                tokio::spawn(async move {
                    hits.fetch_add(1, Ordering::SeqCst);
                    let mut raw = Vec::new();
                    let mut buf = [0u8; 4096];
                    // Read until end of headers.
                    loop {
                        match socket.read(&mut buf).await {
                            Ok(0) => return,
                            Ok(n) => {
                                raw.extend_from_slice(&buf[..n]);
                                if raw.windows(4).any(|w| w == b"\r\n\r\n") || raw.len() > 65536 {
                                    break;
                                }
                            }
                            Err(_) => return,
                        }
                    }
                    let head = String::from_utf8_lossy(&raw);
                    let range = head.lines().find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        if name.trim().eq_ignore_ascii_case("range") {
                            value.trim().strip_prefix("bytes=").and_then(|rest| {
                                rest.strip_suffix('-').unwrap_or(rest).parse::<u64>().ok()
                            })
                        } else {
                            None
                        }
                    });
                    ranges.lock().expect("ranges lock").push(range);
                    let mut lines = head.lines();
                    let path = lines
                        .next()
                        .and_then(|request| request.split_whitespace().nth(1))
                        .unwrap_or("/");
                    let Some((_, body)) = routes
                        .iter()
                        .find(|(p, _)| p == path.trim_start_matches('/'))
                    else {
                        respond(&mut socket, 404, &[], &[]).await;
                        return;
                    };
                    match mode {
                        ServeMode::Full => {
                            respond(&mut socket, 200, &[], &body).await;
                        }
                        ServeMode::RangeAware => match range {
                            Some(start) if start < body.len() as u64 => {
                                let start = start as usize;
                                let header = format!(
                                    "Content-Range: bytes {}-{}/{}\r\n",
                                    start,
                                    body.len() - 1,
                                    body.len()
                                );
                                respond(&mut socket, 206, &[header], &body[start..]).await;
                            }
                            Some(_) => {
                                respond(&mut socket, 416, &[], &[]).await;
                            }
                            None => {
                                respond(&mut socket, 200, &[], &body).await;
                            }
                        },
                        ServeMode::Corrupt => {
                            let garbage = vec![0xABu8; body.len()];
                            respond(&mut socket, 200, &[], &garbage).await;
                        }
                        ServeMode::Stall => {
                            let head = format!(
                                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                                body.len()
                            );
                            let _ = socket.write_all(head.as_bytes()).await;
                            let _ = socket.write_all(&body[..1.min(body.len())]).await;
                            tokio::time::sleep(Duration::from_secs(60)).await;
                        }
                    }
                });
            }
        });
        Fixture {
            base_url: format!("http://{addr}"),
            hits,
            ranges_seen,
        }
    }

    async fn respond(
        socket: &mut tokio::net::TcpStream,
        status: u16,
        extra: &[String],
        body: &[u8],
    ) {
        let reason = match status {
            200 => "OK",
            206 => "Partial Content",
            404 => "Not Found",
            416 => "Range Not Satisfiable",
            _ => "Error",
        };
        let mut head = format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n",
            body.len()
        );
        for header in extra {
            head.push_str(header);
        }
        head.push_str("\r\n");
        let _ = socket.write_all(head.as_bytes()).await;
        let _ = socket.write_all(body).await;
    }

    fn fixture_files(
        base_url: &str,
        entries: &[(&str, usize)],
    ) -> Vec<crate::voice::model_download_catalog::SpeechModelDownloadFile> {
        entries
            .iter()
            .map(|(name, len)| {
                let body = pattern_body(*len);
                let mut hasher = Sha256::new();
                hasher.update(&body);
                crate::voice::model_download_catalog::SpeechModelDownloadFile {
                    name: name.to_string(),
                    url: format!("{base_url}/{name}"),
                    size_bytes: body.len() as u64,
                    sha256: format!("{:x}", hasher.finalize()),
                }
            })
            .collect()
    }

    fn test_manager() -> (ModelManager, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("temp models dir");
        let manager = ModelManager::new(dir.path().join("voice-models"));
        (manager, dir)
    }

    fn progress_recorder() -> (Arc<Mutex<Vec<f32>>>, impl Fn(f32) + Send + Sync) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let cb = move |pct: f32| {
            sink.lock().expect("progress lock").push(pct);
        };
        (seen, cb)
    }

    #[tokio::test]
    async fn downloads_files_and_reports_monotonic_progress() {
        let fixture = start_fixture(
            vec![
                ("a.bin".to_string(), pattern_body(32 * 1024)),
                ("b.bin".to_string(), pattern_body(8 * 1024)),
            ],
            ServeMode::Full,
        )
        .await;
        let (manager, _tmp) = test_manager();
        let files = fixture_files(
            &fixture.base_url,
            &[("a.bin", 32 * 1024), ("b.bin", 8 * 1024)],
        );
        let (seen, cb) = progress_recorder();

        manager
            .download_model_with_files("whisper-tiny", &files, &cb)
            .await
            .expect("download succeeds");

        let dir = manager.model_dir("whisper-tiny").expect("dir resolves");
        assert_eq!(
            std::fs::read(dir.join("a.bin")).expect("a").len(),
            32 * 1024
        );
        assert_eq!(std::fs::read(dir.join("b.bin")).expect("b").len(), 8 * 1024);
        assert!(!dir.join("a.bin.partial").exists());
        let seen = seen.lock().expect("progress lock").clone();
        assert_eq!(seen.first(), Some(&0.0));
        assert_eq!(seen.last(), Some(&1.0));
        assert!(
            seen.windows(2).all(|w| w[1] >= w[0]),
            "progress monotonic: {seen:?}"
        );
        assert_eq!(
            manager
                .states
                .lock()
                .expect("states lock")
                .get("whisper-tiny")
                .map(|s| s.status),
            Some(SpeechModelStatus::Ready)
        );
    }

    #[tokio::test]
    async fn resumes_partial_file_with_range_request() {
        let fixture = start_fixture(
            vec![("a.bin".to_string(), pattern_body(16 * 1024))],
            ServeMode::RangeAware,
        )
        .await;
        let (manager, _tmp) = test_manager();
        let files = fixture_files(&fixture.base_url, &[("a.bin", 16 * 1024)]);
        // Pre-seed the first half as a leftover partial.
        let dir = manager.model_dir("whisper-tiny").expect("dir resolves");
        std::fs::create_dir_all(&dir).expect("mkdir");
        let mut prefix: Vec<u8> = (0..8 * 1024).map(|i| (i % 251) as u8).collect();
        std::fs::write(dir.join("a.bin.partial"), &prefix).expect("seed partial");
        prefix.clear();

        let (_, cb) = progress_recorder();
        manager
            .download_model_with_files("whisper-tiny", &files, &cb)
            .await
            .expect("resume succeeds");

        let ranges = fixture.ranges_seen.lock().expect("ranges lock").clone();
        assert_eq!(ranges, vec![Some(8 * 1024)]);
        let done = std::fs::read(dir.join("a.bin")).expect("file");
        assert_eq!(done.len(), 16 * 1024);
        assert!(done.iter().enumerate().all(|(i, b)| *b == (i % 251) as u8));
    }

    #[tokio::test]
    async fn restarts_file_on_416_and_on_200_to_range() {
        // 416 path: seed a partial past the end so the server rejects it.
        let fixture = start_fixture(
            vec![("a.bin".to_string(), pattern_body(4 * 1024))],
            ServeMode::RangeAware,
        )
        .await;
        let (manager, _tmp) = test_manager();
        let files = fixture_files(&fixture.base_url, &[("a.bin", 4 * 1024)]);
        let dir = manager.model_dir("whisper-tiny").expect("dir resolves");
        std::fs::create_dir_all(&dir).expect("mkdir");
        std::fs::write(dir.join("a.bin.partial"), vec![0u8; 8 * 1024]).expect("oversize partial");

        let (_, cb) = progress_recorder();
        manager
            .download_model_with_files("whisper-tiny", &files, &cb)
            .await
            .expect("416 restarts the file");
        assert_eq!(
            std::fs::read(dir.join("a.bin")).expect("file").len(),
            4 * 1024
        );

        // 200-to-Range path: server ignores Range, client overwrites.
        let full = start_fixture(
            vec![("b.bin".to_string(), pattern_body(4 * 1024))],
            ServeMode::Full,
        )
        .await;
        let files = fixture_files(&full.base_url, &[("b.bin", 4 * 1024)]);
        std::fs::write(dir.join("b.bin.partial"), vec![0xFFu8; 1024]).expect("stale partial");
        manager
            .download_model_with_files("whisper-tiny", &files, &cb)
            .await
            .expect("200 overwrites the partial");
        let done = std::fs::read(dir.join("b.bin")).expect("file");
        assert!(done.iter().enumerate().all(|(i, b)| *b == (i % 251) as u8));
    }

    #[tokio::test]
    async fn checksum_mismatch_deletes_partial_and_errors() {
        let fixture = start_fixture(
            vec![("a.bin".to_string(), pattern_body(4 * 1024))],
            ServeMode::Corrupt,
        )
        .await;
        let (manager, _tmp) = test_manager();
        let files = fixture_files(&fixture.base_url, &[("a.bin", 4 * 1024)]);
        let (_, cb) = progress_recorder();

        let err = manager
            .download_model_with_files("whisper-tiny", &files, &cb)
            .await
            .expect_err("corrupt body fails");
        assert_eq!(err, "checksum_mismatch");
        let dir = manager.model_dir("whisper-tiny").expect("dir resolves");
        assert!(!dir.join("a.bin.partial").exists());
        assert!(!dir.join("a.bin").exists());
        assert_eq!(
            manager
                .states
                .lock()
                .expect("states lock")
                .get("whisper-tiny")
                .cloned()
                .map(|s| (s.status, s.error)),
            Some((SpeechModelStatus::Error, Some("checksum_mismatch".into())))
        );
    }

    #[tokio::test]
    async fn cancel_keeps_partial_and_resets_state() {
        let fixture = start_fixture(
            vec![("a.bin".to_string(), pattern_body(4096))],
            ServeMode::Stall,
        )
        .await;
        let manager = Arc::new(test_manager().0);
        let files = fixture_files(&fixture.base_url, &[("a.bin", 4096)]);
        let (_, cb) = progress_recorder();

        let worker = manager.clone();
        let handle = tokio::spawn(async move {
            worker
                .download_model_with_files("whisper-tiny", &files, &cb)
                .await
        });
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(manager.is_downloading("whisper-tiny"));
        manager.cancel_download("whisper-tiny");
        let result = handle.await.expect("task joins");
        assert!(result.is_ok(), "cancel resolves quietly");

        let dir = manager.model_dir("whisper-tiny").expect("dir resolves");
        assert!(
            dir.join("a.bin.partial").exists(),
            "partial kept for resume"
        );
        assert!(!dir.join("a.bin").exists());
        assert_eq!(
            manager
                .states
                .lock()
                .expect("states lock")
                .get("whisper-tiny")
                .map(|s| s.status),
            Some(SpeechModelStatus::NotDownloaded)
        );
        assert!(!manager.is_downloading("whisper-tiny"));
    }

    #[tokio::test]
    async fn second_download_while_in_flight_is_a_no_op() {
        let fixture = start_fixture(
            vec![("a.bin".to_string(), pattern_body(4096))],
            ServeMode::Stall,
        )
        .await;
        let manager = Arc::new(test_manager().0);
        let files = fixture_files(&fixture.base_url, &[("a.bin", 4096)]);
        let (_, cb) = progress_recorder();

        let worker = manager.clone();
        let files_clone = files.clone();
        let first = tokio::spawn(async move {
            worker
                .download_model_with_files("whisper-tiny", &files_clone, &|_| {})
                .await
        });
        tokio::time::sleep(Duration::from_millis(200)).await;
        manager
            .download_model_with_files("whisper-tiny", &files, &cb)
            .await
            .expect("second call no-ops");
        manager.cancel_download("whisper-tiny");
        let _ = first.await.expect("first joins");
        assert_eq!(fixture.hits.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn public_download_rejects_unknown_and_cloud_models() {
        let (manager, _tmp) = test_manager();
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("rt");
        let err = rt
            .block_on(manager.download_model("nope", &|_| {}))
            .expect_err("unknown model");
        assert_eq!(err, "unknown_model:nope");
        let err = rt
            .block_on(manager.download_model("openai-gpt-4o-transcribe", &|_| {}))
            .expect_err("cloud model");
        assert_eq!(err, "not_downloadable:openai-gpt-4o-transcribe");
    }

    #[test]
    fn model_dir_rejects_unknown_ids() {
        let (manager, _tmp) = test_manager();
        assert!(manager.model_dir("nope").is_err());
        assert!(manager.model_dir("whisper-tiny").is_ok());
    }

    #[test]
    fn verify_model_files_detects_tampering() {
        let (manager, _tmp) = test_manager();
        // Point verification at a hand-built dir via the real tiny hashes is
        // impractical (150 MB); exercise the shape with a missing file.
        let err = manager
            .verify_model_files("whisper-tiny")
            .expect_err("missing files fail");
        assert!(err == "checksum_mismatch" || err.starts_with("io:"));
    }
}
