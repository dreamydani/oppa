// Shared real-git temp-repo fixtures for engine tests; only compiled under cfg(test).
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub struct Sandbox {
    pub root: PathBuf,
    pub repo: PathBuf,
    pub registry_path: PathBuf,
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.root).ok();
    }
}

// Nanos + pid keeps parallel tests from sharing temp roots.
pub fn sandbox(tag: &str) -> Sandbox {
    let s = sandbox_without_commits(tag);
    commit_file(&s.repo, "README.md", "# init", "initial");
    s
}

pub fn sandbox_without_commits(tag: &str) -> Sandbox {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!("oppa-wt-{tag}-{}-{nanos}", std::process::id()));
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-b", "main"]);
    git(&repo, &["config", "user.email", "test@oppa.dev"]);
    git(&repo, &["config", "user.name", "Oppa Test"]);
    Sandbox {
        root: root.clone(),
        repo,
        registry_path: root.join("registry.json"),
    }
}

// Repo wired to a local bare "origin" with main pushed+tracked; bare lives under root for cleanup.
pub fn sandbox_with_origin(tag: &str) -> (Sandbox, PathBuf) {
    let s = sandbox(tag);
    let bare = s.root.join("origin.git");
    let bare_s = bare.to_string_lossy().into_owned();
    let repo_s = s.repo.to_string_lossy().into_owned();
    git(&s.root, &["clone", "--bare", &repo_s, &bare_s]);
    git(&s.repo, &["remote", "add", "origin", &bare_s]);
    git(&s.repo, &["push", "-u", "origin", "main"]);
    (s, bare)
}

// Fresh working clone of a bare origin carrying the same identity as sandbox repos.
pub fn clone_repo(origin: &Path, target: &PathBuf) {
    let origin_s = origin.to_string_lossy().into_owned();
    let target_s = target.to_string_lossy().into_owned();
    git(
        target.parent().unwrap(),
        &["clone", &origin_s, &target_s],
    );
    git(target, &["config", "user.email", "test@oppa.dev"]);
    git(target, &["config", "user.name", "Oppa Test"]);
}

