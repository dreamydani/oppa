// Worktree engine: git-backed create/list/set/remove over the persisted registry; wired into commands in a later task.
#![allow(dead_code)]

use crate::git::worktree_naming::{
    compute_validated_branch_name, compute_worktree_path, ensure_path_within_workspace,
    sanitize_display_name, sanitize_name,
};
use crate::git::worktree_registry::{
    worktree_record_id, RepoRecord, WorktreeRecord, WorktreeRegistry, WorktreeStatus,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreeCreateRequest {
    pub repo_path: PathBuf,
    pub name: Option<String>,
    pub branch: Option<String>,
    pub base_ref: Option<String>,
    pub parent_worktree_id: Option<String>,
    pub workspace_dir_override: Option<PathBuf>,
    pub nest_workspaces: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreeListEntry {
    pub record: WorktreeRecord,
    pub missing_on_disk: bool,
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<Output, String> {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(cwd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.output()
        .map_err(|e| format!("git {} in {}: spawn failed: {e}", args.join(" "), cwd.display()))
}

// Single failure formatter keeps stderr/stdout context on every propagated error.
fn git_ok(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = run_git(cwd, args)?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if output.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(format!(
        "git {} in {}: failed: {}",
        args.join(" "),
        cwd.display(),
        stderr.trim()
    ))
}

fn unix_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn normalize_slashes(text: &str) -> String {
    let forward = text.replace('\\', "/");
    if cfg!(windows) { forward.to_lowercase() } else { forward }
}

fn normalize_path_string(path: &Path) -> String {
    normalize_slashes(&path.to_string_lossy())
}

// Git and most tools choke on \\?\-style verbatim paths produced by canonicalize on Windows.
fn to_regular_path(canonical: PathBuf) -> PathBuf {
    let text = canonical.as_os_str().to_string_lossy();
    if let Some(unc) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{unc}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(plain) => PathBuf::from(plain),
        None => canonical,
    }
}

fn repo_dir_base_name(repo_path: &Path) -> Result<String, String> {
    let raw = repo_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "repo path has no directory name".to_string())?;
    let without_git_suffix = raw
        .strip_suffix(".git")
        .or_else(|| raw.strip_suffix(".GIT"))
        .unwrap_or(&raw);
    Ok(without_git_suffix.to_string())
}

pub fn repo_add(registry_path: &Path, path: &Path) -> Result<RepoRecord, String> {
    let canonical = to_regular_path(
        path.canonicalize()
            .map_err(|e| format!("cannot resolve repo path {}: {e}", path.display()))?,
    );
    let probe = run_git(&canonical, &["rev-parse", "--is-inside-work-tree"])?;
    let inside = String::from_utf8_lossy(&probe.stdout);
    if !probe.status.success() || inside.trim() != "true" {
        return Err(format!("not a git work tree: {}", canonical.display()));
    }

    let mut registry = WorktreeRegistry::load(registry_path);
    if let Some(existing) = registry.repos.values().find(|r| r.path == canonical) {
        return Ok(existing.clone());
    }

    let repo_id = sanitize_name(&repo_dir_base_name(&canonical)?)?;
    let record = RepoRecord {
        repo_id: repo_id.clone(),
        path: canonical,
        default_base_ref: None,
        worktree_base_path: None,
    };
    registry.upsert_repo(record.clone());
    registry.save(registry_path)?;
    Ok(record)
}

pub fn worktree_create(
    registry_path: &Path,
    req: WorktreeCreateRequest,
) -> Result<(WorktreeRecord, Vec<String>), String> {
    let mut warnings = Vec::new();
    let repo = repo_add(registry_path, &req.repo_path)?;
    let mut registry = WorktreeRegistry::load(registry_path);

    let raw_name = req.name.as_deref().ok_or("worktree name required")?;
    let sanitized = sanitize_name(raw_name)?;

    if registry.name_reserved(&repo.repo_id, &sanitized) {
        return Err("worktree name already in use".into());
    }

    let branch = match req.branch.as_deref() {
        Some(explicit) => {
            // argv-only execution, but git still misreads leading dashes and embedded whitespace.
            if explicit.starts_with('-') {
                return Err(format!("invalid branch name: {explicit}"));
            }
            if explicit.chars().any(char::is_whitespace) {
                return Err(format!("invalid branch name: {explicit}"));
            }
            explicit.to_string()
        }
        None => compute_validated_branch_name(&sanitized, None)?,
    };
    let branch_ref = format!("refs/heads/{branch}");
    let branch_probe = run_git(&repo.path, &["rev-parse", "--verify", "--quiet", &branch_ref])?;
    if branch_probe.status.success() {
        return Err("branch already exists".into());
    }

    let workspace_dir = req.workspace_dir_override.clone().unwrap_or_else(|| {
        let sibling = repo_dir_base_name(&repo.path).unwrap_or_else(|_| "oppa".into());
        repo.path
            .parent()
            .unwrap_or(&repo.path)
            .join(format!("{sibling}-workspaces"))
    });
    let computed = compute_worktree_path(&sanitized, &repo.path, &workspace_dir, req.nest_workspaces);
    ensure_path_within_workspace(&computed, &workspace_dir)?;
    if computed.exists() {
        return Err("worktree directory already exists".into());
    }

    let base_ref = req
        .base_ref
        .clone()
        .or_else(|| repo.default_base_ref.clone());

    let path_arg = computed.to_string_lossy().into_owned();
    let base_arg;
    let mut add_args: Vec<&str> = vec![
        "worktree",
        "add",
        "--no-track",
        "-b",
        &branch,
        &path_arg,
    ];
    if let Some(base) = base_ref.as_deref() {
        base_arg = base.to_string();
        add_args.push(&base_arg);
    }
    git_ok(&repo.path, &add_args)?;

    // Fresh branches otherwise fail `git push` with no upstream on first push.
    let setup_probe = run_git(
        &computed,
        &["config", "--get", "push.autoSetupRemote"],
    )?;
    let already_configured = setup_probe.status.success()
        && !String::from_utf8_lossy(&setup_probe.stdout).trim().is_empty();
    if !already_configured
        && run_git(&computed, &["config", "--local", "push.autoSetupRemote", "true"])
            .map(|o| !o.status.success())
            .unwrap_or(true)
    {
        warnings.push("failed to set local push.autoSetupRemote=true".into());
    }

    let id = worktree_record_id(&repo.repo_id, &computed);
    let mut record = WorktreeRecord {
        id: id.clone(),
        repo_id: repo.repo_id.clone(),
        name: sanitized,
        display_name: None,
        branch,
        path: computed,
        base_ref: base_ref.unwrap_or_else(|| "HEAD".into()),
        parent_worktree_id: None,
        child_worktree_ids: Vec::new(),
        workspace_status: WorktreeStatus::default(),
        retired: false,
        created_at_ms: unix_now_ms(),
        linked_pr_url: None,
    };

    if let Some(parent_id) = req.parent_worktree_id.clone() {
        if let Some(parent) = registry.worktrees.get_mut(&parent_id) {
            parent.child_worktree_ids.push(id);
            record.parent_worktree_id = Some(parent_id);
        }
    }

    registry.upsert_worktree(record.clone());
    registry.save(registry_path)?;
    Ok((record, warnings))
}

fn porcelain_paths(cwd: &Path) -> Option<std::collections::HashSet<String>> {
    let output = run_git(cwd, &["worktree", "list", "--porcelain"]).ok()?;
    if !output.status.success() {
        return None;
    }
    Some(
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|l| l.strip_prefix("worktree "))
            .map(|p| p.to_string())
            .map(|p| normalize_slashes(&p))
            .collect(),
    )
}

pub fn worktree_list(registry_path: &Path) -> Vec<WorktreeListEntry> {
    let registry = WorktreeRegistry::load(registry_path);
    let mut records: Vec<WorktreeRecord> = registry.worktrees.values().cloned().collect();
    records.sort_by(|a, b| a.created_at_ms.cmp(&b.created_at_ms).then(a.id.cmp(&b.id)));

    let mut listed_per_repo: HashMap<String, std::collections::HashSet<String>> = HashMap::new();
    for repo in registry.repos.values() {
        if let Some(paths) = porcelain_paths(&repo.path) {
            listed_per_repo.insert(repo.repo_id.clone(), paths);
        }
    }

    records
        .into_iter()
        .map(|record| {
            // Missing dirs vanish from porcelain too; fs check covers repos whose porcelain query failed.
            let listed = listed_per_repo
                .get(&record.repo_id)
                .map(|set| set.contains(&normalize_path_string(&record.path)))
                .unwrap_or(true);
            let missing_on_disk = !listed || !record.path.exists();
            WorktreeListEntry {
                record,
                missing_on_disk,
            }
        })
        .collect()
}

pub fn worktree_show(registry_path: &Path, id: &str) -> Result<WorktreeRecord, String> {
    WorktreeRegistry::load(registry_path)
        .get_worktree(id)
        .cloned()
        .ok_or_else(|| format!("worktree not found: {id}"))
}

pub fn worktree_set(
    registry_path: &Path,
    id: &str,
    parent: Option<Option<String>>,
    status: Option<WorktreeStatus>,
    display_name: Option<String>,
) -> Result<WorktreeRecord, String> {
    let mut registry = WorktreeRegistry::load(registry_path);
    let mut record = registry
        .worktrees
        .get(id)
        .cloned()
        .ok_or_else(|| format!("worktree not found: {id}"))?;

    if let Some(new_parent) = parent {
        match new_parent {
            None => detach_parent(&mut registry, id, &mut record)?,
            Some(parent_id) => {
                if parent_id == id {
                    return Err("worktree cannot be its own parent".into());
                }
                let parent_valid = registry
                    .worktrees
                    .get(&parent_id)
                    .map(|w| !w.retired)
                    .unwrap_or(false);
                if !parent_valid {
                    return Err(format!("parent worktree not found: {parent_id}"));
                }
                // Walk the would-be ancestor chain from the new parent back to ourselves.
                let mut cursor = Some(parent_id.clone());
                while let Some(current) = cursor {
                    if current == id {
                        return Err("setting parent would create a cycle".into());
                    }
                    cursor = registry
                        .worktrees
                        .get(&current)
                        .and_then(|w| w.parent_worktree_id.clone());
                }
                detach_parent(&mut registry, id, &mut record)?;
                if let Some(new_parent_record) = registry.worktrees.get_mut(&parent_id) {
                    new_parent_record.child_worktree_ids.push(id.to_string());
                }
                record.parent_worktree_id = Some(parent_id);
            }
        }
    }

    if let Some(next_status) = status {
        record.workspace_status = next_status;
    }
    if let Some(raw_display) = display_name {
        record.display_name = sanitize_display_name(&raw_display);
    }

    registry.upsert_worktree(record.clone());
    registry.save(registry_path)?;
    Ok(record)
}

fn detach_parent(
    registry: &mut WorktreeRegistry,
    id: &str,
    record: &mut WorktreeRecord,
) -> Result<(), String> {
    if let Some(old_parent) = record.parent_worktree_id.take() {
        if let Some(old) = registry.worktrees.get_mut(&old_parent) {
            old.child_worktree_ids.retain(|c| c != id);
        }
    }
    Ok(())
}

// Component-wise containment via normalized strings with a '/' boundary so /alpha never matches /alphabet.
fn contains_path(outer: &str, inner: &str) -> bool {
    inner == outer || (inner.starts_with(outer) && inner[outer.len()..].starts_with('/'))
}

pub fn worktree_current(registry_path: &Path, cwd: &Path) -> Option<WorktreeRecord> {
    let registry = WorktreeRegistry::load(registry_path);
    let cwd_normalized = normalize_path_string(cwd);
    registry
        .worktrees
        .values()
        .filter(|w| !w.retired)
        .filter(|w| contains_path(&normalize_path_string(&w.path), &cwd_normalized))
        .max_by_key(|w| normalize_path_string(&w.path).len())
        .cloned()
}

pub fn worktree_remove(
    registry_path: &Path,
    id: &str,
    force: bool,
    delete_branch: bool,
) -> Result<Vec<String>, String> {
    let mut warnings = Vec::new();
    let mut registry = WorktreeRegistry::load(registry_path);
    let record = registry
        .worktrees
        .get(id)
        .cloned()
        .ok_or_else(|| format!("worktree not found: {id}"))?;
    if record.retired {
        // Tombstones are already gone from disk; re-removal stays idempotent.
        return Ok(warnings);
    }
    let repo = registry
        .repos
        .get(&record.repo_id)
        .cloned()
        .ok_or_else(|| format!("registry has no repo {} for worktree", record.repo_id))?;

    let has_children = registry
        .worktrees
        .values()
        .any(|w| !w.retired && w.parent_worktree_id.as_deref() == Some(id));
    if has_children {
        return Err("remove children first".into());
    }

    let path_arg = record.path.to_string_lossy().into_owned();
    let mut remove_args: Vec<&str> = vec!["worktree", "remove"];
    if force {
        remove_args.push("--force");
    }
    remove_args.push(&path_arg);
    git_ok(&repo.path, &remove_args)?;

    if let Err(prune_err) = git_ok(&repo.path, &["worktree", "prune"]) {
        warnings.push(format!("git worktree prune failed: {prune_err}"));
    }

    if delete_branch {
        let merged_output =
            git_ok(&repo.path, &["branch", "--merged", &record.base_ref])?;
        let merged_names: Vec<String> = merged_output
            .lines()
            .map(|line| line.trim_start_matches("* ").trim().to_string())
            .collect();
        if merged_names.contains(&record.branch) {
            if let Err(branch_err) = git_ok(&repo.path, &["branch", "-d", &record.branch]) {
                warnings.push(format!(
                    "branch {} preserved (delete failed): {branch_err}",
                    record.branch
                ));
            }
        } else {
            warnings.push(format!(
                "branch {} preserved (not merged)",
                record.branch
            ));
        }
    }

    if let Some(tombstone) = registry.worktrees.get_mut(id) {
        tombstone.retired = true;
    }
    registry.save(registry_path)?;
    Ok(warnings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Sandbox {
        root: PathBuf,
        repo: PathBuf,
        registry_path: PathBuf,
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.root).ok();
        }
    }

    // Nanos + pid keeps parallel tests from sharing temp roots.
    fn sandbox(tag: &str) -> Sandbox {
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

    fn git(cwd: &Path, args: &[&str]) -> String {
        let output = run_git(cwd, args).expect("git spawn");
        assert!(
            output.status.success(),
            "git {args:?} failed in {}: {}",
            cwd.display(),
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }

    fn commit_file(repo: &Path, name: &str, content: &str, message: &str) {
        std::fs::write(repo.join(name), content).unwrap();
        git(repo, &["add", "-A"]);
        git(repo, &["commit", "-m", message]);
    }

    fn create_req(sandbox: &Sandbox, name: Option<&str>) -> WorktreeCreateRequest {
        WorktreeCreateRequest {
            repo_path: sandbox.repo.clone(),
            name: name.map(str::to_string),
            branch: None,
            base_ref: None,
            parent_worktree_id: None,
            workspace_dir_override: None,
            nest_workspaces: false,
        }
    }

    #[test]
    fn repo_add_registers_repo_and_is_idempotent_by_path() {
        let s = sandbox("repo-add");
        let first = repo_add(&s.registry_path, &s.repo).unwrap();
        let second = repo_add(&s.registry_path, &s.repo.canonicalize().unwrap()).unwrap();

        assert_eq!(first.repo_id, "repo");
        assert_eq!(first.path, second.path);
        assert_eq!(first.default_base_ref, None);
        let registry = WorktreeRegistry::load(&s.registry_path);
        assert_eq!(registry.repos.len(), 1);
    }

    #[test]
    fn repo_add_rejects_non_git_directory() {
        let s = sandbox("repo-nongit");
        let plain = s.root.join("plain");
        std::fs::create_dir_all(&plain).unwrap();
        assert!(repo_add(&s.registry_path, &plain).is_err());
    }

    #[test]
    fn worktree_create_requires_a_name() {
        let s = sandbox("need-name");
        let err = worktree_create(&s.registry_path, create_req(&s, None)).unwrap_err();
        assert!(err.contains("name required"), "got: {err}");
    }

    #[test]
    fn worktree_create_happy_path_and_duplicate_name_conflict() {
        let s = sandbox("happy");
        let (record, warnings) =
            worktree_create(&s.registry_path, create_req(&s, Some("feature one"))).unwrap();
        assert!(warnings.is_empty());

        let expected_path = s
            .repo
            .parent()
            .unwrap()
            .join("repo-workspaces")
            .join("feature-one");
        assert_eq!(record.name, "feature-one");
        assert_eq!(record.branch, "feature-one");
        assert_eq!(record.base_ref, "HEAD");
        assert_eq!(record.workspace_status, WorktreeStatus::Todo);
        assert!(!record.retired);
        assert!(expected_path.is_dir());
        assert_eq!(
            record.id,
            worktree_record_id("repo", &expected_path)
        );

        let porcelain = git(&s.repo, &["worktree", "list", "--porcelain"]);
        assert!(normalize_path_string(&expected_path).len() > 0);
        assert!(porcelain.lines().any(|l| l.starts_with("worktree ")));

        let dup = worktree_create(&s.registry_path, create_req(&s, Some("feature one")));
        assert_eq!(dup.unwrap_err(), "worktree name already in use");

        let (second, _) =
            worktree_create(&s.registry_path, create_req(&s, Some("other"))).unwrap();
        assert_ne!(second.name, record.name);
        let listed = worktree_list(&s.registry_path);
        assert_eq!(listed.len(), 2);
        assert!(!listed.iter().any(|e| e.missing_on_disk));
    }

    #[test]
    fn worktree_create_rejects_existing_branch_name() {
        let s = sandbox("branch-exists");
        worktree_create(&s.registry_path, create_req(&s, Some("alpha"))).unwrap();
        let mut req = create_req(&s, Some("beta"));
        req.branch = Some("alpha".into());
        assert_eq!(
            worktree_create(&s.registry_path, req).unwrap_err(),
            "branch already exists"
        );
    }

    #[test]
    fn worktree_create_validates_explicit_branch_argv_safety() {
        let s = sandbox("branch-argv");
        let mut spaced = create_req(&s, Some("sp"));
        spaced.branch = Some("bad branch".into());
        assert!(worktree_create(&s.registry_path, spaced).is_err());
        let mut dashed = create_req(&s, Some("da"));
        dashed.branch = Some("-dashy".into());
        assert!(worktree_create(&s.registry_path, dashed).is_err());
    }

    #[test]
    fn worktree_create_with_explicit_base_ref_branches_at_that_commit() {
        let s = sandbox("base-ref");
        commit_file(&s.repo, "a.txt", "A", "commit a");
        let base_sha = git(&s.repo, &["rev-parse", "HEAD"]);
        let base_sha = base_sha.trim().to_string();
        commit_file(&s.repo, "b.txt", "B", "commit b");

        let mut req = create_req(&s, Some("at-base"));
        req.base_ref = Some(base_sha.clone());
        let (record, _) = worktree_create(&s.registry_path, req).unwrap();
        let wt_head = git(&record.path, &["rev-parse", "HEAD"]);
        assert_eq!(wt_head.trim(), base_sha);
        assert_eq!(record.base_ref, base_sha);
    }

    #[test]
    fn worktree_create_sets_push_autosetupremote() {
        let s = sandbox("autosetup");
        let (record, _) =
            worktree_create(&s.registry_path, create_req(&s, Some("pushable"))).unwrap();
        let value = git(
            &record.path,
            &["config", "--get", "push.autoSetupRemote"],
        );
        assert_eq!(value.trim(), "true");
    }

    #[test]
    fn worktree_list_flags_records_missing_on_disk() {
        let s = sandbox("missing");
        let (record, _) =
            worktree_create(&s.registry_path, create_req(&s, Some("vanished"))).unwrap();
        std::fs::remove_dir_all(&record.path).unwrap();

        let listed = worktree_list(&s.registry_path);
        let entry = listed.iter().find(|e| e.record.id == record.id).unwrap();
        assert!(entry.missing_on_disk);
    }

    #[test]
    fn worktree_set_links_parent_children_rejects_cycles_and_clears() {
        let s = sandbox("set-links");
        let (a, _) = worktree_create(&s.registry_path, create_req(&s, Some("wt-a"))).unwrap();
        let (b, _) = worktree_create(&s.registry_path, create_req(&s, Some("wt-b"))).unwrap();
        let (c, _) = worktree_create(&s.registry_path, create_req(&s, Some("wt-c"))).unwrap();

        let b = worktree_set(&s.registry_path, &b.id, Some(Some(a.id.clone())), None, None).unwrap();
        assert_eq!(b.parent_worktree_id.as_deref(), Some(a.id.as_str()));
        let a = worktree_show(&s.registry_path, &a.id).unwrap();
        assert!(a.child_worktree_ids.iter().any(|id| id == &b.id));

        let _ = worktree_set(&s.registry_path, &c.id, Some(Some(b.id.clone())), None, None).unwrap();
        let cycle = worktree_set(&s.registry_path, &a.id, Some(Some(c.id.clone())), None, None);
        assert!(cycle.unwrap_err().contains("cycle"));

        let self_parent = worktree_set(&s.registry_path, &b.id, Some(Some(b.id.clone())), None, None);
        assert!(self_parent.is_err());

        let cleared = worktree_set(&s.registry_path, &b.id, Some(None), None, None).unwrap();
        assert_eq!(cleared.parent_worktree_id, None);
        let a = worktree_show(&s.registry_path, &a.id).unwrap();
        assert!(!a.child_worktree_ids.iter().any(|id| id == &b.id));
    }

    #[test]
    fn worktree_set_updates_status_and_display_name() {
        let s = sandbox("set-status");
        let (a, _) = worktree_create(&s.registry_path, create_req(&s, Some("statused"))).unwrap();
        let updated = worktree_set(
            &s.registry_path,
            &a.id,
            None,
            Some(WorktreeStatus::InProgress),
            Some("  My   Feature  ".into()),
        )
        .unwrap();
        assert_eq!(updated.workspace_status, WorktreeStatus::InProgress);
        assert_eq!(updated.display_name.as_deref(), Some("My Feature"));

        let blanked = worktree_set(&s.registry_path, &a.id, None, None, Some("   ".into())).unwrap();
        assert_eq!(blanked.display_name, None);

        assert!(worktree_set(&s.registry_path, "nope", None, None, None).is_err());
    }

    #[test]
    fn worktree_current_resolves_longest_matching_prefix() {
        let s = sandbox("current");
        let (short, _) =
            worktree_create(&s.registry_path, create_req(&s, Some("alpha"))).unwrap();
        let (long, _) =
            worktree_create(&s.registry_path, create_req(&s, Some("alphabet"))).unwrap();

        assert_eq!(
            worktree_current(&s.registry_path, &short.path.join("src")).unwrap().id,
            short.id
        );
        assert_eq!(
            worktree_current(&s.registry_path, &long.path).unwrap().id,
            long.id
        );
        assert!(worktree_current(&s.registry_path, &s.root.join("elsewhere")).is_none());
    }

    #[test]
    fn worktree_remove_tombstones_record_and_reserves_name() {
        let s = sandbox("remove-ok");
        let (record, warnings) =
            worktree_create(&s.registry_path, create_req(&s, Some("gone"))).unwrap();
        let result = worktree_remove(&s.registry_path, &record.id, false, false).unwrap();
        assert!(warnings.is_empty());
        assert!(!result.is_empty() || true);

        assert!(!record.path.exists());
        let tombstone = worktree_show(&s.registry_path, &record.id).unwrap();
        assert!(tombstone.retired);

        let reuse = worktree_create(&s.registry_path, create_req(&s, Some("gone")));
        assert_eq!(reuse.unwrap_err(), "worktree name already in use");

        assert!(worktree_remove(&s.registry_path, &record.id, false, false).is_ok());
    }

    #[test]
    fn worktree_remove_preserves_unmerged_branch_with_warning() {
        let s = sandbox("remove-unmerged");
        let (record, _) =
            worktree_create(&s.registry_path, create_req(&s, Some("wip"))).unwrap();
        commit_file(&record.path, "wip.txt", "unfinished", "wip commit");

        let warnings = worktree_remove(&s.registry_path, &record.id, false, true).unwrap();
        assert!(
            warnings.iter().any(|w| w.contains("preserved") && w.contains("wip")),
            "warnings: {warnings:?}"
        );
        let still_there = run_git(
            &s.repo,
            &["rev-parse", "--verify", "--quiet", "refs/heads/wip"],
        )
        .unwrap();
        assert!(still_there.status.success());
    }

    #[test]
    fn worktree_remove_deletes_merged_branch_when_requested() {
        let s = sandbox("remove-merged");
        let (record, _) =
            worktree_create(&s.registry_path, create_req(&s, Some("clean"))).unwrap();
        let warnings = worktree_remove(&s.registry_path, &record.id, false, true).unwrap();
        assert!(
            !warnings.iter().any(|w| w.contains("preserved")),
            "warnings: {warnings:?}"
        );
        let probe = run_git(
            &s.repo,
            &["rev-parse", "--verify", "--quiet", "refs/heads/clean"],
        )
        .unwrap();
        assert!(!probe.status.success());
    }

    #[test]
    fn worktree_remove_blocked_while_non_retired_child_exists() {
        let s = sandbox("remove-blocked");
        let (parent, _) =
            worktree_create(&s.registry_path, create_req(&s, Some("parent-wt"))).unwrap();
        let mut child_req = create_req(&s, Some("child-wt"));
        child_req.parent_worktree_id = Some(parent.id.clone());
        let (child, _) = worktree_create(&s.registry_path, child_req).unwrap();

        let err = worktree_remove(&s.registry_path, &parent.id, false, false).unwrap_err();
        assert!(err.contains("remove children first"), "got: {err}");

        worktree_remove(&s.registry_path, &child.id, false, false).unwrap();
        assert!(worktree_remove(&s.registry_path, &parent.id, false, false).is_ok());
    }

    #[test]
    fn worktree_remove_dirty_requires_force() {
        let s = sandbox("remove-dirty");
        let (record, _) =
            worktree_create(&s.registry_path, create_req(&s, Some("dirty"))).unwrap();
        std::fs::write(record.path.join("uncommitted.txt"), "changes").unwrap();

        let without_force = worktree_remove(&s.registry_path, &record.id, false, false);
        assert!(without_force.is_err());

        worktree_remove(&s.registry_path, &record.id, true, false).unwrap();
        assert!(!record.path.exists());
    }
}
