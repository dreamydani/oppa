// Hosted GitHub reviews: forge detection + eligibility ladder; gh stays argv-only like git.
#![allow(dead_code)]

use crate::agents::catalog;
use crate::git::source_control::{sc_status, validate_ref_name, ConflictState};
use crate::git::worktrees::run_git;
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const GH_AUTH_TIMEOUT_SECS: u64 = 10;

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

// Real-gh wiring for daemon/UI callers; PR lookup arrives with the task-2 gh client.
pub fn review_eligibility_live(cwd: &Path) -> Eligibility {
    review_eligibility(cwd, &|| gh_available(None), &|_owner_repo, _branch| None)
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
}