pub fn git(cwd: &Path, args: &[&str]) -> String {
    let output = super::worktrees::run_git(cwd, args).expect("git spawn");
    assert!(
        output.status.success(),
        "git {args:?} failed in {}: {}",
        cwd.display(),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

pub fn commit_file(repo: &Path, name: &str, content: &str, message: &str) {
    write_file(repo, name, content);
    git(repo, &["add", "-A"]);
    git(repo, &["commit", "-m", message]);
}

pub fn write_file(repo: &Path, name: &str, content: &str) {
    if let Some(parent) = repo.join(name).parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(repo.join(name), content).unwrap();
}

// Fake gh shim for PATH injection; body syntax follows the platform shell.
pub fn fake_gh_dir(script_body: &str) -> PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("oppa-fake-gh-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    #[cfg(windows)]
    {
        std::fs::write(dir.join("gh.cmd"), script_body).unwrap();
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.join("gh");
        std::fs::write(&script, script_body).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    dir
}

// Stateful shim covering the full hosted-review flow: auth status, pr create,
// pr view, pr list. State is a sibling file in the same dir so invocations share it.
// Windows batch and Unix shell both try python first for robust JSON, then fallback.
const FAKE_GH_PY: &str = r#"#!/usr/bin/env python3
import sys, os, json, re
def main():
    args = sys.argv[1:]
    d = os.path.dirname(os.path.abspath(__file__))
    state_url = os.path.join(d, "gh_state_url")
    state_head = os.path.join(d, "gh_state_head")
    state_repo = os.path.join(d, "gh_state_repo")
    blank_flag = os.path.join(d, "blank_create")
    merged_flag = os.path.join(d, "merged")
    if len(args) >= 2 and args[0] == "auth" and args[1] == "status":
        sys.exit(0)
    if len(args) >= 2 and args[0] == "pr" and args[1] == "create":
        repo = "oppa-tests/review-eligibility"
        head = "feature"
        for i, a in enumerate(args):
            if a == "--repo" and i+1 < len(args):
                repo = args[i+1]
            if a == "--head" and i+1 < len(args):
                head = args[i+1]
        url = f"https://github.com/{repo}/pull/9"
        open(state_url, "w").write(url)
        open(state_head, "w").write(head)
        open(state_repo, "w").write(repo)
        if os.path.exists(blank_flag):
            print("")
            sys.exit(0)
        print(url)
        sys.exit(0)
    if len(args) >= 2 and args[0] == "pr" and args[1] == "view":
        if not os.path.exists(state_url):
            print("no pr", file=sys.stderr)
            sys.exit(1)
        url = open(state_url).read().strip()
        head = open(state_head).read().strip() if os.path.exists(state_head) else "feature"
        m = re.search(r'/(\d+)$', url)
        number = int(m.group(1)) if m else 9
        state = "MERGED" if os.path.exists(merged_flag) else "OPEN"
        data = {
            "number": number,
            "title": "Test PR",
            "url": url,
            "state": state,
            "isDraft": False,
            "mergeable": "MERGEABLE",
            "baseRefName": "main",
            "headRefName": head,
            "statusCheckRollup": [
                {"name": "build", "state": "SUCCESS"},
                {"name": "lint", "state": "FAILURE"},
                {"name": "e2e", "state": "PENDING"},
                {"name": "docs", "state": "SKIPPED"}
            ]
        }
        json.dump(data, sys.stdout)
        sys.exit(0)
    if len(args) >= 2 and args[0] == "pr" and args[1] == "list":
        if not os.path.exists(state_url):
            print("[]")
            sys.exit(0)
        url = open(state_url).read().strip()
        m = re.search(r'/(\d+)$', url)
        number = int(m.group(1)) if m else 9
        print(json.dumps([{"number": number, "url": url}]))
        sys.exit(0)
    print(f"unknown command {args}", file=sys.stderr)
    sys.exit(1)
if __name__ == "__main__":
    main()
"#;

#[cfg(not(windows))]
const FAKE_GH_SH: &str = r#"#!/bin/sh
DIR="$(dirname "$0")"
if command -v python3 >/dev/null 2>&1; then exec python3 "$DIR/fake_gh.py" "$@"; fi
if command -v python >/dev/null 2>&1; then exec python "$DIR/fake_gh.py" "$@"; fi
STATE_URL="$DIR/gh_state_url"
STATE_HEAD="$DIR/gh_state_head"
STATE_REPO="$DIR/gh_state_repo"
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then exit 0; fi
if [ "$1" = "pr" ] && [ "$2" = "create" ]; then
  REPO=""; HEAD=""; PREV=""
  for arg in "$@"; do if [ "$PREV" = "--repo" ]; then REPO="$arg"; fi; if [ "$PREV" = "--head" ]; then HEAD="$arg"; fi; PREV="$arg"; done
  if [ -z "$REPO" ]; then REPO="oppa-tests/review-eligibility"; fi
  if [ -z "$HEAD" ]; then HEAD="feature"; fi
  URL="https://github.com/$REPO/pull/9"
  printf "%s" "$URL" > "$STATE_URL"; printf "%s" "$HEAD" > "$STATE_HEAD"; printf "%s" "$REPO" > "$STATE_REPO"
  if [ -f "$DIR/blank_create" ]; then printf ""; exit 0; fi
  printf "%s\n" "$URL"; exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  if [ ! -f "$STATE_URL" ]; then echo "no pr" >&2; exit 1; fi
  URL=$(cat "$STATE_URL"); HEAD=$(cat "$STATE_HEAD" 2>/dev/null); if [ -z "$HEAD" ]; then HEAD="feature"; fi
  NUMBER=$(printf "%s" "$URL" | sed 's/.*\///'); if [ -z "$NUMBER" ]; then NUMBER=9; fi
  STATE="OPEN"; if [ -f "$DIR/merged" ]; then STATE="MERGED"; fi
  cat <<EOF
{"number": $NUMBER, "title": "Test PR", "url": "$URL", "state": "$STATE", "isDraft": false, "mergeable": "MERGEABLE", "baseRefName": "main", "headRefName": "$HEAD", "statusCheckRollup": [{"name": "build", "state": "SUCCESS"}, {"name": "lint", "state": "FAILURE"}, {"name": "e2e", "state": "PENDING"}, {"name": "docs", "state": "SKIPPED"}]}
EOF
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  if [ ! -f "$STATE_URL" ]; then echo "[]"; exit 0; fi
  URL=$(cat "$STATE_URL"); NUMBER=$(printf "%s" "$URL" | sed 's/.*\///'); if [ -z "$NUMBER" ]; then NUMBER=9; fi
  echo "[{\"number\": $NUMBER, \"url\": \"$URL\"}]"; exit 0
fi
echo "unknown $@" >&2; exit 1
"#;

#[cfg(windows)]
const FAKE_GH_CMD: &str = "@echo off\r\n\
setlocal EnableDelayedExpansion\r\n\
set DIR=%~dp0\r\n\
where python >nul 2>nul\r\n\
if %ERRORLEVEL%==0 ( python \"%~dp0fake_gh.py\" %* & exit /b %ERRORLEVEL% )\r\n\
where python3 >nul 2>nul\r\n\
if %ERRORLEVEL%==0 ( python3 \"%~dp0fake_gh.py\" %* & exit /b %ERRORLEVEL% )\r\n\
if \"%1\"==\"auth\" if \"%2\"==\"status\" exit /b 0\r\n\
if \"%1\"==\"pr\" if \"%2\"==\"create\" (\r\n\
  set REPO=oppa-tests/review-eligibility\r\n\
  set HEAD=feature\r\n\
  set PREV=\r\n\
  for %%A in (%*) do (\r\n\
    if \"!PREV!\"==\"--repo\" set REPO=%%A\r\n\
    if \"!PREV!\"==\"--head\" set HEAD=%%A\r\n\
    set PREV=%%A\r\n\
  )\r\n\
  set URL=https://github.com/!REPO!/pull/9\r\n\
  echo !URL! > \"%DIR%gh_state_url\"\r\n\
  echo !HEAD! > \"%DIR%gh_state_head\"\r\n\
  echo !REPO! > \"%DIR%gh_state_repo\"\r\n\
  if exist \"%DIR%blank_create\" ( echo. & exit /b 0 )\r\n\
  echo !URL!\r\n\
  exit /b 0\r\n\
)\r\n\
if \"%1\"==\"pr\" if \"%2\"==\"view\" (\r\n\
  if not exist \"%DIR%gh_state_url\" ( echo no pr 1>&2 & exit /b 1 )\r\n\
  set /p URL=<\"%DIR%gh_state_url\"\r\n\
  set HEAD=feature\r\n\
  if exist \"%DIR%gh_state_head\" set /p HEAD=<\"%DIR%gh_state_head\"\r\n\
  set STATE=OPEN\r\n\
  if exist \"%DIR%merged\" set STATE=MERGED\r\n\
  echo {\"number\": 9, \"title\": \"Test PR\", \"url\": \"!URL!\", \"state\": \"!STATE!\", \"isDraft\": false, \"mergeable\": \"MERGEABLE\", \"baseRefName\": \"main\", \"headRefName\": \"!HEAD!\", \"statusCheckRollup\": [{\"name\": \"build\", \"state\": \"SUCCESS\"}, {\"name\": \"lint\", \"state\": \"FAILURE\"}, {\"name\": \"e2e\", \"state\": \"PENDING\"}, {\"name\": \"docs\", \"state\": \"SKIPPED\"}]}\r\n\
  exit /b 0\r\n\
)\r\n\
if \"%1\"==\"pr\" if \"%2\"==\"list\" (\r\n\
  if not exist \"%DIR%gh_state_url\" ( echo [] & exit /b 0 )\r\n\
  set /p URL=<\"%DIR%gh_state_url\"\r\n\
  echo [{\"number\": 9, \"url\": \"!URL!\"}]\r\n\
  exit /b 0\r\n\
)\r\n\
echo unknown %* 1>&2\r\n\
exit /b 1\r\n\
";

/// Stateful fake gh covering auth status, pr create, pr view, pr list with mixed checks.
/// State lives in sibling files so successive invocations share the pr URL.
pub fn fake_gh_stateful_dir() -> PathBuf {
    fake_gh_stateful_dir_with_blank(false)
}

pub fn fake_gh_stateful_blank_dir() -> PathBuf {
    fake_gh_stateful_dir_with_blank(true)
}

pub fn fake_gh_stateful_dir_with_blank(blank_create: bool) -> PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("oppa-fake-gh-state-{nanos}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("fake_gh.py"), FAKE_GH_PY).unwrap();
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(dir.join("gh"), FAKE_GH_SH).unwrap();
        std::fs::set_permissions(dir.join("gh"), std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::set_permissions(dir.join("fake_gh.py"), std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    #[cfg(windows)]
    {
        std::fs::write(dir.join("gh.cmd"), FAKE_GH_CMD).unwrap();
    }
    if blank_create {
        std::fs::write(dir.join("blank_create"), "").unwrap();
    }
    dir
}
