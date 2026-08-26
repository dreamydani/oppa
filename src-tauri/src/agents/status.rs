// Ported from stablyai/orca src/shared/agent-status-types.ts (MIT license).
// Verbatim semantics: four-state hook-derived truth, field clamps, and the
// done-gate invariants that keep a finished turn from being resurrected.

use serde::{Deserialize, Serialize};

pub const AGENT_STATUS_STATES: [&str; 4] = ["working", "blocked", "waiting", "done"];

// Caps mirror Orca's normalization so UI rows can never blow up on chatty agents.
pub const AGENT_STATUS_MAX_FIELD_LENGTH: usize = 2000;
const TOOL_NAME_MAX_LEN: usize = 256;
const INTERACTIVE_PROMPT_MAX_LEN: usize = 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentStatusState {
    Working,
    Blocked,
    Waiting,
    Done,
}

impl AgentStatusState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Working => "working",
            Self::Blocked => "blocked",
            Self::Waiting => "waiting",
            Self::Done => "done",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "working" => Some(Self::Working),
            "blocked" => Some(Self::Blocked),
            "waiting" => Some(Self::Waiting),
            "done" => Some(Self::Done),
            _ => None,
        }
    }
}

// Where the evidence came from: managed hooks are authority; quietness is fallback.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum StatusOrigin {
    Hook,
    Quiet,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentStatusEntry {
    pub state: AgentStatusState,
    /// Most recent user prompt, cached across the turn because tool pings omit it.
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub agent_type: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub tool_name: Option<String>,
    #[serde(default)]
    pub tool_input: Option<String>,
    /// Literal question an agent is stuck on, so a waiting row shows what to approve.
    #[serde(default)]
    pub interactive_prompt: Option<String>,
    // Only meaningful on done; nulled elsewhere so stale truth cannot cross transitions.
    #[serde(default)]
    pub interrupted: Option<bool>,
    #[serde(default)]
    pub turn_completed_at_ms: Option<u64>,
    /// When this state was first reported; tool pings reset updated_at, never this.
    pub state_started_at_ms: u64,
    pub updated_at_ms: u64,
    pub origin: StatusOrigin,
}

/// Alias probe across per-CLI payload key spellings; hooks vary, meaning does not.
pub fn first_string(value: &serde_json::Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(|v| v.as_str())
            .map(str::to_string)
    })
}

fn collapse_single_line(text: &str) -> String {
    // Controls become separators (house convention matches sanitize_display_name)
    // so embedded bell/backspace payloads cannot weld words together.
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn char_cut(text: &str, max_chars: usize) -> usize {
    text.char_indices().nth(max_chars).map(|(i, _)| i).unwrap_or(text.len())
}

pub fn clamp_single_line(text: &str) -> Option<String> {
    let collapsed = collapse_single_line(text);
    if collapsed.is_empty() {
        return None;
    }
    let cut = char_cut(&collapsed, AGENT_STATUS_MAX_FIELD_LENGTH);
    Some(collapsed[..cut].to_string())
}

fn clamp_multiline(text: &str) -> Option<String> {
    let cleaned: String =
        text.chars().filter(|c| !c.is_control() || *c == '\n').collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed[..char_cut(trimmed, AGENT_STATUS_MAX_FIELD_LENGTH)].to_string())
}

/// Field-specific caps apply before the generic clamp so tool names stay row-safe.
fn clamp_optional_field(
    text: Option<&str>,
    max_chars: usize,
) -> Result<Option<String>, String> {
    let Some(clamped) = text.and_then(clamp_single_line) else {
        return Ok(None);
    };
    if clamped.chars().count() > max_chars {
        return Ok(Some(clamped[..char_cut(&clamped, max_chars)].to_string()));
    }
    Ok(Some(clamped))
}

pub struct NormalizedStatusFields<'a> {
    pub state: &'a str,
    pub prompt: Option<&'a str>,
    pub agent_type: Option<&'a str>,
    pub model: Option<&'a str>,
    pub tool_name: Option<&'a str>,
    pub tool_input: Option<&'a str>,
    pub interactive_prompt: Option<&'a str>,
    pub interrupted: bool,
    pub turn_completed_at_ms: Option<u64>,
    pub state_started_at_ms: u64,
    pub updated_at_ms: u64,
    pub origin: StatusOrigin,
}

/// Single ingress constructor enforcing every invariant the UI relies on:
/// unknown states reject outright; interrupted/turn-completed only exist on done.
pub fn normalize_agent_status(
    fields: NormalizedStatusFields<'_>,
) -> Result<AgentStatusEntry, String> {
    let Some(state) = AgentStatusState::parse(fields.state) else {
        return Err(format!("invalid agent status state: {}", fields.state));
    };
    let is_done = state == AgentStatusState::Done;
    Ok(AgentStatusEntry {
        state,
        prompt: clamp_single_line(fields.prompt.unwrap_or_default()).unwrap_or_default(),
        agent_type: clamp_optional_field(fields.agent_type, AGENT_STATUS_MAX_FIELD_LENGTH)?,
        model: clamp_optional_field(fields.model, AGENT_STATUS_MAX_FIELD_LENGTH)?,
        tool_name: clamp_optional_field(fields.tool_name, TOOL_NAME_MAX_LEN)?,
        tool_input: clamp_optional_field(fields.tool_input, AGENT_STATUS_MAX_FIELD_LENGTH)?,
        interactive_prompt: clamp_optional_field(
            fields.interactive_prompt,
            INTERACTIVE_PROMPT_MAX_LEN,
        )?,
        interrupted: (is_done && fields.interrupted).then_some(true),
        turn_completed_at_ms: is_done.then_some(fields.turn_completed_at_ms).flatten(),
        state_started_at_ms: fields.state_started_at_ms,
        updated_at_ms: fields.updated_at_ms,
        origin: fields.origin,
    })
}

