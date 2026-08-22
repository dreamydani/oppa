# Orca Parity Milestone 1 — Worktrees + CLI + Agent Handoff

Date: 2026-08-23
Status: Approved (user selected Phases 1–3 bundle, Rust bin target CLI, full verb parity)

## Summary

Port the core of Orca's parallel-agentic-development model into OPPA: a git-worktree
workspace engine (each agent gets a private checkout + branch so parallel agents never
contradict each other), an agent-facing `oppa` CLI that drives the running daemon, and the
worktree-create-with-agent handoff flow. Design ideas and algorithms are adapted from
stablyai/orca (MIT, © Lovecast Inc. — attribution preserved in THIRD-PARTY-NOTICES).
No code is copied verbatim across languages; algorithms and UX are ported.

## Goals

1. `oppa worktree create --agent codex --prompt "..."` produces a checkout on a fresh
   branch plus a terminal running the agent, returning an `agent_terminal_handle`.
2. Parallel agents own disjoint trees by construction (worktree-per-agent).
3. Every pane is bound to a worktree via injected env vars, enabling agentic self-identification.
4. The CLI speaks the same NDJSON named-pipe/UDS protocol as the GUI.

## Non-goals (deferred to later milestones)

SSH/WSL worktree mirroring, sparse checkout, symlink reconciliation, APFS clone,
hosted-PR merge-back, orchestration runtime, dashboard board UI, automations.
cardStatus field exists on records (settable/readable) but no kanban UI yet.

## Architecture

