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

/// Writes the hook scripts next to the endpoint files and registers the
/// managed hooks in Claude Code's settings.json (merging, never clobbering).
pub fn install(app_data_dir: &Path, home: &Path) -> std::io::Result<()> {
    let hook_dir = app_data_dir.join("agent-hooks");
    fs::create_dir_all(&hook_dir)?;
    fs::write(hook_dir.join("oppa-claude-hook.ps1"), POWERSHELL_HOOK)?;
    fs::write(hook_dir.join("oppa-claude-hook.sh"), SH_HOOK)?;

    let settings_path = claude_settings_path(home);
    let mut root: Value = read_settings(&settings_path)?;
    let command = hook_command(app_data_dir);
    for event in HOOK_EVENTS {
        set_event_hook(&mut root, event, &command);
    }
    write_atomic(&settings_path, &root)
}

/// Removes our managed entries while leaving the user's own hooks untouched.
pub fn uninstall(home: &Path) -> std::io::Result<()> {
    let settings_path = claude_settings_path(home);
    if !settings_path.exists() {
        return Ok(());
    }
    let mut root: Value = read_settings(&settings_path)?;
    for event in HOOK_EVENTS {
        remove_managed_entries(&mut root, event);
    }
    write_atomic(&settings_path, &root)
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
}
