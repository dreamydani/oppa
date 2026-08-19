use std::fmt;
use std::str::FromStr;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContextScope {
    Global,
    Workspace,
}

impl ContextScope {
    pub fn as_str(&self) -> &'static str {
        match self {
            ContextScope::Global => "global",
            ContextScope::Workspace => "workspace",
        }
    }
}

impl FromStr for ContextScope {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "global" => Ok(ContextScope::Global),
            "workspace" => Ok(ContextScope::Workspace),
            other => Err(format!("Invalid scope '{}'", other)),
        }
    }
}

impl fmt::Display for ContextScope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContextCategory {
    Architecture,
    Quirk,
    Runbook,
    Preference,
    Persona,
}

impl ContextCategory {
    pub fn as_str(&self) -> &'static str {
        match self {
            ContextCategory::Architecture => "architecture",
            ContextCategory::Quirk => "quirk",
            ContextCategory::Runbook => "runbook",
            ContextCategory::Preference => "preference",
            ContextCategory::Persona => "persona",
        }
    }
}

impl FromStr for ContextCategory {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "architecture" => Ok(ContextCategory::Architecture),
            "quirk" => Ok(ContextCategory::Quirk),
            "runbook" => Ok(ContextCategory::Runbook),
            "preference" => Ok(ContextCategory::Preference),
            "persona" => Ok(ContextCategory::Persona),
            other => Err(format!("Invalid category '{}'", other)),
        }
    }
}

impl fmt::Display for ContextCategory {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_round_trips_via_str() {
        for s in [ContextScope::Global, ContextScope::Workspace] {
            assert_eq!(ContextScope::from_str(s.as_str()).unwrap(), s);
        }
    }

    #[test]
    fn scope_rejects_unknown() {
        assert!(ContextScope::from_str("project").is_err());
    }

    #[test]
    fn category_round_trips_via_str() {
        for c in [
            ContextCategory::Architecture,
            ContextCategory::Quirk,
            ContextCategory::Runbook,
            ContextCategory::Preference,
            ContextCategory::Persona,
        ] {
            assert_eq!(ContextCategory::from_str(c.as_str()).unwrap(), c);
        }
    }

    #[test]
    fn category_rejects_plural_form() {
        assert!(ContextCategory::from_str("preferences").is_err());
        assert!(ContextCategory::from_str("standards").is_err());
    }
}
