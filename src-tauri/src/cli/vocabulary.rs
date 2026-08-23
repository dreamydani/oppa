// Ported vocabulary policy: one canonical family/verb table shared by parsing, help text, and agent-context.
use crate::pty::ipc_protocol::DAEMON_PROTOCOL_VERSION;
use clap::{Arg, ArgAction, Command as ClapCommand};
use serde::Serialize;

pub const CANONICAL_COMMANDS: &[(&str, &[&str])] = &[
    ("status", &[]),
    ("open", &[]),
    ("agent-context", &[]),
    ("repo", &["add", "list", "show"]),
    (
        "worktree",
        &[
            "list", "show", "current", "create", "set", "rm", "purge", "ps", "lineage",
        ],
    ),
    (
        "terminal",
        &[
            "list", "show", "read", "send", "wait", "create", "close", "switch", "rename", "split",
        ],
    ),
];

// Parse-level aliasing keeps muscle memory working while the wire/help surface stays canonical.
pub fn normalize_verb(verb: &str) -> &str {
    match verb {
        "delete" | "remove" => "rm",
        other => other,
    }
}

pub fn validate_verb(family: &str, verb: &str) -> Result<(), String> {
    let Some((_, verbs)) = CANONICAL_COMMANDS.iter().find(|(f, _)| *f == family) else {
        return Err(format!("unknown command family '{family}'"));
    };
    if verbs.contains(&verb) {
        return Ok(());
    }
    if verbs.is_empty() {
        return Err(format!("'{family}' takes no verb"));
    }
    // Destructive verbs are exactly "rm"; single-item reads are "show"
    // (browser/storage would allow "get" but do not exist yet).
    if matches!(verb, "delete" | "remove") && verbs.contains(&"rm") {
        return Err(format!("destructive verb must be 'rm' (got '{verb}')"));
    }
    if verb == "get" && verbs.contains(&"show") {
        return Err(format!(
            "single-item reads use 'show', not 'get', for '{family}'"
        ));
    }
    Err(format!(
        "unknown verb '{verb}' for '{family}'; expected one of: {}",
        verbs.join(", ")
    ))
}

// ---- agent-context catalog: clap is the single source for verbs, flags, and summaries ----

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CatalogFlag {
    pub name: String,
    pub takes_value: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CatalogCommand {
    pub family: String,
    // Verb-less families (status/open/agent-context) keep an empty verb.
    pub verb: String,
    pub summary: String,
    pub flags: Vec<CatalogFlag>,
    pub example: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentContextDocument {
    pub version: &'static str,
    pub protocol: u32,
    pub commands: Vec<CatalogCommand>,
    pub notes: Vec<&'static str>,
}

pub const CATALOG_NOTES: &[&str] = &[
    "exit codes: 0 ok, 1 error, 75 reserved for runtime-unavailable",
    "auth: reads the daemon endpoint and token from oppa-runtime.json in the app data dir",
    "vocabulary policy: destructive verbs are rm; single-item reads are show",
];

// Examples are the only hand-authored surface here; the drift-guard test keeps keys tied to clap.
const EXAMPLES: &[(&str, &str)] = &[
    ("status", "oppa status --json"),
    ("open", "oppa open"),
    ("agent-context", "oppa agent-context --json"),
    ("repo add", "oppa repo add /path/to/repo"),
    ("repo list", "oppa repo list --json"),
    ("repo show", "oppa repo show <repo_id>"),
    ("worktree list", "oppa worktree list --all"),
    ("worktree show", "oppa worktree show <id>"),
    ("worktree current", "oppa worktree current /some/dir"),
    (
        "worktree create",
        "oppa worktree create feat-a --repo /path/to/repo --branch feat/a",
    ),
    ("worktree set", "oppa worktree set <id> --status in-progress"),
    ("worktree rm", "oppa worktree rm <id> --delete-branch"),
    ("worktree purge", "oppa worktree purge <id>"),
    ("worktree ps", "oppa worktree ps --json"),
    ("worktree lineage", "oppa worktree lineage <id>"),
    ("terminal list", "oppa terminal list --json"),
    ("terminal show", "oppa terminal show <id>"),
    ("terminal read", "oppa terminal read <id>"),
    (
        "terminal send",
        "oppa terminal send <id> --text \"cargo test\" --enter",
    ),
    (
        "terminal wait",
        "oppa terminal wait <id> --for exit --timeout-ms 60000",
    ),
    ("terminal create", "oppa terminal create --cwd /some/dir"),
    ("terminal close", "oppa terminal close <id>"),
    ("terminal switch", "oppa terminal switch <id>"),
    ("terminal rename", "oppa terminal rename <id> --to build"),
    ("terminal split", "oppa terminal split <id>"),
];

fn lookup_example(key: &str) -> &'static str {
    EXAMPLES
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, example)| *example)
        .unwrap_or_else(|| panic!("missing agent-context example for '{key}'"))
}

