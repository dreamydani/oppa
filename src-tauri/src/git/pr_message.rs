// AI PR title/body generation: branch diff vs base -> installed agent -> heuristic fallback.
use crate::agents::catalog;
use crate::git::worktrees::run_git;
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::path::Path;
use crate::git::agent_process::run_agent_with_timeout as run_with_timeout;

const DIFF_CTX_CAP_BYTES: usize = 32 * 1024;
pub(crate) const MAX_TITLE_CHARS: usize = 200;
const AGENT_TIMEOUT_SECS: u64 = 30;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrMessage {
    pub title: String,
    pub body: String,
}

fn cap_at_char_boundary(bytes: &[u8], cap: usize) -> String {
    let mut end = cap.min(bytes.len());
    while end > 0 && end < bytes.len() && (bytes[end] & 0xC0) == 0x80 {
        end -= 1;
    }
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

fn resolve_base_for_pr(cwd: &Path) -> Result<String, String> {
    // Reuse hosted_reviews ladder resolver; map BlockedReason to string.
    match crate::git::hosted_reviews::resolve_base_ref(cwd) {
        Ok(base) => Ok(base),
        Err(reason) => {
            let kebab = serde_json::to_string(&reason).unwrap_or_default();
            Err(format!("cannot resolve base branch: {}", kebab.trim_matches('"')))
        }
    }
}

pub fn branch_diff_context(cwd: &Path) -> Result<String, String> {
    let base = resolve_base_for_pr(cwd)?;
    let range = format!("{base}...HEAD");
    let output = run_git(cwd, &["diff", &range])?;
    if !output.status.success() {
        return Err(format!(
            "git diff {} failed: {}",
            range,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let raw = output.stdout;
    if raw.iter().all(|&b| b.is_ascii_whitespace()) {
        return Err("no changes vs base".into());
    }
    Ok(cap_at_char_boundary(&raw, DIFF_CTX_CAP_BYTES))
}

pub fn build_pr_prompt(diff_ctx: &str, base: &str) -> String {
    format!(
        "Write a pull request title (<=72 chars, conventional-commit style, no quotes) on the first line, \
         then a blank line, then a concise body (1-3 short paragraphs, markdown) summarizing this branch diff vs base \"{base}\". \
         Reply with title on line 1, blank line, then body.\n\nBranch diff vs {base}:\n{diff_ctx}"
    )
}

fn strip_wrapping_quotes(text: &str) -> &str {
    let trimmed = text.trim();
    let wrap_ok = |c: char| c == '"' || c == '\'' || c == '`';
    if trimmed.len() >= 2 {
        let first = trimmed.chars().next().unwrap();
        let last = trimmed.chars().last().unwrap();
        if first == last && wrap_ok(first) {
            return trimmed[1..trimmed.len() - first.len_utf8()].trim();
        }
    }
    trimmed
}

fn clean_pr_reply(raw: &str) -> Result<PrMessage, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("empty response from agent".into());
    }
    // Collect first non-empty non-fence line as title
    let mut lines = trimmed.lines().peekable();
    let mut title_line: Option<String> = None;
    let mut body_lines: Vec<String> = Vec::new();
    let mut found_title = false;
    for line in lines.by_ref() {
        let t = line.trim();
        if t.is_empty() || t.starts_with("```") {
            if found_title {
                // after title, a fence line or empty line is part of separator; continue to body collection
                continue;
            } else {
                continue;
            }
        }
        if !found_title {
            let mut cand = t;
            // Only strip quotes on single-line title candidate before fence handling
            if !cand.contains('\n') {
                cand = strip_wrapping_quotes(cand);
            }
            let title: String = cand.chars().take(MAX_TITLE_CHARS).collect();
            if title.is_empty() {
                return Err("empty title from agent".into());
            }
            title_line = Some(title);
            found_title = true;
        } else {
            // Once title found, remaining lines are body; break to collect rest
            // Put this line as first body line, then drain rest
            // Skip fence lines that are just ```
            if t.starts_with("```") {
                continue;
            }
            body_lines.push(line.to_string());
            break;
        }
    }
    // If we broke after finding first body line, collect rest of lines
    if found_title {
        for line in lines {
            // Keep body lines as-is but skip pure fence lines
            if line.trim().starts_with("```") && line.trim().len() <= 6 {
                // Allow fenced code blocks in body? For v1, skip standalone fence markers but keep content
                // We treat ``` alone as fence -> skip, but ```lang stays?
                // Simpler: if line starts with ```, skip the fence marker line only, keep content between
                continue;
            }
            body_lines.push(line.to_string());
        }
    }
    let title = title_line.ok_or_else(|| "empty response from agent".to_string())?;
    // Body: join, trim leading/trailing blank lines, cap to body limit?
    let mut body = body_lines.join("\n").trim().to_string();
    // If body starts with blank lines due to separator, trim already handled
    // Cap body at 64KB to match hosted_reviews limit; but keep char boundary
    const MAX_BODY_BYTES: usize = 64 * 1024;
    if body.len() > MAX_BODY_BYTES {
        body = cap_at_char_boundary(body.as_bytes(), MAX_BODY_BYTES);
        body = body.trim_end().to_string();
    }
    // If still empty, keep empty string (allowed)
    Ok(PrMessage { title, body })
}

pub fn generate_pr_with_agent(cwd: &Path, profile: &catalog::AgentProfile) -> Result<PrMessage, String> {
    generate_pr_with_agent_path(cwd, profile, None)
}

pub fn generate_pr_with_agent_path(
    cwd: &Path,
    profile: &catalog::AgentProfile,
    path_env: Option<&OsStr>,
) -> Result<PrMessage, String> {
    let prompt_arg: &str = match profile.id {
        "claude" => "-p",
        "codex" => "exec",
        _ => return Err("ai pr messages support claude and codex only".into()),
    };
    let resolved =
        catalog::resolve_command_with_path(profile.command, path_env)
            .ok_or_else(|| "agent not found on PATH".to_string())?;
    let diff_ctx = branch_diff_context(cwd)?;
    // Need base for prompt context
    let base = resolve_base_for_pr(cwd).unwrap_or_else(|_| "base".to_string());
    let prompt = build_pr_prompt(&diff_ctx, &base);
    let is_batch = is_windows_batch(&resolved);
    let args: Vec<String> = if is_batch {
        vec![prompt_arg.to_string()]
    } else {
        vec![prompt_arg.to_string(), prompt.clone()]
    };
    let stdin_prompt = is_batch.then_some(prompt.as_str());
    let stdout = run_with_timeout(&resolved, &args, cwd, AGENT_TIMEOUT_SECS, stdin_prompt)?;
    clean_pr_reply(&stdout)
}

fn is_windows_batch(program: &Path) -> bool {
    if !cfg!(windows) {
        return false;
    }
    program
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
}

pub fn heuristic_pr_message(cwd: &Path) -> PrMessage {
    // Try branch diff file list via base...HEAD
    let base = resolve_base_for_pr(cwd).unwrap_or_else(|_| "main".to_string());
    let range = format!("{base}...HEAD");
    let name_only = run_git(cwd, &["diff", "--name-only", &range])
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    let paths: Vec<&str> = name_only
        .lines()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect();
    if paths.is_empty() {
        // Fallback to log subjects between base and HEAD
        let log = run_git(cwd, &["log", "--oneline", &format!("{base}..HEAD")])
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default();
        let trimmed = log.trim();
        if !trimmed.is_empty() {
            let first_line = trimmed.lines().next().unwrap_or("update");
            let subject = first_line.splitn(2, ' ').nth(1).unwrap_or(first_line);
            let title: String = format!("feat: {}", subject).chars().take(MAX_TITLE_CHARS).collect();
            let body = trimmed.lines().take(20).collect::<Vec<_>>().join("\n");
            return PrMessage { title, body };
        }
        // Last resort: generic
        return PrMessage {
            title: "chore: update branch".into(),
            body: format!("Changes vs {base}."),
        };
    }
    if paths.len() == 1 {
        let base_name = paths[0].rsplit(['/', '\\']).next().unwrap_or(paths[0]);
        return PrMessage {
            title: format!("chore: update {base_name}"),
            body: format!("Updates {base_name} vs {base}.\n\nFiles changed:\n- {}", paths[0]),
        };
    }
    PrMessage {
        title: format!("chore: update {} files", paths.len()),
        body: format!(
            "Updates {} files vs {}.\n\nFiles changed:\n{}",
            paths.len(),
            base,
            paths.iter().map(|p| format!("- {p}")).collect::<Vec<_>>().join("\n")
        ),
    }
}

pub fn sc_generate_pr_message(cwd: &Path) -> Result<PrMessage, String> {
    sc_generate_pr_message_path(cwd, None)
}

pub fn sc_generate_pr_message_path(cwd: &Path, path_env: Option<&OsStr>) -> Result<PrMessage, String> {
    // Need diff; error only if no changes vs base
    branch_diff_context(cwd)?;
    for id in ["claude", "codex"] {
        if let Some(profile) = catalog::lookup(id) {
            if let Ok(msg) = generate_pr_with_agent_path(cwd, profile, path_env) {
                return Ok(msg);
            }
        }
    }
    Ok(heuristic_pr_message(cwd))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};
    use crate::agents::catalog::lookup;
    use crate::git::test_support::{commit_file, sandbox, sandbox_with_origin, write_file};
    use std::ffi::OsStr;
    use std::path::Path;
    
    fn sc_stage_for_test(repo: &Path, paths: &[&str]) {
        let mut args = vec!["add", "--"];
        args.extend(paths.iter().copied());
        crate::git::worktrees::run_git(repo, &args).unwrap();
    }

    fn feature_branch_sandbox(tag: &str) -> crate::git::test_support::Sandbox {
        let (s, _bare) = sandbox_with_origin(tag);
        crate::git::test_support::git(&s.repo, &["checkout", "-b", "feature"]);
        commit_file(&s.repo, "feat.txt", "feat", "feat commit");
        write_file(&s.repo, "extra.txt", "extra");
        sc_stage_for_test(&s.repo, &["extra.txt"]);
        // keep one staged change? For pr diff we want committed vs base, not staged.
        // Commit extra so branch diff is visible
        crate::git::test_support::git(&s.repo, &["commit", "-m", "add extra"]);
        s
    }

    #[test]
    fn branch_diff_context_errors_when_no_changes_vs_base() {
        let (s, _bare) = sandbox_with_origin("pr-empty-branch");
        // On main with no feature branch, diff vs base should be empty (base is main itself)
        let err = branch_diff_context(&s.repo).unwrap_err();
        assert_eq!(err, "no changes vs base");
    }

    #[test]
    fn branch_diff_context_returns_branch_diff_and_caps() {
        let s = feature_branch_sandbox("pr-cap");
        let ctx = branch_diff_context(&s.repo).unwrap();
        assert!(ctx.len() <= DIFF_CTX_CAP_BYTES);
        assert!(!ctx.contains('\u{FFFD}'));
        assert!(ctx.contains("feat.txt") || ctx.contains("extra.txt"));
    }

    #[test]
    fn build_pr_prompt_embeds_branch_and_diff() {
        let ctx = "diff --git a/a.txt b/a.txt\n+hello";
        let prompt = build_pr_prompt(ctx, "main");
        assert!(prompt.contains("pull request title"));
        assert!(prompt.contains("main"));
        assert!(prompt.ends_with(ctx));
    }

    #[test]
    fn clean_pr_reply_title_and_body_split() {
        let raw = "feat: add awesome feature\n\nThis is a detailed body\nwith multiple lines\n";
        let msg = clean_pr_reply(raw).unwrap();
        assert_eq!(msg.title, "feat: add awesome feature");
        assert_eq!(msg.body, "This is a detailed body\nwith multiple lines");
    }

    #[test]
    fn clean_pr_reply_strips_wrapping_quotes_and_fences() {
        assert_eq!(
            clean_pr_reply("\"feat: quoted\"\n\nBody here").unwrap().title,
            "feat: quoted"
        );
        assert_eq!(
            clean_pr_reply("```\nfeat: fenced\n```\n\nBody").unwrap().title,
            "feat: fenced"
        );
    }

    #[test]
    fn clean_pr_reply_truncates_title_at_200() {
        let long = "a".repeat(300);
        let raw = format!("{long}\n\nBody");
        let msg = clean_pr_reply(&raw).unwrap();
        assert_eq!(msg.title.chars().count(), MAX_TITLE_CHARS);
    }

    #[test]
    fn clean_pr_reply_body_empty_allowed() {
        let msg = clean_pr_reply("feat: only title\n").unwrap();
        assert_eq!(msg.title, "feat: only title");
        assert_eq!(msg.body, "");
    }

    #[test]
    fn unsupported_agent_ids_are_rejected() {
        let s = feature_branch_sandbox("pr-unsupported");
        for id in ["gemini", "qwen", "opencode", "grok", "generic"] {
            let err = generate_pr_with_agent_path(&s.repo, lookup(id).unwrap(), Some(OsStr::new("")))
                .unwrap_err();
            assert_eq!(err, "ai pr messages support claude and codex only", "{id}");
        }
    }

    #[test]
    fn missing_binary_reports_agent_not_found() {
        let s = feature_branch_sandbox("pr-missing");
        let err = generate_pr_with_agent_path(&s.repo, lookup("claude").unwrap(), Some(OsStr::new("")))
            .unwrap_err();
        assert_eq!(err, "agent not found on PATH");
    }

    fn fake_agent_dir_with_pr_output() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        {
            // batch shim: echo title then blank then body
            std::fs::write(
                dir.path().join("claude.cmd"),
                "@echo off\r\necho feat: fake pr title\r\necho.\r\necho Fake body line 1\r\n",
            )
            .unwrap();
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            let script = dir.path().join("claude");
            std::fs::write(
                &script,
                "#!/bin/sh\nprintf \"feat: fake pr title\\n\\nFake body line 1\\n\"\n",
            )
            .unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        dir
    }

    #[test]
    fn fake_claude_on_injected_path_yields_title_and_body() {
        let s = feature_branch_sandbox("pr-fake-agent");
        let fake = fake_agent_dir_with_pr_output();
        let msg = generate_pr_with_agent_path(
            &s.repo,
            lookup("claude").unwrap(),
            Some(fake.path().as_os_str()),
        )
        .unwrap();
        assert_eq!(msg.title, "feat: fake pr title");
        assert!(msg.body.contains("Fake body line 1"));
    }

    #[test]
    fn orchestrator_falls_back_to_heuristic_when_no_agent() {
        let s = feature_branch_sandbox("pr-fallback-one");
        let msg = sc_generate_pr_message_path(&s.repo, Some(OsStr::new(""))).unwrap();
        // heuristic should produce deterministic title containing file count or basename
        assert!(!msg.title.is_empty());
        assert!(msg.title.len() <= MAX_TITLE_CHARS);
    }

    #[test]
    fn orchestrator_errors_only_when_no_changes_vs_base() {
        let (s, _bare) = sandbox_with_origin("pr-nothing-vs-base");
        let err = sc_generate_pr_message_path(&s.repo, Some(OsStr::new(""))).unwrap_err();
        assert_eq!(err, "no changes vs base");
    }

    #[test]
    fn heuristic_single_file_uses_basename_multi_reports_count() {
        let (s, _bare) = sandbox_with_origin("pr-heuristic");
        crate::git::test_support::git(&s.repo, &["checkout", "-b", "feat-single"]);
        commit_file(&s.repo, "deep/nested/only.rs", "// code", "add only");
        let msg = heuristic_pr_message(&s.repo);
        assert_eq!(msg.title, "chore: update only.rs");
        assert!(msg.body.contains("only.rs"));
    }

    #[test]
    fn heuristic_multi_files_reports_count() {
        let s = feature_branch_sandbox("pr-heuristic-multi");
        let msg = heuristic_pr_message(&s.repo);
        assert!(msg.title.contains("files") || msg.title.contains("feat.txt"));
    }

    #[cfg(windows)]
    #[test]
    fn run_with_timeout_kills_windows_sleeper_after_deadline() {
        let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into());
        let started = Instant::now();
        let err = run_with_timeout(
            Path::new(&comspec),
            &["/c".into(), "waitfor".into(), "/t".into(), "90".into(), "oppaNeverPr".into()],
            Path::new("."),
            1,
            None,
        )
        .unwrap_err();
        assert!(err.contains("timed out"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(20));
    }

    #[cfg(not(windows))]
    #[test]
    fn run_with_timeout_kills_unix_sleeper_after_deadline() {
        let started = Instant::now();
        let err = run_with_timeout(
            Path::new("/bin/sh"),
            &["-c".into(), "sleep 90".into()],
            Path::new("."),
            1,
            None,
        )
        .unwrap_err();
        assert!(err.contains("timed out"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(20));
    }
}