**Daemon-as-runtime** (Orca's key insight, matches ours): the headless daemon owns all
state — PTY sessions, worktree registry, repo registry. Both clients (GUI process,
`oppa` CLI) are peers speaking `DaemonRequest/DaemonResponse` NDJSON over the existing
named pipe / UDS. The daemon persists registries under `appDataDir`.

### Data model

```
RepoRecord      { repo_id: String (slug of path), path: PathBuf, default_base_ref: Option<String>,
                  worktree_base_path: Option<String> }
WorktreeRecord  { id: String ("<repo_id>::<path>"), repo_id: String, name: String,
                  display_name: Option<String>, branch: String, path: PathBuf,
                  base_ref: String, parent_worktree_id: Option<String>,
                  child_worktree_ids: Vec<String>, workspace_status: String
                  ("todo"|"in-progress"|"in-review"|"completed"),
                  retired: bool, created_at_ms: u64, linked_pr_url: Option<String> }
```

Persisted: `appDataDir/worktrees.json` (atomic write, temp+rename), repos registered
on demand from create flows (`appDataDir/repos.json`).

Settings additions (`settings.json`): `workspace_dir` (default `<appDataDir>/workspaces`),
`nest_workspaces: bool` (default false), `branch_prefix: "git-username"|"custom"|"none"`
(default none for v1; git-username resolution deferred), `branch_prefix_custom: String`.

## Naming rules (ported from orca `worktree-logic.ts` / `branch-prefix.ts`)

- `sanitize_name(input)`: trim → replace any run of chars outside Unicode letters,
  numbers, `.`, `_`, `-` with a single `-` → collapse repeated `-` → collapse `..` to `.`
  → trim leading/trailing `.`/`-`. Empty result ⇒ error `Invalid worktree name`.
  (Emoji→shortcode catalog deferred; emoji-only names fall back to `workspace`.)
- Branch prefix normalization: trim surrounding whitespace and `/`; collapse internal
  `//` runs. Validation mirrors `git check-ref-format`: reject control chars/spaces,
  `~^:?*[\`, `..`, `@{`, leading `-`, trailing `.`, any `/`-segment starting `.` or
  ending `.lock`. Invalid custom prefix ⇒ loud error; (future git-username strategy
  degrades to unprefixed rather than blocking).
- Branch name: `{prefix}/{sanitized}` when a prefix resolves, else `sanitized`.
- Display name persisted only when it differs from both requested name and branch leaf.

## Path layout

`computeWorktreePath(sanitized, repo_path, settings)` =
`join(workspace_root, [repoName/,] sanitized)` where `repoName` = basename of repo path
minus `.git` suffix, included iff `nest_workspaces`. `workspace_root` = absolute setting,
or resolved relative to repo path. Windows paths use win32 semantics (native PathBuf).

## Git operations contract (shell out to `git`, matching existing git.rs pattern)

- **add**: `git worktree add --no-track -b <branch> <path> [<base>]` (base defaults to
  repo HEAD). On success probe `git config --get push.autoSetupRemote`; if unset, set
  `git config --local push.autoSetupRemote true` (failure ⇒ warn, never block create).
- **list**: `git worktree list --porcelain` parsed into records; union with registry.
- **remove**: preflight (no live sessions bound — see teardown), `git worktree remove
  [--force] <path>`, prune, then branch deletion ONLY if fully merged into its base
  (`git branch --merged <base>` contains branch); otherwise preserve branch + warning;
  explicit force-branch-delete is a separate CAS-flagged call.
- **current**: resolve cwd → longest matching registered worktree path.

## Teardown proof (the safety rule we port)

Before any directory deletion: every session whose `cwd` or bound `worktree_id` maps to
that worktree must be dead in the daemon registry (GUI graph + daemon sessions). If any
live session remains ⇒ refuse removal with the blocking session ids. Registry record
moves to `retired: true` tombstone first; name reservation prevents reuse while a
retired tombstone holds the name (reuse allowed after purge).

## IPC v3 (protocol_version bumps 2 → 3)

New `DaemonRequest` variants (tag/type style unchanged):

```
WorktreeList | WorktreeShow { id } | WorktreeCurrent { cwd }
WorktreeCreate { repo_path, name?, branch?, base_ref?, agent?, prompt?,
                 parent_worktree_id?, activate? }
WorktreeSet   { id, parent_worktree_id?, clear_parent?, workspace_status?, display_name? }
WorktreeRemove{ id, force?, delete_branch? }
WorktreePurge { id }   // clears retired tombstone
WorktreePs    {}       // per-worktree live-session summary + last screen preview line
RepoAdd { path } | RepoList
ReadScreen { session_id }                    // rendered text from ScreenMirror
WaitFor    { session_id, cond: "exit"|"tui-idle", timeout_ms }
Hello gains auth_token field (see metadata file)
CreateOrAttach gains optional worktree_id + env: Vec<(String,String)>
```

Responses reuse `Ok/Error` plus typed payloads (`WorktreeRecords(Vec<WorktreeRecord>)`,
`ScreenText(String)`, `WaitResult{ satisfied: bool, exit_code: Option<i32> }`,
`AgentHandoff(WorktreeCreateResult{ record, session_id, agent_terminal_handle })`).
Older clients keep working: unknown variants already fail closed per-client; bump
version and have daemon negotiate min(v2, v3) behavior per Hello.

## Runtime discovery file (ports orca runtime-bootstrap pattern)

Daemon writes `appDataDir/oppa-runtime.json` on start (and removes on shutdown):
`{ pid, pipe_path, auth_token (random 32B hex, chmod-scoped file), protocol_version,
started_at_ms }`. GUI and CLI read it instead of guessing pipe names; token required
in Hello. Stale file (dead pid) ⇒ spawner logic already restarts daemon, then rewrites.

## Env injection contract (per spawned pane)

When a session is bound to a worktree, spawn env gains:
`OPPA_PANE_KEY=<session_id>`, `OPPA_TAB_ID=<tab/session group id>`,
`OPPA_WORKTREE_ID=<id>`, `OPPA_WORKTREE_BRANCH=<branch>`, `OPPA_WORKTREE_PATH=<path>`,
plus `ORCA_TERMINAL_HANDLE` alias omitted deliberately — agents inside oppa read OPPA_*.
Existing `OPPA_PANE_KEY`/hook vars stay authoritative for hooks; dedupe on collision.

## CLI surface (`oppa` bin target, clap, full verb parity with orca where listed)

Global flags: `--json`, `--timeout-ms`. Exit codes: 0 ok, 1 error, 75 = ask/resume-required
(reserved). Discovery: read `oppa-runtime.json` → connect → Hello(token) → request.
If daemon absent: `open` spawns it; everything else errors `runtime_unavailable`.

```
oppa status                     # daemon reachable, protocol version, counts
oppa repo list|add|show
oppa worktree list|show|current|create|set|rm|ps
oppa terminal list|show|read [--screen]|send --text [--enter|--interrupt]
        |wait --for exit|tui-idle --timeout-ms|create|close|switch|rename|split
oppa agent-context              # serialized spec table of every verb/flag
```

Vocabulary policy (ported): destructive verbs are `rm` (+aliases delete/remove);
single-item reads are `show`; lists are `<noun> list`. `agent-context` output is
generated from the same clap definitions so docs cannot drift from binary.

## Agent catalog + handoff (ports tui-agent-config subset, ~30 entries)

Rust module `agents/catalog.rs`: static table of agent profiles
(id, display name, command, default args, env overrides, prompt_delivery: arg|stdin|paste_on_ready).
M1 ships: claude, codex, gemini, qwen, opencode, grok, cursor-agent, aider, amp, droid,
copilot, goose, kimi, antigravity + generic `--command` passthrough.
Handoff flow: validate/create worktree → CreateOrAttach(cwd=worktree.path,
worktree_id, env) → wait ready-marker (existing 15s machinery) → deliver prompt per
delivery mode → return handle. Managed hook installers run best-effort on spawn.

## UI changes (renderer)

LeftSidebar gains a Worktrees view: cards (name, branch chip, status chip, live dot),
create dialog (repo picker, name, base ref, agent dropdown, prompt textarea, parent
picker), context actions (open terminal here, rename, set status, remove). Cards bind
to daemon records via DaemonClient events (`worktree_changed` broadcast event added).

## Testing strategy

TDD per AGENTS.md. Rust unit tests for naming/sanitize/validation (port orca's
worktree-logic.test.ts cases). Integration tests in daemon_integration_test.rs:
registry persistence round-trip, create/remove lifecycle against real temp git repos,
teardown-refusal with live session, CLI↔daemon round-trip over real pipe. Vitest for
sidebar card rendering with mocked transport. Every task ends in a conventional commit.

## Security notes

Auth token file lives in user-scoped appDataDir; CLI refuses world-readable metadata on
unix (best-effort). No shell interpolation of user strings into git args — always argv
arrays. Removal paths validated to be inside workspace root (anti-traversal, ports
ensurePathWithinWorkspace).
