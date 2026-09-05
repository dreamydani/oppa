// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match oppa_lib::launch_mode::resolve_mode(&args) {
        oppa_lib::launch_mode::LaunchMode::Daemon => oppa_lib::run_daemon(),
        oppa_lib::launch_mode::LaunchMode::Gui => oppa_lib::run(),
        // The MCP server was removed: a stale external config (e.g. opencode's
        // `mcp.oppa` entry) spawning `oppa --mcp` must fail loudly on stderr,
        // never open the GUI window.
        oppa_lib::launch_mode::LaunchMode::RefusedMcp => {
            eprintln!("error: `oppa --mcp` is no longer supported (built-in MCP server removed)");
            eprintln!("remove the stale `mcp.oppa` entry from the spawning config (e.g. ~/.config/opencode/opencode.json)");
            std::process::exit(1);
        }
    }
}
