pub mod comments_store;
pub mod source_control;
pub mod teardown;
pub mod worktree_lineage;
pub mod worktree_naming;
pub mod worktree_registry;
pub mod worktrees;

#[cfg(test)]
pub(crate) mod test_support;

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitFileStatus {
    pub path: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GitStatusResult {
    pub is_git: bool,
    pub branch: String,
    pub files: Vec<GitFileStatus>,
    pub ahead: usize,
    pub behind: usize,
}

/// Extract clean branch name from porcelain v1 branch header.
fn extract_branch_name(raw: &str) -> String {
    if let Some(rest) = raw.strip_prefix("Initial commit on ") {
        rest.trim().to_string()
    } else if let Some(rest) = raw.strip_prefix("No commits yet on ") {
        rest.trim().to_string()
    } else {
        let parts: Vec<&str> = raw.split("...").collect();
        let local_part = parts[0].trim();
        if local_part.is_empty() {
            "HEAD".to_string()
        } else {
            local_part.to_string()
        }
    }
}

/// Parse porcelain v1 format text into GitStatusResult.
pub fn parse_git_status_porcelain(stdout: &str) -> GitStatusResult {
    let mut lines = stdout.lines();
    let mut branch = "HEAD".to_string();
    let mut ahead = 0;
    let mut behind = 0;

    if let Some(branch_line) = lines.next() {
        let raw = branch_line.strip_prefix("## ").unwrap_or(branch_line).trim();

        if let Some(bracket_idx) = raw.find('[') {
            let bracket_content = &raw[bracket_idx..];
            if let Some(ahead_part) = bracket_content.split("ahead ").nth(1) {
                ahead = ahead_part
                    .chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse()
                    .unwrap_or(0);
            }
            if let Some(behind_part) = bracket_content.split("behind ").nth(1) {
                behind = behind_part
                    .chars()
                    .take_while(|c| c.is_ascii_digit())
                    .collect::<String>()
                    .parse()
                    .unwrap_or(0);
            }
            let pre_bracket = raw[..bracket_idx].trim();
            branch = extract_branch_name(pre_bracket);
        } else {
            branch = extract_branch_name(raw);
        }
    }

    let mut files = Vec::new();
    for line in lines {
        if line.len() < 3 {
            continue;
        }
        let status = line[0..2].trim().to_string();
        let file_path = line[3..].trim().trim_matches('"').to_string();
        if !status.is_empty() && !file_path.is_empty() {
            files.push(GitFileStatus {
                path: file_path,
                status,
            });
        }
    }

    GitStatusResult {
        is_git: true,
        branch,
        files,
        ahead,
        behind,
    }
}

#[tauri::command]
pub fn git_status(path: String) -> Result<GitStatusResult, String> {
    let dir = Path::new(&path);
    if !dir.exists() {
        return Err(format!("Directory does not exist: {}", path));
    }

    let mut cmd = Command::new("git");
    cmd.arg("status").arg("--porcelain=v1").arg("-b").current_dir(dir);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output();

    let output = match output {
        Ok(o) if o.status.success() => o,
        _ => {
            return Ok(GitStatusResult {
                is_git: false,
                branch: String::new(),
                files: Vec::new(),
                ahead: 0,
                behind: 0,
            });
        }
    };

    let text = String::from_utf8_lossy(&output.stdout);
    Ok(parse_git_status_porcelain(&text))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("oppa-git-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn test_git_status_non_git_folder() {
        let dir = temp_dir("nongit");
        let result = git_status(dir.to_string_lossy().to_string()).unwrap();
        assert!(!result.is_git);
        assert_eq!(result.branch, "");
        assert_eq!(result.files.len(), 0);
        assert_eq!(result.ahead, 0);
        assert_eq!(result.behind, 0);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn test_git_status_nonexistent_directory_returns_err() {
        let res = git_status("/nonexistent/path/for/oppa/test".to_string());
        assert!(res.is_err());
    }

    #[test]
    fn test_parse_git_status_porcelain_with_ahead_and_behind() {
        let stdout = "## main...origin/main [ahead 3, behind 1]\n M src/lib.rs\n?? new_file.txt\nD  old_file.txt\n";
        let parsed = parse_git_status_porcelain(stdout);
        assert!(parsed.is_git);
        assert_eq!(parsed.branch, "main");
        assert_eq!(parsed.ahead, 3);
        assert_eq!(parsed.behind, 1);
        assert_eq!(parsed.files.len(), 3);
        assert_eq!(
            parsed.files[0],
            GitFileStatus {
                path: "src/lib.rs".to_string(),
                status: "M".to_string(),
            }
        );
        assert_eq!(
            parsed.files[1],
            GitFileStatus {
                path: "new_file.txt".to_string(),
                status: "??".to_string(),
            }
        );
        assert_eq!(
            parsed.files[2],
            GitFileStatus {
                path: "old_file.txt".to_string(),
                status: "D".to_string(),
            }
        );
    }

    #[test]
    fn test_parse_git_status_porcelain_no_commits() {
        let stdout = "## No commits yet on feature-x\n?? initial.txt\n";
        let parsed = parse_git_status_porcelain(stdout);
        assert!(parsed.is_git);
        assert_eq!(parsed.branch, "feature-x");
        assert_eq!(parsed.ahead, 0);
        assert_eq!(parsed.behind, 0);
        assert_eq!(parsed.files.len(), 1);
        assert_eq!(parsed.files[0].path, "initial.txt");
    }

    #[test]
    fn test_parse_git_status_porcelain_detached_head() {
        let stdout = "## HEAD (no branch)\n";
        let parsed = parse_git_status_porcelain(stdout);
        assert!(parsed.is_git);
        assert_eq!(parsed.branch, "HEAD (no branch)");
        assert_eq!(parsed.files.len(), 0);
    }
}
