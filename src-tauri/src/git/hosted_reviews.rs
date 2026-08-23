// Hosted GitHub reviews: forge detection + eligibility ladder; gh stays argv-only like git.
#![allow(dead_code)]

use crate::agents::catalog;
use crate::git::source_control::{sc_status, validate_ref_name, ConflictState};
use crate::git::worktree_registry::{WorktreeRecord, WorktreeRegistry};
use crate::git::worktrees::{run_git, worktree_current};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const GH_AUTH_TIMEOUT_SECS: u64 = 10;
const GH_CREATE_TIMEOUT_SECS: u64 = 60;
const MAX_TITLE_CHARS: usize = 200;
const MAX_BODY_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ForgeProvider {
    Github,
    Unsupported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForgeInfo {
    pub provider: ForgeProvider,
    pub owner_repo: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BlockedReason {
    DetachedHead,
    ExistingReview,
    UnsupportedProvider,
    DefaultBranch,
    Dirty,
    NoUpstream,
    NeedsSync,
    AuthRequired,
    NeedsPush,
    BaseNotOnRemote,
    GhMissing,
    GhNotAuthed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Eligibility {
    pub eligible: bool,
    pub blocked_reason: Option<BlockedReason>,
    pub base_ref: Option<String>,
    pub owner_repo: Option<String>,
    pub existing_pr_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateReviewInput {
    pub title: String,
    pub body: String,
    pub draft: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreatedReview {
    pub pr_url: String,
    pub pr_number: Option<u32>,
    pub base_ref: String,
    pub owner_repo: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GhRunError {
    Failed { stderr: String },
    TimedOut,
}

pub fn forge_info(cwd: &Path) -> ForgeInfo {
    let url = match run_git(cwd, &["remote", "get-url", "origin"]) {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        _ => return ForgeInfo { provider: ForgeProvider::Unsupported, owner_repo: None },
    };
    let configured_host = std::env::var("OPPA_GH_HOST").ok();
    parse_origin_url_with_host(&url, configured_host.as_deref())
}

fn parse_origin_url_with_host(url: &str, configured_host: Option<&str>) -> ForgeInfo {
    let unsupported =
        ForgeInfo { provider: ForgeProvider::Unsupported, owner_repo: None };
    let (raw_host, tail) = match url.split_once("://") {
        Some((_scheme, rest)) => match rest.split_once('/') {
            Some((host, path)) => (host, path),
            None => return unsupported,
        },
        None => match url.split_once(':') {
            Some((user_host, path)) => (user_host, path),
            None => return unsupported,
        },
    };
    let host = raw_host.rsplit('@').next().unwrap_or(raw_host);
    let host = host.split(':').next().unwrap_or("").to_ascii_lowercase();
    if !host.contains("github") {
        return unsupported;
    }
    // Enterprise hosts are opt-in via OPPA_GH_HOST so lookalike paths fail closed.
    if host != "github.com" && configured_host.map(|c| c.to_ascii_lowercase()).as_deref() != Some(host.as_str()) {
        return unsupported;
    }
    let trimmed = tail.trim_end_matches('/');
    let no_dotgit = match trimmed.len() >= 4 {
        true if trimmed[trimmed.len() - 4..].eq_ignore_ascii_case(".git") => &trimmed[..trimmed.len() - 4],
        _ => trimmed,
    };
    let mut segments = no_dotgit.split('/');
    let (owner, repo) = match (segments.next(), segments.next(), segments.next()) {
        (Some(o), Some(r), None) if !o.is_empty() && !r.is_empty() => (o, r),
        _ => return unsupported,
    };
    ForgeInfo {
        provider: ForgeProvider::Github,
        owner_repo: Some(format!("{}/{}", owner.to_ascii_lowercase(), repo)),
    }
}

pub fn gh_available(path_env: Option<&OsStr>) -> Result<(), BlockedReason> {
    let resolved =
        catalog::resolve_command_with_path("gh", path_env).ok_or(BlockedReason::GhMissing)?;
    run_gh_auth_status(&resolved)
}

fn run_gh_auth_status(program: &Path) -> Result<(), BlockedReason> {
    let mut cmd = Command::new(program);
    cmd.args(["auth", "status"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let Ok(mut child) = cmd.spawn() else {
        return Err(BlockedReason::GhMissing);
    };
    let deadline = Instant::now() + Duration::from_secs(GH_AUTH_TIMEOUT_SECS);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return status.success().then_some(()).ok_or(BlockedReason::GhNotAuthed)
            }
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(BlockedReason::GhNotAuthed);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return Err(BlockedReason::GhNotAuthed),
        }
    }
}

pub fn resolve_base_ref(cwd: &Path) -> Result<String, BlockedReason> {
    if let Ok(out) = run_git(cwd, &["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]) {
        if out.status.success() {
            let full = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if let Some(short) = full.strip_prefix("refs/remotes/origin/") {
                if !short.is_empty() && validate_ref_name(short).is_ok() {
                    return Ok(short.to_string());
                }
            }
        }
    }
    for candidate in ["main", "master"] {
        if base_exists_on_remote(cwd, candidate) {
            return Ok(candidate.to_string());
        }
    }
    Err(BlockedReason::BaseNotOnRemote)
}

pub fn base_exists_on_remote(cwd: &Path, base: &str) -> bool {
    if validate_ref_name(base).is_err() {
        return false;
    }
    run_git(
        cwd,
        &["rev-parse", "--verify", "-q", &format!("refs/remotes/origin/{base}")],
    )
    .map(|out| out.status.success())
    .unwrap_or(false)
}

pub fn review_eligibility(
    cwd: &Path,
    gh_probe: &dyn Fn() -> Result<(), BlockedReason>,
    pr_lookup: &dyn Fn(&str, &str) -> Option<String>,
) -> Eligibility {
    let blocked = |reason, base_ref, owner_repo| Eligibility {
        eligible: false,
        blocked_reason: Some(reason),
        base_ref,
        owner_repo,
        existing_pr_url: None,
    };

    // Ladder order is fixed per spec; first failing rung wins.
    let branch = run_git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    if branch.is_empty() || branch == "HEAD" {
        return blocked(BlockedReason::DetachedHead, None, None);
    }

    let info = forge_info(cwd);
    let owner_repo = if info.provider == ForgeProvider::Github { info.owner_repo } else { None };
    let Some(owner_repo) = owner_repo else {
        return blocked(BlockedReason::UnsupportedProvider, None, None);
    };

    if let Err(reason) = gh_probe() {
        return blocked(reason, None, Some(owner_repo));
    }

    let base_ref = match resolve_base_ref(cwd) {
        Ok(base) => base,
        Err(reason) => return blocked(reason, None, Some(owner_repo)),
    };
    if branch == base_ref {
        return blocked(BlockedReason::DefaultBranch, Some(base_ref), Some(owner_repo));
    }

    // One porcelain walk feeds Dirty plus all three upstream rungs.
    let st = match sc_status(cwd) {
        Ok(st) => st,
        Err(_) => return blocked(BlockedReason::Dirty, Some(base_ref), Some(owner_repo)),
    };
    if st.conflict_state != ConflictState::None || !st.entries.is_empty() {
        return blocked(BlockedReason::Dirty, Some(base_ref), Some(owner_repo));
    }
    if !st.upstream.has_upstream {
        return blocked(BlockedReason::NoUpstream, Some(base_ref), Some(owner_repo));
    }
    if st.upstream.behind > 0 {
        return blocked(BlockedReason::NeedsSync, Some(base_ref), Some(owner_repo));
    }
    if st.upstream.ahead > 0 {
        return blocked(BlockedReason::NeedsPush, Some(base_ref), Some(owner_repo));
    }
    if !base_exists_on_remote(cwd, &base_ref) {
        return blocked(BlockedReason::BaseNotOnRemote, Some(base_ref), Some(owner_repo));
    }

    let existing_pr_url = pr_lookup(owner_repo.as_str(), &branch);
    Eligibility {
        eligible: true,
        blocked_reason: None,
        base_ref: Some(base_ref),
        owner_repo: Some(owner_repo),
        existing_pr_url,
    }
}

// Real-gh wiring for daemon/UI callers; PR lookup now probes via gh view/list.
pub fn review_eligibility_live(cwd: &Path) -> Eligibility {
    review_eligibility_live_with_search_path(cwd, None)
}

fn blocked_message(reason: &BlockedReason) -> String {
    // Serde's kebab wire-name doubles as the human-facing reason token.
    let kebab = serde_json::to_string(reason).unwrap_or_default();
    format!("blocked: {}", kebab.trim_matches('"'))
}

fn current_branch(cwd: &Path) -> Option<String> {
    let out = run_git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).ok()?;
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (out.status.success() && !name.is_empty() && name != "HEAD").then_some(name)
}

fn extract_pr_url(stdout: &str) -> Option<String> {
    stdout
        .split_whitespace()
        .filter(|token| token.contains("/pull/"))
        .next_back()
        .map(str::to_string)
}

fn pr_number_from_url(pr_url: &str) -> Option<u32> {
    pr_url.rsplit('/').next()?.parse().ok()
}

// Drop guard so the body file vanishes on every exit path, success or failure.
struct TempBodyFile {
    path: PathBuf,
}

impl TempBodyFile {
    fn write(body: &str) -> Result<TempBodyFile, String> {
        // Unique suffix keeps parallel creates from colliding in the shared temp dir.
        let path =
            std::env::temp_dir().join(format!("oppa-pr-body-{}.md", uuid::Uuid::new_v4()));
        std::fs::write(&path, body).map_err(|e| format!("cannot write pr body temp file: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(TempBodyFile { path })
    }
}

impl Drop for TempBodyFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn stamp_linked_pr(registry_path: &Path, cwd: &Path, pr_url: &str) {
    // Longest-prefix match mirrors worktree_current; no record ⇒ nothing to link.
    let Some(record) = worktree_current(registry_path, cwd) else { return };
    let mut registry = WorktreeRegistry::load(registry_path);
    if let Some(worktree) = registry.worktrees.get_mut(&record.id) {
        worktree.linked_pr_url = Some(pr_url.to_string());
        let _ = registry.save(registry_path);
    }
}

pub fn create_pull_request(
    cwd: &Path,
    registry_path: &Path,
    input: CreateReviewInput,
    gh_runner: &dyn Fn(&[&str]) -> Result<String, GhRunError>,
    pr_lookup: &dyn Fn(&str, &str) -> Option<String>,
) -> Result<CreatedReview, String> {
    let title = input.title.trim();
    if title.is_empty() || title.chars().count() > MAX_TITLE_CHARS {
        return Err(format!("invalid title: must be 1-{MAX_TITLE_CHARS} characters"));
    }
    if input.body.len() > MAX_BODY_BYTES {
        return Err(format!("invalid body: exceeds {}KB limit", MAX_BODY_BYTES / 1024));
    }

    // Auth rides the same injectable runner so tests observe every gh argv.
    let auth_probe = || match gh_runner(&["auth", "status"]) {
        Ok(_) => Ok(()),
        Err(_) => Err(BlockedReason::GhNotAuthed),
    };
    let eligibility = review_eligibility(cwd, &auth_probe, pr_lookup);
    if !eligibility.eligible {
        return Err(eligibility
            .blocked_reason
            .as_ref()
            .map(blocked_message)
            .unwrap_or_else(|| "blocked: unknown".into()));
    }
    let base_ref =
        eligibility.base_ref.clone().ok_or_else(|| "eligibility missing base ref".to_string())?;
    let owner_repo = eligibility
        .owner_repo
        .clone()
        .ok_or_else(|| "eligibility missing owner/repo".to_string())?;
    if let Some(existing) = eligibility.existing_pr_url.clone() {
        // Duplicate safety: an open PR for this branch is returned, never recreated.
        stamp_linked_pr(registry_path, cwd, &existing);
        return Ok(CreatedReview {
            pr_number: pr_number_from_url(&existing),
            pr_url: existing,
            base_ref,
            owner_repo,
        });
    }
    let branch = current_branch(cwd)
        .ok_or_else(|| blocked_message(&BlockedReason::DetachedHead))?;

    let body_file = TempBodyFile::write(&input.body)?;
    let body_path_text = body_file.path.to_string_lossy().into_owned();
    let mut argv: Vec<&str> = vec![
        "pr",
        "create",
        "--repo",
        owner_repo.as_str(),
        "--base",
        base_ref.as_str(),
        "--title",
        title,
        "--body-file",
        body_path_text.as_str(),
        "--head",
        branch.as_str(),
    ];
    if input.draft {
        argv.push("--draft");
    }

    let finish = |pr_url: String| {
        stamp_linked_pr(registry_path, cwd, &pr_url);
        CreatedReview {
            pr_number: pr_number_from_url(&pr_url),
            base_ref: base_ref.clone(),
            owner_repo: owner_repo.clone(),
            pr_url,
        }
    };

    match gh_runner(&argv) {
        Ok(stdout) => {
            if let Some(pr_url) = extract_pr_url(&stdout) {
                return Ok(finish(pr_url));
            }
            // Ambiguous: the PR may exist despite unusable stdout.
            match pr_lookup(owner_repo.as_str(), &branch) {
                Some(pr_url) => Ok(finish(pr_url)),
                None => Err(format!(
                    "pr create failed: no pull request URL in output: {}",
                    stdout.trim()
                )),
            }
        }
        // Timeout stays ambiguous: create may have landed before the kill, so probe too.
        Err(GhRunError::TimedOut) => match pr_lookup(owner_repo.as_str(), &branch) {
            Some(pr_url) => Ok(finish(pr_url)),
            None => Err("pr create failed: gh timed out after 60s".into()),
        },
        Err(GhRunError::Failed { stderr }) => {
            if stderr.contains("already exists") {
                match pr_lookup(owner_repo.as_str(), &branch) {
                    Some(pr_url) => Ok(finish(pr_url)),
                    None => Err(format!("pr create failed: {stderr}")),
                }
            } else {
                Err(format!("pr create failed: {stderr}"))
            }
        }
    }
}

fn run_gh_argv(cwd: &Path, program: &Path, argv: &[String]) -> Result<String, GhRunError> {
    use std::io::Read;
    let mut cmd = Command::new(program);
    cmd.args(argv)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| GhRunError::Failed { stderr: format!("gh spawn failed: {e}") })?;
    let deadline = Instant::now() + Duration::from_secs(GH_CREATE_TIMEOUT_SECS);
    let outcome = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(GhRunError::TimedOut);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(e) => break Err(GhRunError::Failed { stderr: format!("gh wait failed: {e}") }),
        }
    };
    let mut stdout_text = String::new();
    let mut stderr_text = String::new();
    if let Some(mut pipe) = child.stdout.take() {
        let _ = pipe.read_to_string(&mut stdout_text);
    }
    if let Some(mut pipe) = child.stderr.take() {
        let _ = pipe.read_to_string(&mut stderr_text);
    }
    match outcome {
        Err(err) => Err(err),
        Ok(status) if status.success() => Ok(stdout_text),
        Ok(_) => Err(GhRunError::Failed { stderr: stderr_text.trim().to_string() }),
    }
}

// Real-gh wiring; now probes via gh for duplicate detection.
pub fn create_pull_request_live(
    cwd: &Path,
    registry_path: &Path,
    input: CreateReviewInput,
) -> Result<CreatedReview, String> {
    create_pull_request_live_with_search_path(cwd, registry_path, input, None)
}

// ---------- task 3: pr status parsing + poller ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CheckState {
    Passing,
    Failing,
    Pending,
    Skipping,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CheckRun {
    pub name: String,
    pub state: CheckState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrStatus {
    pub number: u32,
    pub title: String,
    pub url: String,
    // Lowercased gh wire value: open | closed | merged
    pub state: String,
    pub draft: bool,
    pub mergeable: String,
    pub base_ref_name: String,
    pub head_ref_name: String,
    pub checks: Vec<CheckRun>,
    pub fetched_at_ms: u64,
}

const PR_STATUS_JSON_FIELDS: &str =
    "number,title,url,state,isDraft,mergeable,baseRefName,headRefName,statusCheckRollup";

pub(crate) fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn map_check_token(token: &str) -> Option<CheckState> {
    match token.to_ascii_uppercase().as_str() {
        "SUCCESS" | "PASS" => Some(CheckState::Passing),
        "FAILURE" | "ERROR" | "FAILING" => Some(CheckState::Failing),
        "PENDING" | "IN_PROGRESS" | "QUEUED" => Some(CheckState::Pending),
        "SKIPPED" | "NEUTRAL" => Some(CheckState::Skipping),
        _ => None,
    }
}

// Rollup entries vary (CheckRun vs StatusContext): first candidate field landing in a
// known bucket wins, so a CheckRun's COMPLETED wrapper status never masks its conclusion.
fn parse_rollup_entry(entry: &serde_json::Value) -> Option<CheckRun> {
    let name = entry
        .get("name")
        .and_then(|v| v.as_str())
        .or_else(|| entry.get("context").and_then(|v| v.as_str()))?
        .to_string();
    let state = ["state", "status", "conclusion"]
        .iter()
        .find_map(|key| entry.get(*key)?.as_str().and_then(map_check_token))
        .unwrap_or(CheckState::Pending);
    Some(CheckRun { name, state })
}

pub fn pr_status_from_json(json: &str, now_ms: u64) -> Result<PrStatus, String> {
    let value: serde_json::Value =
        serde_json::from_str(json).map_err(|e| format!("pr view json parse failed: {e}"))?;
    let text_field = |key: &str| -> Result<String, String> {
        value
            .get(key)
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .ok_or_else(|| format!("pr view json missing {key}"))
    };
    let number = value
        .get("number")
        .and_then(|v| v.as_u64())
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(|| "pr view json missing number".to_string())?;
    let draft = value
        .get("isDraft")
        .and_then(|v| v.as_bool())
        .ok_or_else(|| "pr view json missing isDraft".to_string())?;
    let rollup = value
        .get("statusCheckRollup")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "pr view json missing statusCheckRollup".to_string())?;
    Ok(PrStatus {
        number,
        title: text_field("title")?,
        url: text_field("url")?,
        state: text_field("state")?.to_ascii_lowercase(),
        draft,
        mergeable: text_field("mergeable")?.to_ascii_lowercase(),
        base_ref_name: text_field("baseRefName")?,
        head_ref_name: text_field("headRefName")?,
        checks: rollup.iter().filter_map(parse_rollup_entry).collect(),
        fetched_at_ms: now_ms,
    })
}

pub fn pr_status(
    cwd: &Path,
    url: &str,
    gh_runner: &dyn Fn(&[&str]) -> Result<String, GhRunError>,
) -> Result<PrStatus, String> {
    let argv = ["pr", "view", url, "--json", PR_STATUS_JSON_FIELDS];
    let stdout = gh_runner(&argv).map_err(|e| match e {
        GhRunError::Failed { stderr } => format!("pr view failed: {stderr}"),
        GhRunError::TimedOut => "pr view failed: gh timed out after 60s".into(),
    })?;
    pr_status_from_json(&stdout, unix_now_ms())
}

// Injectable seam so the poller and manual refresh run against mocks in tests.
pub trait GhClient: Send + Sync {
    fn status(&self, cwd: &Path, url: &str) -> Result<PrStatus, String>;
}

pub struct LiveGhClient {
    gh_search_path: Option<PathBuf>,
}

impl LiveGhClient {
    pub fn new() -> Self {
        Self { gh_search_path: None }
    }

    pub fn with_search_path(path: Option<PathBuf>) -> Self {
        Self { gh_search_path: path }
    }

    fn resolve_program(&self) -> Option<PathBuf> {
        catalog::resolve_command_with_path(
            "gh",
            self.gh_search_path.as_deref().map(|p| p.as_os_str()),
        )
    }
}

impl Default for LiveGhClient {
    fn default() -> Self {
        Self::new()
    }
}

impl GhClient for LiveGhClient {
    fn status(&self, cwd: &Path, url: &str) -> Result<PrStatus, String> {
        let program = self
            .resolve_program()
            .ok_or_else(|| blocked_message(&BlockedReason::GhMissing))?;
        pr_status(cwd, url, &|argv: &[&str]| {
            let owned: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
            run_gh_argv(cwd, &program, &owned)
        })
    }
}

fn gh_lookup_pr_url(
    cwd: &Path,
    program: &Path,
    owner_repo: &str,
    branch: &str,
) -> Option<String> {
    // Primary: gh pr view <branch> --json url
    let view_argv = vec![
        "pr".to_string(),
        "view".to_string(),
        branch.to_string(),
        "--json".to_string(),
        "url".to_string(),
    ];
    if let Ok(stdout) = run_gh_argv(cwd, program, &view_argv) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&stdout) {
            if let Some(url) = value.get("url").and_then(|v| v.as_str()) {
                if !url.is_empty() && url.contains("/pull/") {
                    return Some(url.to_string());
                }
            }
        }
        if let Some(url) = extract_pr_url(&stdout) {
            return Some(url);
        }
    }
    // Fallback: gh pr list --repo owner/repo --head branch --json number,url --limit 5
    let list_argv = vec![
        "pr".to_string(),
        "list".to_string(),
        "--repo".to_string(),
        owner_repo.to_string(),
        "--head".to_string(),
        branch.to_string(),
        "--json".to_string(),
        "number,url".to_string(),
        "--limit".to_string(),
        "5".to_string(),
    ];
    if let Ok(stdout) = run_gh_argv(cwd, program, &list_argv) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&stdout) {
            if let Some(arr) = value.as_array() {
                if let Some(first) = arr.first() {
                    if let Some(url) = first.get("url").and_then(|v| v.as_str()) {
                        if !url.is_empty() {
                            return Some(url.to_string());
                        }
                    }
                }
            }
        }
        if let Some(url) = extract_pr_url(&stdout) {
            return Some(url);
        }
    }
    None
}

