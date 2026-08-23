# Plan — M2: Source Control + Diff Comments + M1.5 Polish

Spec: docs/superpowers/specs/2026-08-23-m2-source-control-design.md
Workflow: subagent-driven (fresh implementer per task, controller review, ledger at
.superpowers/sdd/2026-08-23-m2-source-control/). TDD: failing test first.

## Task 0 — Docs
Spec+plan+ledger committed on feat/m2-source-control.
Commit: `docs: m2 source control spec, plan, ledger`

## Task 1 — M1.5a session titles
ipc: SetSessionTitle request + TitleChanged event (+SessionFocusRequested). DaemonSession
title field + accessor; snapshot propagation; CLI rename real (strip controls, ≤80 chars,
Err when empty); switch validates + emits focus event; renderer listens → focuses tab;
vitest for listener. Unit+pipe tests.
Commit: `feat(pty): session title sync closes rename stub`

## Task 2 — M1.5b GUI agent picker
DaemonClient::create_worktree_with_agent passthrough + Tauri command worktree_create_agent;
WorktreeCreateModal agent dropdown from catalog list (new Tauri command agent_profiles or
static TS list mirrored — prefer command so single source) + prompt textarea; submit →
handoff → focus returned session_id via existing spawn/bind flow. Vitest modal flows.
Commit: `feat(ui): wire agent picker to handoff in create dialog`

## Task 3 — git service core ops
git/source_control.rs: area-aware status parse (porcelain v1 -z), stage/unstage/discard
(+bulk, confirm flag for untracked discard), commit (message validation), local_branches,
checkout (ref-name validation). Reuse run_git pattern from worktrees.rs. Temp-repo tests
incl. conflict-state fixture (merge two branches with collision).
Commit: `feat(git): staging commit checkout service layer`

## Task 4 — diffs history compare
Per-file diff returning content pairs (staged/unstaged; HEAD-compare flag), size cap +
truncated flag; history(limit) with numstat stats; branch_compare(base_ref). Tests:
modified/deleted/renamed files, binary file detection (NUL sniff ⇒ binary kind), unicode
paths (-z core.quoteitem off).
Commit: `feat(git): content-pair diffs, history stats, branch compare`

## Task 5 — remote sync ops
fetch/pull(ff-only default)/fast_forward/push(publish, force_with_lease); upstream status
enrichment. Tests against local bare remote (init bare, add as origin, full push/pull e2e).
Commit: `feat(git): fetch pull push with upstream status`

## Task 6 — IPC v4 plumbing
All git.* requests/responses; DiffComments CRUD variants; git-changed global event emitted
after every mutation; protocol bump 4; Tauri commands (manager.get_client() one-liners);
transport.ts wrappers + store git slice actions. Roundtrip + pipe tests.
Commit: `feat(daemon): IPC v4 git surface and comment CRUD`

## Task 7 — panel rebuild UI
Sections Staged/Unstaged/Conflicts/Untracked; per-file click → openDiffView read-only
DiffEditor; stage/unstage/discard buttons + bulk bar; commit box w/ AI button (calls
generate endpoint, graceful error); branch dropdown checkout; sync buttons + ahead/behind.
Refresh wiring via git-changed debounce (also StatusBar). Vitest coverage per interaction.
Commit: `feat(ui): source control panel rebuild with staging and commit`

## Task 8 — diff comments persistence + IPC
diff-comments.json keyed by worktree id (atomic save); CRUD handlers wired from task 6
variants; validation (line_number ≥1, body non-empty ≤4KB). Tests: roundtrip, cross-
worktree isolation, mark-sent stamps.
Commit: `feat(comments): diff comment persistence keyed by worktree`

## Task 9 — comments UX + send-to-agent loop
Gutter/hunk comment affordance in diff view (fallback selected-text only if Monaco gutter
fighting); Notes shelf grouped by file; format blocks module (port orca deterministic
format, escaping tests); Send menu → live sessions picker → Write prompt → delete/mark-sent.
Vitest: formatting golden, send flow with mocked transport.
Commit: `feat(ui): diff notes shelf and send-to-agent loop`

## Task 10 (stretch) — AI commit messages
Staged-diff context builder (cap 32KB) → catalog agent print-mode exec → message cleanup;
timeout 30s; heuristic fallback; settings toggle default ON only when an agent resolves.
Tests with fake agent script.
Commit: `feat(git): ai commit message generation via agents`
