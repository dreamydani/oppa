# Third-Party Notices

Oppa is free and open source under the MIT License (see `LICENSE`).

This project depends on the following third-party software. Full license texts are available in the respective upstream repositories and in `Cargo.lock` / `pnpm-lock.yaml` at the pinned versions below.

## Direct dependencies

| Package | Version (pinned) | Upstream | License |
| --- | --- | --- | --- |
| Tauri | 2.11.5 | https://github.com/tauri-apps/tauri | Apache-2.0 / MIT |
| portable-pty | 0.9.0 | https://github.com/wez/wezterm (portable-pty crate) | MIT |
| vt100 | 0.15.2 | https://github.com/hackaugusto/vt100-rust | MIT |
| Tokio | 1.x | https://github.com/tokio-rs/tokio | MIT |
| React | 19.2.8 | https://github.com/facebook/react | MIT |
| xterm.js (`@xterm/xterm`) | 6.0.0 | https://github.com/xtermjs/xterm.js | MIT |
| Monaco Editor | 0.56.0 | https://github.com/microsoft/monaco-editor | MIT |

Transitive dependencies are pinned in `src-tauri/Cargo.lock` and `pnpm-lock.yaml`. To regenerate this list, inspect those lockfiles for the exact resolved versions.
