# OPPA — Shell Bootstrap & Integration Design

Date: 2026-08-17
Status: Approved

## Purpose

Implement full shell launch and integration parity in OPPA (`D:\oppa\oppa`), bringing it up to the behavioral standards established by reference terminal architectures (such as Orca). 

Specifically, this milestone delivers:
1. **Clean Shell Startup**: Eliminates the classic Microsoft copyright banner on Windows PowerShell via `-NoLogo`, enforces UTF-8 encoding across all Windows shells (`powershell.exe`, `pwsh.exe`, `cmd.exe`) to prevent CJK/Unicode character corruption, and probes shells in modern priority order (`pwsh.exe` -> `powershell.exe` -> `cmd.exe`).
2. **OSC 133 Semantic Prompt Integration**: Injects prompt markers (`OSC 133;A` through `133;D`) into PowerShell to enable prompt and execution-state awareness.
3. **OSC 7 Live Working Directory Tracking**: Real-time in-stream scanning of OSC 7 / OSC 9;9 directory sequences in the Rust PTY read loop, dynamically synchronizing the active working directory to the frontend so split panes and new sessions spawn in the user's current directory.

---

## Architecture & Module Structure

All backend logic resides in `src-tauri/src/pty/`. No external runtime files or temporary disk scripts are created.

```
src-tauri/src/pty/
├── mod.rs
├── commands.rs             # Tauri command entrypoints (pty_spawn, pty_write, etc.)
├── manager.rs              # Session registry & read loops with integrated OSC scanner
├── session.rs              # Wraps portable-pty PtyPair and process state
├── shell_args.rs           # Cross-platform shell path probing & argument builder
├── powershell_bootstrap.rs # Base64 UTF-16LE EncodedCommand generator for PowerShell
└── osc_scanner.rs          # Non-destructive in-stream OSC 7 (CWD) and OSC 133 parser
```

```mermaid
flowchart LR
    subgraph Frontend ["Frontend (React / Zustand)"]
        UI[TerminalPane / Store] -->|pty_spawn| CMD[commands.rs]
        EVT[onPtyCwd] <--|pty:cwd| EMIT[AppHandle::emit]
    end

    subgraph Backend ["Rust PTY Backend"]
        CMD --> ARGS[shell_args.rs]
        ARGS -->|PowerShell| BOOTSTRAP[powershell_bootstrap.rs]
        ARGS --> PTY[PtySession::new / portable-pty]
        PTY --> READ_LOOP[manager.rs Read Loop]
        READ_LOOP --> SCANNER[osc_scanner.rs]
        SCANNER -->|Extracts CWD| UPDATE_CWD[Update Session CWD & Emit pty:cwd]
        READ_LOOP -->|pty:data| EMIT
    end
```

---

## Technical Specifications

### 1. Shell Resolution & Launch Arguments (`shell_args.rs`)

#### Windows Shell Priority:
When no specific shell is requested:
1. Probe for `pwsh.exe` in `PATH`.
2. Probe for `powershell.exe` in `SystemRoot\System32\WindowsPowerShell\v1.0` and `PATH`.
3. Fallback to `cmd.exe` (`COMSPEC`).

#### Argument Building:
- **PowerShell (`pwsh.exe` / `powershell.exe`)**:
  ```rust
  pub struct ShellLaunchConfig {
      pub program: String,
      pub args: Vec<String>,
      pub env_overrides: Vec<(String, String)>,
  }
  ```
  Arguments:
  ```rust
  vec![
      "-NoLogo".to_string(),
      "-NoExit".to_string(),
      "-EncodedCommand".to_string(),
      generate_powershell_encoded_bootstrap(initial_cwd),
  ]
  ```
- **CMD (`cmd.exe`)**:
  Arguments:
  ```rust
  vec!["/K".to_string(), "chcp 65001 > nul".to_string()]
  ```
- **macOS / Linux**:
  Probes `$SHELL` -> `/bin/zsh` -> `/bin/bash` -> `/bin/sh`. Launches with login shell args (`-l`).

---

### 2. PowerShell Bootstrap Generator (`powershell_bootstrap.rs`)

Generates a compact Base64 UTF-16LE string executed via `-EncodedCommand`:

