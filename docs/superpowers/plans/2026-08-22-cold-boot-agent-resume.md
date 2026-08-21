# Plan: Cold Boot Agent Resume (2026-08-22)

Spec: `docs/superpowers/specs/2026-08-22-cold-boot-agent-resume-design.md`
Prior art (design only): Orca `pty-connection-cold-restore-agent-resume`.

## Tasks

### Task 1 — OscEvent enum + OSC 133;C/D parsing
- `osc_scanner.rs`: `scan()` returns `Vec<OscEvent>` (`Cwd`, `CommandStart(cmdline)`, `CommandEnd`). Chunked/BEL/ST/overflow semantics preserved. Update sole caller `daemon_session.rs`.
- Tests: cmdline capture incl. chunk boundaries, ST terminator, overflow recovery, empty cmdline, D-clears.

### Task 2 — Bootstrap emits command line
- `powershell_bootstrap.rs`: PSConsoleHostReadLine hook emits `$Esc]133;C;$commandLine$Bel`; add one-shot ready marker `ESC]633;oppa-ready BEL` emitted once after hooks install.
- Tests: generated text contains cmdline emission + ready marker exactly once.

### Task 3 — DaemonSession foreground tracking + initial_command injection
- `daemon_session.rs`: new `foreground_command: Arc<Mutex<Option<String>>>` (set on CommandStart, cleared on CommandEnd); reader thread consumes `Vec<OscEvent>`.
- New spawn option `initial_command: Option<String>`: reader watches for ready marker, writes `<cmd>\r` once (`AtomicBool` guard). Never re-fires.
- Accessor `foreground_command()`.
- Tests: unit-testable pieces via existing spawn harness (sh.exe): feed OSC via echo, assert tracking; injection writes once.

### Task 4 — SessionSnapshot extension + periodic checkpoints
- `snapshot.rs`: `foreground_command: Option<String>`, `agent_session: Option<AgentSessionRef>` with `#[serde(default)]`; old JSON still loads.
- `daemon_server.rs`: per-session debounced (~3 s idle) checkpoint task using ScreenMirror snapshot + cwd/title/dims + foreground state; skip unchanged writes; flush all on Shutdown before draining.
- Tests: round-trip with new fields; backward compat; debounce behavior (integration-style with temp storage).

### Task 5 — Agent registry (`src-tauri/src/pty/agent_resume.rs`)
- `AgentProfile { name, program_match, transcript_dir(cwd, home), build_resume(session_ref, cwd) }`.
- Profiles: claude (`~/.claude/projects/<cwd-slug>/*.jsonl` → `claude --resume <id>`), codex (`~/.codex/sessions/**/rollout-*.jsonl` → `codex resume <id>`), gemini, aider, agy (verify flags from installed binary during impl; unknown → None).
- Helpers: `match_program(cmd) -> Option<&Profile>`, `find_newest_transcript(dir) -> Option<(id, path)>`, `plan_resume(...) -> Option<String>`.
- Tests: temp-dir transcript fixtures, ext-tolerant matching (.exe/.cmd/.ps1), newest-mtime selection.

### Task 6 — Cold-restore resume flow (IPC + server + commands)
- `ipc_protocol.rs`: `CreateOrAttachResult { resume: Option<ResumePlan>, resume_declined_reason: Option<String> }`; `ResumePlan { command_line, kind: AgentResume|CommandRelaunch }`; `CreateOrAttach { resume_agents: bool }`.
- `daemon_server.rs`: cold path loads structured snapshot → build plan (agent_session first, else allowlisted foreground_command) → if `resume_agents`, set session `initial_command`. Warm path unaffected.
- `manager.rs` / `daemon_client.rs`: pass-through flag; `commands.rs`: payload fields.
- Bump `DAEMON_PROTOCOL_VERSION` to 2.
- Tests: integration — seed storage dir → create_or_attach on dead id → expect ResumePlan + command written post-ready-marker.

### Task 7 — Frontend wiring
- `transport.ts` + `commands.rs` payload types; `terminalStore.ts`: store resume kind, pass `resumeAgents` setting, persist `lastCommand` per leaf in layout.json.
- `TerminalPaneHeader.tsx`: badge variants — green `● Agent resumed`, amber `● Command relaunched`, amber `● Session restored` (existing).
- Settings toggle `terminal.autoResumeAgents` (default true) in General Settings.
- Vitest: banner variants render/dismiss; store stores plan; setting-off suppression.

### Task 8 — Final review & gates
- Full gates: `cargo test -p oppa --lib && cargo test -p oppa --test daemon_integration_test && pnpm vitest run && pnpm build && cargo check`.
- Broad review vs spec; ledger closure.

## Rules
- TDD per task; conventional commits; concise WHY-only comments.
- Never drop terminal output; backpressure untouched except where noted.