/// Multiline cleaner for assistant-message style fields; shared rules, v1 keeps
/// it out of the struct but hook classifiers still need it.
pub fn clamp_assistant_message(text: &str) -> Option<String> {
    clamp_multiline(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_fields(state: &'static str) -> NormalizedStatusFields<'static> {
        NormalizedStatusFields {
            state,
            prompt: None,
            agent_type: None,
            model: None,
            tool_name: None,
            tool_input: None,
            interactive_prompt: None,
            interrupted: false,
            turn_completed_at_ms: None,
            state_started_at_ms: 100,
            updated_at_ms: 200,
            origin: StatusOrigin::Hook,
        }
    }

    #[test]
    fn states_roundtrip_kebab_case() {
        assert_eq!(AgentStatusState::Done.as_str(), "done");
        assert_eq!(
            serde_json::to_value(AgentStatusState::Working).unwrap(),
            "working"
        );
        assert_eq!(
            serde_json::from_str::<AgentStatusState>("\"waiting\"").unwrap(),
            AgentStatusState::Waiting
        );
        assert_eq!(AGENT_STATUS_STATES, ["working", "blocked", "waiting", "done"]);
    }

    #[test]
    fn invalid_state_is_rejected_not_coerced() {
        assert!(normalize_agent_status(base_fields("finished")).is_err());
        assert!(normalize_agent_status(base_fields("")).is_err());
    }

    #[test]
    fn interrupted_only_survives_on_done() {
        let mut f = base_fields("working");
        f.interrupted = true;
        assert_eq!(normalize_agent_status(f).unwrap().interrupted, None);
        assert_eq!(
            normalize_agent_status(base_fields("done")).unwrap().interrupted,
            None
        );
        let mut f = base_fields("done");
        f.interrupted = true;
        assert_eq!(
            normalize_agent_status(f).unwrap().interrupted,
            Some(true)
        );
    }

    #[test]
    fn turn_completed_at_nulled_when_not_done() {
        let mut f = base_fields("waiting");
        f.turn_completed_at_ms = Some(999);
        assert_eq!(normalize_agent_status(f).unwrap().turn_completed_at_ms, None);
        let mut f = base_fields("done");
        f.turn_completed_at_ms = Some(999);
        assert_eq!(
            normalize_agent_status(f).unwrap().turn_completed_at_ms,
            Some(999)
        );
    }

    #[test]
    fn single_line_clamps_strip_controls_and_cap_chars() {
        assert_eq!(clamp_single_line("a\u{1}b\u{7f}   c"), Some("a b c".into()));
        let long = "x".repeat(AGENT_STATUS_MAX_FIELD_LENGTH + 50);
        assert_eq!(
            clamp_single_line(&long).unwrap().chars().count(),
            AGENT_STATUS_MAX_FIELD_LENGTH
        );
        assert_eq!(clamp_single_line("   \u{0}\u{1} "), None);
    }

    #[test]
    fn optional_field_uses_tighter_dedicated_caps() {
        let long_tool = "t".repeat(400);
        let clamped = clamp_optional_field(Some(&long_tool), TOOL_NAME_MAX_LEN)
            .unwrap()
            .unwrap();
        assert_eq!(clamped.chars().count(), TOOL_NAME_MAX_LEN);

        let long_prompt = "?".repeat(2000);
        let clamped = clamp_optional_field(Some(&long_prompt), INTERACTIVE_PROMPT_MAX_LEN)
            .unwrap()
            .unwrap();
        assert_eq!(clamped.chars().count(), INTERACTIVE_PROMPT_MAX_LEN);
    }

    #[test]
    fn multiline_preserves_newlines_but_trims_edges() {
        assert_eq!(clamp_multiline("line1\nline2\n"), Some("line1\nline2".into()));
        assert_eq!(clamp_multiline("\n \n"), None);
        assert!(clamp_assistant_message("ok").is_some());
    }

    #[test]
    fn first_string_probes_alias_keys_in_order() {
        let v = serde_json::json!({"error_message": null, "message": "stuck"});
        assert_eq!(first_string(&v, &["message"]), Some("stuck".into()));
        assert_eq!(
            first_string(&v, &["error_message", "message"]),
            Some("stuck".into())
        );
        assert_eq!(first_string(&v, &["missing"]), None);
    }

    #[test]
    fn empty_optional_input_becomes_clean_defaults_never_crash() {
        let entry = normalize_agent_status(base_fields("working")).unwrap();
        assert_eq!(entry.prompt, "");
        assert_eq!(entry.state, AgentStatusState::Working);
        assert_eq!(entry.tool_name, None);
    }
}


