# Cold Boot Agent Resume Specification: Relaunching CLI Agents Across Machine Restarts

## 1. Overview & Goal

`2026-08-19-cold-session-restore` already replays scrollback and reseats fresh shells in saved cwds after a PC shutdown. What it cannot do is bring back a **running agent CLI** — after a cold boot the pane shows a fresh PowerShell prompt where `claude`, `codex`, or `agy` used to be running, and the user must manually relaunch and resume.

This spec adds **Cold Boot Agent Resume**, following the same mechanism Orca uses (`pty-connection-cold-restore-agent-resume`, MIT — we borrow the design, never code):

1. While an agent runs in a pane, OPPA tracks **which program** is in the foreground and (for known agents) its **provider session id**.
2. That identity is checkpointed to disk continuously by the daemon.
3. After a cold boot, when `create_or_attach` finds no live session but finds a checkpoint whose foreground command matches a known agent, the fresh shell spawns **with the agent's native resume command injected at spawn time** (never typed via `sendInput`).
4. Scrollback replay paints on top, so the pane *looks* continuous. A header badge states exactly what happened.

**Honest limits**: no process survives power loss; output in the final seconds before a hard cut may be missing (bounded by checkpoint cadence); agents needing interactive auth will show their own login prompt.

---

## 2. Mechanism Fidelity vs Orca

| Mechanism | Orca | OPPA |
|---|---|---|
| Resume command passed at spawn/connect time, never `sendInput` | `command: "codex ... 'resume' '<id>'"` on connect | `initial_command` on `CreateOrAttach` |
| Persisted per-pane agent record consumed after restart | `sleepingAgentSessionsByPaneKey` quit-captured record | `SessionSnapshot` agent fields + layout `lastCommand` |
| Session id sourced from agent's own transcripts | `transcriptPath: ~/.codex/sessions/...rollout.jsonl` | Same dir patterns, scanned at command end |
| Decline unverifiable resume → fresh start | `agentResumeUnavailable` | Same fallback state |
| Foreground-command tracking | Not needed — Orca launches agents itself | **Adaptation**: OSC 133;C cmdline capture, because OPPA users type commands themselves |
| Power-cut durability | Quit-time persistence | **Addition**: daemon-side debounced checkpoints (~3 s idle) |

---

## 3. Technical Specifications

### 3.1 OSC 133 Command Capture (`osc_scanner.rs`, `powershell_bootstrap.rs`, `daemon_session.rs`)

- Bootstrap change: `PSConsoleHostReadLine` emits the command line with the C marker:
  `$Esc]133;C;$commandLine$Bel` (BEL-terminated; PSReadLine already has `$commandLine` in scope).
- Scanner change: return type becomes `OscEvent` enum instead of `Option<String>`:
  - `OscEvent::Cwd(String)` — OSC 7 / OSC 9;9 (existing logic, unchanged behavior)
  - `OscEvent::CommandStart(String)` — `133;C;<cmdline>` (empty cmdline tolerated → `CommandStart(String::new())`)
  - `OscEvent::CommandEnd` — `133;A/B/D` resets nothing on A/B; `D` clears foreground command.
- Chunk-boundary safety, BEL/ST terminators, 1024-byte overflow reset all carry over; the cmdline payload shares the same overflow budget.
- `DaemonSession` gains `foreground_command: Option<String>` (set on C, cleared on D) exposed to the server for checkpointing. Non-Windows shells: no emitter yet — field stays `None`, feature silently degrades (documented).

### 3.2 Daemon-Side Periodic Checkpoints (`snapshot.rs`, `daemon_session.rs`, `daemon_server.rs`)

- `SessionSnapshot` gains two optional fields (serde defaults keep old files loadable):
  - `foreground_command: Option<String>`
  - `agent_session: Option<AgentSessionRef>` — `{ agent: String, id: String, transcript_path: Option<String> }`
- New debounced writer task per live session: ~3 s after last PTY output, write `save_snapshot()` with `ScreenMirror::get_formatted_snapshot()` + cwd + title + cols/rows + foreground state. Skip if nothing changed since last write.
- On daemon `Shutdown`: flush every session synchronously before draining the registry (best-effort, bounded).
- Existing `.bin` frontend path stays as-is; the structured JSON becomes authoritative for cold restore when present.

### 3.3 Cold-Restore Resume Flow (`ipc_protocol.rs`, `daemon_server.rs`, `daemon_session.rs`, `commands.rs`, `shell_args.rs`)

