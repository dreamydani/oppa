// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let is_daemon = args.iter().any(|arg| arg == "--daemon");

    if is_daemon {
        oppa_lib::run_daemon();
    } else {
        oppa_lib::run();
    }
}
