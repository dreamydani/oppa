use crate::pty::powershell_bootstrap::generate_powershell_encoded_bootstrap;
use std::path::Path;

// Configuration for launching a terminal shell process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellLaunchConfig {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
}

#[cfg(target_os = "windows")]
fn is_executable_in_path(exe: &str) -> bool {
    if Path::new(exe).is_absolute() {
        return Path::new(exe).exists();
    }
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            if dir.join(exe).exists() {
                return true;
            }
        }
    }
    false
}

#[cfg(target_os = "windows")]
fn powershell_exists() -> bool {
    if is_executable_in_path("powershell.exe") {
        return true;
    }
    let sys_root = std::env::var("SystemRoot")
        .or_else(|_| std::env::var("WINDIR"))
        .unwrap_or_else(|_| "C:\\Windows".to_string());
    Path::new(&sys_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe")
        .exists()
}

#[cfg(target_os = "windows")]
pub fn default_windows_shell() -> String {
    if is_executable_in_path("pwsh.exe") {
        return "pwsh.exe".to_string();
    }
    if powershell_exists() {
        return "powershell.exe".to_string();
    }
    std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
}

#[cfg(not(target_os = "windows"))]
pub fn default_unix_shell() -> String {
    std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| {
        ["/bin/zsh", "/bin/bash", "/bin/sh"]
            .into_iter()
            .find(|candidate| Path::new(candidate).exists())
            .unwrap_or("/bin/sh")
            .to_string()
    })
}

pub fn resolve_shell_launch_config(
    requested_shell: Option<String>,
    cwd: Option<String>,
) -> ShellLaunchConfig {
    #[cfg(target_os = "windows")]
    {
        let program = requested_shell
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(default_windows_shell);

        let basename = Path::new(&program)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&program)
            .to_ascii_lowercase();

        let args = if basename == "powershell.exe"
            || basename == "pwsh.exe"
            || basename == "powershell"
            || basename == "pwsh"
        {
            vec![
                "-NoLogo".to_string(),
                "-NoExit".to_string(),
                "-EncodedCommand".to_string(),
                generate_powershell_encoded_bootstrap(cwd.as_deref()),
            ]
        } else if basename == "cmd.exe" || basename == "cmd" {
            vec!["/K".to_string(), "chcp 65001 > nul".to_string()]
        } else {
            Vec::new()
        };

        ShellLaunchConfig { program, args, cwd }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let program = requested_shell
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(default_unix_shell);
        let args = vec!["-l".to_string()];
        ShellLaunchConfig { program, args, cwd }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "windows")]
    fn test_windows_powershell_args_contain_nologo_and_encoded_command() {
        let config = resolve_shell_launch_config(
            Some("powershell.exe".into()),
            Some("C:\\test".into()),
        );
        assert_eq!(config.program, "powershell.exe");
        assert_eq!(config.args.len(), 4);
        assert_eq!(config.args[0], "-NoLogo");
        assert_eq!(config.args[1], "-NoExit");
        assert_eq!(config.args[2], "-EncodedCommand");
        assert!(!config.args[3].is_empty());
        assert_eq!(config.cwd.as_deref(), Some("C:\\test"));
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn test_windows_powershell_full_path() {
        let config = resolve_shell_launch_config(
            Some("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe".into()),
            None,
        );
        assert_eq!(
            config.program,
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
        );
        assert_eq!(config.args.len(), 4);
        assert_eq!(config.args[0], "-NoLogo");
        assert_eq!(config.args[1], "-NoExit");
        assert_eq!(config.args[2], "-EncodedCommand");
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn test_windows_pwsh_args() {
        let config = resolve_shell_launch_config(Some("pwsh.exe".into()), None);
        assert_eq!(config.program, "pwsh.exe");
        assert_eq!(config.args.len(), 4);
        assert_eq!(config.args[0], "-NoLogo");
        assert_eq!(config.args[1], "-NoExit");
        assert_eq!(config.args[2], "-EncodedCommand");
        assert!(config.cwd.is_none());
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn test_windows_cmd_args_contain_chcp_utf8() {
        let config = resolve_shell_launch_config(Some("cmd.exe".into()), None);
        assert_eq!(config.program, "cmd.exe");
        assert_eq!(
            config.args,
            vec!["/K".to_string(), "chcp 65001 > nul".to_string()]
        );
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn test_windows_cmd_full_path() {
        let config = resolve_shell_launch_config(
            Some("C:\\Windows\\System32\\cmd.exe".into()),
            Some("C:\\workspace".into()),
        );
        assert_eq!(config.program, "C:\\Windows\\System32\\cmd.exe");
        assert_eq!(
            config.args,
            vec!["/K".to_string(), "chcp 65001 > nul".to_string()]
        );
        assert_eq!(config.cwd.as_deref(), Some("C:\\workspace"));
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn test_windows_custom_shell_empty_args() {
        let config = resolve_shell_launch_config(
            Some("bash.exe".into()),
            Some("C:\\test".into()),
        );
        assert_eq!(config.program, "bash.exe");
        assert!(config.args.is_empty());
        assert_eq!(config.cwd.as_deref(), Some("C:\\test"));
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn test_windows_default_shell_resolution() {
        let config = resolve_shell_launch_config(None, None);
        assert!(!config.program.is_empty());
        if config.program.to_lowercase().contains("powershell")
            || config.program.to_lowercase().contains("pwsh")
        {
            assert_eq!(config.args[0], "-NoLogo");
            assert_eq!(config.args[1], "-NoExit");
            assert_eq!(config.args[2], "-EncodedCommand");
        } else if config.program.to_lowercase().contains("cmd") {
            assert_eq!(
                config.args,
                vec!["/K".to_string(), "chcp 65001 > nul".to_string()]
            );
        }
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn test_unix_shell_args_use_login_flag() {
        let config = resolve_shell_launch_config(
            Some("/bin/zsh".into()),
            Some("/tmp".into()),
        );
        assert_eq!(config.program, "/bin/zsh");
        assert_eq!(config.args, vec!["-l".to_string()]);
        assert_eq!(config.cwd.as_deref(), Some("/tmp"));
    }
}