```powershell
# 1. Force UTF-8 input/output for clean Unicode & CJK display
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
    [Console]::InputEncoding = [System.Text.UTF8Encoding]::new()
    $OutputEncoding = [Console]::OutputEncoding
} catch {}

# 2. Setup OSC 133 and OSC 7 prompt hooks
if ($ExecutionContext.SessionState.LanguageMode -eq "FullLanguage" -and
    (-not (Test-Path variable:global:__OppaOscState))) {
    $Global:__OppaOscState = @{
        OriginalPrompt = $function:prompt
        OriginalReadLine = $function:PSConsoleHostReadLine
        HasSeenPrompt = $false
        HasPSReadLine = $null -ne (Get-Module -Name PSReadLine)
        Esc = [char]27
        Bel = [char]7
    }

    function Global:prompt {
        $fakeExitCode = [int](!$global:?)
        Set-StrictMode -Off
        $result = ""
        if ($Global:__OppaOscState.HasSeenPrompt) {
            $result += "$($Global:__OppaOscState.Esc)]133;D;$fakeExitCode$($Global:__OppaOscState.Bel)"
        }
        $Global:__OppaOscState.HasSeenPrompt = $true
        
        # OSC 7 working directory notification
        $rawPath = $PWD.Path -replace '\\', '/'
        $result += "$($Global:__OppaOscState.Esc)]7;file://$($env:COMPUTERNAME)/$rawPath$($Global:__OppaOscState.Bel)"
        
        # OSC 133;A prompt start
        $result += "$($Global:__OppaOscState.Esc)]133;A$($Global:__OppaOscState.Bel)"
        if ($fakeExitCode -ne 0) { Write-Error "failure" -ea ignore }
        $result += $Global:__OppaOscState.OriginalPrompt.Invoke()
        # OSC 133;B command start
        $result += "$($Global:__OppaOscState.Esc)]133;B$($Global:__OppaOscState.Bel)"
        $result
    }

    if ($Global:__OppaOscState.HasPSReadLine -and $null -ne $Global:__OppaOscState.OriginalReadLine) {
        function Global:PSConsoleHostReadLine {
            $commandLine = $Global:__OppaOscState.OriginalReadLine.Invoke()
            [Console]::Write("$($Global:__OppaOscState.Esc)]133;C$($Global:__OppaOscState.Bel)")
            return $commandLine
        }
    }
}

# 3. Restore intended working directory if changed by $PROFILE
try { Set-Location -LiteralPath '<INITIAL_CWD>' -ErrorAction Stop } catch {}
```

---

### 3. In-Stream OSC 7 Scanner (`osc_scanner.rs`)

A zero-allocation byte scanner running in the PTY read loop:
- Matches `\x1b]7;file://[^/]*(/[^\x07\x1b]*)(?:\x07|\x1b\\)` and `\x1b]9;9;([^\x07\x1b]*)(?:\x07|\x1b\\)`.
- Normalizes path: URL decoding, stripping leading slash before Windows drive letter (`/C:/dir` -> `C:\dir`).
- On successful extraction:
  - Updates `session.cwd`.
  - Sends `pty:cwd` payload `{ id: String, cwd: String }` via `AppHandle::emit`.

---

## 4. Frontend Integration (`src/lib/pty/transport.ts` & `src/store/terminalStore.ts`)

- **Transport**:
  - Exposes `onPtyCwd(callback: (payload: { id: string, cwd: string }) => void): Promise<UnlistenFn>`.
- **Zustand Store**:
  - Listens for `pty:cwd` to keep each session's `cwd` up to date.
  - `splitPane` queries the focused session's `cwd` and passes it to `spawnSession(cwd)` so new panes open in the exact active directory.

---

## Testing & Verification Plan

### Rust Backend Tests (`cargo test -p oppa --lib`):
1. `powershell_bootstrap::tests::test_bootstrap_encoding`: Verifies UTF-16LE Base64 encoding validity.
2. `shell_args::tests::test_windows_args_resolution`: Verifies `-NoLogo`, `-NoExit`, `-EncodedCommand` flags.
3. `osc_scanner::tests::test_osc7_path_extraction`: Validates POSIX paths, Windows paths, spaces, and percent-encoded paths.
4. `manager::tests::test_pty_spawn_with_bootstrap`: Live PTY spawn asserting clean output without copyright text.

### Frontend Tests (`pnpm vitest run`):
1. `terminalStore.test.ts`: Verify `pty:cwd` updates `state.sessions[id].cwd`.
2. `PaneSplit.test.tsx`: Verify `splitPane` inherits the active session's CWD.
