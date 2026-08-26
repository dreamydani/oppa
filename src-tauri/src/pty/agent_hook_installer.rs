// Installs/removes OPPA's managed lifecycle hooks into agent CLI configs
// (Claude Code: ~/.claude/settings.json). The hook pipes its stdin JSON —
// which carries the authoritative session_id + transcript_path — to the
// daemon's localhost receiver, tagged with the pane it ran inside.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

/// Appears in every command we install so re-runs replace only our entries.
const MANAGED_MARKER: &str = "oppa-claude-hook";
const HOOK_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "Notification",
    "Stop",
];

// Antigravity (agy) hooks live in ~/.gemini/config/hooks.json as a named
// bundle — same mechanism Orca registers under "orca-status".
const AGY_BUNDLE_NAME: &str = "oppa-status";
const AGY_EVENTS: &[&str] = &["PreInvocation", "PostInvocation", "Stop"];

// Gemini CLI / Qwen Code / Cursor / Grok / OpenCode — per-agent specs below.
const GEMINI_EVENTS: &[&str] = &["BeforeAgent", "AfterAgent", "BeforeTool", "AfterTool"];
const CURSOR_EVENTS: &[&str] = &[
    "beforeSubmitPrompt",
    "stop",
    "preToolUse",
    "postToolUse",
    "postToolUseFailure",
    "beforeShellExecution",
    "beforeMCPExecution",
    "afterAgentResponse",
];
const GROK_EVENTS: &[(&str, bool)] = &[
    // (event name, needs tool matcher regex — Grok rejects bare `*`)
    ("SessionStart", false),
    ("UserPromptSubmit", false),
    ("Stop", false),
    ("StopFailure", false),
    ("SessionEnd", false),
    ("PreToolUse", true),
    ("PostToolUse", true),
    ("PostToolUseFailure", true),
    ("Notification", false),
];

fn gemini_hooks_path(home: &Path) -> std::path::PathBuf {
    home.join(".gemini").join("config").join("hooks.json")
}

fn claude_settings_path(home: &Path) -> std::path::PathBuf {
    home.join(".claude").join("settings.json")
}

#[cfg(target_os = "windows")]
fn hook_command(app_data_dir: &Path) -> String {
    format!(
        "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"{}\"",
        app_data_dir
            .join("agent-hooks")
            .join("oppa-claude-hook.ps1")
            .display()
    )
}

#[cfg(not(target_os = "windows"))]
fn hook_command(app_data_dir: &Path) -> String {
    format!(
        "/bin/sh \"{}\"",
        app_data_dir
            .join("agent-hooks")
            .join("oppa-claude-hook.sh")
            .display()
    )
}

const POWERSHELL_HOOK: &str = r#"$ErrorActionPreference = 'SilentlyContinue'
$in = [Console]::In.ReadToEnd()
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = Get-Content (Join-Path $dir 'port') -ErrorAction SilentlyContinue
$token = Get-Content (Join-Path $dir 'token') -ErrorAction SilentlyContinue
if (-not $env:OPPA_PANE_KEY -or -not $port -or -not $token -or -not $in) { exit 0 }
$body = @{ pane_key = $env:OPPA_PANE_KEY; token = $token; payload = ($in | ConvertFrom-Json) }
Invoke-RestMethod -Uri ("http://127.0.0.1:" + $port + "/hook/claude") -Method Post -ContentType 'application/json' -Body (($body | ConvertTo-Json -Depth 8 -Compress)) -TimeoutSec 3 | Out-Null
exit 0
"#;

const SH_HOOK: &str = r#"#!/bin/sh
# OPPA managed hook: forwards agent lifecycle JSON to the OPPA daemon.
in=$(cat)
dir=$(cd "$(dirname "$0")" && pwd)
port=$(cat "$dir/port" 2>/dev/null)
token=$(cat "$dir/token" 2>/dev/null)
[ -n "$OPPA_PANE_KEY" ] && [ -n "$port" ] && [ -n "$token" ] && [ -n "$in" ] || exit 0
printf '{"pane_key":"%s","token":"%s","payload":%s}' "$OPPA_PANE_KEY" "$token" "$in" |
  curl -s -m 3 -X POST "http://127.0.0.1:$port/hook/claude" \
    -H 'Content-Type: application/json' --data-binary @- >/dev/null 2>&1