pub fn review_eligibility_live_with_search_path(
    cwd: &Path,
    search_path: Option<&Path>,
) -> Eligibility {
    let gh_probe = || gh_available(search_path.map(|p| p.as_os_str()));
    let lookup = |owner_repo: &str, branch: &str| {
        let program = catalog::resolve_command_with_path(
            "gh",
            search_path.map(|p| p.as_os_str()),
        )?;
        gh_lookup_pr_url(cwd, &program, owner_repo, branch)
    };
    review_eligibility(cwd, &gh_probe, &lookup)
}

pub fn create_pull_request_live_with_search_path(
    cwd: &Path,
    registry_path: &Path,
    input: CreateReviewInput,
    search_path: Option<&Path>,
) -> Result<CreatedReview, String> {
    let program = catalog::resolve_command_with_path(
        "gh",
        search_path.map(|p| p.as_os_str()),
    )
    .ok_or_else(|| blocked_message(&BlockedReason::GhMissing))?;
    let runner = |argv: &[&str]| -> Result<String, GhRunError> {
        let owned: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
        run_gh_argv(cwd, &program, &owned)
    };
    let lookup = |owner_repo: &str, branch: &str| gh_lookup_pr_url(cwd, &program, owner_repo, branch);
    create_pull_request(cwd, registry_path, input, &runner, &lookup)
}