1. `CreateOrAttachResult` gains:
   - `resume: Option<ResumePlan>` where `ResumePlan { command_line: String, kind: ResumeKind }`, `ResumeKind::{AgentResume, CommandRelaunch}`
   - `resume_declined_reason: Option<String>` (mirrors Orca's `agentResumeUnavailable`)
2. Server logic when session not in memory and snapshot exists:
   - If `agent_session` present and registry can build a resume command → `AgentResume`.
   - Else if `foreground_command` present AND its program matches the known-agent allowlist → `CommandRelaunch` (plain re-execution).
   - Else → `None`; today's scrollback-only restore.
3. Spawn options gain `initial_command: Option<String>`. When set, the session's reader loop watches for the shell-ready marker — the bootstrap emits a dedicated `OSC 633;oppa-ready` once after prompt-hook installation — then writes `<command>\r` into the PTY exactly once. Guarded by a `initial_command_written` flag; never re-fires on resize/reconnect.
4. `commands.rs` surfaces `resume`/`resume_declined_reason` in `PtySpawnResultPayload`.

### 3.4 Agent Registry (`src-tauri/src/pty/agent_resume.rs` — new file)

```rust
pub struct AgentProfile {
    pub name: &'static str,              // "claude", "codex", "agy", ...
    pub program_match: fn(&str) -> bool, // basename of first token, ext-tolerant (.exe/.cmd/.ps1)
    pub transcript_dir: fn(&Path /*cwd*/, &Path /*home*/) -> Option<PathBuf>,
    pub build_resume: fn(&AgentSessionRef, &str /*cwd*/) -> Option<String>, // None => plain relaunch
}
```

- Initial profiles: Claude Code (`~/.claude/projects/<cwd-slug>/*.jsonl`, newest mtime wins → `claude --resume <id>`), Codex (`~/.codex/sessions/**/rollout-*.jsonl` → `codex resume <id>`), Gemini, Aider, Antigravity/agy (flags verified against the installed binary's `--help` during implementation; unknown → plain relaunch).
- Session-id capture: on `OscEvent::CommandEnd`, if the ended command matched a profile, scan its transcript dir filtered by cwd recency and populate `agent_session`. Best-effort; failure just leaves `agent_session = None`.
- Allowlist policy (user decision): ONLY known-agent programs auto-relaunch. Arbitrary foreground commands (`npm run dev`, vim, ssh) are never re-executed.

### 3.5 Frontend (`terminalStore.ts`, `transport.ts`, `TerminalPane.tsx`, `TerminalPaneHeader.tsx`, settings)

- `spawnSession` stores `res.resume` in the session record; passes nothing extra to Rust (server injects on its own).
- Badge variants extend the existing `isRestored` banner:
  - `● Agent resumed` (green tint) — `kind === "agent-resume"`
  - `● Command relaunched` (amber) — `kind === "command-relaunch"`
  - `● Session restored` (existing amber) — scrollback-only
- Dismissal semantics unchanged (first user input fades out).
- Setting `terminal.autoResumeAgents: boolean` (default `true`) gates whether the renderer requests resume at all; when `false`, `pty_spawn` callers pass a flag that suppresses `initial_command` server-side. Lives in General Settings under Terminal.
- `layout.json` sessions also persist `lastCommand` as a secondary source when the structured snapshot is missing/corrupt.

---

## 4. Design & Aesthetics

Follows the established restored-badge language from `2026-08-19` (11px, 500 weight, pulsing dot, subtle border). Green variant: dot/text `#34d399`, bg `rgba(52, 211, 153, 0.1)`, border `rgba(52, 211, 153, 0.25)`.

---

## 5. Verification & Test Plan (TDD)

**Rust unit tests** (`cargo test -p oppa --lib`):
- `osc_scanner`: parses `133;C;cmdline` incl. chunked boundaries, ST terminator, overflow recovery; `133;D` clears; A/B/C ordering; empty cmdline tolerated.
- `powershell_bootstrap`: encoded script contains cmdline emission.
- `snapshot`: round-trip with `foreground_command` + `agent_session`; old JSON without new fields still loads.
- `agent_resume`: program matching (`.exe`/bare), transcript-dir newest-file selection, resume-command builders, unknown-agent → `None`.
- Integration (`daemon_integration_test`): feed OSC stream → checkpoint appears within debounce window → simulate cold restart (new server, same storage dir) → `create_or_attach` returns `ResumePlan` → `initial_command` written once after ready marker.

**Renderer tests** (`pnpm vitest run`):
- `terminalStore`: resume plan stored; setting-off path suppresses.
- `TerminalPane/Header`: three banner variants render and dismiss.

**Gates**: `cargo test -p oppa --lib && cargo test -p oppa --test daemon_integration_test && pnpm vitest run && pnpm build && cargo check` — all green before commit. Conventional commits per task; ledger updated in `.superpowers/sdd/`.