exit 0
"#;

// Antigravity core script: echoes the response agy expects BEFORE forwarding
// (agy blocks the loop on hooks), then POSTs the stdin JSON to the daemon.
// Ported 1:1 from Orca's antigravity-hook.cmd (OPPA env names).
const AGY_CORE_CMD: &str = r#"@echo off
setlocal
if /I "%OPPA_ANTIGRAVITY_EVENT%"=="Stop" (
  echo {"decision":""}
) else (
  echo {}
)
if "%OPPA_AGENT_HOOK_PORT%"=="" goto oppa_drain_stdin
if "%OPPA_AGENT_HOOK_TOKEN%"=="" goto oppa_drain_stdin
if "%OPPA_PANE_KEY%"=="" goto oppa_drain_stdin
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$utf8=[System.Text.UTF8Encoding]::new($false); [Console]::InputEncoding=$utf8; $inputData=[Console]::In.ReadToEnd(); try { $payload=if ([string]::IsNullOrWhiteSpace($inputData)) { @{} } else { $inputData | ConvertFrom-Json }; $body=@{ pane_key=$env:OPPA_PANE_KEY; token=$env:OPPA_HOOK_TOKEN; hook_event_name=$env:OPPA_ANTIGRAVITY_EVENT; payload=$payload } | ConvertTo-Json -Depth 100 -Compress; Invoke-RestMethod -Method Post -Uri ('http://127.0.0.1:' + $env:OPPA_AGENT_HOOK_PORT + '/hook/antigravity') -ContentType 'application/json; charset=utf-8' -Body ($utf8.GetBytes($body)) -TimeoutSec 2 | Out-Null } catch {}"
exit /b 0
:oppa_drain_stdin
"%SystemRoot%\System32\more.com" >nul 2>nul
exit /b 0
"#;

fn agy_wrapper_cmd(event: &str) -> String {
    format!(
        r#"@echo off
setlocal
set "OPPA_ANTIGRAVITY_EVENT={event}"
set "OPPA_ANTIGRAVITY_CORE=%~dp0oppa-antigravity-hook.cmd"
if exist "%OPPA_ANTIGRAVITY_CORE%" (
  call "%OPPA_ANTIGRAVITY_CORE%"
  exit /b 0
)
if /I "%OPPA_ANTIGRAVITY_EVENT%"=="Stop" (
  echo {{"decision":""}}
) else (
  echo {{}}
)
"%SystemRoot%\System32\more.com" >nul 2>nul
exit /b 0
"#
    )
}

// ─── Generic per-agent forwarders (Gemini/Qwen/Cursor/Grok) ──────────────
// Same JSON-post contract as the Claude script; only the route differs.

const POWERSHELL_FORWARDER_TEMPLATE: &str = r#"$ErrorActionPreference = 'SilentlyContinue'
$in = [Console]::In.ReadToEnd()
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = Get-Content (Join-Path $dir 'port') -ErrorAction SilentlyContinue
$token = Get-Content (Join-Path $dir 'token') -ErrorAction SilentlyContinue
if (-not $env:OPPA_PANE_KEY -or -not $port -or -not $token -or -not $in) { exit 0 }
try { $payload = $in | ConvertFrom-Json } catch { exit 0 }
$body = @{ pane_key = $env:OPPA_PANE_KEY; token = $token; payload = $payload }
Invoke-RestMethod -Uri ("http://127.0.0.1:" + $port + "/hook/{route}") -Method Post -ContentType 'application/json' -Body (($body | ConvertTo-Json -Depth 8 -Compress)) -TimeoutSec 3 | Out-Null
exit 0
"#;

const SH_FORWARDER_TEMPLATE: &str = r#"#!/bin/sh
# OPPA managed hook: forwards agent lifecycle JSON to the OPPA daemon.
in=$(cat)
dir=$(cd "$(dirname "$0")" && pwd)
port=$(cat "$dir/port" 2>/dev/null)
token=$(cat "$dir/token" 2>/dev/null)
[ -n "$OPPA_PANE_KEY" ] && [ -n "$port" ] && [ -n "$token" ] && [ -n "$in" ] || exit 0
printf '{"pane_key":"%s","token":"%s","payload":%s}' "$OPPA_PANE_KEY" "$token" "$in" |
  curl -s -m 3 -X POST "http://127.0.0.1:$port/hook/{route}" \
    -H 'Content-Type: application/json' --data-binary @- >/dev/null 2>&1
