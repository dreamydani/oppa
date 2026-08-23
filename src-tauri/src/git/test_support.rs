// Shared real-git temp-repo fixtures for engine tests; only compiled under cfg(test).
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub(crate) struct Sandbox {
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
pub(crate) fn sandbox(tag: &str) -> Sandbox {
    let s = sandbox_without_commits(tag);
    commit_file(&s.repo, "README.md", "# init", "initial");
    s
}

pub(crate) fn sandbox_without_commits(tag: &str) -> Sandbox {
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
pub(crate) fn sandbox_with_origin(tag: &str) -> (Sandbox, PathBuf) {
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
pub(crate) fn clone_repo(origin: &Path, target: &PathBuf) {
    let origin_s = origin.to_string_lossy().into_owned();
    let target_s = target.to_string_lossy().into_owned();
    git(
        target.parent().unwrap(),
        &["clone", &origin_s, &target_s],
    );
    git(target, &["config", "user.email", "test@oppa.dev"]);
    git(target, &["config", "user.name", "Oppa Test"]);
}

pub(crate) fn git(cwd: &Path, args: &[&str]) -> String {
    let output = super::worktrees::run_git(cwd, args).expect("git spawn");
    assert!(
        output.status.success(),
        "git {args:?} failed in {}: {}",
        cwd.display(),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).into_owned()
}

pub(crate) fn commit_file(repo: &Path, name: &str, content: &str, message: &str) {
    write_file(repo, name, content);
    git(repo, &["add", "-A"]);
    git(repo, &["commit", "-m", message]);
}

pub(crate) fn write_file(repo: &Path, name: &str, content: &str) {
    if let Some(parent) = repo.join(name).parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    std::fs::write(repo.join(name), content).unwrap();
}

// Fake gh shim for PATH injection; body syntax follows the platform shell.
pub(crate) fn fake_gh_dir(script_body: &str) -> PathBuf {
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
