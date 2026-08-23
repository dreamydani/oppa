//! Static launch catalog for TUI coding agents: command, args, env vars, and
//! how a first prompt reaches the agent (argv flag, positional, stdin, paste).
//! Data ported from Orca's tui-agent-config.ts / tui-agent-startup.ts;
//! agent ids follow oppa's own resume/hook conventions where they overlap.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PromptDelivery {
    Arg,
    Stdin,
    PasteOnReady,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentProfile {
    pub id: &'static str,
    pub display_name: &'static str,
    pub command: &'static str,
    pub default_args: &'static [&'static str],
    pub env: &'static [(&'static str, &'static str)],
    pub prompt_delivery: PromptDelivery,
    /// Flag whose value is the prompt (Arg delivery only); None => positional append
    pub prompt_arg: Option<&'static str>,
    /// Guard inserted before a positional prompt so flag-like text stays a prompt
    pub prompt_argv_separator: Option<&'static str>,
    pub trust_preapproval_args: &'static [&'static str],
}

pub fn profiles() -> &'static [AgentProfile] {
    PROFILES
}

pub fn lookup(id: &str) -> Option<&'static AgentProfile> {
    let wanted = id.trim().to_ascii_lowercase();
    PROFILES.iter().find(|p| p.id == wanted)
}

pub fn build_launch_command(profile: &AgentProfile, prompt: Option<&str>) -> Vec<String> {
    let mut argv = vec![profile.command.to_string()];
    argv.extend(profile.default_args.iter().map(|a| a.to_string()));
    argv.extend(profile.trust_preapproval_args.iter().map(|a| a.to_string()));
    if profile.prompt_delivery == PromptDelivery::Arg {
        if let Some(prompt) = prompt {
            if let Some(flag) = profile.prompt_arg {
                argv.push(flag.to_string());
            } else if let Some(separator) = profile.prompt_argv_separator {
                argv.push(separator.to_string());
            }
            argv.push(prompt.to_string());
        }
    }
    argv
}

pub fn resolve_command(command: &str) -> Option<PathBuf> {
    resolve_command_with_path(command, None)
}

// path_var=None falls back to the process PATH so tests can inject a fake lookup scope.
pub fn resolve_command_with_path(command: &str, path_var: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    if command.trim().is_empty() {
        return None;
    }
    let as_path = Path::new(command);
    let has_dir_component = as_path.parent().is_some_and(|p| !p.as_os_str().is_empty());
    if has_dir_component {
        return is_executable_file(as_path).then(|| as_path.to_path_buf());
    }
    let path_var = path_var.map(|p| p.to_os_string()).or_else(|| std::env::var_os("PATH"))?;
    for dir in std::env::split_paths(&path_var) {
        for candidate in extension_candidates(command) {
            let full = dir.join(&candidate);
            if is_executable_file(&full) {
                return Some(full);
            }
        }
    }
    None
}

// Windows CreateProcess only auto-appends .exe; .cmd/.bat must be named exactly,
// so probe PATHEXT (filtered to the launchable three) after the bare name.
#[cfg(windows)]
fn extension_candidates(command: &str) -> Vec<String> {
    let lower = command.to_ascii_lowercase();
    let mut candidates = vec![command.to_string()];
    let patext = std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT".to_string());
    for ext in patext.split(';') {
        let ext_lower = ext.trim().to_ascii_lowercase();
        if matches!(ext_lower.as_str(), ".exe" | ".cmd" | ".bat") && !lower.ends_with(&ext_lower) {
            candidates.push(format!("{command}{ext}"));
        }
    }
    candidates
}

#[cfg(not(windows))]
fn extension_candidates(command: &str) -> Vec<String> {
    vec![command.to_string()]
}

fn is_executable_file(path: &Path) -> bool {
    #[cfg(windows)]
    {
        path.is_file()
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        path.is_file()
            && path
                .metadata()
                .map(|m| m.permissions().mode() & 0o111 != 0)
                .unwrap_or(false)
    }
}

const NO_ARGS: &[&str] = &[];
const NO_ENV: &[(&str, &str)] = &[];

