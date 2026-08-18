// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;

fn parse_workspace_arg(args: &[String]) -> Option<PathBuf> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--workspace" || arg == "-w" {
            if let Some(val) = iter.next() {
                return Some(PathBuf::from(val));
            }
        } else if let Some(val) = arg.strip_prefix("--workspace=") {
            return Some(PathBuf::from(val));
        } else if let Some(val) = arg.strip_prefix("-w=") {
            return Some(PathBuf::from(val));
        }
    }
    None
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let is_daemon = args.iter().any(|arg| arg == "--daemon");
    let is_mcp = args.iter().any(|arg| arg == "--mcp" || arg == "mcp");

    if is_daemon {
        oppa_lib::run_daemon();
    } else if is_mcp {
        let workspace = parse_workspace_arg(&args);
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("failed to build tokio runtime for mcp server");
        if let Err(e) = rt.block_on(oppa_lib::mcp::run_mcp_stdio(workspace)) {
            eprintln!("MCP server exited with error: {e}");
            std::process::exit(1);
        }
    } else {
        oppa_lib::run();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_workspace_arg_flags() {
        let args = vec![
            "oppa".into(),
            "--mcp".into(),
            "--workspace".into(),
            "/path/to/project".into(),
        ];
        assert_eq!(
            parse_workspace_arg(&args),
            Some(PathBuf::from("/path/to/project"))
        );

        let args_short = vec![
            "oppa".into(),
            "mcp".into(),
            "-w".into(),
            "/path/to/project".into(),
        ];
        assert_eq!(
            parse_workspace_arg(&args_short),
            Some(PathBuf::from("/path/to/project"))
        );

        let args_eq = vec!["oppa".into(), "--workspace=/path/to/project".into()];
        assert_eq!(
            parse_workspace_arg(&args_eq),
            Some(PathBuf::from("/path/to/project"))
        );

        let args_short_eq = vec!["oppa".into(), "-w=/path/to/project".into()];
        assert_eq!(
            parse_workspace_arg(&args_short_eq),
            Some(PathBuf::from("/path/to/project"))
        );

        let args_none = vec!["oppa".into(), "--mcp".into()];
        assert_eq!(parse_workspace_arg(&args_none), None);

        let args_trailing_flag = vec!["oppa".into(), "--workspace".into()];
        assert_eq!(parse_workspace_arg(&args_trailing_flag), None);
    }
}
