# Plan — Orca Parity M1: Worktrees + CLI + Agent Handoff

Spec: docs/superpowers/specs/2026-08-23-orca-parity-m1-design.md
Workflow: subagent-driven development — fresh implementer per task, controller review after each, ledger at .superpowers/sdd/2026-08-23-orca-parity-m1/progress.md. TDD: failing test first, then implementation.

## Task 0 — Docs + attribution
Files: THIRD-PARTY-NOTICES (copy of orca MIT notice), this spec+plan+ledger.
Commit: `docs: orca parity M1 spec, plan, ledger, MIT attribution`

## Task 1 — Worktree naming module
New file `src-tauri/src/git/worktree_naming.rs` (+ wire into git module).
Port algorithms from orca worktree-logic.ts / branch-prefix.ts / worktree-branch-name.ts:
sanitize_name, normalize_branch_prefix, branch_prefix_issue, compute_branch_name,
compute_validated_branch_name, should_set_display_name, sanitize_display_name,
compute_worktree_path, ensure_path_within_workspace.
Tests first (port cases from orca worktree-logic.test.ts): traversal names (`../..`),
`..` collapse, emoji-only fallback `workspace`, unicode preservation (CJK/accented),
prefix double-slash normalization, `.lock` segment rejection, trailing-dot rejection.
Commit: `feat(git): worktree naming module ported from orca`

## Task 2 — Worktree engine ops
New files `src-tauri/src/git/worktree_registry.rs` (RepoRecord/WorktreeRecord store,
atomic persistence), `src-tauri/src/git/worktrees.rs` (add/list/show/set/remove/current
against real git via argv arrays; push.autoSetupRemote probe+set; merged-only branch
deletion). Tests use real temp repos (git init + commit) in daemon_integration_test style.
Commit: `feat(git): worktree engine with registry persistence`

## Task 3 — Lineage, retirement/trash, teardown proof
Extend registry: parent/child lineage updates, retirement tombstones w/ name reservation,
purge. Teardown gate queries daemon session registry (cwd/worktree_id match) and refuses
removal listing live session ids. ensure_path_within_workspace enforced on all paths.
Tests: removal blocked by live session, retired-name reuse blocked until purge,
branch preserved when unmerged, force-delete-branch CAS flag.
Commit: `feat(git): lineage, retirement tombstones, teardown proof`

## Task 4 — IPC v3 + runtime metadata file
ipc_protocol.rs: bump protocol to 3, add request/response variants per spec, Hello gains
optional auth_token (back-compat: absent token accepted when no metadata file expected —
daemon enforces only after it starts writing tokens). daemon_server.rs handles new
variants by delegating to engine; writes appDataDir/oppa-runtime.json on start, removes
on shutdown; broadcast DaemonEvent::WorktreeChanged. Integration tests: create→list→show
over pipe, stale metadata detection.
Commit: `feat(daemon): IPC v3 worktree surface + runtime discovery file`

## Task 5 — Pane↔worktree env binding
daemon_session.rs spawn env gains OPPA_WORKTREE_ID/BRANCH/PATH, OPPA_TAB_ID;
CreateOrAttach carries optional worktree_id + extra env pairs. Snapshot records
worktree binding for warm reattach continuity. Unit test asserts env map contents.
Commit: `feat(pty): bind panes to worktrees via injected env`

## Task 6 — Sidebar worktree cards UI
src/lib/pty/transport.ts additions (worktreeList/Create/Set/Remove through DaemonClient);
terminalStore slice worktrees; LeftSidebar Worktrees view with cards + create dialog +
status chips + remove flow (shows teardown-refusal reason). Vitest with mocked transport.
Commit: `feat(ui): worktree workspace cards and creation dialog`

## Task 7 — CLI skeleton
Cargo bin target `oppa-cli` (clap). Discovery reads oppa-runtime.json → TCP-less connect
via existing pipe path logic (reuse get_daemon_socket_path + auth token) → Hello →
request/response with --json envelopes, exit codes 0/1, --timeout-ms default 10s,
runtime_unavailable error shape. Integration test spawns daemon binary headless and
runs `oppa-cli status`.
Commit: `feat(cli): oppa-cli bin with runtime discovery and authed connect`

## Task 8 — repo + worktree verbs
Handlers wiring CLI args to IPC v3 requests; vocabulary policy module (rm aliases,
show reads); human + --json output formatters; `worktree ps` composes ListSessions +
registry. Round-trip integration tests per verb incl. error paths (invalid name,
teardown refusal).
Commit: `feat(cli): repo and worktree command families`

## Task 9 — terminal verbs + daemon read/wait additions
Daemon: ReadScreen dumps ScreenMirror as rendered text (vt100 parser state → plain text
with colors optional off by default); WaitFor long-poll with keepalive frames on the
pipe (existing pattern from hook server heartbeat), cond=exit uses exit events,
cond=tui-idle = OSC133-D marker followed by ≥800ms output silence. CLI verbs:
list/show/read(--screen)/send(--enter|--interrupt)/wait/create/close/switch/rename/split
(split reuses pane split semantics server-side minimal: two sessions same cwd).
Integration tests cover wait-for-exit and screen text fidelity.
Commit: `feat(cli): terminal verbs with screen read and idle wait`

## Task 10 — agent-context self-description
Generate spec table from clap definitions at runtime (command, flags, examples, notes),
emit JSON + pretty text. Test asserts every registered verb appears and JSON parses.
Commit: `feat(cli): agent-context machine-readable command catalog`

## Task 11 — Agent launch catalog
`src-tauri/src/agents/catalog.rs`: profiles per spec list (claude, codex, gemini, qwen,
opencode, grok, cursor-agent, aider, amp, droid, copilot, goose, kimi, antigravity,
generic). Each: command resolution (PATH lookup), default args, env, prompt delivery
mode arg|stdin|paste_on_ready. Table-driven tests validate resolution + arg building.
Commit: `feat(agents): launch catalog with prompt delivery modes`

## Task 12 — Worktree-create-with-agent handoff
Wire WorktreeCreate{agent,prompt} end-to-end: engine create → CreateOrAttach(cwd=
worktree.path, env bound) → ready-marker wait → deliver prompt per mode → managed hook
install best-effort → return AgentHandoff{record, session_id, agent_terminal_handle}.
CLI prints handle; UI dialog flows through same RPC. Integration test: fake agent script
as PATH command receives prompt, exits cleanly; handle round-trips.
Commit: `feat(handoff): worktree create --agent spawns coding agent with prompt`