exit 0
"#;

// Minimal OpenCode plugin: OpenCode loads every .js in <config>/plugin.
// Only the session-id capture is needed for resume — not Orca's full
// status-dashboard plugin (1200+ lines of busy/child-session machinery).
const OPENCODE_PLUGIN_JS: &str = r#"// OPPA managed plugin: forwards session ids to the OPPA daemon (auto-loaded).
const http = require("http");
function post(payload) {
  const port = process.env.OPPA_HOOK_PORT;
  const token = process.env.OPPA_HOOK_TOKEN;
  const paneKey = process.env.OPPA_PANE_KEY;
  if (!port || !token || !paneKey || !payload || !payload.sessionID) return;
  const body = JSON.stringify({ pane_key: paneKey, token, payload });
  try {
    const req = http.request({
      host: "127.0.0.1", port: Number(port), path: "/hook/opencode", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, () => {});
    req.on("error", () => {});
    req.end(body);
  } catch {}
}
export const OppaOpenCodeStatusPlugin = async () => ({
  event: async ({ event }) => {
    try {
      if (!event || typeof event.type !== "string") return;
      if (!event.type.startsWith("session.") && event.type !== "message.updated") return;
      const sessionID =
        event.properties?.sessionID ?? event.properties?.info?.sessionID ?? null;
      post({ sessionID });
    } catch {}
  },
});
export default { id: "oppa-opencode-status", server: OppaOpenCodeStatusPlugin };
"#;

/// Windows launch command for a managed script file.
fn windows_command_for(script_path: &Path) -> String {
    format!(
        "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"{}\"",
        script_path.display()
    )
}

#[cfg(target_os = "windows")]
fn posix_or_win_command(script_path: &Path) -> String {
    windows_command_for(script_path)
}

#[cfg(not(target_os = "windows"))]
fn posix_or_win_command(script_path: &Path) -> String {
    format!("\"{}\"", script_path.display())
}

/// Removes entries whose command references `marker` from every definition in
/// an event bucket array (Claude shape: nested under `hooks`).
fn sweep_nested_managed(arr: &mut Vec<Value>, marker: &str) {
    arr.retain(|definition| {
        let commands = definition
            .get("hooks")
            .and_then(|h| h.as_array())
            .map(|hooks| {
                hooks
                    .iter()
                    .filter_map(|h| h.get("command").and_then(|c| c.as_str()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let top = definition
            .get("command")
            .and_then(|c| c.as_str())
            .into_iter()
            .collect::<Vec<_>>();
        !(commands.iter().chain(top.iter())).any(|c| c.contains(marker))
    });
}

/// Installs/replaces managed command hooks under `config["hooks"][event]` for
/// each event (Claude-shape configs: Gemini CLI, Qwen Code).
fn upsert_command_hooks(
    config: &mut Value,
    events: &[&str],
    command: &str,
    marker: &str,
) -> Result<(), std::io::Error> {
    let obj = config
        .as_object_mut()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "root not object"))?;
    let hooks = obj
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "hooks not object")
        })?;
    for event in events {
        let bucket = hooks.entry(event.to_string()).or_insert_with(|| json!([]));
        if !bucket.is_array() {
            *bucket = json!([]);
        }
        let arr = bucket.as_array_mut().expect("array");
        sweep_nested_managed(arr, marker);
        arr.push(json!({
            "hooks": [{ "type": "command", "command": command }]
        }));
    }
    Ok(())
}

/// Removes managed command hooks referencing `marker` from all buckets,
/// deleting emptied buckets (used on uninstall).
fn remove_command_hooks(config: &mut Value, marker: &str) {
    let Some(obj) = config.as_object_mut() else {
        return;
    };
    let Some(hooks) = obj.get_mut("hooks").and_then(|h| h.as_object_mut()) else {
        return;
    };
    let emptied: Vec<String> = hooks
        .keys()
        .filter(|k| k.as_str() != "version")
        .cloned()
        .collect();
    for key in emptied {
        if let Some(bucket) = hooks.get_mut(&key).and_then(|b| b.as_array_mut()) {
            sweep_nested_managed(bucket, marker);
            if bucket.is_empty() {
                hooks.remove(&key);
            }
        }
    }
    if hooks.is_empty() {
        obj.remove("hooks");
    }
}

