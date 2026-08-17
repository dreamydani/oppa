# Shell Bootstrap & Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement clean shell startup (suppress Windows PowerShell copyright banner, force UTF-8 console output, probe pwsh -> powershell -> cmd), inject OSC 133 semantic prompt hooks, and provide in-stream OSC 7 directory scanning so split panes inherit the active working directory.

**Architecture:** Rust backend in `src-tauri/src/pty/` resolves shell args and builds Base64 UTF-16LE bootstrap scripts for PowerShell, while an in-stream OSC parser in `manager.rs` inspects PTY output chunks to update session CWD in real-time and emit `pty:cwd` to the React/Zustand frontend.

**Tech Stack:** Rust, Tauri 2, portable-pty, base64, React 19, TypeScript, Vitest, Zustand, xterm.js.

## Global Constraints

- **Rust-First**: All shell resolution, bootstrap encoding, and OSC parsing must live in Rust (`src-tauri/src/pty/`).
- **No Temporary Files**: No script files written to disk or temp directories; use `-EncodedCommand` for PowerShell.
- **Cross-Platform**: Support Windows (`pwsh.exe`, `powershell.exe`, `cmd.exe`), macOS, and Linux (`$SHELL`, `/bin/zsh`, `/bin/bash`, `/bin/sh`).
- **TDD**: Write failing tests first, verify failure, implement, verify pass, and commit.
- **Code Style**: Concise 1-line comments explaining WHY, descriptive variable names, concrete domain module names.

---

### Task 1: PowerShell Bootstrap Generator (`powershell_bootstrap.rs`)

**Files:**
- Create: `src-tauri/src/pty/powershell_bootstrap.rs`
- Modify: `src-tauri/src/pty/mod.rs`
- Test: `src-tauri/src/pty/powershell_bootstrap.rs` (inline test module)

**Interfaces:**
- Produces: `pub fn generate_powershell_encoded_bootstrap(initial_cwd: Option<&str>) -> String`
- Produces: `pub fn encode_powershell_command(command: &str) -> String`

