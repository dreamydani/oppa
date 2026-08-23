// AI commit-message generation: staged-diff context -> installed agent -> heuristic fallback.
use crate::agents::catalog;
use crate::git::worktrees::run_git;
use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const DIFF_CTX_CAP_BYTES: usize = 32 * 1024;
pub(crate) const MAX_SUBJECT_CHARS: usize = 72;
const AGENT_TIMEOUT_SECS: u64 = 30;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommitMessage {
    pub message: String,
}

// Char-boundary-safe cut so lossy decoding never emits U+FFFD for valid UTF-8 input.
fn cap_at_char_boundary(bytes: &[u8], cap: usize) -> String {
    let mut end = cap.min(bytes.len());
    while end > 0 && end < bytes.len() && (bytes[end] & 0xC0) == 0x80 {
        end -= 1;
    }
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

pub fn staged_diff_context(cwd: &Path) -> Result<String, String> {
    let output = run_git(cwd, &["diff", "--cached"])?;
    if !output.status.success() {
        return Err(format!(
            "git diff --cached failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let raw = output.stdout;
    if raw.iter().all(|&b| b.is_ascii_whitespace()) {
        return Err("nothing staged".into());
    }
    Ok(cap_at_char_boundary(&raw, DIFF_CTX_CAP_BYTES))
}

pub fn build_prompt(diff_ctx: &str) -> String {
    format!(
        "Write a single conventional-commit subject line (<=72 chars, no body) summarizing this \
         staged diff. Reply with ONLY the subject line.\n\nStaged diff:\n{diff_ctx}"
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

// Agents love prose and markdown fences; only a bare subject line survives this.
fn clean_agent_reply(raw: &str) -> Result<String, String> {
    let mut candidate = raw.trim();
    // Quote-wrapping only makes sense on single-line replies; multiline is markdown
    // territory handled by fence-skipping below (stripping "```" pairs would mangle it).
    if !candidate.contains('\n') {
        candidate = strip_wrapping_quotes(candidate);
    }
    let subject = candidate
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with("```"))
        .next()
        .unwrap_or("");
    let subject: String = subject.chars().take(MAX_SUBJECT_CHARS).collect();
    if subject.is_empty() {
        return Err("empty response from agent".into());
    }
    Ok(subject)
}

pub fn generate_with_agent(cwd: &Path, profile: &catalog::AgentProfile) -> Result<String, String> {
    generate_with_agent_path(cwd, profile, None)
}

// path_env overrides PATH lookup so tests can inject fake agent binaries without
// mutating process env; None inherits the real environment.
pub fn generate_with_agent_path(
    cwd: &Path,
    profile: &catalog::AgentProfile,
    path_env: Option<&OsStr>,
) -> Result<String, String> {
    // Print-mode argv per Orca semantics: claude -p <prompt>, codex exec <prompt>.
    let prompt_arg: &str = match profile.id {
        "claude" => "-p",
        "codex" => "exec",
        _ => return Err("ai commit messages support claude and codex only".into()),
    };
    let resolved =
        catalog::resolve_command_with_path(profile.command, path_env)
            .ok_or_else(|| "agent not found on PATH".to_string())?;
    let diff_ctx = staged_diff_context(cwd)?;
    let prompt = build_prompt(&diff_ctx);
    // Rust's BatBadBut guard refuses newline-bearing argv on .cmd/.bat shims
    // (npm installs of both agents), so batch targets take the prompt on stdin.
    let is_batch = is_windows_batch(&resolved);
    let args: Vec<String> = if is_batch {
        vec![prompt_arg.to_string()]
    } else {
        vec![prompt_arg.to_string(), prompt.clone()]
    };
    let stdin_prompt = is_batch.then_some(prompt.as_str());
    let stdout = run_with_timeout(&resolved, &args, cwd, AGENT_TIMEOUT_SECS, stdin_prompt)?;
    clean_agent_reply(&stdout)
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

fn run_with_timeout(
    program: &Path,
    args: &[String],
    cwd: &Path,
    secs: u64,
    stdin_prompt: Option<&str>,
) -> Result<String, String> {
    use std::io::Write;
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(if stdin_prompt.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to launch {}: {e}", program.display()))?;
    if let Some(prompt) = stdin_prompt {
        // Prompt fits the OS pipe buffer (32KB cap), so this write cannot deadlock.
        if let Some(mut pipe) = child.stdin.take() {
            let _ = pipe.write_all(prompt.as_bytes());
        }
    }
    let mut stdout_pipe = child.stdout.take();
    let deadline = Instant::now() + Duration::from_secs(secs);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("agent timed out after {secs}s"));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(format!("agent wait failed: {e}")),
        }
    };
    let mut text = String::new();
    if let Some(pipe) = stdout_pipe.as_mut() {
        let _ = pipe.read_to_string(&mut text);
    }
    if !status.success() {
        return Err(format!("agent exited with {}", status));
    }
    Ok(text)
}

// Deterministic floor so the feature degrades to something committable when no agent exists.
pub fn heuristic_message(cwd: &Path) -> String {
    let numstat = run_git(cwd, &["diff", "--cached", "--numstat"])
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    let paths: Vec<&str> = numstat
        .lines()
        .filter_map(|line| line.split('\t').nth(2))
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect();
    if paths.len() == 1 {
        let base = paths[0].rsplit(['/', '\\']).next().unwrap_or(paths[0]);
        return format!("chore: update {base}");
    }
    format!("chore: update {} files", paths.len())
}

pub fn sc_generate_commit_message(cwd: &Path) -> Result<String, String> {
    sc_generate_commit_message_path(cwd, None)
}

// Never errors unless nothing staged: agent failures degrade to the heuristic message.
pub fn sc_generate_commit_message_path(
    cwd: &Path,
    path_env: Option<&OsStr>,
) -> Result<String, String> {
    staged_diff_context(cwd)?;
    for id in ["claude", "codex"] {
        if let Some(profile) = catalog::lookup(id) {
            if let Ok(message) = generate_with_agent_path(cwd, profile, path_env) {
                return Ok(message);
            }
        }
    }
    Ok(heuristic_message(cwd))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agents::catalog::lookup;
    use crate::git::test_support::{sandbox, write_file};

    #[test]
    fn staged_diff_context_errors_when_nothing_staged() {
        let s = sandbox("cm-empty");
        assert_eq!(staged_diff_context(&s.repo).unwrap_err(), "nothing staged");
    }

    #[test]
    fn staged_diff_context_returns_staged_content_and_caps_at_32kb_char_safe() {
        let s = sandbox("cm-cap");
        // 3-byte cycle guarantees the 32KB cap lands mid-char.
        let big = "é€".repeat(30_000);
        write_file(&s.repo, "big.txt", &big);
        sc_stage_for_test(&s.repo, &["big.txt"]);

        let ctx = staged_diff_context(&s.repo).unwrap();
        assert!(ctx.len() <= DIFF_CTX_CAP_BYTES);
        assert!(!ctx.contains('\u{FFFD}'));
        assert!(ctx.contains("+++ b/big.txt"));
        let last = ctx.chars().last().unwrap();
        // Cycle chars plus diff punctuation: anything else means a mangled cut.
        assert!(
            matches!(last, 'a' | 'é' | '€' | '+' | '-' | '@' | ' ' | '\n' | '\\' | '.' | 't' | 'x' | 'g' | ':' | 'b' | '/'),
            "cut must land on a whole char, got {last:?}"
        );
    }

    #[test]
    fn prompt_embeds_instruction_and_full_context() {
        let ctx = "diff --git a/a.txt b/a.txt\n+hello";
        let prompt = build_prompt(ctx);
        assert!(prompt.starts_with("Write a single conventional-commit subject line"));
        assert!(prompt.ends_with(ctx));
        assert!(prompt.contains("Reply with ONLY the subject line"));
    }

    #[test]
    fn cleanup_strips_wrapping_quotes_and_backticks() {
        assert_eq!(clean_agent_reply("\"feat: quoted\"\n").unwrap(), "feat: quoted");
        assert_eq!(clean_agent_reply("'feat: single'").unwrap(), "feat: single");
        assert_eq!(clean_agent_reply("`feat: backtick`\n").unwrap(), "feat: backtick");
    }

    #[test]
    fn cleanup_takes_first_non_empty_line_and_skips_fences() {
        assert_eq!(
            clean_agent_reply("\n\nfeat: first\nfeat: second\n").unwrap(),
            "feat: first"
        );
        assert_eq!(
            clean_agent_reply("```\nfix: from fenced block\n```").unwrap(),
            "fix: from fenced block"
        );
        assert_eq!(clean_agent_reply("").unwrap_err(), "empty response from agent");
        assert_eq!(clean_agent_reply("```js\n```").unwrap_err(), "empty response from agent");
    }

    #[test]
    fn cleanup_truncates_multibyte_subjects_at_72_chars_without_splitting() {
        let long = "fé".repeat(60);
        let cleaned = clean_agent_reply(&long).unwrap();
        assert_eq!(cleaned.chars().count(), MAX_SUBJECT_CHARS);
        assert_eq!(cleaned, "fé".repeat(MAX_SUBJECT_CHARS / 2));
        assert!(!cleaned.contains('\u{FFFD}'));
    }

    #[test]
    fn unsupported_agent_ids_are_rejected_upfront() {
        let s = sandbox("cm-unsupported");
        write_file(&s.repo, "x.txt", "x");
        sc_stage_for_test(&s.repo, &["x.txt"]);
        for id in ["gemini", "qwen", "opencode", "grok", "generic"] {
            let err = generate_with_agent_path(&s.repo, lookup(id).unwrap(), Some(OsStr::new("")))
                .unwrap_err();
            assert_eq!(err, "ai commit messages support claude and codex only", "{id}");
        }
    }

    #[test]
    fn missing_binary_reports_agent_not_found_on_path() {
        let s = sandbox("cm-missing");
        write_file(&s.repo, "x.txt", "x");
        sc_stage_for_test(&s.repo, &["x.txt"]);
        let err = generate_with_agent_path(&s.repo, lookup("claude").unwrap(), Some(OsStr::new("")))
            .unwrap_err();
        assert_eq!(err, "agent not found on PATH");
    }

    fn fake_agent_dir(tag: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        {
            std::fs::write(dir.path().join("claude.cmd"), "@echo off\r\necho feat: fake subject\r\n")
                .unwrap();
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            let script = dir.path().join("claude");
            std::fs::write(&script, "#!/bin/sh\necho \"feat: fake subject\"\n").unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let _ = tag;
        dir
    }

    #[test]
    fn fake_claude_on_injected_path_yields_its_subject_line() {
        let s = sandbox("cm-fake-agent");
        write_file(&s.repo, "code.rs", "fn main() {}\n");
        sc_stage_for_test(&s.repo, &["code.rs"]);
        let fake = fake_agent_dir("unit");

        let msg = generate_with_agent_path(
            &s.repo,
            lookup("claude").unwrap(),
            Some(fake.path().as_os_str()),
        )
        .unwrap();
        assert_eq!(msg, "feat: fake subject");
    }

    #[cfg(windows)]
    #[test]
    fn run_with_timeout_kills_windows_sleeper_after_deadline() {
        let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into());
        let started = Instant::now();
        let err = run_with_timeout(
            Path::new(&comspec),
            &["/c".into(), "waitfor".into(), "/t".into(), "90".into(), "oppaNever".into()],
            Path::new("."),
            1,
            None,
        )
        .unwrap_err();
        assert!(err.contains("timed out"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(20), "kill must not wait out the sleeper");
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
        assert!(started.elapsed() < Duration::from_secs(20), "kill must not wait out the sleeper");
    }

    #[test]
    fn orchestrator_falls_back_to_heuristic_when_no_agent_resolves() {
        let s = sandbox("cm-fallback-one");
        write_file(&s.repo, "single.txt", "content");
        sc_stage_for_test(&s.repo, &["single.txt"]);
        let msg = sc_generate_commit_message_path(&s.repo, Some(OsStr::new(""))).unwrap();
        assert_eq!(msg, "chore: update single.txt");

        write_file(&s.repo, "nested/second.txt", "more");
        sc_stage_for_test(&s.repo, &["nested/second.txt"]);
        let msg = sc_generate_commit_message_path(&s.repo, Some(OsStr::new(""))).unwrap();
        assert_eq!(msg, "chore: update 2 files");
    }

    #[test]
    fn orchestrator_errors_only_when_nothing_staged() {
        let s = sandbox("cm-nothing-staged");
        assert_eq!(
            sc_generate_commit_message_path(&s.repo, Some(OsStr::new(""))).unwrap_err(),
            "nothing staged"
        );
    }

    #[test]
    fn heuristic_single_file_uses_basename_multi_reports_count() {
        let s = sandbox("cm-heuristic");
        write_file(&s.repo, "deep/nested/only.rs", "// code");
        sc_stage_for_test(&s.repo, &["deep/nested/only.rs"]);
        assert_eq!(heuristic_message(&s.repo), "chore: update only.rs");
    }

    fn sc_stage_for_test(repo: &Path, paths: &[&str]) {
        let mut args = vec!["add", "--"];
        args.extend(paths.iter().copied());
        crate::git::worktrees::run_git(repo, &args).unwrap();
    }
}