/// Writes the hook scripts next to the endpoint files and registers the
/// managed hooks in Claude Code's settings.json (merging, never clobbering).
pub fn install(app_data_dir: &Path, home: &Path) -> std::io::Result<()> {
    let hook_dir = app_data_dir.join("agent-hooks");
    fs::create_dir_all(&hook_dir)?;
    fs::write(hook_dir.join("oppa-claude-hook.ps1"), POWERSHELL_HOOK)?;
    fs::write(hook_dir.join("oppa-claude-hook.sh"), SH_HOOK)?;

    // Antigravity scripts: per-event wrappers + shared core (Orca structure)
    fs::write(hook_dir.join("oppa-antigravity-hook.cmd"), AGY_CORE_CMD)?;
    for event in AGY_EVENTS {
        let file = format!(
            "oppa-antigravity-{}.cmd",
            event.replace("Invocation", "-invocation").replace("Stop", "stop")
        );
        fs::write(hook_dir.join(&file), agy_wrapper_cmd(event))?;
    }

    let settings_path = claude_settings_path(home);
    let mut root: Value = read_settings(&settings_path)?;
    let command = hook_command(app_data_dir);
    for event in HOOK_EVENTS {
        set_event_hook(&mut root, event, &command);
    }
    write_atomic(&settings_path, &root)?;

    install_agy_bundle(app_data_dir, home)?;

    // Gemini / Qwen / Cursor / Grok / OpenCode (Orca-parity installers)
    install_generic_agent_hooks(app_data_dir, home)?;
    Ok(())
}

