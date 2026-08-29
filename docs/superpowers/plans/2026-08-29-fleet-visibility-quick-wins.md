# Fleet Visibility Quick Wins — Implementation Plan

Spec: `docs/superpowers/specs/2026-08-29-fleet-visibility-quick-wins-design.md`
Branch: `fix/fleet-visibility-quick-wins`
Ledger: `.superpowers/sdd/2026-08-29-fleet-visibility-quick-wins/progress.md`

Execution: subagent-driven — fresh implementer per task, brief inlined in
the dispatch, review after each task, ledger row per commit. Implementers
never dispatch subagents.

### T1 — Finished-chip reactivity fix `T1`
Files: `src/components/worktree/WorktreePane.tsx`, `WorktreePane.test.tsx`.
- Failing test first: hook `done` transition with `workingBySessionId`
  unchanged must set the finished chip (and fire auto in-review).
- Fix memo: use subscribed `statusBySessionId`, add to deps.
Acceptance: new test red → green; existing WorktreePane suite green; tsc clean.

### T2 — StatusBar fleet aggregate `T2`
Files: `src/components/layout/StatusBar.tsx`, `StatusBar.test.tsx`,
`StatusBar.css`.
- Counts by state over live sessions from `statusBySessionId`; hidden when
  no live agent rows.
- Click → attention order blocked → waiting → working → done; jumps to that
  session's tab via findLeafPath/selectTab/markAgentStatusSeen.
Acceptance: vitest counts, ordering, hidden-when-empty; tsc clean.

### T3 — Open fleet grid button `T3`
Files: `src/components/worktree/FleetSpawnSheet.tsx`, `FleetSpawnSheet.test.tsx`.
- Done phase action calls `tileProjectBranches(repoId, okWorktreeIds)`,
  closes sheet; inline error if it throws.
Acceptance: vitest args (repoId + only ok slot ids), close-on-success,
error path renders; tsc clean.

### T4 — Interrupt action on cards `T4`
Files: `src/components/worktree/WorktreePane.tsx`, `WorktreePane.test.tsx`.
- Stop button per linked live terminal row writes `\x03` via `ptyWrite`
  through a store action `interruptSession`; exited sessions disabled.
Acceptance: vitest writes once to live, refuses exited; tsc clean.

### T5 — Time-in-state on pills `T5`
Files: `src/components/agent/AgentStatusPill.tsx`, `.test.tsx`, `.css`,
new `src/components/agent/useElapsedTicker.ts` + test.
- Compact elapsed since `state_started_at_ms` (30s shared ticker hook);
  formats <60s "now-ish", m, h, d.
Acceptance: vitest formatting + refresh; tsc clean.

## Rules

- Every task: failing test first, implement, relevant suites green,
  conventional commit, ledger row before next task.
- Never break existing suites; never copy Orca code.
- No push at any point.