fn flag_takes_value(arg: &Arg) -> bool {
    matches!(arg.get_action(), ArgAction::Set | ArgAction::Append)
}

fn arg_help(arg: &Arg) -> Option<String> {
    arg.get_long_help()
        .or_else(|| arg.get_help())
        .map(|styled| styled.to_string())
}

fn positional_flag(arg: &Arg) -> CatalogFlag {
    let id = arg.get_id();
    let name = if arg.is_required_set() {
        format!("<{id}>")
    } else {
        format!("[{id}]")
    };
    CatalogFlag {
        name,
        takes_value: true,
        help: arg_help(arg),
    }
}

fn option_flag(arg: &Arg) -> CatalogFlag {
    let long = arg
        .get_long()
        .map(str::to_owned)
        .unwrap_or_else(|| arg.get_id().as_str().to_string());
    CatalogFlag {
        name: format!("--{long}"),
        takes_value: flag_takes_value(arg),
        help: arg_help(arg),
    }
}

fn spec_for(family: &str, verb: &str, cmd: &ClapCommand, globals: &[CatalogFlag]) -> CatalogCommand {
    let mut flags: Vec<CatalogFlag> = cmd.get_positionals().map(positional_flag).collect();
    flags.extend(cmd.get_arguments().filter(|arg| !arg.is_positional()).map(option_flag));
    // Global root args (--json/--timeout-ms) parse on every leaf after propagation.
    flags.extend(globals.iter().cloned());
    CatalogCommand {
        family: family.to_string(),
        verb: verb.to_string(),
        summary: cmd.get_about().unwrap_or_default().to_string(),
        flags,
        example: lookup_example(&if verb.is_empty() {
            family.to_string()
        } else {
            format!("{family} {verb}")
        })
        .to_string(),
    }
}

pub fn build_catalog() -> Vec<CatalogCommand> {
    let root = crate::cli::command_tree::build_root_command();
    let globals: Vec<CatalogFlag> = root
        .get_arguments()
        .filter(|arg| arg.is_global_set())
        .map(option_flag)
        .collect();
    let mut commands = Vec::new();
    for family_cmd in root.get_subcommands() {
        if family_cmd.has_subcommands() {
            for verb_cmd in family_cmd.get_subcommands() {
                commands.push(spec_for(
                    family_cmd.get_name(),
                    verb_cmd.get_name(),
                    verb_cmd,
                    &globals,
                ));
            }
        } else {
            commands.push(spec_for(family_cmd.get_name(), "", family_cmd, &globals));
        }
    }
    commands
}

pub fn agent_context_document() -> AgentContextDocument {
    AgentContextDocument {
        version: env!("CARGO_PKG_VERSION"),
        protocol: DAEMON_PROTOCOL_VERSION,
        commands: build_catalog(),
        notes: CATALOG_NOTES.to_vec(),
    }
}
