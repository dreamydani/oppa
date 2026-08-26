# Parallel Agent Fleets — Design Spec

Date: 2026-08-26
Branch: `feat/parallel-agent-fleets`
Status: APPROVED (user decisions recorded below)
Companion plan: `docs/superpowers/plans/2026-08-26-parallel-agent-fleets.md`

## Problem

Running multiple AI coding agents in parallel requires manually creating one
worktree at a time from the left sidebar. Beta users report the flow as
friction-heavy and complain about "not delivered / incomplete work" — they
cannot tell what any agent is doing or whether it finished. There is also no
guided finish path: the codebase has no merge-back operation and nothing
reacts when an agent completes.

## Approved user decisions

1. **Spawn trigger**: explicit **Fleet Spawn** sheet + a split-button popover
   offering "Same directory" vs "New branch…" on mouse splits. Keyboard splits
   stay instant plain splits.
2. **Layout**: one tab per agent (existing `createTab` behavior).
3. **Finish**: PR-first chain; guarded local merge as secondary action.
4. **Naming**: deterministic prompt-slug branches (`fix-login-timeout`,
   `-2`, `-3`…). No AI renaming.

## Prior art studied

Orca (`C:\github-repo\orca`) — architecture ideas only, zero code copied:
hook-driven agent status, creationId progress surfaces, retired-name registry,
PR-centric finish. Their weaknesses we avoid: no desktop fan-out UI, fragile
AI branch renaming, title-scraping heuristics, PR-only finish.

OPPA assets reused as-is: single-agent handoff (`agent_handoff.rs`), agent
catalog (15 profiles), worktree registry/lineage/tombstones, OSC-133 +
TuiIdle machinery, PR eligibility/create/link-stamp, push with poll burst.

## Feature design

### M1 — Parallel spawn + visibility

**F1. Fleet spawn backend.**
`DaemonRequest::WorktreeCreateFleet { repo_path, base_ref?, shared_prompt?,
slots: Vec<FleetSlot> }` where `FleetSlot { name?, agent?, command?, prompt? }`
(per-slot fields override shared). Sequential internal spawn reusing
`create_worktree_with_agent`; per-slot isolation: a slot failing
(unknown agent, missing binary, name clash) records an error and never aborts
the fleet. Response `{ results: Vec<FleetSlotResult> }` with
`FleetSlotResult { index, ok, record?, session_id?, error? }`. One
`WorktreeChanged` publish after the fleet lands.

**F2. Prompt-slug naming.** New `worktree_naming::slug_from_prompt(text)`
→ lowercase kebab slug, ≤40 chars, stripped trailing separators. Uniqueness
against registry names including retired tombstones by numeric suffix
(`fix-login-timeout`, `-2`, `-3`). Explicit slot `name` wins when given.

**F3. Seeded titles.** The pane title is set to the slot's final name at
spawn time so headers/dropdowns are meaningful immediately.

**F4. Fleet Spawn Sheet** (left sidebar, Worktrees view button): repo select,
base ref, shared prompt textarea, slot rows (agent picker each, optional
per-slot prompt/name), confirm summary ("N × claude …" + prompt excerpt) —
fleet launches only after explicit confirm. Per-row live progress
(pending → spawning → spawned/error), results open one tab per agent.

**F5. Header terminal dropdown.** `TerminalPaneHeader` gains project-title ▾
opening a list of all tabs' sessions: seeded/extracted title, **branch chip**
(joined via `session.worktreeId → registry.branch`, pure frontend), working/
idle dot, agent icon when bound. Click switches tab.

**F6. Live agent dots.** Daemon exposes per-session working/idle derived from
existing OSC-133 state (foreground command active = working; prompt-end +
quiet past threshold = idle) — piggybacks on TuiIdle logic; surfaced through
the existing event stream to header/sidebar without new polling.

**F7. Sidebar cards.** Worktree cards list linked terminal titles (local join
on persisted `session.worktreeId`), agent chip, and the same dot.

**F8. Split chooser popover.** Mouse split buttons show two options:
Same directory (today) / New branch… (opens fleet sheet prefilled with that
pane's repo/base, count=1). Keyboard shortcuts unchanged.

### M2 — Finish flow

**F9. Finish chain** (card + header action): commit-all (tracked+untracked,
respecting gitignore) → push (publish if needed) → create review via existing
eligibility path → status auto-set `in-review`. Blocked reasons surface the
existing actionable messages; local merge offered as fallback when blocked.

**F10. Guarded local merge.** Pre-flight triple guard: main checkout clean,
main checkout already on `base_ref`, `git merge-tree --write-tree` probe
clean. Any failure blocks with a plain-language reason (no branch switching,
ever). On pass: squash or merge-commit into base from the main checkout,
report merged summary, offer worktree cleanup (remove + delete branch —
branch deletion stays guarded by the existing merged-only safety).

**F11. Completion wiring.** Idle-after-prompt detection (F6) marks bound
cards "finished"; `pty:exit` remains merely "terminal closed". Optional
auto-status transition `in-progress → in-review` on finish (setting-gated,
default on).

## Non-goals (v1)

No SSH remotes, no kanban/board views, no orchestration DAGs, no cross-host
identity, no sparse checkouts, no setup-script policy engine.

## Risks / mitigations

- Merge mutating main checkout → F10 triple guard, hard-block otherwise.
- Fleet cost surprise → F4 confirm summary is mandatory before launch.
- Partial spawn failures → F1 per-slot isolation + visible per-row errors.
- Title heuristics drift → titles seeded deterministically (F3); extraction
  remains fallback only.
- Restart mid-fleet → sessions persist individually via existing layout save;
  no cohort atomicity promised across restarts.

## Testing strategy

Rust unit tests for slug naming, fleet request validation, per-slot failure
isolation, idle-state derivation; daemon integration test spawning a 2-slot
fleet over the pipe asserting both worktrees + sessions + one changed event.
Frontend vitest for sheet validation/confirm gating, dropdown join/dot
rendering, finish-chain sequencing with mocked transports, merge-guard
rejections. Existing suites must stay green throughout.