// Auto-clear rule (v1): merged PRs and head-ref divergence drop the link.
pub fn reconcile_link(
    registry_path: &Path,
    cwd: &Path,
    current: &PrStatus,
) -> Result<bool, String> {
    let record = match worktree_current(registry_path, cwd) {
        Some(record) => record,
        None => return Ok(false),
    };
    if record.linked_pr_url.as_deref() != Some(current.url.as_str()) {
        return Ok(false);
    }
    let diverged =
        current.state == "merged" || current.head_ref_name != record.branch;
    if !diverged {
        return Ok(false);
    }
    let mut registry = WorktreeRegistry::load(registry_path);
    if let Some(worktree) = registry.worktrees.get_mut(&record.id) {
        worktree.linked_pr_url = None;
    }
    registry.save(registry_path)?;
    Ok(true)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PollerConfig {
    pub tick: Duration,
    pub backoff_after: u32,
    pub backoff_tick: Duration,
}

impl Default for PollerConfig {
    fn default() -> Self {
        PollerConfig {
            tick: Duration::from_secs(60),
            backoff_after: 3,
            backoff_tick: Duration::from_secs(15 * 60),
        }
    }
}

// Per-worktree failure bookkeeping backing the 3-strikes/15min backoff.
#[derive(Debug, Default)]
pub struct PrPollerState {
    consecutive_failures: HashMap<String, u32>,
    last_attempt_ms: HashMap<String, u64>,
}

// One synchronous sweep over linked non-retired worktrees; returns fetch count.
// Publishes the worktree id per successful fetch (fresh data or link change).
pub fn poll_pass_once(
    state: &mut PrPollerState,
    config: &PollerConfig,
    registry_path: &Path,
    client: &dyn GhClient,
    now_ms: u64,
    publish: &mut dyn FnMut(Option<String>),
) -> usize {
    let registry = WorktreeRegistry::load(registry_path);
    let mut targets: Vec<WorktreeRecord> = registry
        .worktrees
        .values()
        .filter(|w| !w.retired && w.linked_pr_url.is_some())
        .cloned()
        .collect();
    targets.sort_by(|a, b| a.id.cmp(&b.id));

    let mut fetched = 0;
    for record in targets {
        let id = record.id.clone();
        let failures = state.consecutive_failures.get(&id).copied().unwrap_or(0);
        let last_attempt = state.last_attempt_ms.get(&id).copied().unwrap_or(0);
        let gated = failures >= config.backoff_after
            && now_ms < last_attempt.saturating_add(config.backoff_tick.as_millis() as u64);
        if gated {
            continue;
        }
        state.last_attempt_ms.insert(id.clone(), now_ms);
        // A vanished worktree is not a gh failure; skip without poisoning the counter.
        if !record.path.exists() {
            continue;
        }
        let url = record.linked_pr_url.clone().unwrap_or_default();
        match client.status(&record.path, &url) {
            Ok(status) => {
                state.consecutive_failures.insert(id.clone(), 0);
                let _ = reconcile_link(registry_path, &record.path, &status);
                publish(Some(id));
                fetched += 1;
            }
            Err(_) => {
                *state.consecutive_failures.entry(id).or_insert(0) += 1;
            }
        }
    }
    fetched
}

// On-demand path for IPC/manual refreshes: fetch, reconcile, publish, return status.
pub fn refresh_pr_status_now(
    cwd: &Path,
    registry_path: &Path,
    client: &dyn GhClient,
    publish: &mut dyn FnMut(Option<String>),
) -> Result<PrStatus, String> {
    let record = worktree_current(registry_path, cwd)
        .ok_or_else(|| "no linked pull request: worktree not registered".to_string())?;
    let url = record
        .linked_pr_url
        .clone()
        .ok_or_else(|| "no linked pull request".to_string())?;
    let status = client.status(cwd, &url)?;
    reconcile_link(registry_path, cwd, &status)?;
    publish(Some(record.id));
    Ok(status)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git::test_support::{
        clone_repo, commit_file, fake_gh_dir, git, sandbox, sandbox_with_origin, write_file,
    };
    use std::path::PathBuf;
    use std::sync::Mutex;

    const GH_HTTPS: &str = "https://github.com/oppa-tests/review-eligibility.git";

    fn set_github_origin(repo: &Path) {
        git(repo, &["remote", "set-url", "origin", GH_HTTPS]);
    }

    fn ok_probe() -> Result<(), BlockedReason> {
        Ok(())
    }

    fn no_pr(_owner_repo: &str, _branch: &str) -> Option<String> {
        None
    }

    // feature pushed+tracked while origin still points at the real bare remote.
    fn feature_ready(tag: &str) -> (crate::git::test_support::Sandbox, PathBuf) {
        let (s, bare) = sandbox_with_origin(tag);
        git(&s.repo, &["checkout", "-b", "feature"]);
        commit_file(&s.repo, "f.txt", "f", "feature work");
        git(&s.repo, &["push", "-u", "origin", "feature"]);
        (s, bare)
    }

    // Must be the LAST setup step: after this fetch/push would hit github.com.
    fn eligible_state(tag: &str) -> (crate::git::test_support::Sandbox, PathBuf) {
        let (s, bare) = feature_ready(tag);
        set_github_origin(&s.repo);
        (s, bare)
    }

    #[test]
    fn forge_info_https_with_git_suffix_parses_owner_repo() {
        let s = sandbox("hr-https-git");
        git(&s.repo, &["remote", "add", "origin", "https://github.com/Owner/Repo.git"]);
        let info = forge_info(&s.repo);
        assert_eq!(info.provider, ForgeProvider::Github);
        assert_eq!(info.owner_repo.as_deref(), Some("owner/Repo"));
    }

    #[test]
    fn forge_info_https_without_suffix_still_parses() {
        let s = sandbox("hr-https-bare");
        git(&s.repo, &["remote", "add", "origin", "https://github.com/alice/api"]);
        let info = forge_info(&s.repo);
        assert_eq!(info.provider, ForgeProvider::Github);
        assert_eq!(info.owner_repo.as_deref(), Some("alice/api"));
    }

    #[test]
    fn forge_info_ssh_scp_form_parses() {
        let s = sandbox("hr-ssh");
        git(&s.repo, &["remote", "add", "origin", "git@github.com:Owner/Repo.git"]);
        let info = forge_info(&s.repo);
        assert_eq!(info.provider, ForgeProvider::Github);
        assert_eq!(info.owner_repo.as_deref(), Some("owner/Repo"));
    }

    #[test]
    fn forge_info_lowercases_owner_but_keeps_repo_case() {
        let s = sandbox("hr-case");
        git(&s.repo, &["remote", "add", "origin", "https://github.com/CapOwner/RepoX.git"]);
        let info = forge_info(&s.repo);
        assert_eq!(info.owner_repo.as_deref(), Some("capowner/RepoX"));
    }

    #[test]
    fn forge_info_non_github_host_is_unsupported() {
        let s = sandbox("hr-gitlab");
        git(&s.repo, &["remote", "add", "origin", "https://gitlab.com/g/g.git"]);
        let info = forge_info(&s.repo);
        assert_eq!(info.provider, ForgeProvider::Unsupported);
        assert_eq!(info.owner_repo, None);
    }

    #[test]
    fn forge_info_missing_origin_is_unsupported() {
        let s = sandbox("hr-no-origin");
        let info = forge_info(&s.repo);
        assert_eq!(info.provider, ForgeProvider::Unsupported);
        assert_eq!(info.owner_repo, None);
    }

    #[test]
    fn parse_enterprise_host_requires_matching_configured_host() {
        let url = "https://github.mycompany.com/Team/Proj.git";
        assert_eq!(
            parse_origin_url_with_host(url, None).provider,
            ForgeProvider::Unsupported
        );
        assert_eq!(
            parse_origin_url_with_host(url, Some("other.host")).provider,
            ForgeProvider::Unsupported
        );
        let matched = parse_origin_url_with_host(url, Some("GitHub.MyCompany.com"));
        assert_eq!(matched.provider, ForgeProvider::Github);
        assert_eq!(matched.owner_repo.as_deref(), Some("team/Proj"));
    }

    #[test]
    fn review_types_serialize_kebab_case_for_ipc() {
        assert_eq!(serde_json::to_string(&ForgeProvider::Github).unwrap(), "\"github\"");
        assert_eq!(
            serde_json::to_string(&ForgeProvider::Unsupported).unwrap(),
            "\"unsupported\""
        );
        assert_eq!(
            serde_json::to_string(&BlockedReason::DetachedHead).unwrap(),
            "\"detached-head\""
        );
        assert_eq!(
            serde_json::to_string(&BlockedReason::ExistingReview).unwrap(),
            "\"existing-review\""
        );
        assert_eq!(
            serde_json::to_string(&BlockedReason::NeedsSync).unwrap(),
            "\"needs-sync\""
        );
        assert_eq!(
            serde_json::to_string(&BlockedReason::BaseNotOnRemote).unwrap(),
            "\"base-not-on-remote\""
        );
        assert_eq!(
            serde_json::to_string(&BlockedReason::GhMissing).unwrap(),
            "\"gh-missing\""
        );
    }

    fn garbage_path_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("oppa-empty-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn gh_available_missing_binary_reports_gh_missing() {
        let dir = garbage_path_dir("hr-gh-missing");
        assert_eq!(
            gh_available(Some(dir.as_os_str())).unwrap_err(),
            BlockedReason::GhMissing
        );
    }

    #[test]
    fn gh_available_shim_exit_zero_passes() {
        #[cfg(windows)]
        let dir = fake_gh_dir("@echo off\r\nexit /b 0\r\n");
        #[cfg(not(windows))]
        let dir = fake_gh_dir("#!/bin/sh\nexit 0\n");
        assert_eq!(gh_available(Some(dir.as_os_str())), Ok(()));
    }

    #[test]
    fn gh_available_shim_exit_one_reports_not_authed() {
        #[cfg(windows)]
        let dir = fake_gh_dir("@echo off\r\nexit /b 1\r\n");
        #[cfg(not(windows))]
        let dir = fake_gh_dir("#!/bin/sh\nexit 1\n");
        assert_eq!(
            gh_available(Some(dir.as_os_str())).unwrap_err(),
            BlockedReason::GhNotAuthed
        );
    }

    #[test]
    fn gh_available_kills_sleeping_shim_fast_and_reports_not_authed() {
        #[cfg(windows)]
        let dir = fake_gh_dir("@echo off\r\nwaitfor /t 90 oppaGhNever >nul\r\n");
        #[cfg(not(windows))]
        let dir = fake_gh_dir("#!/bin/sh\nsleep 90\n");
        let started = Instant::now();
        let err = gh_available(Some(dir.as_os_str())).unwrap_err();
        assert_eq!(err, BlockedReason::GhNotAuthed);
        // Kill must beat the 90s sleeper, not wait it out.
        assert!(started.elapsed() < Duration::from_secs(20));
    }

    #[test]
    fn resolve_base_ref_prefers_symbolic_ref_head_over_probe_chain() {
        let (s, _bare) = sandbox_with_origin("rb-symbolic");
        git(&s.repo, &["push", "origin", "HEAD:refs/heads/base-custom"]);
        git(&s.repo, &["fetch", "origin"]);
        git(&s.repo, &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/base-custom"]);
        assert_eq!(resolve_base_ref(&s.repo).unwrap(), "base-custom");
    }

    #[test]
    fn resolve_base_ref_falls_back_to_main_without_head_symbol() {
        let (s, _bare) = sandbox_with_origin("rb-main");
        assert_eq!(resolve_base_ref(&s.repo).unwrap(), "main");
    }

    #[test]
    fn resolve_base_ref_falls_back_to_master_when_only_master_exists() {
        let s = sandbox("rb-master");
        let bare = s.root.join("o.git");
        let bare_s = bare.to_string_lossy().into_owned();
        git(&s.root, &["init", "--bare", &bare_s]);
        git(&s.repo, &["remote", "add", "origin", &bare_s]);
        git(&s.repo, &["push", "origin", "main:master"]);
        git(&s.repo, &["fetch", "origin"]);
        assert_eq!(resolve_base_ref(&s.repo).unwrap(), "master");
    }

    #[test]
    fn resolve_base_ref_errors_when_nothing_on_remote() {
        let s = sandbox("rb-none");
        let ghost = s.root.join("ghost.git");
        let ghost_s = ghost.to_string_lossy().into_owned();
        git(&s.repo, &["remote", "add", "origin", &ghost_s]);
        assert_eq!(resolve_base_ref(&s.repo).unwrap_err(), BlockedReason::BaseNotOnRemote);
    }

    #[test]
    fn base_exists_on_remote_checks_ref_and_rejects_invalid_names() {
        let (s, _bare) = sandbox_with_origin("be-checks");
        assert!(base_exists_on_remote(&s.repo, "main"));
        git(&s.repo, &["update-ref", "-d", "refs/remotes/origin/main"]);
        assert!(!base_exists_on_remote(&s.repo, "main"));
        for bad in ["", "-x"] {
            assert!(!base_exists_on_remote(&s.repo, bad), "{bad:?} must fail closed");
        }
    }

    #[test]
    fn eligibility_detached_head_wins_before_everything() {
        let s = sandbox("el-detached");
        write_file(&s.repo, "dirty.txt", "x");
        git(&s.repo, &["checkout", "--detach"]);
        let out = review_eligibility(&s.repo, &ok_probe, &no_pr);
        assert_eq!(out.blocked_reason, Some(BlockedReason::DetachedHead));
        assert!(!out.eligible);
        assert_eq!(out.base_ref, None);
        assert_eq!(out.owner_repo, None);
    }

    #[test]
    fn eligibility_unsupported_provider_blocks_with_no_owner_repo() {
        let s = sandbox("el-provider");
        git(&s.repo, &["remote", "add", "origin", "https://gitlab.com/g/g.git"]);
        let out = review_eligibility(&s.repo, &ok_probe, &no_pr);
        assert_eq!(out.blocked_reason, Some(BlockedReason::UnsupportedProvider));
        assert_eq!(out.owner_repo, None);
    }

    #[test]
    fn eligibility_propagates_gh_missing_after_forge_gate() {
        let (s, _bare) = eligible_state("el-gh-missing");
        let dir = garbage_path_dir("el-gh-missing-dir");
        let probe = || gh_available(Some(dir.as_os_str()));
        let out = review_eligibility(&s.repo, &probe, &no_pr);
        assert_eq!(out.blocked_reason, Some(BlockedReason::GhMissing));
        assert_eq!(out.owner_repo.as_deref(), Some("oppa-tests/review-eligibility"));
        assert_eq!(out.base_ref, None);
    }

    #[test]
    fn eligibility_propagates_gh_not_authed_from_real_shim() {
        let (s, _bare) = eligible_state("el-gh-auth");
        #[cfg(windows)]
        let dir = fake_gh_dir("@echo off\r\nexit /b 1\r\n");
        #[cfg(not(windows))]
        let dir = fake_gh_dir("#!/bin/sh\nexit 1\n");
        let probe = || gh_available(Some(dir.as_os_str()));
        let out = review_eligibility(&s.repo, &probe, &no_pr);
        assert_eq!(out.blocked_reason, Some(BlockedReason::GhNotAuthed));
        assert_eq!(out.base_ref, None);
    }

    #[test]
    fn eligibility_default_branch_blocked_even_when_synced_clean() {
        let (s, _bare) = sandbox_with_origin("el-default");
        set_github_origin(&s.repo);
        let out = review_eligibility(&s.repo, &ok_probe, &no_pr);
        assert_eq!(out.blocked_reason, Some(BlockedReason::DefaultBranch));
        assert_eq!(out.base_ref.as_deref(), Some("main"));
        assert_eq!(out.owner_repo.as_deref(), Some("oppa-tests/review-eligibility"));
    }

    #[test]
    fn eligibility_dirty_beats_upstream_rungs_including_untracked() {
        let (s, _bare) = sandbox_with_origin("el-dirty-order");
        git(&s.repo, &["checkout", "-b", "feature"]);
        commit_file(&s.repo, "f.txt", "f", "feature work without push");
        write_file(&s.repo, "untracked.txt", "x");
        set_github_origin(&s.repo);
        let out = review_eligibility(&s.repo, &ok_probe, &no_pr);
        assert_eq!(out.blocked_reason, Some(BlockedReason::Dirty));
        assert_eq!(out.base_ref.as_deref(), Some("main"));
    }

    #[test]
    fn eligibility_no_upstream_when_branch_never_pushed() {
        let (s, _bare) = sandbox_with_origin("el-no-upstream");
        git(&s.repo, &["checkout", "-b", "feature"]);
        commit_file(&s.repo, "f.txt", "f", "local only work");
        set_github_origin(&s.repo);
        let out = review_eligibility(&s.repo, &ok_probe, &no_pr);
        assert_eq!(out.blocked_reason, Some(BlockedReason::NoUpstream));
        assert_eq!(out.base_ref.as_deref(), Some("main"));
    }

    #[test]
    fn eligibility_needs_sync_when_behind_upstream() {
        let (s, bare) = feature_ready("el-sync");
        let twin = s.root.join("twin");
        clone_repo(&bare, &twin);
        git(&twin, &["checkout", "-b", "feature", "origin/feature"]);
        commit_file(&twin, "tw.txt", "tw", "twin advances feature");
        git(&twin, &["push", "origin", "feature"]);
        git(&s.repo, &["fetch", "origin"]);
        set_github_origin(&s.repo);
        let out = review_eligibility(&s.repo, &ok_probe, &no_pr);
        assert_eq!(out.blocked_reason, Some(BlockedReason::NeedsSync));
    }

    #[test]
    fn eligibility_needs_push_when_ahead_of_upstream() {
        let (s, _bare) = eligible_state("el-push");
        commit_file(&s.repo, "next.txt", "n", "unpushed local commit");
        let out = review_eligibility(&s.repo, &ok_probe, &no_pr);
        assert_eq!(out.blocked_reason, Some(BlockedReason::NeedsPush));
    }

    #[test]
    fn eligibility_base_not_on_remote_fails_closed() {
        let (s, _bare) = eligible_state("el-base-gone");
        git(&s.repo, &["update-ref", "-d", "refs/remotes/origin/main"]);
        let out = review_eligibility(&s.repo, &ok_probe, &no_pr);
        assert_eq!(out.blocked_reason, Some(BlockedReason::BaseNotOnRemote));
    }

    #[test]
    fn eligibility_happy_path_is_fully_eligible_and_passes_lookup_args() {
        let (s, _bare) = eligible_state("el-happy");
        let calls: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());
        let lookup = |owner_repo: &str, branch: &str| {
            calls.lock().unwrap().push((owner_repo.to_string(), branch.to_string()));
            None
        };
        let out = review_eligibility(&s.repo, &ok_probe, &lookup);
        assert!(out.eligible);
        assert_eq!(out.blocked_reason, None);
        assert_eq!(out.existing_pr_url, None);
        assert_eq!(out.base_ref.as_deref(), Some("main"));
        assert_eq!(out.owner_repo.as_deref(), Some("oppa-tests/review-eligibility"));
        assert_eq!(*calls.lock().unwrap(), vec![("oppa-tests/review-eligibility".to_string(), "feature".to_string())]);
    }

    #[test]
    fn eligibility_existing_review_stays_eligible_with_pr_url() {
        let (s, _bare) = eligible_state("el-existing");
        let lookup = |owner_repo: &str, _branch: &str| {
            assert_eq!(owner_repo, "oppa-tests/review-eligibility");
            Some("https://github.com/oppa-tests/review-eligibility/pull/7".to_string())
        };
        let out = review_eligibility(&s.repo, &ok_probe, &lookup);
        assert!(out.eligible);
        assert_eq!(out.blocked_reason, None);
        assert_eq!(
            out.existing_pr_url.as_deref(),
            Some("https://github.com/oppa-tests/review-eligibility/pull/7")
        );
        assert_eq!(out.base_ref.as_deref(), Some("main"));
    }

    #[test]
    fn live_wrapper_runs_full_ladder_against_local_bare_origin_as_unsupported() {
        let (s, _bare) = feature_ready("el-live");
        let out = review_eligibility_live(&s.repo);
        assert_eq!(out.blocked_reason, Some(BlockedReason::UnsupportedProvider));
    }

    // ---------- task 2: pr creation service ----------

    use crate::git::worktree_registry::{
        worktree_record_id, WorktreeRecord, WorktreeRegistry, WorktreeStatus,
    };

    const CREATED_URL: &str = "https://github.com/oppa-tests/review-eligibility/pull/9";

    type ArgvLog = Mutex<Vec<Vec<String>>>;

    fn review_input(title: &str, body: &str, draft: bool) -> CreateReviewInput {
        CreateReviewInput { title: title.into(), body: body.into(), draft }
    }

    fn log_args(log: &ArgvLog, argv: &[&str]) {
        log.lock().unwrap().push(argv.iter().map(|s| s.to_string()).collect());
    }

    fn create_calls(log: &ArgvLog) -> Vec<Vec<String>> {
        log.lock()
            .unwrap()
            .iter()
            .filter(|c| c.first().map(String::as_str) == Some("pr"))
            .cloned()
            .collect()
    }

    fn register_worktree_at(registry_path: &Path, repo_id: &str, name: &str, path: &Path) -> String {
        let id = worktree_record_id(repo_id, path);
        registry_path.parent().map(std::fs::create_dir_all).unwrap_or(Ok(())).unwrap();
        let mut registry = WorktreeRegistry::load(registry_path);
        registry.upsert_worktree(WorktreeRecord {
            id: id.clone(),
            repo_id: repo_id.into(),
            name: name.into(),
            display_name: None,
            branch: "feature".into(),
            path: path.to_path_buf(),
            base_ref: "main".into(),
            parent_worktree_id: None,
            child_worktree_ids: vec![],
            workspace_status: WorktreeStatus::Todo,
            retired: false,
            created_at_ms: 0,
            linked_pr_url: None,
        });
        registry.save(registry_path).unwrap();
        id
    }

    // Echo runner: auth passes, pr create yields CREATED_URL; every argv is logged.
    fn echo_runner(log: &ArgvLog) -> impl Fn(&[&str]) -> Result<String, GhRunError> + '_ {
        move |argv: &[&str]| {
            log_args(log, argv);
            if argv.first() == Some(&"auth") {
                Ok(String::new())
            } else {
                Ok(format!("{CREATED_URL}\n"))
            }
        }
    }

    #[test]
    fn create_happy_path_argv_body_lifecycle_and_nested_prefix_stamp() {
        let (s, _bare) = eligible_state("cr-happy");
        let root_record = register_worktree_at(&s.registry_path, "r1", "root-wt", &s.repo);
        std::fs::create_dir_all(s.repo.join("src")).unwrap();
        let nested_record =
            register_worktree_at(&s.registry_path, "r1", "nested-wt", &s.repo.join("src"));
        let log: ArgvLog = Mutex::new(Vec::new());
        let body_seen_during_call = Mutex::new(None::<bool>);
        let runner = |argv: &[&str]| -> Result<String, GhRunError> {
            log_args(&log, argv);
            if argv.first() == Some(&"auth") {
                return Ok(String::new());
            }
            let body_index = argv.iter().position(|a| *a == "--body-file").unwrap() + 1;
            *body_seen_during_call.lock().unwrap() = Some(Path::new(argv[body_index]).exists());
            Ok(format!("{CREATED_URL}\n"))
        };
        let out = create_pull_request(
            &s.repo.join("src"),
            &s.registry_path,
            review_input("Title", "Body", false),
            &runner,
            &no_pr,
        )
        .unwrap();
        assert_eq!(
            out,
            CreatedReview {
                pr_url: CREATED_URL.into(),
                pr_number: Some(9),
                base_ref: "main".into(),
                owner_repo: "oppa-tests/review-eligibility".into(),
            }
        );
        let calls = create_calls(&log);
        assert_eq!(calls.len(), 1);
        let argv = &calls[0];
        assert_eq!(argv[0], "pr");
        assert_eq!(argv[1], "create");
        assert_eq!(argv[2], "--repo");
        assert_eq!(argv[3], "oppa-tests/review-eligibility");
        assert_eq!(argv[4], "--base");
        assert_eq!(argv[5], "main");
        assert_eq!(argv[6], "--title");
        assert_eq!(argv[7], "Title");
        assert_eq!(argv[8], "--body-file");
        assert!(argv[9].contains("oppa-pr-body-"), "{}", argv[9]);
        assert_eq!(argv[10], "--head");
        assert_eq!(argv[11], "feature");
        assert_eq!(argv.len(), 12);
        assert_eq!(*body_seen_during_call.lock().unwrap(), Some(true));
        assert!(!PathBuf::from(&argv[9]).exists(), "temp body must be deleted after spawn");
        let registry = WorktreeRegistry::load(&s.registry_path);
        assert_eq!(
            registry.worktrees[&nested_record].linked_pr_url.as_deref(),
            Some(CREATED_URL)
        );
        assert_eq!(registry.worktrees[&root_record].linked_pr_url, None);
    }

    #[test]
    fn create_draft_flag_appended_when_requested() {
        let (s, _bare) = eligible_state("cr-draft");
        let log: ArgvLog = Mutex::new(Vec::new());
        create_pull_request(
            &s.repo,
            &s.registry_path,
            review_input("T", "B", true),
            &echo_runner(&log),
            &no_pr,
        )
        .unwrap();
        let argv = &create_calls(&log)[0];
        assert_eq!(argv.last().map(String::as_str), Some("--draft"));
        assert_eq!(argv[argv.len() - 2], "feature");
    }

    #[test]
    fn create_blocked_by_dirty_rung_never_spawns_create() {
        let (s, _bare) = eligible_state("cr-dirty");
        write_file(&s.repo, "uncommitted.txt", "x");
        let log: ArgvLog = Mutex::new(Vec::new());
        let err = create_pull_request(
            &s.repo,
            &s.registry_path,
            review_input("T", "B", false),
            &echo_runner(&log),
            &no_pr,
        )
        .unwrap_err();
        assert!(err.contains("blocked: dirty"), "{err}");
        assert!(create_calls(&log).is_empty());
    }

    #[test]
    fn create_existing_pr_short_circuits_without_create_call() {
        let (s, _bare) = eligible_state("cr-existing");
        let record = register_worktree_at(&s.registry_path, "r", "wt", &s.repo);
        let existing = "https://github.com/oppa-tests/review-eligibility/pull/4".to_string();
        let log: ArgvLog = Mutex::new(Vec::new());
        let lookup_existing =
            |_owner_repo: &str, _branch: &str| Some("https://github.com/oppa-tests/review-eligibility/pull/4".to_string());
        let out = create_pull_request(
            &s.repo,
            &s.registry_path,
            review_input("T", "B", false),
            &echo_runner(&log),
            &lookup_existing,
        )
        .unwrap();
        assert_eq!(out.pr_url, existing);
        assert_eq!(out.pr_number, Some(4));
        assert!(create_calls(&log).is_empty());
        let registry = WorktreeRegistry::load(&s.registry_path);
        assert_eq!(registry.worktrees[&record].linked_pr_url.as_deref(), Some(existing.as_str()));
    }

    #[test]
    fn create_blank_stdout_recovers_pr_via_lookup_probe() {
        let (s, _bare) = eligible_state("cr-blank");
        let record = register_worktree_at(&s.registry_path, "r", "wt", &s.repo);
        let log: ArgvLog = Mutex::new(Vec::new());
        let blank_runner = |argv: &[&str]| -> Result<String, GhRunError> {
            log_args(&log, argv);
            if argv.first() == Some(&"auth") {
                Ok(String::new())
            } else {
                Ok("   \n".into())
            }
        };
        let recovered = "https://github.com/oppa-tests/review-eligibility/pull/11".to_string();
        let lookup_found = {
            let recovered = recovered.clone();
            move |_owner_repo: &str, _branch: &str| Some(recovered.clone())
        };
        let out = create_pull_request(
            &s.repo,
            &s.registry_path,
            review_input("T", "B", false),
            &blank_runner,
            &lookup_found,
        )
        .unwrap();
        assert_eq!(out.pr_url, recovered);
        assert_eq!(out.pr_number, Some(11));
        let registry = WorktreeRegistry::load(&s.registry_path);
        assert_eq!(registry.worktrees[&record].linked_pr_url.as_deref(), Some(recovered.as_str()));
    }

    #[test]
    fn create_unusable_stdout_without_probe_hit_errors_with_context() {
        let (s, _bare) = eligible_state("cr-unusable");
        let log: ArgvLog = Mutex::new(Vec::new());
        let noise_runner = |argv: &[&str]| -> Result<String, GhRunError> {
            log_args(&log, argv);
            if argv.first() == Some(&"auth") {
                Ok(String::new())
            } else {
                Ok("creating pull request...\n".into())
            }
        };
        let err = create_pull_request(
            &s.repo,
            &s.registry_path,
            review_input("T", "B", false),
            &noise_runner,
            &no_pr,
        )
        .unwrap_err();
        assert!(err.contains("pr create failed"), "{err}");
    }

    #[test]
    fn create_already_exists_error_takes_recovery_probe_path() {
        let (s, _bare) = eligible_state("cr-exists-hit");
        let log: ArgvLog = Mutex::new(Vec::new());
        let dup_runner = |argv: &[&str]| -> Result<String, GhRunError> {
            log_args(&log, argv);
            if argv.first() == Some(&"auth") {
                return Ok(String::new());
            }
            Err(GhRunError::Failed {
                stderr: "a pull request for branch \"feature\" already exists".into(),
            })
        };
        let found = "https://github.com/oppa-tests/review-eligibility/pull/12";
        let lookup_found = |_owner_repo: &str, _branch: &str| Some(found.to_string());
        let out = create_pull_request(
            &s.repo,
            &s.registry_path,
            review_input("T", "B", false),
            &dup_runner,
            &lookup_found,
        )
        .unwrap();
        assert_eq!(out.pr_url, found);
        assert_eq!(out.pr_number, Some(12));
    }

    #[test]
    fn create_already_exists_without_found_pr_reports_stderr_context() {
        let (s, _bare) = eligible_state("cr-exists-miss");
        let log: ArgvLog = Mutex::new(Vec::new());
        let dup_runner = |argv: &[&str]| -> Result<String, GhRunError> {
            log_args(&log, argv);
            if argv.first() == Some(&"auth") {
                return Ok(String::new());
            }
            Err(GhRunError::Failed {
                stderr: "a pull request for branch \"feature\" already exists".into(),
            })
        };
        let err = create_pull_request(
            &s.repo,
            &s.registry_path,
            review_input("T", "B", false),
            &dup_runner,
            &no_pr,
        )
        .unwrap_err();
        assert!(err.contains("pr create failed") && err.contains("already exists"), "{err}");
    }

    #[test]
    fn create_timeout_probes_then_reports_timeout_when_absent() {
        let (s, _bare) = eligible_state("cr-timeout");
        let started = Instant::now();
        let slow_runner = |argv: &[&str]| -> Result<String, GhRunError> {
            if argv.first() == Some(&"auth") {
                return Ok(String::new());
            }
            Err(GhRunError::TimedOut)
        };
        let found = "https://github.com/oppa-tests/review-eligibility/pull/13";
        let lookup_found = |_owner_repo: &str, _branch: &str| Some(found.to_string());
        let out = create_pull_request(
            &s.repo,
            &s.registry_path,
            review_input("T", "B", false),
            &slow_runner,
            &lookup_found,
        )
        .unwrap();
        assert_eq!(out.pr_url, found);
        let err = create_pull_request(
            &s.repo,
            &s.registry_path,
            review_input("T", "B", false),
            &slow_runner,
            &no_pr,
        )
        .unwrap_err();
        assert!(err.contains("gh timed out after 60s"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(20));
    }

    #[test]
    fn create_rejects_bad_titles_before_any_gh_call() {
        let (s, _bare) = eligible_state("cr-title");
        let log: ArgvLog = Mutex::new(Vec::new());
        for bad in ["".to_string(), "   ".into(), "\t\n".into(), "x".repeat(201)] {
            let err = create_pull_request(
                &s.repo,
                &s.registry_path,
                review_input(&bad, "B", false),
                &echo_runner(&log),
                &no_pr,
            )
            .unwrap_err();
            assert!(err.contains("title"), "{err}");
        }
        assert!(log.lock().unwrap().is_empty());
        let ok = create_pull_request(
            &s.repo,
            &s.registry_path,
            review_input(&"x".repeat(200), "B", false),
            &echo_runner(&log),
            &no_pr,
        )
        .unwrap();
        assert_eq!(ok.pr_number, Some(9));
    }

    #[test]
    fn create_rejects_oversized_body_before_any_gh_call() {
        let (s, _bare) = eligible_state("cr-body");
        let log: ArgvLog = Mutex::new(Vec::new());
        let oversized = "a".repeat(64 * 1024 + 1);
        let err = create_pull_request(
            &s.repo,
            &s.registry_path,
            review_input("T", &oversized, false),
            &echo_runner(&log),
            &no_pr,
        )
        .unwrap_err();
        assert!(err.contains("body"), "{err}");
        assert!(log.lock().unwrap().is_empty());
        let boundary = "a".repeat(64 * 1024);
        create_pull_request(
            &s.repo,
            &s.registry_path,
            review_input("T", &boundary, false),
            &echo_runner(&log),
            &no_pr,
        )
        .unwrap();
    }

    #[test]
    fn create_skips_stamping_silently_without_matching_worktree() {
        let (s, _bare) = eligible_state("cr-nostamp");
        let missing_registry = s.root.join("does-not-exist.json");
        let throwaway_log: ArgvLog = Mutex::new(Vec::new());
        let out = create_pull_request(
            &s.repo,
            &missing_registry,
            review_input("T", "B", false),
            &echo_runner(&throwaway_log),
            &no_pr,
        );
        let _ = out;
        assert!(!missing_registry.exists());
        register_worktree_at(&s.registry_path, "r", "other", Path::new("Z:\\elsewhere"));
        let log: ArgvLog = Mutex::new(Vec::new());
        create_pull_request(
            &s.repo,
            &s.registry_path,
            review_input("T", "B", false),
            &echo_runner(&log),
            &no_pr,
        )
        .unwrap();
        let registry = WorktreeRegistry::load(&s.registry_path);
        assert!(registry.worktrees.values().all(|w| w.linked_pr_url.is_none()));
    }

    // ---------- task 3: pr status parsing + poller ----------

    const PR_VIEW_JSON: &str = r#"{
        "number": 42,
        "title": "Add polling",
        "url": "https://github.com/oppa-tests/review-eligibility/pull/42",
        "state": "OPEN",
        "isDraft": true,
        "mergeable": "CONFLICTING",
        "baseRefName": "main",
        "headRefName": "feature",
        "statusCheckRollup": [
            {"__typename": "CheckRun", "name": "build", "status": "COMPLETED", "conclusion": "SUCCESS", "completedAt": "2026-08-23T10:00:00Z"},
            {"__typename": "StatusContext", "context": "ci/travis", "state": "FAILURE", "targetUrl": "https://example.com/y"},
            {"__typename": "CheckRun", "name": "e2e", "status": "IN_PROGRESS", "conclusion": null},
            {"__typename": "StatusContext", "context": "docs", "state": "SKIPPED"}
        ]
    }"#;

    fn rollup_check_state(entry_json: &str) -> CheckState {
        let json = format!(
            r#"{{"number":1,"title":"t","url":"u","state":"OPEN","isDraft":false,"mergeable":"UNKNOWN","baseRefName":"b","headRefName":"h","statusCheckRollup":[{entry_json}]}}"#
        );
        pr_status_from_json(&json, 0).unwrap().checks.remove(0).state
    }

    fn open_status(url: &str, head_ref: &str) -> PrStatus {
        PrStatus {
            number: 9,
            title: "T".into(),
            url: url.into(),
            state: "open".into(),
            draft: false,
            mergeable: "mergeable".into(),
            base_ref_name: "main".into(),
            head_ref_name: head_ref.into(),
            checks: vec![],
            fetched_at_ms: 0,
        }
    }

    fn link_pr(registry_path: &Path, id: &str, url: &str) {
        let mut registry = WorktreeRegistry::load(registry_path);
        registry.worktrees.get_mut(id).unwrap().linked_pr_url = Some(url.into());
        registry.save(registry_path).unwrap();
    }

    fn retire_record(registry_path: &Path, id: &str) {
        let mut registry = WorktreeRegistry::load(registry_path);
        registry.worktrees.get_mut(id).unwrap().retired = true;
        registry.save(registry_path).unwrap();
    }

    struct MockClient {
        result: Result<PrStatus, String>,
        calls: Mutex<Vec<(String, String)>>,
    }

    impl MockClient {
        fn returning(result: Result<PrStatus, String>) -> Self {
            MockClient { result, calls: Mutex::new(Vec::new()) }
        }
    }

    impl GhClient for MockClient {
        fn status(&self, cwd: &Path, url: &str) -> Result<PrStatus, String> {
            self.calls
                .lock()
                .unwrap()
                .push((cwd.to_string_lossy().into_owned(), url.to_string()));
            self.result.clone()
        }
    }

    // Failure/success flips mid-sequence so backoff reset can be driven in-process.
    struct ToggleClient {
        failing: Mutex<bool>,
        calls: Mutex<Vec<String>>,
    }

    impl GhClient for ToggleClient {
        fn status(&self, _cwd: &Path, url: &str) -> Result<PrStatus, String> {
            self.calls.lock().unwrap().push(url.to_string());
            if *self.failing.lock().unwrap() {
                Err("gh down".into())
            } else {
                Ok(open_status(url, "feature"))
            }
        }
    }

    fn short_backoff_config() -> PollerConfig {
        PollerConfig {
            tick: Duration::from_secs(60),
            backoff_after: 2,
            backoff_tick: Duration::from_secs(900),
        }
    }

    #[test]
    fn pr_status_from_json_parses_every_field_lowercased_with_timestamp() {
        let status = pr_status_from_json(PR_VIEW_JSON, 1724419200123).unwrap();
        assert_eq!(status.number, 42);
        assert_eq!(status.title, "Add polling");
        assert_eq!(
            status.url,
            "https://github.com/oppa-tests/review-eligibility/pull/42"
        );
        assert_eq!(status.state, "open");
        assert!(status.draft);
        assert_eq!(status.mergeable, "conflicting");
        assert_eq!(status.base_ref_name, "main");
        assert_eq!(status.head_ref_name, "feature");
        assert_eq!(status.fetched_at_ms, 1724419200123);
        assert_eq!(status.checks.len(), 4);
    }

    #[test]
    fn rollup_maps_all_four_buckets_and_unknown_to_pending() {
        let status = pr_status_from_json(PR_VIEW_JSON, 0).unwrap();
        let state_of =
            |name: &str| status.checks.iter().find(|c| c.name == name).unwrap().state;
        // conclusion beats the COMPLETED wrapper status; completedAt-style extras are ignored
        assert_eq!(state_of("build"), CheckState::Passing);
        assert_eq!(state_of("ci/travis"), CheckState::Failing);
        assert_eq!(state_of("e2e"), CheckState::Pending);
        assert_eq!(state_of("docs"), CheckState::Skipping);
    }

    #[test]
    fn check_state_tokens_cover_buckets_context_names_and_unknown_pending() {
        assert_eq!(rollup_check_state(r#"{"name":"c","state":"SUCCESS"}"#), CheckState::Passing);
        assert_eq!(rollup_check_state(r#"{"name":"c","state":"PASS"}"#), CheckState::Passing);
        assert_eq!(rollup_check_state(r#"{"name":"c","state":"FAILURE"}"#), CheckState::Failing);
        assert_eq!(rollup_check_state(r#"{"name":"c","status":"ERROR"}"#), CheckState::Failing);
        assert_eq!(rollup_check_state(r#"{"name":"c","state":"FAILING"}"#), CheckState::Failing);
        assert_eq!(rollup_check_state(r#"{"name":"c","state":"PENDING"}"#), CheckState::Pending);
        assert_eq!(rollup_check_state(r#"{"name":"c","status":"IN_PROGRESS"}"#), CheckState::Pending);
        assert_eq!(rollup_check_state(r#"{"name":"c","state":"QUEUED"}"#), CheckState::Pending);
        assert_eq!(rollup_check_state(r#"{"name":"c","state":"SKIPPED"}"#), CheckState::Skipping);
        assert_eq!(rollup_check_state(r#"{"name":"c","state":"NEUTRAL"}"#), CheckState::Skipping);
        assert_eq!(rollup_check_state(r#"{"name":"c","state":"MYSTERY"}"#), CheckState::Pending);
        assert_eq!(rollup_check_state(r#"{"name":"c","status":"COMPLETED"}"#), CheckState::Pending);
        assert_eq!(rollup_check_state(r#"{"context":"deploy","state":"SUCCESS"}"#), CheckState::Passing);
        assert_eq!(rollup_check_state(r#"{"context":"deploy"}"#), CheckState::Pending);
    }

    #[test]
    fn malformed_or_incomplete_pr_json_errors() {
        assert!(pr_status_from_json("not json at all", 0).is_err());
        assert!(pr_status_from_json(r#"{"number":1}"#, 0).is_err());
    }

    #[test]
    fn check_state_serializes_kebab_for_ipc() {
        assert_eq!(serde_json::to_string(&CheckState::Passing).unwrap(), "\"passing\"");
        assert_eq!(serde_json::to_string(&CheckState::Failing).unwrap(), "\"failing\"");
        assert_eq!(serde_json::to_string(&CheckState::Pending).unwrap(), "\"pending\"");
        assert_eq!(serde_json::to_string(&CheckState::Skipping).unwrap(), "\"skipping\"");
        assert!(serde_json::from_str::<CheckState>("\"bogus\"").is_err());
    }

    #[test]
    fn pr_status_builds_view_argv_and_propagates_runner_failure() {
        let log: ArgvLog = Mutex::new(Vec::new());
        {
            let runner = |argv: &[&str]| -> Result<String, GhRunError> {
                log_args(&log, argv);
                Ok(PR_VIEW_JSON.into())
            };
            let status = pr_status(Path::new("."), CREATED_URL, &runner).unwrap();
            assert_eq!(status.number, 42);
        }
        assert_eq!(
            *log.lock().unwrap(),
            vec![vec![
                "pr".to_string(),
                "view".into(),
                CREATED_URL.into(),
                "--json".into(),
                "number,title,url,state,isDraft,mergeable,baseRefName,headRefName,statusCheckRollup"
                    .into(),
            ]]
        );
        let failing =
            |_argv: &[&str]| -> Result<String, GhRunError> {
                Err(GhRunError::Failed { stderr: "gh exploded".into() })
            };
        assert!(pr_status(Path::new("."), CREATED_URL, &failing)
            .unwrap_err()
            .contains("gh exploded"));
    }

    #[test]
    fn reconcile_merged_clears_and_persists() {
        let (s, _bare) = eligible_state("rc-merged");
        let id = register_worktree_at(&s.registry_path, "r", "wt", &s.repo);
        link_pr(&s.registry_path, &id, CREATED_URL);
        let mut merged = open_status(CREATED_URL, "feature");
        merged.state = "merged".into();
        assert_eq!(reconcile_link(&s.registry_path, &s.repo, &merged).unwrap(), true);
        assert!(WorktreeRegistry::load(&s.registry_path).worktrees[&id].linked_pr_url.is_none());
    }

    #[test]
    fn reconcile_head_ref_divergence_clears_link() {
        let (s, _bare) = eligible_state("rc-diverge");
        let id = register_worktree_at(&s.registry_path, "r", "wt", &s.repo);
        link_pr(&s.registry_path, &id, CREATED_URL);
        let renamed = open_status(CREATED_URL, "renamed-branch");
        assert_eq!(reconcile_link(&s.registry_path, &s.repo, &renamed).unwrap(), true);
        assert!(WorktreeRegistry::load(&s.registry_path).worktrees[&id].linked_pr_url.is_none());
    }

    #[test]
    fn reconcile_open_matching_head_keeps_link() {
        let (s, _bare) = eligible_state("rc-keep");
        let id = register_worktree_at(&s.registry_path, "r", "wt", &s.repo);
        link_pr(&s.registry_path, &id, CREATED_URL);
        let fresh = open_status(CREATED_URL, "feature");
        assert_eq!(reconcile_link(&s.registry_path, &s.repo, &fresh).unwrap(), false);
        assert_eq!(
            WorktreeRegistry::load(&s.registry_path).worktrees[&id].linked_pr_url.as_deref(),
            Some(CREATED_URL)
        );
    }

    #[test]
    fn reconcile_unlinked_missing_or_foreign_url_no_ops() {
        let (s, _bare) = eligible_state("rc-noop");
        // No record covering cwd at all
        assert_eq!(
            reconcile_link(&s.registry_path, &s.repo, &open_status(CREATED_URL, "feature"))
                .unwrap(),
            false
        );
        // Record exists but never linked
        let id = register_worktree_at(&s.registry_path, "r", "wt", &s.repo);
        assert_eq!(
            reconcile_link(&s.registry_path, &s.repo, &open_status(CREATED_URL, "feature"))
                .unwrap(),
            false
        );
        assert!(WorktreeRegistry::load(&s.registry_path).worktrees[&id].linked_pr_url.is_none());
        // Linked to a different PR than the fetched one
        link_pr(&s.registry_path, &id, "https://github.com/other/repo/pull/1");
        assert_eq!(
            reconcile_link(&s.registry_path, &s.repo, &open_status(CREATED_URL, "feature"))
                .unwrap(),
            false
        );
        assert_eq!(
            WorktreeRegistry::load(&s.registry_path).worktrees[&id].linked_pr_url.as_deref(),
            Some("https://github.com/other/repo/pull/1")
        );
    }

    #[test]
    fn poll_pass_fetches_linked_active_records_and_publishes_ids() {
        let (s, _bare) = eligible_state("pp-fetch");
        std::fs::create_dir_all(s.repo.join("src")).unwrap();
        let id_a = register_worktree_at(&s.registry_path, "r", "wt-a", &s.repo);
        let id_b = register_worktree_at(&s.registry_path, "r", "wt-b", &s.repo.join("src"));
        let id_retired = register_worktree_at(&s.registry_path, "r", "wt-old", Path::new("Z:\\gone"));
        let _id_unlinked =
            register_worktree_at(&s.registry_path, "r", "wt-bare", Path::new("Z:\\unlinked"));
        for id in [&id_a, &id_b, &id_retired] {
            link_pr(&s.registry_path, id, CREATED_URL);
        }
        retire_record(&s.registry_path, &id_retired);

        let client = MockClient::returning(Ok(open_status(CREATED_URL, "feature")));
        let mut state = PrPollerState::default();
        let mut published: Vec<Option<String>> = Vec::new();
        let fetched = poll_pass_once(
            &mut state,
            &short_backoff_config(),
            &s.registry_path,
            &client,
            unix_now_ms(),
            &mut |id| published.push(id),
        );
        assert_eq!(fetched, 2);
        let mut ids: Vec<String> = published.into_iter().flatten().collect();
        ids.sort();
        let mut expected = vec![id_a, id_b];
        expected.sort();
        assert_eq!(ids, expected);
        assert_eq!(client.calls.lock().unwrap().len(), 2);
        assert!(state.consecutive_failures.values().all(|count| *count == 0));
    }

    #[test]
    fn poll_pass_skips_missing_paths_without_counting_failure() {
        let (s, _bare) = eligible_state("pp-missing");
        let id = register_worktree_at(&s.registry_path, "r", "wt", Path::new("Z:\\not-here"));
        link_pr(&s.registry_path, &id, CREATED_URL);
        let client = MockClient::returning(Ok(open_status(CREATED_URL, "feature")));
        let mut state = PrPollerState::default();
        let fetched = poll_pass_once(
            &mut state,
            &short_backoff_config(),
            &s.registry_path,
            &client,
            unix_now_ms(),
            &mut |_| {},
        );
        assert_eq!(fetched, 0);
        assert!(client.calls.lock().unwrap().is_empty());
        assert!(state.consecutive_failures.get(&id).is_none());
    }

    #[test]
    fn poll_pass_gates_attempts_after_consecutive_failures_until_window_elapses() {
        let (s, _bare) = eligible_state("pp-backoff");
        let id = register_worktree_at(&s.registry_path, "r", "wt", &s.repo);
        link_pr(&s.registry_path, &id, CREATED_URL);
        let client = MockClient::returning(Err("gh down".into()));
        let config = short_backoff_config();
        let mut state = PrPollerState::default();
        let mut pass = |now_ms: u64| {
            poll_pass_once(&mut state, &config, &s.registry_path, &client, now_ms, &mut |_| {})
        };
        pass(1_000);
        pass(2_000);
        pass(3_000);
        pass(901_000);
        pass(902_500);
        pass(906_000);
        assert_eq!(client.calls.lock().unwrap().len(), 3, "gated windows must suppress attempts");
        assert_eq!(state.consecutive_failures.get(&id), Some(&3));
        assert_eq!(state.last_attempt_ms.get(&id), Some(&902_500));
    }

    #[test]
    fn poll_pass_success_resets_backoff_counter() {
        let (s, _bare) = eligible_state("pp-reset");
        let id = register_worktree_at(&s.registry_path, "r", "wt", &s.repo);
        link_pr(&s.registry_path, &id, CREATED_URL);
        let client = ToggleClient { failing: Mutex::new(true), calls: Mutex::new(Vec::new()) };
        let config = short_backoff_config();
        let mut state = PrPollerState::default();
        let mut published: Vec<Option<String>> = Vec::new();
        let mut pass = |failing: bool, now_ms: u64| {
            *client.failing.lock().unwrap() = failing;
            poll_pass_once(&mut state, &config, &s.registry_path, &client, now_ms, &mut |id| {
                published.push(id);
            })
        };
        assert_eq!(pass(true, 1_000), 0);
        assert_eq!(pass(true, 2_000), 0);
        assert_eq!(pass(false, 902_500), 1, "window-expired retry succeeds and resets");
        assert_eq!(pass(true, 903_000), 0, "fresh failure attempts immediately below threshold");
        assert_eq!(client.calls.lock().unwrap().len(), 4);
        assert_eq!(state.consecutive_failures.get(&id), Some(&1));
        assert_eq!(published, vec![Some(id)]);
    }

    #[test]
    fn refresh_now_fetches_reconciles_and_publishes_worktree_id() {
        let (s, _bare) = eligible_state("rf-now");
        let id = register_worktree_at(&s.registry_path, "r", "wt", &s.repo);
        link_pr(&s.registry_path, &id, CREATED_URL);
        let mut merged = open_status(CREATED_URL, "feature");
        merged.state = "merged".into();
        let client = MockClient::returning(Ok(merged));
        let mut published: Vec<Option<String>> = Vec::new();
        let out = refresh_pr_status_now(&s.repo, &s.registry_path, &client, &mut |wid| {
            published.push(wid);
        })
        .unwrap();
        assert_eq!(out.url, CREATED_URL);
        assert_eq!(out.state, "merged");
        assert_eq!(published, vec![Some(id.clone())]);
        assert!(WorktreeRegistry::load(&s.registry_path).worktrees[&id].linked_pr_url.is_none());
        assert_eq!(
            client.calls.lock().unwrap()[0],
            (s.repo.to_string_lossy().into_owned(), CREATED_URL.to_string())
        );
    }

    #[test]
    fn refresh_now_errors_without_link_or_record() {
        let (s, _bare) = eligible_state("rf-none");
        register_worktree_at(&s.registry_path, "r", "wt", &s.repo);
        let client = MockClient::returning(Ok(open_status(CREATED_URL, "feature")));
        let err = refresh_pr_status_now(&s.repo, &s.registry_path, &client, &mut |_| {})
            .unwrap_err();
        assert!(err.contains("no linked pull request"), "{err}");
        let orphan = refresh_pr_status_now(Path::new("Z:\\elsewhere"), &s.registry_path, &client, &mut |_| {})
            .unwrap_err();
        assert!(orphan.contains("no linked pull request"), "{orphan}");
    }
}
