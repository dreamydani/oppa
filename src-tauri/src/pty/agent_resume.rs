//! Registry of known agent CLIs so cold-booted terminals can resume their native sessions.

use crate::pty::snapshot::AgentSessionRef;
use std::fs;
use std::path::{Path, PathBuf};

pub struct AgentProfile {
    pub name: &'static str,
    /// First token of the command line, ext-tolerant (.exe/.cmd/.ps1/.bat stripped, case-insensitive)
    pub matches_program: fn(&str) -> bool,
    /// Transcript dir for this agent given home + cwd; None when unknown
    pub transcript_dir: fn(home: &Path, cwd: &str) -> Option<PathBuf>,
    /// Native resume command line; None => caller falls back to plain relaunch of foreground_command
    pub build_resume: fn(&AgentSessionRef) -> Option<String>,
}

fn program_is(expected: &'static str, command_line: &str) -> bool {
    normalize_program_token(&first_token(command_line)) == expected
}

/// Extract the first whitespace-or-quote-delimited token of a command line.
fn first_token(command_line: &str) -> String {
    let trimmed = command_line.trim();
    if let Some(rest) = trimmed.strip_prefix('"') {
        return rest.split('"').next().unwrap_or("").to_string();
    }
    trimmed.split_whitespace().next().unwrap_or("").to_string()
}

fn normalize_program_token(token: &str) -> String {
    // Take basename across both separators, then strip a known launcher extension.
    let basename = token
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(token)
        .trim_matches('"')
        .to_ascii_lowercase();
    let stem = basename
        .strip_suffix(".exe")
        .or_else(|| basename.strip_suffix(".cmd"))
        .or_else(|| basename.strip_suffix(".ps1"))
        .or_else(|| basename.strip_suffix(".bat"))
        .unwrap_or(&basename);
    stem.to_string()
}

/// Claude Code slug: cwd with every non-alphanumeric replaced by '-' (case preserved).
/// Verified against a real ~/.claude/projects: "C:\\Users\\danial" -> "C--Users-danial".
fn claude_cwd_slug(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect()
}

fn claude_transcript_dir(home: &Path, cwd: &str) -> Option<PathBuf> {
    Some(
        home.join(".claude")
            .join("projects")
            .join(claude_cwd_slug(cwd)),
    )
}

fn codex_transcript_dir(home: &Path, _cwd: &str) -> Option<PathBuf> {
    Some(home.join(".codex").join("sessions"))
}

fn no_transcript_dir(_home: &Path, _cwd: &str) -> Option<PathBuf> {
    None
}

fn claude_build_resume(session: &AgentSessionRef) -> Option<String> {
    Some(format!("claude --resume {}", session.id))
}

fn codex_build_resume(session: &AgentSessionRef) -> Option<String> {
    Some(format!("codex resume {}", session.id))
}

// agy exposes --continue (most recent) and --conversation <ID>; by-id is precise.
fn agy_build_resume(session: &AgentSessionRef) -> Option<String> {
    Some(format!("agy --conversation {}", session.id))
}

// Plain-relaunch agents: no structured resume known; callers re-run foreground_command.
fn gemini_build_resume(_session: &AgentSessionRef) -> Option<String> {
    None
}

fn aider_build_resume(_session: &AgentSessionRef) -> Option<String> {
    None
}

const PROFILES: &[AgentProfile] = &[
    AgentProfile {
        name: "claude",
        matches_program: |cmd| program_is("claude", cmd),
        transcript_dir: claude_transcript_dir,
        build_resume: claude_build_resume,
    },
    AgentProfile {
        name: "codex",
        matches_program: |cmd| program_is("codex", cmd),
        transcript_dir: codex_transcript_dir,
        build_resume: codex_build_resume,
    },
    AgentProfile {
        name: "gemini",
        matches_program: |cmd| program_is("gemini", cmd),
        transcript_dir: no_transcript_dir,
        build_resume: gemini_build_resume,
    },
    AgentProfile {
        name: "aider",
        matches_program: |cmd| program_is("aider", cmd),
        transcript_dir: no_transcript_dir,
        build_resume: aider_build_resume,
    },
    AgentProfile {
        name: "agy",
        matches_program: |cmd| program_is("agy", cmd),
        transcript_dir: no_transcript_dir,
        build_resume: agy_build_resume,
    },
];

pub fn find_profile(command_line: &str) -> Option<&'static AgentProfile> {
    PROFILES.iter().find(|p| (p.matches_program)(command_line))
}

pub fn is_known_agent_program(command_line: &str) -> bool {
    find_profile(command_line).is_some()
}

/// Newest-mtime *.jsonl-style transcript under dir (recursive).
/// id = file stem minus Codex's "rollout-" prefix (no other agent uses it).
pub fn find_newest_transcript(dir: &Path, extension: &str) -> Option<(String, PathBuf)> {
    let mut best: Option<(std::time::SystemTime, String, PathBuf)> = None;
    walk_transcripts(dir, extension, &mut |path| {
        let Ok(metadata) = path.metadata() else {
            return;
        };
        let Ok(modified) = metadata.modified() else {
            return;
        };
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            return;
        };
        if best.as_ref().is_none_or(|(m, _, _)| modified > *m) {
            best = Some((modified, codex_id_from_stem(stem), path.to_path_buf()));
        }
    });
    best.map(|(_, id, path)| (id, path))
}

