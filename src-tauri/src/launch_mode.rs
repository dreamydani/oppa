// Decides which entrypoint the unified binary takes based on argv.
//
// Exists because stale external configs (e.g. an old opencode `mcp.oppa`
// entry spawning `oppa --mcp`) must exit with a message — never fall through
// to the GUI window, which shows a confusing localhost error page.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchMode {
    Gui,
    Daemon,
    /// `oppa --mcp` / `oppa mcp`: the MCP server was removed; refuse outright.
    RefusedMcp,
}

/// Pure over argv including argv[0]; never touches the process.
pub fn resolve_mode(argv: &[String]) -> LaunchMode {
    let args: Vec<&String> = argv.iter().skip(1).collect();
    // `--daemon` keeps its historical any-position precedence.
    if args.iter().any(|a| a.as_str() == "--daemon") {
        return LaunchMode::Daemon;
    }
    if args.iter().any(|a| a.as_str() == "--mcp") {
        return LaunchMode::RefusedMcp;
    }
    let first_positional = args.iter().find(|a| !a.starts_with('-'));
    if first_positional.map(|a| a.as_str()) == Some("mcp") {
        return LaunchMode::RefusedMcp;
    }
    LaunchMode::Gui
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(parts: &[&str]) -> Vec<String> {
        parts.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn bare_invocation_launches_gui() {
        assert_eq!(resolve_mode(&argv(&["oppa"])), LaunchMode::Gui);
    }

    #[test]
    fn file_path_arg_still_launches_gui() {
        assert_eq!(
            resolve_mode(&argv(&["oppa", "D:\\proj\\file.ts"])),
            LaunchMode::Gui
        );
    }

    #[test]
    fn daemon_flag_selects_daemon() {
        assert_eq!(
            resolve_mode(&argv(&["oppa", "--daemon"])),
            LaunchMode::Daemon
        );
    }

    #[test]
    fn mcp_flag_never_launches_gui() {
        assert_eq!(
            resolve_mode(&argv(&[
                "oppa",
                "--mcp",
                "--workspace",
                "D:\\oppa\\oppa"
            ])),
            LaunchMode::RefusedMcp
        );
    }

    #[test]
    fn mcp_subcommand_never_launches_gui() {
        assert_eq!(resolve_mode(&argv(&["oppa", "mcp"])), LaunchMode::RefusedMcp);
    }

    #[test]
    fn daemon_wins_over_mcp_as_before() {
        assert_eq!(
            resolve_mode(&argv(&["oppa", "--mcp", "--daemon"])),
            LaunchMode::Daemon
        );
    }
}