/// Installs managed hooks for the remaining supported CLIs. Best-effort per
/// agent: one agent's config failure must not block the others.
fn install_generic_agent_hooks(app_data_dir: &Path, home: &Path) -> std::io::Result<()> {
    let hook_dir = app_data_dir.join("agent-hooks");

    // Per-agent forwarding scripts (same contract, different routes)
    let agents: &[(&str, &str)] = &[
        ("gemini", "gemini"),
        ("qwen", "qwen"),
        ("cursor", "cursor"),
        ("grok", "grok"),
    ];
    for (name, route) in agents {
        fs::write(
            hook_dir.join(format!("oppa-{name}-hook.ps1")),
            POWERSHELL_FORWARDER_TEMPLATE.replace("{route}", route),
        )?;
        fs::write(
            hook_dir.join(format!("oppa-{name}-hook.sh")),
            SH_FORWARDER_TEMPLATE.replace("{route}", route),
        )?;
    }
    fs::create_dir_all(hook_dir.join("opencode-plugin"))?;
    fs::write(
        hook_dir.join("opencode-plugin").join("oppa-opencode-status.js"),
        OPENCODE_PLUGIN_JS,
    )?;

    // Gemini CLI: ~/.gemini/settings.json, Claude-shape hooks
    let gemini_command = posix_or_win_command(&hook_dir.join(if cfg!(windows) {
        "oppa-gemini-hook.ps1"
    } else {
        "oppa-gemini-hook.sh"
    }));
    let mut config = read_settings(&home.join(".gemini").join("settings.json"))?;
    upsert_command_hooks(
        &mut config,
        GEMINI_EVENTS,
        &gemini_command,
        "oppa-gemini-hook",
    )?;
    write_atomic(&home.join(".gemini").join("settings.json"), &config)?;

    // Qwen Code (gemini-cli fork): same shape under ~/.qwen
    let qwen_command = posix_or_win_command(&hook_dir.join(if cfg!(windows) {
        "oppa-qwen-hook.ps1"
    } else {
        "oppa-qwen-hook.sh"
    }));
    let mut config = read_settings(&home.join(".qwen").join("settings.json"))?;
    upsert_command_hooks(&mut config, GEMINI_EVENTS, &qwen_command, "oppa-qwen-hook")?;
    write_atomic(&home.join(".qwen").join("settings.json"), &config)?;

    // Cursor: ~/.cursor/hooks.json — command sits directly on the definition,
    // and the file requires `version: 1` (preserve a user-pinned value).
    let cursor_command = posix_or_win_command(&hook_dir.join(if cfg!(windows) {
        "oppa-cursor-hook.ps1"
    } else {
        "oppa-cursor-hook.sh"
    }));
    let cursor_path = home.join(".cursor").join("hooks.json");
    let mut config = read_settings(&cursor_path)?;
    if let Some(obj) = config.as_object_mut() {
        let hooks = obj
            .entry("hooks")
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .expect("hooks object");
        for event in CURSOR_EVENTS {
            let bucket = hooks.entry(event.to_string()).or_insert_with(|| json!([]));
            if !bucket.is_array() {
                *bucket = json!([]);
            }
            let arr = bucket.as_array_mut().expect("array");
            sweep_nested_managed(arr, "oppa-cursor-hook");
            arr.push(json!({ "type": "command", "command": cursor_command }));
        }
        obj.entry("version")
            .or_insert(json!(1));
    }
    write_atomic(&cursor_path, &config)?;

    // Grok: dedicated file $GROK_HOME/hooks/oppa-status.json — entirely ours,
    // so no merge logic; user-authored hook files stay untouched. Tool events
    // need the `.*` regex matcher (bare `*` never fires on Grok).
    let grok_home = std::env::var("GROK_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home.join(".grok"));
    let grok_command = posix_or_win_command(&hook_dir.join(if cfg!(windows) {
        "oppa-grok-hook.ps1"
    } else {
        "oppa-grok-hook.sh"
    }));
    let grok_root: Value = json!({
        "hooks": GROK_EVENTS
            .iter()
            .map(|(event, tool_matcher)| {
                let mut definition = json!({});
                if *tool_matcher {
                    definition["matcher"] = json!(".*");
                }
                definition["hooks"] =
                    json!([{ "type": "command", "command": grok_command }]);
                (event.to_string(), definition)
            })
            .collect::<serde_json::Map<String, Value>>()
    });
    fs::create_dir_all(grok_home.join("hooks"))?;
    write_atomic(&grok_home.join("hooks").join("oppa-status.json"), &grok_root)?;

    // OpenCode: drop the plugin into the default global config dir's plugin/
    // (auto-loaded). Only reached when the user has no OPENCODE_CONFIG_DIR of
    // their own — respect an explicit external setup.
    if std::env::var_os("OPENCODE_CONFIG_DIR").is_none() {
        let xdg = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"));
        let plugin_path = xdg
            .join("opencode")
            .join("plugin")
            .join("oppa-opencode-status.js");
        if let Some(parent) = plugin_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(plugin_path, OPENCODE_PLUGIN_JS)?;
    }

    Ok(())
}

fn install_agy_bundle(app_data_dir: &Path, home: &Path) -> std::io::Result<()> {
    let hooks_path = gemini_hooks_path(home);
    let mut root: Value = read_settings(&hooks_path)?;
    let dir = app_data_dir.join("agent-hooks");
    let command_for = |event: &str| -> String {
        let file = format!(
            "oppa-antigravity-{}.cmd",
            event
                .replace("Invocation", "-invocation")
                .replace("Stop", "stop")
        );
        format!("\"{}\"", dir.join(&file).display())
    };
    let handlers_for = |event: &str| -> Value {
        json!([{ "type": "command", "command": command_for(event), "timeout": 10 }])
    };

    root.as_object_mut()
        .unwrap_or_else(|| panic!("root is an object"))
        .insert(
            AGY_BUNDLE_NAME.to_string(),
            json!({
                "PreInvocation": handlers_for("PreInvocation"),
                "PostInvocation": handlers_for("PostInvocation"),
                "Stop": handlers_for("Stop"),
            }),
        );
    write_atomic(&hooks_path, &root)
}

/// Removes our managed entries while leaving the user's own hooks untouched.
pub fn uninstall(home: &Path) -> std::io::Result<()> {
    let settings_path = claude_settings_path(home);
    if settings_path.exists() {
        let mut root: Value = read_settings(&settings_path)?;
        for event in HOOK_EVENTS {
            remove_managed_entries(&mut root, event);
        }
        write_atomic(&settings_path, &root)?;
    }

    // Antigravity: remove our whole named bundle (user bundles untouched)
    let hooks_path = gemini_hooks_path(home);
    if hooks_path.exists() {
        let mut root: Value = read_settings(&hooks_path)?;
        if let Some(obj) = root.as_object_mut() {
            obj.remove(AGY_BUNDLE_NAME);
        }
        write_atomic(&hooks_path, &root)?;
    }

    // Gemini / Qwen: sweep managed entries from every event bucket
    for (marker, config_path) in [
        ("oppa-gemini-hook", home.join(".gemini").join("settings.json")),
        ("oppa-qwen-hook", home.join(".qwen").join("settings.json")),
    ] {
        if !config_path.exists() {
            continue;
        }
        let mut root = read_settings(&config_path)?;
        remove_command_hooks(&mut root, marker);
        write_atomic(&config_path, &root)?;
    }

    // Cursor
    let cursor_path = home.join(".cursor").join("hooks.json");
    if cursor_path.exists() {
        let mut root = read_settings(&cursor_path)?;
        remove_command_hooks(&mut root, "oppa-cursor-hook");
        write_atomic(&cursor_path, &root)?;
    }

    // Grok: the whole file is ours — delete it
    let grok_home = std::env::var("GROK_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home.join(".grok"));
    let grok_file = grok_home.join("hooks").join("oppa-status.json");
    if grok_file.exists() {
        fs::remove_file(grok_file)?;
    }

    // OpenCode plugin (only when we own the default config location)
    if std::env::var_os("OPENCODE_CONFIG_DIR").is_none() {
        let xdg = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"));
        let plugin_path = xdg
            .join("opencode")
            .join("plugin")
            .join("oppa-opencode-status.js");
        if plugin_path.exists() {
            fs::remove_file(plugin_path)?;
        }
    }
    Ok(())
}

fn read_settings(path: &Path) -> std::io::Result<Value> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let raw = fs::read_to_string(path)?;
    serde_json::from_str(&raw)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

fn group_is_managed(group: &Value) -> bool {
    group
        .get("hooks")
        .and_then(|h| h.as_array())
        .map(|hooks| {
            hooks.iter().any(|h| {
                h.get("command")
                    .and_then(|c| c.as_str())
                    .map(|c| c.contains(MANAGED_MARKER))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn set_event_hook(root: &mut Value, event: &str, command: &str) {
    let groups = root
        .as_object_mut()
        .expect("root is an object")
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .expect("hooks is an object")
        .entry(event)
        .or_insert_with(|| json!([]));
    if !groups.is_array() {
        *groups = json!([]);
    }
    let arr = groups.as_array_mut().expect("array");
    // Replace any previous managed entry in place; user entries survive
    arr.retain(|group| !group_is_managed(group));
    arr.push(json!({
        "hooks": [{ "type": "command", "command": command, "timeout": 10 }]
    }));
}

fn remove_managed_entries(root: &mut Value, event: &str) {
    let Some(groups) = root
        .get_mut("hooks")
        .and_then(|h| h.get_mut(event))
        .and_then(|e| e.as_array_mut())
    else {
        return;
    };
    groups.retain(|group| !group_is_managed(group));
}

fn write_atomic(path: &Path, value: &Value) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!(
        "tmp.{}",
        std::process::id()
    ));
    fs::write(&tmp, serde_json::to_string_pretty(value)? )?;
    fs::rename(tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user_entry(command: &str) -> Value {
        json!({ "hooks": [{ "type": "command", "command": command }] })
    }

    #[test]
    fn install_creates_scripts_and_managed_entries_preserving_user_hooks() {
        let home = tempfile::tempdir().expect("home tmp");
        let app = tempfile::tempdir().expect("app tmp");

        // Pre-existing user config with their own Stop hook
        let settings = claude_settings_path(home.path());
        fs::create_dir_all(settings.parent().unwrap()).expect("mkdir");
        fs::write(
            &settings,
            json!({
                "theme": "dark",
                "hooks": { "Stop": [user_entry("echo mine")] }
            })
            .to_string(),
        )
        .expect("seed");

        install(app.path(), home.path()).expect("install");

        let root: Value =
            serde_json::from_str(&fs::read_to_string(&settings).expect("read")).expect("json");
        assert_eq!(root["theme"], "dark", "unrelated keys survive");
        let stop_groups = root["hooks"]["Stop"].as_array().expect("stop groups");
        assert_eq!(stop_groups.len(), 2, "user entry kept + one managed added");
        assert!(root["hooks"]["SessionStart"].as_array().is_some());
        assert!(root["hooks"]["UserPromptSubmit"].as_array().is_some());

        assert!(app
            .path()
            .join("agent-hooks")
            .join("oppa-claude-hook.ps1")
            .exists());
        assert!(app
            .path()
            .join("agent-hooks")
            .join("oppa-claude-hook.sh")
            .exists());
    }

    #[test]
    fn reinstall_replaces_managed_entries_without_duplicates() {
        let home = tempfile::tempdir().expect("home tmp");
        let app1 = tempfile::tempdir().expect("app1 tmp");
        install(app1.path(), home.path()).expect("first install");
        // Second install from a different app dir (e.g. moved install)
        let app2 = tempfile::tempdir().expect("app2 tmp");
        install(app2.path(), home.path()).expect("second install");

        let root: Value = serde_json::from_str(
            &fs::read_to_string(claude_settings_path(home.path())).expect("read"),
        )
        .expect("json");
        for event in HOOK_EVENTS {
            let arr = root["hooks"][event].as_array().unwrap();
            let managed: Vec<&Value> = arr.iter().filter(|g| group_is_managed(g)).collect();
            assert_eq!(managed.len(), 1, "{event}: exactly one managed entry");
            let cmd = managed[0]["hooks"][0]["command"].as_str().unwrap();
            assert!(
                cmd.contains(&app2.path().to_string_lossy().as_ref()),
                "{event}: managed command points at latest script location"
            );
        }
    }

    #[test]
    fn claude_registrations_request_tool_and_permission_lifecycle_events() {
        // Status-truth MVP: without these events the daemon can only ever see
        // session boundaries — no tool activity, no permission questions.
        for required in [
            "PreToolUse",
            "PostToolUse",
            "PostToolUseFailure",
            "Notification",
            "SessionStart",
            "UserPromptSubmit",
            "Stop",
        ] {
            assert!(
                HOOK_EVENTS.contains(&required),
                "{required} must be registered with Claude Code"
            );
        }
        assert_eq!(HOOK_EVENTS.len(), 7, "no stray registrations");
    }

    #[test]
    fn uninstall_removes_only_our_entries() {
        let home = tempfile::tempdir().expect("home tmp");
        let app = tempfile::tempdir().expect("app tmp");
        let settings = claude_settings_path(home.path());
        fs::create_dir_all(settings.parent().unwrap()).expect("mkdir");
        fs::write(
            &settings,
            json!({
                "hooks": { "Stop": [user_entry("echo mine"), user_entry("claude --help")] }
            })
            .to_string(),
        )
        .expect("seed");
        install(app.path(), home.path()).expect("install");

        uninstall(home.path()).expect("uninstall");
        let root: Value =
            serde_json::from_str(&fs::read_to_string(&settings).expect("read")).expect("json");
        let stop_groups = root["hooks"]["Stop"].as_array().unwrap();
        assert_eq!(stop_groups.len(), 2);
        assert!(
            stop_groups.iter().all(|g| !group_is_managed(g)),
            "only user entries remain"
        );
    }

    #[test]
    fn uninstall_on_missing_settings_is_noop() {
        let home = tempfile::tempdir().expect("home tmp");
        uninstall(home.path()).expect("noop uninstall");
    }

    #[test]
    #[test]
    fn gemini_qwen_cursor_grok_opencode_roundtrip() {
        let home = tempfile::tempdir().expect("home tmp");
        let app = tempfile::tempdir().expect("app tmp");
        // Pre-existing user content that must survive installs
        let gemini_settings = home.path().join(".gemini").join("settings.json");
        fs::create_dir_all(gemini_settings.parent().unwrap()).expect("mkdir");
        fs::write(
            &gemini_settings,
            json!({
                "theme": "auto",
                "hooks": { "BeforeAgent": [user_entry("echo mine")] }
            })
            .to_string(),
        )
        .expect("seed gemini");

        install(app.path(), home.path()).expect("install");

        // Gemini: 4 event buckets, user entry kept + one managed each
        let root: Value =
            serde_json::from_str(&fs::read_to_string(&gemini_settings).expect("read"))
                .expect("json");
        assert_eq!(root["theme"], "auto");
        for event in GEMINI_EVENTS {
            let arr = root["hooks"][event].as_array().unwrap_or_else(|| panic!("{event}"));
            let expected = if *event == "BeforeAgent" { 2 } else { 1 };
            assert_eq!(arr.len(), expected, "{event}: user (if seeded) + managed");
        }

        // Qwen: same shape under ~/.qwen
        let qwen_root: Value = serde_json::from_str(
            &fs::read_to_string(home.path().join(".qwen").join("settings.json")).expect("read"),
        )
        .expect("json");
        assert!(qwen_root["hooks"]["BeforeAgent"].as_array().is_some());

        // Cursor: direct-command definitions + version preserved/added
        let cursor_root: Value = serde_json::from_str(
            &fs::read_to_string(home.path().join(".cursor").join("hooks.json")).expect("read"),
        )
        .expect("json");
        assert_eq!(cursor_root["version"], 1);
        assert!(
            cursor_root["hooks"]["stop"].as_array().is_some(),
            "cursor stop bucket present"
        );

        // Grok: dedicated file, whole-file ownership
        let grok_path = home.path().join(".grok").join("hooks").join("oppa-status.json");
        let grok_root: Value =
            serde_json::from_str(&fs::read_to_string(&grok_path).expect("read")).expect("json");
        assert!(grok_root["hooks"]["PreToolUse"]["matcher"] == ".*");

        // OpenCode plugin dropped into the default config location
        let plugin = home
            .path()
            .join(".config")
            .join("opencode")
            .join("plugin")
            .join("oppa-opencode-status.js");
        assert!(plugin.exists(), "opencode plugin written");

        // Uninstall sweeps everything without touching user entries
        uninstall(home.path()).expect("uninstall");
        let root: Value =
            serde_json::from_str(&fs::read_to_string(&gemini_settings).expect("read"))
                .expect("json");
        assert!(root["hooks"]["BeforeAgent"].as_array().unwrap().len() == 1);
        assert!(root["hooks"]["AfterAgent"].as_array().map(|a| a.is_empty()).unwrap_or(true));
        assert!(!grok_path.exists());
        assert!(!plugin.exists());
    }

    #[test]
    fn agy_bundle_merges_into_existing_hooks_json_and_uninstalls_cleanly() {
        let home = tempfile::tempdir().expect("home tmp");
        let app = tempfile::tempdir().expect("app tmp");
        // Mirror the real-world file: user already has Orca's bundle registered
        let hooks_path = gemini_hooks_path(home.path());
        fs::create_dir_all(hooks_path.parent().unwrap()).expect("mkdir");
        fs::write(
            &hooks_path,
            json!({
                "orca-status": {
                    "Stop": [
                        { "type": "command", "command": "C:\\Users\\me\\.orca\\agent-hooks\\antigravity-stop.cmd", "timeout": 10 }
                    ]
                }
            })
            .to_string(),
        )
        .expect("seed");

        install(app.path(), home.path()).expect("install");

        let root: Value =
            serde_json::from_str(&fs::read_to_string(&hooks_path).expect("read")).expect("json");
        // Orca's bundle untouched
        assert!(root["orca-status"]["Stop"].as_array().is_some());
        // Ours present with all three events
        let ours = &root["oppa-status"];
        for event in AGY_EVENTS {
            let arr = ours[event].as_array().expect(event);
            assert_eq!(arr.len(), 1, "{event}: one managed handler");
            let cmd = arr[0]["command"].as_str().unwrap();
            assert!(
                cmd.contains("oppa-antigravity"),
                "{event}: command points at our wrapper"
            );
        }

        // Re-install replaces (no duplicates possible: named bundle)
        install(app.path(), home.path()).expect("reinstall");
        let root: Value =
            serde_json::from_str(&fs::read_to_string(&hooks_path).expect("read")).expect("json");
        assert_eq!(root.as_object().unwrap().len(), 2, "two bundles total");

        uninstall(home.path()).expect("uninstall");
        let root: Value =
            serde_json::from_str(&fs::read_to_string(&hooks_path).expect("read")).expect("json");
        assert!(root.get("oppa-status").is_none(), "our bundle removed");
        assert!(root["orca-status"]["Stop"].as_array().is_some(), "orca kept");
    }
}