fn walk_transcripts(dir: &Path, extension: &str, visit: &mut impl FnMut(&Path)) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk_transcripts(&path, extension, visit);
        } else if path.extension().and_then(|e| e.to_str()) == Some(extension) {
            visit(&path);
        }
    }
}

fn codex_id_from_stem(stem: &str) -> String {
    stem.strip_prefix("rollout-").unwrap_or(stem).to_string()
}

fn capture_for_profile(
    profile: &AgentProfile,
    home: &Path,
    cwd: &str,
) -> Option<AgentSessionRef> {
    let transcript_dir = (profile.transcript_dir)(home, cwd)?;
    let (stem_id, transcript_path) = find_newest_transcript(&transcript_dir, "jsonl")?;
    // Recent Claude Code names the transcript file with a UUID that can differ
    // from the real session id — prefer the id recorded inside the file.
    let id = session_id_from_transcript(&transcript_path).unwrap_or(stem_id);
    Some(AgentSessionRef {
        agent: profile.name.to_string(),
        id,
        transcript_path: Some(transcript_path.to_string_lossy().into_owned()),
    })
}

/// Reads the first few lines of a transcript looking for a top-level
/// `"sessionId"` field (Claude Code writes it on line 1).
fn session_id_from_transcript(path: &Path) -> Option<String> {
    use std::io::BufRead;
    let file = fs::File::open(path).ok()?;
    for line in std::io::BufReader::new(file).lines().take(5) {
        let line = line.ok()?;
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
            if let Some(id) = value.get("sessionId").and_then(|v| v.as_str()) {
                return Some(id.to_string());
            }
        }
    }
    None
}

pub fn capture_agent_session(command_line: &str, cwd: &str) -> Option<AgentSessionRef> {
    let profile = find_profile(command_line)?;
    let home = dirs::home_dir()?;
    capture_for_profile(profile, &home, cwd)
}

