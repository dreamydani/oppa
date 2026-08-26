// Shared runner for agent CLI invocations that produce prompt text
// (commit-message and PR-description generation): spawn with optional
// stdin prompt, bounded wait, kill on deadline, capture stdout.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Apply the Windows no-window flag so agent consoles never flash.
pub(crate) fn set_no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// Run `program args` in `cwd`, optionally feeding `stdin_prompt`, and
/// return stdout. Kills the child at the `secs` deadline.
pub(crate) fn run_agent_with_timeout(
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
    set_no_window(&mut cmd);
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
