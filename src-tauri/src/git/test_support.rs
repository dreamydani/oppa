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
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root = std::env::temp_dir().join(format!("oppa-wt-{tag}-{}-{nanos}", std::process::id()));
    let repo = root.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    git(&repo, &["init", "-b", "main"]);
    git(&repo, &["config", "user.email", "test@oppa.dev"]);
    git(&repo, &["config", "user.name", "Oppa Test"]);
    commit_file(&repo, "README.md", "# init", "initial");
    Sandbox {
        root: root.clone(),
        repo,
        registry_path: root.join("registry.json"),
    }
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
    std::fs::write(repo.join(name), content).unwrap();
    git(repo, &["add", "-A"]);
    git(repo, &["commit", "-m", message]);
}
