// Quoting stays deliberately simple because agent prompts are plain text.
pub fn quote_arg(arg: &str) -> String {
    if arg.is_empty() || arg.chars().any(|c| c.is_whitespace()) {
        #[cfg(windows)]
        return format!("\"{arg}\"");
        #[cfg(not(windows))]
        return format!("'{arg}'");
    }
    arg.to_string()
}

pub fn join_argv(argv: &[String]) -> String {
    argv.iter().map(|a| quote_arg(a)).collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    fn wrap(s: &str) -> String {
        format!("\"{s}\"")
    }

    #[cfg(not(windows))]
    fn wrap(s: &str) -> String {
        format!("'{s}'")
    }

    #[test]
    fn bare_args_pass_through_unquoted() {
        assert_eq!(quote_arg("claude"), "claude");
        assert_eq!(quote_arg("--prompt-interactive"), "--prompt-interactive");
    }

    #[test]
    fn args_with_spaces_are_wrapped_per_platform() {
        let expected = wrap("fix the tests");
        assert_eq!(quote_arg("fix the tests"), expected);
        assert_eq!(quote_arg("a\tb"), wrap("a\tb"));
    }

    #[test]
    fn empty_args_are_wrapped_so_they_survive_the_shell() {
        assert_eq!(quote_arg(""), wrap(""));
    }

    #[test]
    fn join_argv_glues_quoted_parts_with_single_spaces() {
        let argv = vec!["claude".to_string(), "fix the tests".to_string()];
        assert_eq!(join_argv(&argv), format!("claude {}", wrap("fix the tests")));
    }

    #[test]
    fn join_argv_handles_empty_argv_and_single_element() {
        assert_eq!(join_argv(&[]), "");
        assert_eq!(join_argv(&["codex".to_string()]), "codex");
    }
}