- [ ] **Step 1: Write the failing tests in `src-tauri/src/pty/powershell_bootstrap.rs`**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_powershell_command_utf16le_base64() {
        let cmd = "Write-Host 'Hello'";
        let encoded = encode_powershell_command(cmd);
        // Base64 of UTF-16LE bytes
        let utf16_bytes: Vec<u8> = cmd.encode_utf16().flat_map(|c| c.to_le_bytes()).collect();
        let expected = base64_simd::STANDARD.encode_to_string(&utf16_bytes);
        assert_eq!(encoded, expected);
    }

    #[test]
    fn test_generate_powershell_encoded_bootstrap_contains_hooks() {
        let bootstrap = generate_powershell_bootstrap_text(Some("C:\\test\\dir"));
        assert!(bootstrap.contains("[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()"));
        assert!(bootstrap.contains("133;A"));
        assert!(bootstrap.contains("133;D"));
        assert!(bootstrap.contains("]7;file://"));
        assert!(bootstrap.contains("Set-Location -LiteralPath 'C:\\test\\dir'"));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p oppa --lib pty::powershell_bootstrap` in `src-tauri`
Expected: FAIL (module not found or functions not defined)

- [ ] **Step 3: Implement minimal code in `src-tauri/src/pty/powershell_bootstrap.rs`**

```rust
// Generates UTF-16LE Base64 bootstrap for PowerShell startup.

pub fn encode_powershell_command(command: &str) -> String {
    let utf16_bytes: Vec<u8> = command.encode_utf16().flat_map(|c| c.to_le_bytes()).collect();
    // Manual standard base64 encoding to avoid external crate overhead if desired or standard base64
    base64_encode(&utf16_bytes)
}

fn base64_encode(bytes: &[u8]) -> String {
    const CHARSET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = chunk.get(1).copied().unwrap_or(0);
        let b2 = chunk.get(2).copied().unwrap_or(0);
        out.push(CHARSET[(b0 >> 2) as usize] as char);
        out.push(CHARSET[(((b0 & 0x03) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            out.push(CHARSET[(((b1 & 0x0f) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(CHARSET[(b2 & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

pub fn generate_powershell_bootstrap_text(initial_cwd: Option<&str>) -> String {
    let restore_cwd = match initial_cwd {
        Some(cwd) if !cwd.is_empty() => {
            let escaped = cwd.replace('\'', "''");
            format!("\ntry {{ Set-Location -LiteralPath '{escaped}' -ErrorAction Stop }} catch {{}}\n")
        }
        _ => String::new(),
    };

    format!(
r#"try {{
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
    [Console]::InputEncoding = [System.Text.UTF8Encoding]::new()
    $OutputEncoding = [Console]::OutputEncoding
}} catch {{}}
if ($ExecutionContext.SessionState.LanguageMode -eq "FullLanguage" -and (-not (Test-Path variable:global:__OppaOscState))) {{
    $Global:__OppaOscState = @{{
        OriginalPrompt = $function:prompt
        OriginalReadLine = $function:PSConsoleHostReadLine
        HasSeenPrompt = $false
        HasPSReadLine = $null -ne (Get-Module -Name PSReadLine)
        Esc = [char]27
        Bel = [char]7
    }}
    function Global:prompt {{
        $fakeExitCode = [int](!$global:?)
        Set-StrictMode -Off
        $result = ""
        if ($Global:__OppaOscState.HasSeenPrompt) {{
            $result += "$($Global:__OppaOscState.Esc)]133;D;$fakeExitCode$($Global:__OppaOscState.Bel)"
        }}
        $Global:__OppaOscState.HasSeenPrompt = $true
        $rawPath = $PWD.Path -replace '\\', '/'
        $result += "$($Global:__OppaOscState.Esc)]7;file://$($env:COMPUTERNAME)/$rawPath$($Global:__OppaOscState.Bel)"
        $result += "$($Global:__OppaOscState.Esc)]133;A$($Global:__OppaOscState.Bel)"
        if ($fakeExitCode -ne 0) {{ Write-Error "failure" -ea ignore }}
        $result += $Global:__OppaOscState.OriginalPrompt.Invoke()
        $result += "$($Global:__OppaOscState.Esc)]133;B$($Global:__OppaOscState.Bel)"
        $result
    }}
    if ($Global:__OppaOscState.HasPSReadLine -and $null -ne $Global:__OppaOscState.OriginalReadLine) {{
        function Global:PSConsoleHostReadLine {{
            $commandLine = $Global:__OppaOscState.OriginalReadLine.Invoke()
            [Console]::Write("$($Global:__OppaOscState.Esc)]133;C$($Global:__OppaOscState.Bel)")
            return $commandLine
        }}
    }}
}}{restore_cwd}"#
    )
}

pub fn generate_powershell_encoded_bootstrap(initial_cwd: Option<&str>) -> String {
    let script = generate_powershell_bootstrap_text(initial_cwd);
    encode_powershell_command(&script)
}
```

- [ ] **Step 4: Register module in `src-tauri/src/pty/mod.rs` and run tests**

```rust
pub mod commands;
pub mod manager;
pub mod powershell_bootstrap;
pub mod session;
```

Run: `cargo test -p oppa --lib pty::powershell_bootstrap` in `src-tauri`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pty/powershell_bootstrap.rs src-tauri/src/pty/mod.rs
git commit -m "feat(pty): add PowerShell UTF-8 and OSC 133 bootstrap generator"
```

---

### Task 2: Shell Resolution & Launch Configuration (`shell_args.rs`)

**Files:**
- Create: `src-tauri/src/pty/shell_args.rs`
- Modify: `src-tauri/src/pty/mod.rs`
- Test: `src-tauri/src/pty/shell_args.rs` (inline test module)

**Interfaces:**
- Consumes: `powershell_bootstrap::generate_powershell_encoded_bootstrap`
- Produces: `pub struct ShellLaunchConfig { pub program: String, pub args: Vec<String>, pub cwd: Option<String> }`
- Produces: `pub fn resolve_shell_launch_config(requested_shell: Option<String>, cwd: Option<String>) -> ShellLaunchConfig`

- [ ] **Step 1: Write the failing tests in `src-tauri/src/pty/shell_args.rs`**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(target_os = "windows")]
    fn test_windows_powershell_args_contain_nologo_and_encoded_command() {
        let config = resolve_shell_launch_config(Some("powershell.exe".into()), Some("C:\\test".into()));
        assert_eq!(config.program, "powershell.exe");
        assert!(config.args.contains(&"-NoLogo".to_string()));
        assert!(config.args.contains(&"-NoExit".to_string()));
        assert!(config.args.contains(&"-EncodedCommand".to_string()));
        assert_eq!(config.cwd.as_deref(), Some("C:\\test"));
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn test_windows_cmd_args_contain_chcp_utf8() {
        let config = resolve_shell_launch_config(Some("cmd.exe".into()), None);
        assert_eq!(config.program, "cmd.exe");
        assert_eq!(config.args, vec!["/K".to_string(), "chcp 65001 > nul".to_string()]);
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn test_unix_shell_args_use_login_flag() {
        let config = resolve_shell_launch_config(Some("/bin/zsh".into()), Some("/tmp".into()));
        assert_eq!(config.program, "/bin/zsh");
        assert_eq!(config.args, vec!["-l".to_string()]);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p oppa --lib pty::shell_args` in `src-tauri`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `src-tauri/src/pty/shell_args.rs`**

```rust
use crate::pty::powershell_bootstrap::generate_powershell_encoded_bootstrap;
use std::path::Path;

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
pub fn default_windows_shell() -> String {
    if is_executable_in_path("pwsh.exe") {
        return "pwsh.exe".to_string();
    }
    if is_executable_in_path("powershell.exe") {
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
        let program = requested_shell.unwrap_or_else(default_windows_shell);
        let basename = Path::new(&program)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&program)
            .to_ascii_lowercase();

        let args = if basename == "powershell.exe" || basename == "pwsh.exe" || basename == "powershell" || basename == "pwsh" {
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
        let program = requested_shell.unwrap_or_else(default_unix_shell);
        let args = vec!["-l".to_string()];
        ShellLaunchConfig { program, args, cwd }
    }
}
```

- [ ] **Step 4: Register module in `src-tauri/src/pty/mod.rs` and run tests**

```rust
pub mod commands;
pub mod manager;
pub mod powershell_bootstrap;
pub mod session;
pub mod shell_args;
```

Run: `cargo test -p oppa --lib pty::shell_args` in `src-tauri`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pty/shell_args.rs src-tauri/src/pty/mod.rs
git commit -m "feat(pty): add cross-platform shell detection and launch config"
```

---

### Task 3: In-Stream OSC 7 & OSC 133 Scanner (`osc_scanner.rs`)

**Files:**
- Create: `src-tauri/src/pty/osc_scanner.rs`
- Modify: `src-tauri/src/pty/mod.rs`
- Test: `src-tauri/src/pty/osc_scanner.rs` (inline test module)

**Interfaces:**
- Produces: `pub struct OscScanner`
- Produces: `impl OscScanner { pub fn new() -> Self; pub fn scan(&mut self, chunk: &[u8]) -> Option<String>; }`

- [ ] **Step 1: Write the failing tests in `src-tauri/src/pty/osc_scanner.rs`**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_osc_scanner_extracts_osc7_path() {
        let mut scanner = OscScanner::new();
        let stream = b"\x1b]7;file://MYHOST/C:/Users/oppa/repo\x07";
        let cwd = scanner.scan(stream);
        #[cfg(target_os = "windows")]
        assert_eq!(cwd, Some("C:\\Users\\oppa\\repo".to_string()));
        #[cfg(not(target_os = "windows"))]
        assert_eq!(cwd, Some("/C:/Users/oppa/repo".to_string()));
    }

    #[test]
    fn test_osc_scanner_extracts_osc7_with_escaped_spaces() {
        let mut scanner = OscScanner::new();
        let stream = b"\x1b]7;file://localhost/home/user/my%20project\x1b\\";
        let cwd = scanner.scan(stream);
        assert_eq!(cwd, Some("/home/user/my project".to_string()));
    }

    #[test]
    fn test_osc_scanner_extracts_osc9_9_path() {
        let mut scanner = OscScanner::new();
        let stream = b"\x1b]9;9;C:\\projects\\oppa\x07";
        let cwd = scanner.scan(stream);
        assert_eq!(cwd, Some("C:\\projects\\oppa".to_string()));
    }

    #[test]
    fn test_osc_scanner_handles_chunked_escapes() {
        let mut scanner = OscScanner::new();
        let part1 = b"some random output\x1b]7;file://host";
        let part2 = b"/tmp/worktree\x07and trailing data";
        assert_eq!(scanner.scan(part1), None);
        assert_eq!(scanner.scan(part2), Some("/tmp/worktree".to_string()));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p oppa --lib pty::osc_scanner` in `src-tauri`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement `src-tauri/src/pty/osc_scanner.rs`**

```rust
// In-flight OSC 7 and OSC 9;9 directory scanner for PTY output streams.

pub struct OscScanner {
    buffer: Vec<u8>,
    in_osc: bool,
}

impl Default for OscScanner {
    fn default() -> Self {
        Self::new()
    }
}

impl OscScanner {
    pub fn new() -> Self {
        Self {
            buffer: Vec::with_capacity(512),
            in_osc: false,
        }
    }

    pub fn scan(&mut self, chunk: &[u8]) -> Option<String> {
        let mut result = None;

        for &b in chunk {
            if !self.in_osc {
                if b == 0x1b {
                    self.buffer.clear();
                    self.buffer.push(b);
                } else if self.buffer.len() == 1 && b == b']' {
                    self.buffer.push(b);
                    self.in_osc = true;
                } else {
                    self.buffer.clear();
                }
            } else {
                self.buffer.push(b);
                // Terminators: BEL (\x07) or ST (\x1b\\)
                let is_bel = b == 0x07;
                let is_st = self.buffer.len() >= 2 && self.buffer[self.buffer.len() - 2] == 0x1b && b == b'\\';

                if is_bel || is_st {
                    self.in_osc = false;
                    let payload_bytes = if is_st {
                        &self.buffer[2..self.buffer.len() - 2]
                    } else {
                        &self.buffer[2..self.buffer.len() - 1]
                    };

                    if let Some(parsed) = parse_osc_payload(payload_bytes) {
                        result = Some(parsed);
                    }
                    self.buffer.clear();
                } else if self.buffer.len() > 1024 {
                    // Prevent unbound buffer growth on malformed escape sequences
                    self.in_osc = false;
                    self.buffer.clear();
                }
            }
        }

        result
    }
}

fn parse_osc_payload(payload: &[u8]) -> Option<String> {
    let s = std::str::from_utf8(payload).ok()?;

    if let Some(rest) = s.strip_prefix("7;") {
        let path = rest.strip_prefix("file://")?;
        // Skip hostname: find the first '/' after file://
        let slash_idx = path.find('/')?;
        let raw_path = &path[slash_idx..];
        let decoded = url_decode(raw_path);
        Some(normalize_parsed_path(&decoded))
    } else if let Some(rest) = s.strip_prefix("9;9;") {
        Some(normalize_parsed_path(rest))
    } else {
        None
    }
}

fn url_decode(input: &str) -> String {
    let mut out = Vec::with_capacity(input.len());
    let bytes = input.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(val) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..=i + 2]).unwrap_or(""), 16) {
                out.push(val);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn normalize_parsed_path(path: &str) -> String {
    #[cfg(target_os = "windows")]
    {
        // Strip leading slash before drive letter: /C:/dir -> C:\dir
        let trimmed = if path.len() >= 3 && path.starts_with('/') && path.as_bytes()[2] == b':' {
            &path[1..]
        } else {
            path
        };
        trimmed.replace('/', "\\")
    }
    #[cfg(not(target_os = "windows"))]
    {
        path.to_string()
    }
}
```

- [ ] **Step 4: Register module in `src-tauri/src/pty/mod.rs` and run tests**

```rust
pub mod commands;
pub mod manager;
pub mod osc_scanner;
pub mod powershell_bootstrap;
pub mod session;
pub mod shell_args;
```

Run: `cargo test -p oppa --lib pty::osc_scanner` in `src-tauri`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pty/osc_scanner.rs src-tauri/src/pty/mod.rs
git commit -m "feat(pty): add in-stream OSC 7 and OSC 9;9 CWD scanner"
```

---

### Task 4: Connect Shell Launcher & OSC Scanner in PTY Manager (`session.rs`, `manager.rs`, `commands.rs`)

**Files:**
- Modify: `src-tauri/src/pty/session.rs`
- Modify: `src-tauri/src/pty/manager.rs`
- Modify: `src-tauri/src/pty/commands.rs`

**Interfaces:**
- Consumes: `shell_args::resolve_shell_launch_config`, `osc_scanner::OscScanner`
- Produces: `PtySession::cwd` (live dynamic `Arc<Mutex<Option<String>>>`)
- Produces: `pty:cwd` Tauri event payload `{ id: String, cwd: String }`

- [ ] **Step 1: Update `src-tauri/src/pty/session.rs`**

Update `PtySession` struct and `new` constructor to store live `cwd: Arc<parking_lot::Mutex<Option<String>>>` and use `ShellLaunchConfig`:

```rust
pub struct PtySession {
    pub id: String,
    pub master: Arc<parking_lot::Mutex<Option<Box<dyn MasterPty + Send>>>>,
    pub writer: Arc<parking_lot::Mutex<Box<dyn std::io::Write + Send>>>,
    pub child: Arc<parking_lot::Mutex<Box<dyn Child + Send + Sync>>>,
    pub cwd: Arc<parking_lot::Mutex<Option<String>>>,
    pub cols: u16,
    pub rows: u16,
    pub pending_bytes: Arc<AtomicUsize>,
    pub paused: Arc<AtomicBool>,
}
```

- [ ] **Step 2: Update `src-tauri/src/pty/manager.rs` to run `OscScanner` in `start_read_loop`**

In `start_read_loop`:
- Create `let mut osc = OscScanner::new();`
- When `reader.read(&mut buf)` succeeds with `n > 0`:
  ```rust
  if let Some(new_cwd) = osc.scan(&buf[..n]) {
      *session_cwd.lock() = Some(new_cwd.clone());
      if let Some(ref on_cwd) = on_cwd {
          on_cwd(&id, &new_cwd);
      }
  }
  ```
- Add `on_cwd: Option<Box<dyn Fn(&str, &str) + Send + Sync + 'static>>` callback to `PtyManager::spawn`.

- [ ] **Step 3: Update `src-tauri/src/pty/commands.rs` to emit `pty:cwd` and resolve shell config**

```rust
#[derive(Clone, Serialize)]
pub struct PtyCwdPayload {
    pub id: String,
    pub cwd: String,
}

#[tauri::command]
pub fn pty_spawn(
    manager: State<'_, PtyManager>,
    app: AppHandle,
    shell: Option<String>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<String, String> {
    let cols = cols.unwrap_or(80);
    let rows = rows.unwrap_or(24);
    let config = crate::pty::shell_args::resolve_shell_launch_config(shell, cwd);
    let seq = AtomicU64::new(0);

    let on_data_app = app.clone();
    let on_data: Box<dyn Fn(&str, &[u8]) + Send + Sync + 'static> =
        Box::new(move |id: &str, bytes: &[u8]| {
            let payload = PtyDataPayload {
                id: id.to_string(),
                data: String::from_utf8_lossy(bytes).into_owned(),
                seq: seq.fetch_add(1, Ordering::SeqCst),
            };
            let _ = on_data_app.emit("pty:data", payload);
        });

    let on_exit_app = app.clone();
    let on_exit: Box<dyn Fn(&str, Option<i32>) + Send + Sync + 'static> =
        Box::new(move |id: &str, code: Option<i32>| {
            let payload = PtyExitPayload {
                id: id.to_string(),
                code,
                error: None,
            };
            let _ = on_exit_app.emit("pty:exit", payload);
        });

    let on_cwd_app = app.clone();
    let on_cwd: Box<dyn Fn(&str, &str) + Send + Sync + 'static> =
        Box::new(move |id: &str, cwd: &str| {
            let payload = PtyCwdPayload {
                id: id.to_string(),
                cwd: cwd.to_string(),
            };
            let _ = on_cwd_app.emit("pty:cwd", payload);
        });

    manager.spawn(
        Some(config.program),
        config.cwd,
        cols,
        rows,
        config.args,
        Some(on_data),
        Some(on_exit),
        Some(on_cwd),
    )
}
```

- [ ] **Step 4: Run Rust test suite to verify everything compiles and passes**

Run: `cargo test -p oppa --lib` in `src-tauri`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pty/session.rs src-tauri/src/pty/manager.rs src-tauri/src/pty/commands.rs
git commit -m "feat(pty): integrate shell launch config and live CWD events into PtyManager"
```

---

### Task 5: Frontend Transport & Dynamic CWD Integration (`transport.ts`, `terminalStore.ts`)

**Files:**
- Modify: `src/lib/pty/transport.ts`
- Modify: `src/store/terminalStore.ts`
- Modify: `src/lib/pty/transport.test.ts`
- Modify: `src/components/PaneSplit.tsx`

**Interfaces:**
- Consumes: `pty:cwd` Tauri event
- Produces: `export function onPtyCwd(handler: (p: { id: string; cwd: string }) => void): Promise<UnlistenFn>`
- Produces: `splitPane` inherits current session's live `cwd`

- [ ] **Step 1: Add `onPtyCwd` to `src/lib/pty/transport.ts`**

```typescript
export interface PtyCwdPayload {
  id: string;
  cwd: string;
}

export async function onPtyCwd(
  handler: (payload: PtyCwdPayload) => void,
): Promise<UnlistenFn> {
  return listen<PtyCwdPayload>("pty:cwd", (event) => handler(event.payload));
}
```

- [ ] **Step 2: Wire `onPtyCwd` listener and CWD inheritance in `src/store/terminalStore.ts`**

In `terminalStore.ts`:
1. In `splitPane(dir, path)`:
   ```typescript
   splitPane: async (dir, path) => {
     const target = path ?? get().focusedPath;
     const tree = get().layout;
     const focusedId = focus(tree, target);
     const currentCwd = get().sessions[focusedId]?.cwd;
     const id = await get().spawnSession(currentCwd);
     set({
       layout: split(dir, get().layout, target, id),
       focusedPath: [...target, 1],
     });
     void get().saveLayout().catch(() => {});
   }
   ```
2. Update session CWD handler:
   ```typescript
   updateSessionCwd: (id: string, cwd: string) => {
     set((state) => {
       const session = state.sessions[id];
       if (!session) return state;
       return {
         sessions: {
           ...state.sessions,
           [id]: { ...session, cwd },
         },
       };
     });
   }
   ```

- [ ] **Step 3: Register `onPtyCwd` in `App.tsx` or `TerminalPane.tsx`**

In `src/App.tsx`:
```typescript
useEffect(() => {
  const unlistenPromise = onPtyCwd((p) => {
    useTerminalStore.getState().updateSessionCwd(p.id, p.cwd);
  });
  return () => {
    void unlistenPromise.then((unlisten) => unlisten());
  };
}, []);
```

- [ ] **Step 4: Run frontend vitest suite**

Run: `pnpm vitest run`
Expected: PASS

- [ ] **Step 5: Run full project verification**

Run:
1. `cargo check` in `src-tauri`
2. `cargo test -p oppa --lib` in `src-tauri`
3. `pnpm build`
4. `pnpm vitest run`

- [ ] **Step 6: Commit**

```bash
git add src/lib/pty/transport.ts src/store/terminalStore.ts src/App.tsx
git commit -m "feat(ui): subscribe to live PTY CWD updates and inherit CWD on split"
```