pub fn plan_resume(agent_session: &AgentSessionRef) -> Option<String> {
    let profile = PROFILES.iter().find(|p| p.name == agent_session.agent)?;
    (profile.build_resume)(agent_session)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::Duration;

    #[test]
    fn matches_bare_and_ext_tolerant_program_tokens() {
        assert!(find_profile("claude").is_some());
        assert!(find_profile("claude.exe").is_some());
        assert!(find_profile(r#""C:\path\claude.exe" --resume x"#).is_some());
        assert!(find_profile("CLAUDE").is_some());
        assert!(find_profile("Claude.cmd --flag").is_some());
    }

    #[test]
    fn non_agent_commands_do_not_match() {
        assert!(find_profile("npm run dev").is_none());
        assert!(find_profile("vim notes.txt").is_none());
        assert!(find_profile("git status").is_none());
        assert!(find_profile("").is_none());
        assert!(!is_known_agent_program("npm install"));
        assert!(is_known_agent_program("claude.exe"));
    }

    #[test]
    fn find_newest_transcript_picks_newest_mtime_and_stem_id() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let dir = tmp.path();
        fs::write(dir.join("old-session.jsonl"), b"a").expect("write");
        std::thread::sleep(Duration::from_millis(30));
        fs::write(dir.join("middle.jsonl"), b"c").expect("write");
        std::thread::sleep(Duration::from_millis(30));
        fs::write(dir.join("newest-session.jsonl"), b"b").expect("write");
        fs::write(dir.join("ignored.txt"), b"d").expect("write");

        let (id, path) = find_newest_transcript(dir, "jsonl").expect("found");
        assert_eq!(id, "newest-session");
        assert_eq!(path, dir.join("newest-session.jsonl"));
    }

    #[test]
    fn find_newest_transcript_searches_recursively_and_strips_rollout_prefix() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let nested = tmp.path().join("2026").join("08");
        fs::create_dir_all(&nested).expect("mkdir");
        fs::write(tmp.path().join("rollout-shallow.jsonl"), b"a").expect("write");
        std::thread::sleep(Duration::from_millis(30));
        fs::write(nested.join("rollout-newest-id.jsonl"), b"b").expect("write");
        let (id, path) = find_newest_transcript(tmp.path(), "jsonl").expect("found");
        assert_eq!(id, "newest-id", "rollout- prefix stripped from stem");
        assert_eq!(path, nested.join("rollout-newest-id.jsonl"));
    }

    #[test]
    fn find_newest_transcript_empty_dir_returns_none() {
        let tmp = tempfile::tempdir().expect("tempdir");
        assert!(find_newest_transcript(tmp.path(), "jsonl").is_none());
    }

    #[test]
    fn claude_slug_matches_real_projects_layout() {
        assert_eq!(
            claude_cwd_slug(r"C:\Users\danial"),
            "C--Users-danial"
        );
        assert_eq!(
            claude_cwd_slug(r"C:\01-DeveloperSpace"),
            "C--01-DeveloperSpace"
        );
    }

    #[test]
    fn capture_finds_newest_claude_transcript_in_temp_home() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let projects = tmp.path().join(".claude").join("projects").join("C--Users-danial");
        fs::create_dir_all(&projects).expect("mkdir");
        fs::write(projects.join("stale.jsonl"), b"a").expect("write");
        std::thread::sleep(Duration::from_millis(30));
        fs::write(projects.join("fresh-id.jsonl"), b"b").expect("write");

        let claude_profile =
            find_profile("claude --continue").expect("profile");
        let captured = capture_for_profile(claude_profile, tmp.path(), r"C:\Users\danial")
            .expect("captured");
        assert_eq!(
            captured,
            AgentSessionRef {
                agent: "claude".to_string(),
                id: "fresh-id".to_string(),
                transcript_path: Some(
                    projects.join("fresh-id.jsonl").to_string_lossy().into_owned()
                ),
            }
        );
    }

    #[test]
    fn capture_codex_strips_rollout_prefix_from_id() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let sessions = tmp.path().join(".codex").join("sessions").join("2026");
        fs::create_dir_all(&sessions).expect("mkdir");
        fs::write(sessions.join("rollout-abc-123.jsonl"), b"a").expect("write");

        let codex_profile = find_profile("codex.exe").expect("profile");
        let captured = capture_for_profile(codex_profile, tmp.path(), "/tmp/proj")
            .expect("captured");
        assert_eq!(captured.agent, "codex");
        assert_eq!(captured.id, "abc-123");
    }

    #[test]
    fn capture_returns_none_when_no_transcripts_or_unknown_agent() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let claude_profile = find_profile("claude").expect("profile");
        assert!(capture_for_profile(claude_profile, tmp.path(), r"C:\proj").is_none());

        let gemini_profile = find_profile("gemini").expect("profile");
        assert!(capture_for_profile(gemini_profile, tmp.path(), r"C:\proj").is_none());
        assert!(capture_agent_session("vim file.txt", "/x").is_none());
    }

    #[test]
    fn capture_prefers_session_id_recorded_inside_transcript_over_filename_stem() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let projects = tmp.path().join(".claude").join("projects").join("C--proj");
        fs::create_dir_all(&projects).expect("mkdir");
        // Filename UUID deliberately differs from the real session id (recent Claude Code)
        let content = b"{\"type\":\"mode\",\"mode\":\"normal\",\"sessionId\":\"real-session-uuid\"}\n";
        std::thread::sleep(Duration::from_millis(30));
        fs::write(projects.join("deadbeef-0000.jsonl"), content).expect("write");

        let claude_profile = find_profile("claude --continue").expect("profile");
        let captured = capture_for_profile(claude_profile, tmp.path(), r"C:\proj")
            .expect("captured");
        assert_eq!(captured.id, "real-session-uuid");
        assert_eq!(captured.agent, "claude");
    }

    #[test]
    fn capture_falls_back_to_stem_when_transcript_has_no_session_id_field() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let projects = tmp.path().join(".claude").join("projects").join("C--proj2");
        fs::create_dir_all(&projects).expect("mkdir");
        fs::write(projects.join("stem-id.jsonl"), b"{}\n").expect("write");

        let claude_profile = find_profile("claude").expect("profile");
        let captured =
            capture_for_profile(claude_profile, tmp.path(), r"C:\proj2").expect("captured");
        assert_eq!(captured.id, "stem-id");
    }

    #[test]
    fn plan_resume_builds_native_commands() {
        let claude_ref = AgentSessionRef {
            agent: "claude".to_string(),
            id: "abc123".to_string(),
            transcript_path: None,
        };
        assert_eq!(
            plan_resume(&claude_ref),
            Some("claude --resume abc123".to_string())
        );

        let codex_ref = AgentSessionRef {
            agent: "codex".to_string(),
            id: "xyz".to_string(),
            transcript_path: None,
        };
        assert_eq!(plan_resume(&codex_ref), Some("codex resume xyz".to_string()));

        let agy_ref = AgentSessionRef {
            agent: "agy".to_string(),
            id: "conv9".to_string(),
            transcript_path: None,
        };
        assert_eq!(
            plan_resume(&agy_ref),
            Some("agy --conversation conv9".to_string())
        );
    }

    #[test]
    fn plain_relaunch_profiles_yield_none_from_plan_resume() {
        for agent in ["gemini", "aider"] {
            let session = AgentSessionRef {
                agent: agent.to_string(),
                id: "whatever".to_string(),
                transcript_path: None,
            };
            assert_eq!(plan_resume(&session), None, "{agent} must plain-relaunch");
        }
        let unknown = AgentSessionRef {
            agent: "mystery".to_string(),
            id: "x".to_string(),
            transcript_path: None,
        };
        assert_eq!(plan_resume(&unknown), None);
    }
}
