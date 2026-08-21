// Installs/removes OPPA's managed lifecycle hooks into agent CLI configs
// (Claude Code: ~/.claude/settings.json). The hook pipes its stdin JSON —
// which carries the authoritative session_id + transcript_path — to the
// daemon's localhost receiver, tagged with the pane it ran inside.

use serde_json::{json, Value};
use std::fs;
use std::path::Path;

/// Appears in every command we install so re-runs replace only our entries.
const MANAGED_MARKER: &str = "oppa-claude-hook";
const HOOK_EVENTS: &[&str] = &["SessionStart", "Stop", "UserPromptSubmit"];

// Antigravity (agy) hooks live in ~/.gemini/config/hooks.json as a named
// bundle — same mechanism Orca registers under "orca-status".
const AGY_BUNDLE_NAME: &str = "oppa-status";
const AGY_EVENTS: &[&str] = &["PreInvocation", "PostInvocation", "Stop"];

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

    install_agy_bundle(app_data_dir, home)
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
