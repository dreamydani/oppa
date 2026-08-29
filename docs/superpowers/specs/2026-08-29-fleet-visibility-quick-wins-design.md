# Fleet Visibility Quick Wins — Design Spec

Date: 2026-08-29
Branch: `fix/fleet-visibility-quick-wins`
Status: APPROVED (from the 2026-08-29 parallel-agents review)
Companion plan: `docs/superpowers/plans/2026-08-29-fleet-visibility-quick-wins.md`

## Problem

The parallel-agent fleet stack (M1+M2 merged) has one real bug and four
monitoring gaps found in the in-depth review:

1. **Bug**: the worktree "finished" chip memo reads `statusBySessionId` via
   `getState()` but its deps are `[worktrees, sessions, workingBySessionId]`.
   A hook `done` transition that doesn't move `workingBySessionId` never
   recomputes the memo, so the finished chip — and the auto `in-review` flip
   wired to it — can hang indefinitely.
2. Parallel monitoring requires watching the sidebar; the StatusBar shows
   only the active session.
3. After a fleet launches, watching all agents means manually tiling panes,
   even though `tileProjectBranches` already builds the grid.
4. A runaway/blocked agent can only be stopped by switching tabs and typing
   Ctrl+C into the terminal.
5. Status pills show state but not how long the agent has been in it — the
   single most useful signal for noticing a stalled agent.

## Feature design

### T1 — Finished-chip reactivity fix (bug)

`WorktreePane.tsx` `finishedByWorktreeId` memo: drop the `getState()` read,
use the component's already-subscribed `statusBySessionId` selector value,
and add it to the dependency array. Zero behavior change beyond the memo
becoming correct. Test-first: a hook `done` transition with
`workingBySessionId` unchanged must flip the chip.

### T2 — StatusBar fleet aggregate

StatusBar gains an agents cluster (only when live agent sessions exist):
`working N · blocked N · waiting N · done N`, each count joined from
`statusBySessionId` over live non-exited sessions. Click behavior:

- blocked/waiting exist → jump to the first attention session's tab
  (existing `openLinkedTerminal` pattern: find tab by `findLeafPath`,
  `selectTab`, `markAgentStatusSeen`)
- else → first working session's tab
- else → first done session's tab

No backend changes; pure frontend join. Exited sessions excluded.

### T3 — Open fleet grid button

FleetSpawnSheet done phase gains an "Open grid" action listing this fleet's
successful records: it calls `tileProjectBranches(repoId, worktreeIds)`
with the successful slots' worktree ids (the action already reuses live
sessions — no duplicate spawns), then closes the sheet. Errors surface
inline in the sheet (non-blocking; the fleet already landed).

### T4 — Interrupt action on cards

Worktree card linked-terminal rows gain a stop button next to the existing
send-target button: writes `\x03` (Ctrl+C) to the session via the existing
`ptyWrite` transport path (same primitive `sendPromptToSession` uses),
guarded to live sessions only. Confirmation is unnecessary — a single
Ctrl+C matches what a user would type; anything more is a kill via the
existing remove-flow.

### T5 — Time-in-state on pills

`AgentStatusPill` renders elapsed time since `state_started_at_ms` as a
compact suffix ("12m", "3h"). A 30s-interval shared ticker component
re-renders pills (one interval for the app, not one per pill). Tooltip
keeps the state description; title shows the full timestamp. Exited
sessions render no pill (unchanged).

## Non-goals

No daemon/protocol changes in this pass; no per-slot spawn streaming, no
`fleet_id`, no daemon-side finish chain, no diff stats, no notifications —
those are the next structural batch.

## Testing strategy

Vitest per task: T1 memo reactivity (hook done transition flips chip without
working-map change); T2 aggregate counts + click-to-attention ordering;
T3 grid action args + tab reuse; T4 writes `\x03` once to live sessions,
refuses exited; T5 formatting + ticker mount/unmount. Existing suites stay
green; tsc clean; no Rust changes so cargo runs once at the end as a
regression gate.