// Orca pre-approves trust for cursor/copilot/codex by pre-writing trust FILES
// (agent-trust-presets.ts); it verified no argv equivalent exists, so those
// stay empty here and file presets remain a task-12 concern.
const PROFILES: &[AgentProfile] = &[
    AgentProfile {
        id: "claude",
        display_name: "Claude Code",
        command: "claude",
        default_args: NO_ARGS,
        env: NO_ENV,
        prompt_delivery: PromptDelivery::Arg,
        prompt_arg: None,
        prompt_argv_separator: None,
        trust_preapproval_args: NO_ARGS,
    },
    AgentProfile {
        id: "codex",
        display_name: "Codex",
        command: "codex",
        default_args: NO_ARGS,
        env: NO_ENV,
        prompt_delivery: PromptDelivery::Arg,
        prompt_arg: None,
        prompt_argv_separator: None,
        trust_preapproval_args: NO_ARGS,
    },
    AgentProfile {
        id: "gemini",
        display_name: "Gemini CLI",
        command: "gemini",
        default_args: NO_ARGS,
        env: NO_ENV,
        // Orca flag-prompt-interactive: `--prompt-interactive <text>` keeps the session interactive
        prompt_delivery: PromptDelivery::Arg,
        prompt_arg: Some("--prompt-interactive"),
        prompt_argv_separator: None,
        trust_preapproval_args: NO_ARGS,
    },
    AgentProfile {
        id: "qwen",
        display_name: "Qwen Code",
        command: "qwen",
        default_args: NO_ARGS,
        env: NO_ENV,
        // Orca treats qwen-code as stdin-after-start despite the gemini lineage
        prompt_delivery: PromptDelivery::Stdin,
        prompt_arg: None,
        prompt_argv_separator: None,
        trust_preapproval_args: NO_ARGS,
    },
    AgentProfile {
        id: "opencode",
        display_name: "OpenCode",
        command: "opencode",
        default_args: NO_ARGS,
        env: NO_ENV,
        prompt_delivery: PromptDelivery::Arg,
        prompt_arg: Some("--prompt"),
        prompt_argv_separator: None,
        trust_preapproval_args: NO_ARGS,
    },
    AgentProfile {
        id: "grok",
        display_name: "Grok CLI",
        command: "grok",
        default_args: NO_ARGS,
        env: NO_ENV,
        // Grok takes a positional prompt; Orca guards it with a `--` separator
        // so prompts that look like flags stay prompts.
        prompt_delivery: PromptDelivery::Arg,
        prompt_arg: None,
        prompt_argv_separator: Some("--"),
        trust_preapproval_args: NO_ARGS,
    },
    AgentProfile {
        id: "cursor",
        display_name: "Cursor Agent",
        command: "cursor-agent",
        default_args: NO_ARGS,
        env: NO_ENV,
        prompt_delivery: PromptDelivery::Arg,
        prompt_arg: None,
        prompt_argv_separator: None,
        trust_preapproval_args: NO_ARGS,
    },
    AgentProfile {
        id: "aider",
        display_name: "Aider",
        command: "aider",
        default_args: NO_ARGS,
        env: NO_ENV,
        prompt_delivery: PromptDelivery::Stdin,
        prompt_arg: None,
        prompt_argv_separator: None,
        trust_preapproval_args: NO_ARGS,
    },
    AgentProfile {
        id: "amp",
        display_name: "Amp",
        command: "amp",
        default_args: NO_ARGS,
        env: NO_ENV,
        prompt_delivery: PromptDelivery::Stdin,
        prompt_arg: None,
        prompt_argv_separator: None,
        trust_preapproval_args: NO_ARGS,
    },
    AgentProfile {
        id: "droid",
        display_name: "Droid",
        command: "droid",
        default_args: NO_ARGS,
        env: NO_ENV,
        prompt_delivery: PromptDelivery::Arg,
        prompt_arg: None,
        prompt_argv_separator: None,
        trust_preapproval_args: NO_ARGS,
    },
    AgentProfile {
        id: "copilot",
        display_name: "GitHub Copilot CLI",
        command: "copilot",
        default_args: NO_ARGS,
        env: NO_ENV,
        // Orca flag-interactive: `-i` keeps the hosted session alive (--prompt would exit on completion)
        prompt_delivery: PromptDelivery::Arg,
        prompt_arg: Some("-i"),
        prompt_argv_separator: None,
        trust_preapproval_args: NO_ARGS,
    },
    AgentProfile {
        id: "goose",
        display_name: "Goose",
        command: "goose",
        default_args: NO_ARGS,
        env: NO_ENV,
        prompt_delivery: PromptDelivery::Stdin,
        prompt_arg: None,
        prompt_argv_separator: None,
        trust_preapproval_args: NO_ARGS,
    },
    AgentProfile {
        id: "kimi",
        display_name: "Kimi CLI",
        command: "kimi",
        default_args: NO_ARGS,
        env: NO_ENV,
        prompt_delivery: PromptDelivery::Stdin,
        prompt_arg: None,
        prompt_argv_separator: None,
        trust_preapproval_args: NO_ARGS,
    },
    AgentProfile {
        id: "agy",
        display_name: "Antigravity",
        command: "agy",
        default_args: NO_ARGS,
        env: NO_ENV,
        prompt_delivery: PromptDelivery::Arg,
        prompt_arg: Some("--prompt-interactive"),
        prompt_argv_separator: None,
        trust_preapproval_args: NO_ARGS,
    },
    // Placeholder for user-typed raw commands; never spawned via lookup.
    AgentProfile {
        id: "generic",
        display_name: "Custom command",
        command: "generic",
        default_args: NO_ARGS,
        env: NO_ENV,
        prompt_delivery: PromptDelivery::Arg,
        prompt_arg: None,
        prompt_argv_separator: None,
        trust_preapproval_args: NO_ARGS,
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    const M1_IDS: &[&str] = &[
        "claude", "codex", "gemini", "qwen", "opencode", "grok", "cursor", "aider", "amp", "droid",
        "copilot", "goose", "kimi", "agy", "generic",
    ];

    #[test]
    fn every_m1_id_resolves_case_insensitively_and_unknown_is_none() {
        for id in M1_IDS {
            assert!(lookup(id).is_some(), "{id}");
            assert!(lookup(&id.to_ascii_uppercase()).is_some(), "{id} upper");
        }
        assert!(lookup("nope").is_none());
        assert!(lookup("").is_none());
    }

    #[test]
    fn ids_match_agent_resume_and_hook_conventions_for_overlapping_agents() {
        for id in [
            "claude", "codex", "gemini", "qwen", "opencode", "grok", "cursor", "aider", "agy",
        ] {
            assert!(lookup(id).is_some(), "{id} must keep oppa's existing id");
        }
    }

    #[test]
    fn claude_takes_prompt_positionally_per_orca_argv_mode() {
        let cmd = build_launch_command(lookup("claude").unwrap(), Some("fix the tests"));
        assert_eq!(cmd, vec!["claude", "fix the tests"]);
    }

    #[test]
    fn codex_takes_prompt_positionally() {
        let cmd = build_launch_command(lookup("codex").unwrap(), Some("refactor"));
        assert_eq!(cmd, vec!["codex", "refactor"]);
    }

    #[test]
    fn gemini_family_uses_prompt_interactive_flag_from_orca_startup_builder() {
        let cmd = build_launch_command(lookup("gemini").unwrap(), Some("hi"));
        assert_eq!(cmd, vec!["gemini", "--prompt-interactive", "hi"]);
        let cmd = build_launch_command(lookup("agy").unwrap(), Some("hi"));
        assert_eq!(cmd, vec!["agy", "--prompt-interactive", "hi"]);
    }

    #[test]
    fn opencode_and_copilot_flags_match_orca_argv_construction() {
        let oc = build_launch_command(lookup("opencode").unwrap(), Some("hi"));
        assert_eq!(oc, vec!["opencode", "--prompt", "hi"]);
        let cp = build_launch_command(lookup("copilot").unwrap(), Some("hi"));
        assert_eq!(cp, vec!["copilot", "-i", "hi"]);
    }

    #[test]
    fn grok_guards_positional_prompt_with_double_dash_separator() {
        let cmd = build_launch_command(lookup("grok").unwrap(), Some("do it"));
        assert_eq!(cmd, vec!["grok", "--", "do it"]);
    }

    #[test]
    fn droid_takes_prompt_positionally_without_separator() {
        let cmd = build_launch_command(lookup("droid").unwrap(), Some("do it"));
        assert_eq!(cmd, vec!["droid", "do it"]);
    }

    #[test]
    fn only_grok_declares_the_argv_separator() {
        let with_separator: Vec<&str> = profiles()
            .iter()
            .filter(|p| p.prompt_argv_separator.is_some())
            .map(|p| p.id)
            .collect();
        assert_eq!(with_separator, vec!["grok"]);
    }

    #[test]
    fn separator_is_omitted_when_no_prompt_or_flag_prompt_used() {
        let bare = build_launch_command(lookup("grok").unwrap(), None);
        assert_eq!(bare, vec!["grok"]);
        let flagged = build_launch_command(lookup("gemini").unwrap(), Some("hi"));
        assert!(!flagged.contains(&"--".to_string()));
    }

    #[test]
    fn stdin_delivery_agents_omit_prompt_from_argv() {
        for id in ["qwen", "aider", "amp", "goose", "kimi"] {
            let profile = lookup(id).unwrap();
            assert_eq!(profile.prompt_delivery, PromptDelivery::Stdin, "{id}");
            let with = build_launch_command(profile, Some("late prompt"));
            assert_eq!(with, vec![profile.command], "{id} must not carry prompt");
        }
    }

    #[test]
    fn paste_on_ready_agents_also_omit_prompt_from_argv() {
        let profile = AgentProfile {
            id: "synthetic",
            display_name: "Synthetic",
            command: "synth",
            default_args: &[],
            env: &[],
            prompt_delivery: PromptDelivery::PasteOnReady,
            prompt_arg: None,
            prompt_argv_separator: None,
            trust_preapproval_args: &[],
        };
        assert_eq!(build_launch_command(&profile, Some("draft")), vec!["synth"]);
    }

    #[test]
    fn trust_args_append_once_between_defaults_and_prompt() {
        let profile = AgentProfile {
            id: "synthetic",
            display_name: "Synthetic",
            command: "synth",
            default_args: &["--flag-a"],
            env: &[],
            prompt_delivery: PromptDelivery::Arg,
            prompt_arg: Some("--prompt"),
            prompt_argv_separator: None,
            trust_preapproval_args: &["--trust"],
        };
        let cmd = build_launch_command(&profile, Some("do it"));
        assert_eq!(
            cmd,
            vec!["synth", "--flag-a", "--trust", "--prompt", "do it"]
        );
        assert_eq!(cmd.iter().filter(|a| **a == "--trust").count(), 1);
    }

    #[test]
    fn no_prompt_yields_bare_command_plus_defaults() {
        let cmd = build_launch_command(lookup("claude").unwrap(), None);
        assert_eq!(cmd, vec!["claude"]);
    }

    #[test]
    fn generic_profile_has_no_agent_specific_behavior() {
        let p = lookup("generic").unwrap();
        assert_eq!(p.prompt_delivery, PromptDelivery::Arg);
        assert!(p.default_args.is_empty());
        assert!(p.prompt_arg.is_none());
    }

    #[test]
    fn resolve_command_finds_known_tools_on_this_machine() {
        #[cfg(windows)]
        {
            assert!(resolve_command("cmd").is_some());
            assert!(resolve_command("git").is_some());
        }
        #[cfg(not(windows))]
        assert!(resolve_command("sh").is_some());
    }

    #[test]
    fn resolve_command_rejects_garbage() {
        assert!(resolve_command("definitely-not-a-tool-xyz").is_none());
        assert!(resolve_command("").is_none());
    }

    #[test]
    fn catalog_sanity_unique_ids_nonempty_fields() {
        let mut seen = std::collections::HashSet::new();
        for p in profiles() {
            assert!(!p.id.is_empty());
            assert!(!p.command.is_empty(), "{} command", p.id);
            assert!(!p.display_name.is_empty(), "{} display name", p.id);
            assert!(seen.insert(p.id), "duplicate id {}", p.id);
        }
        assert_eq!(profiles().len(), M1_IDS.len());
    }

    #[test]
    fn serde_exposes_kebab_case_delivery_and_profile_fields() {
        assert_eq!(
            serde_json::to_string(&PromptDelivery::PasteOnReady).unwrap(),
            "\"paste-on-ready\""
        );
        assert_eq!(
            serde_json::to_string(&PromptDelivery::Stdin).unwrap(),
            "\"stdin\""
        );
        let json = serde_json::to_value(lookup("generic").unwrap()).unwrap();
        assert_eq!(json["id"], "generic");
        assert_eq!(json["command"], "generic");
    }
}
