// Ported vocabulary policy: one canonical family/verb table shared by parsing, help text, and agent-context.

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
