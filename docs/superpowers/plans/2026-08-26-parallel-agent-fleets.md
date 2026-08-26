# Parallel Agent Fleets — Implementation Plan

Spec: `docs/superpowers/specs/2026-08-26-parallel-agent-fleets-design.md`
Branch: `feat/parallel-agent-fleets`
Ledger: `.superpowers/sdd/2026-08-26-parallel-agent-fleets/progress.md`

Execution: subagent-driven — fresh implementer per task, brief inlined in the
dispatch, review after each task, ledger row per commit. Implementers never
dispatch subagents.

## M1 — Parallel spawn + visibility

### T1 — Fleet backend (Rust) `M1-T1`
Files: `src-tauri/src/git/worktree_naming.rs`, `src-tauri/src/git/mod.rs` new
`fleet.rs`, `ipc_protocol.rs`, `request_router.rs`, `pty/commands.rs`,
`daemon_client.rs`.
- `slug_from_prompt(text) -> String` (+ unit tests: slugify rules, 40-char
  cap, trailing-separator strip).
- Name uniquing `next_available_name(base)` checking registry incl. retired.
- `WorktreeCreateFleet` request/response types; router handler loops slots
  through existing single-agent path with per-slot error capture; one
  WorktreeChanged publish at end.
- Tauri command `worktree_create_fleet` + DaemonClient method + TS transport
  `worktreeCreateFleet`.
Acceptance: unit tests green; daemon integration test spawns a 2-slot fleet
over the pipe asserting two worktrees, two sessions, one changed event,
partial-failure slot isolated.

### T2 — Working/idle state exposure (Rust→TS) `M1-T2`
Files: `daemon_session.rs`, `ipc_protocol.rs` (event variant or snapshot
field), `request_router.rs`, frontend transport types.
- Derive per-session working/idle from existing foreground/prompt-end state;
  emit on transitions (debounced) and include in attach snapshot.
Acceptance: integration test toggling idle via OSC-133 sequences sees the
transition event.

### T3 — Fleet Spawn Sheet UI `M1-T3`
Files: new `src/components/worktree/FleetSpawnSheet.tsx` + css + tests;
WorktreePane button; store slice action `spawnFleet`.
- Fields per spec F4; mandatory confirm summary; per-row progress states;
  opens one tab per successful slot.
Acceptance: vitest covers validation, confirm gating, partial-failure row
rendering, tab creation calls.

### T4 — Header dropdown `M1-T4`
Files: `TerminalPaneHeader.tsx` + css + tests.
- Project-title ▾ panel listing tabs/sessions: title, branch chip
  (`session.worktreeId → worktrees.branch`), agent icon, working/idle dot;
  click switches tab. Esc/click-out closes.
Acceptance: vitest for join correctness, dot rendering from state, switch.

### T5 — Sidebar card enrichment `M1-T5`
Files: `WorktreePane.tsx` + tests.
- Linked terminal titles list, agent chip, dot on cards.
Acceptance: vitest joins sessions→cards correctly.

### T6 — Split chooser popover `M1-T6`
Files: `TerminalPaneHeader.tsx` (split buttons), shared sheet prefill support.
- Mouse split buttons → popover Same directory / New branch… (sheet prefilled
  count=1); keyboard shortcuts unchanged.
Acceptance: vitest popover options + keyboard path unchanged.

## M2 — Finish flow

### T7 — Finish chain `M2-T1`
Files: store slice action `finishWorktree` sequencing existing stage/commit/
push/create-review/status transports; button on WorktreePane card +
header dropdown; blocked-reason surfacing.
Acceptance: vitest sequencing incl. blocked-reason fallback offer.

### T8 — Guarded local merge `M2-T2`
Files: `source_control.rs` new `sc_merge_to_base` (+ router/command/
transport), UI on card menu.
- Triple guard (clean / on-base / merge-tree probe) → squash|merge commit;
  conflicted-file report on probe failure.
Acceptance: rust tests for each guard rejection + clean squash; vitest for
blocked rendering.

### T9 — Completion wiring `M2-T3`
Files: consume T2 events in store → card "finished" badge + optional
auto-status setting (default on).
Acceptance: vitest badge/status transition on idle event.

## Rules

- Every task: failing tests first where feasible, implement, full relevant
  suites green, conventional commit, ledger row before next task.
- Never break existing suites; never copy Orca code.
- Stop conditions per AGENTS.md (irreversible ops, security, out-of-worktree,
  broken plan).
