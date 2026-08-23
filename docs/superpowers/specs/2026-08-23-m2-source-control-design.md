# Orca Parity M2 — Source Control Panel + Diff Comments + M1.5 Polish

Date: 2026-08-23
Status: Approved (user selected M1.5 + Phase 4, diff-comments included)
Branch: feat/m2-source-control
M1 reference: docs/superpowers/specs/2026-08-23-orca-parity-m1-design.md

## Summary

Port Orca's source-control operation surface into the daemon, rebuild the renderer's git
panel around it (staging/commit/diff/history/sync), and add Orca's diff-comments loop
(comment on diff lines → batch → ship to an agent pane as a prompt). Close M1 stubs:
session rename via title sync and the GUI agent picker.

## Architecture decisions

1. **Git ops live in the daemon** (`src-tauri/src/git/source_control.rs`), argv-only exec,
   same pattern as worktrees engine. Rationale: single git codepath, CLI/headless parity
   for future orchestration.
2. **Protocol v3 → v4**, additive `git.*` requests. Old clients unaffected; version bump
   is honest about the new surface.
3. **Diffs are content pairs** (`original_content` / `modified_content`), not patch text —
   feeds Monaco DiffEditor directly. Size-capped (default 512KB per side) with truncated flag.
4. **Diff comments persist daemon-side** in `<appDataDir>/diff-comments.json` keyed by
   worktree id — cross-client consistent (GUI + CLI see the same notes).
5. **AI commit messages** run installed agent CLIs non-interactively via existing catalog;
   heuristic fallback on failure. Stretch task — cut if flaky.

## Git service contract (ported from orca rpc/methods/git*.ts semantics)

All ops take a worktree path (resolved cwd). Status returns area-aware entries:
`{path, index_status, worktree_status, area: staged|unstaged|untracked|conflict, old_path?}`.
- stage/unstage/discard (+bulk): index mutations; discard uses checkout-index semantics
  for tracked files, deletes untracked; refuse discarding untracked files unless confirmed flag.
- commit: message required non-empty; nothing staged ⇒ Error("nothing to commit").
- history(limit≤200): id, parent ids, subject, author/email/date, files/insertions/deletions
  stats (numstat), refs decoration.
- branch_compare(base_ref): ahead/behind counts + changed file list (name-status).
- local_branches / checkout: anti-injection validated branch names.
- fetch/pull/fast_forward/push(publish?, force_with_lease?): upstream status enriched
  {has_upstream, ahead, behind}; pull defaults to ff-only with merge fallback flag.
- conflict detection: merge/rebase/revert in-progress state surfaced as status field.
- AI commit message: build staged-diff context → prompt catalog agent in print mode
  (`claude -p`, `codex exec`) → first line(s) as message; timeout 30s; fallback heuristic
  from numstat ("feat: update N files").

## Diff comments schema (ported from orca diff-comment-schema)

```
DiffComment { id (uuid), worktree_id, file_path, source: "diff"|"markdown",
              selected_text?, start_line?, line_number (required, 1+),
              body, scope: "unstaged"|"staged"|"branch", old_path?, created_at_ms,
              updated_at_ms?, sent_at? }
```
CRUD via IPC: DiffCommentsList{worktree_id} / Add / Update / Delete / MarkSent(ids).
Prompt format blocks joined by blank lines:
`File: <path>` + (`Scope: <scope>` | `Lines: a-b` | `Line: n`) + `User comment: "<body>"`.
Send flow: pick target session (agent pane) → Write(prompt+"\r") → mark sent_at (or delete).

## Session titles (closes M1 rename stub)

`DaemonRequest::SetSessionTitle {session_id, title}` → stored on DaemonSession, propagated
into SessionSnapshot.title on checkpoint save, `DaemonEvent::TitleChanged{session_id,title}`
broadcast globally. CLI `terminal rename --to <t>` maps to it (max 80 chars, control-stripped).
`terminal switch <id>` validates then emits `SessionFocusRequested{session_id}` global event;
renderer listens and focuses that tab/pane when running.

## Renderer changes

- **Panel rebuild** (right-sidebar git tab): sections Staged / Unstaged / Conflicts /
  Untracked with per-file and bulk controls; click file → store action `openDiffView(path,
  original, modified)` rendering read-only Monaco DiffEditor (no accept/reject banner —
  distinct from pendingAiDiff); commit box (message textarea + AI-generate button); branch
  dropdown w/ checkout; fetch/pull/push buttons with ahead/behind badges.
- **git slice** in terminalStore: status/diff/history/comments state + actions through
  transport; refresh on new global `git-changed` daemon event (debounced) — also fixes
  stale StatusBar/status-panel data after any mutation.
- **Comments UX**: gutter-line comment affordance in diff view (fallback: comment button
  per file hunk header using selected text); Notes shelf listing unsent notes grouped by
  file; Send menu targets any live session; delivered ⇒ deleted; manual "mark sent" option.
- **Agent picker**: WorktreeCreateModal agent dropdown populated from catalog list +
  prompt textarea; submit routes AgentHandoff RPC; result focuses returned session.

## Testing strategy

TDD throughout. Rust unit tests per op against real temp repos (bare-remote e2e for push/
pull/fetch). Pipe integration tests for every new request variant incl. auth/versioning.
Vitest for panel sections, commit box, diff view open, comments CRUD + send formatting.
Conventional commits per task; ledger at .superpowers/sdd/2026-08-23-m2-source-control/.

## Non-goals

Hosted PR creation (Phase 6), submodules, sparse checkout, fork sync, remote file URLs,
commit graph UI beyond flat list, i18n of new strings.

## Security notes

Branch/ref names argv-checked (no leading '-', no whitespace). Discard requires explicit
confirmation flag from caller (UI double-confirms). Diff content caps prevent memory blowup
on generated files. Comments bodies escaped at prompt-format time (quotes backslash-escaped).
