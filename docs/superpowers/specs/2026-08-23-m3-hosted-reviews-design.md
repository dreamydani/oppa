# Orca Parity M3 — Hosted Reviews (GitHub-first)

Date: 2026-08-23
Status: Approved (user selected merge-M2-then-Phase-6, GitHub-only v1)
Branch: feat/m3-hosted-reviews
Prior: docs/superpowers/specs/2026-08-23-m2-source-control-design.md (merged to main @4fe590c)

## Summary

Complete the spawn-to-merge loop: detect the GitHub forge from origin, gate PR creation
behind Orca's eligibility ladder, create PRs via `gh` with duplicate-recovery, poll PR +
checks state, and surface it all in the source control panel and worktree cards. Created
PRs link onto the worktree record; the composer's title/body can be AI-generated through
M2's agent print-mode machinery.

## Scope

GitHub only via `gh` CLI. GitLab/Bitbucket/Azure/Gitea, GHES, review-comment viewing,
auto-merge: out of scope. Rate-limit handling = simple failure backoff (no circuit breaker).

## Architecture decisions

1. **gh passthrough in the daemon** (`src-tauri/src/git/hosted_reviews.rs`), argv-only,
   same run_git discipline. Daemon owns eligibility + create + status; GUI and CLI are peers.
2. **Eligibility ladder is a single function** reused by UI probe and create-time last-gate.
   Blocked-reason ladder ported from orca hosted-review-creation.ts:
   `detached_head → existing_review → unsupported_provider → default_branch → dirty →
   no_upstream → needs_sync → auth_required → needs_push → base_not_on_remote`.
3. **Body via temp file** (`--body-file`), never inline argv. 60s timeout per gh call.
4. **Duplicate safety**: ambiguous create outcomes trigger a recovery probe
   (`gh pr list --head <branch> --json number,url`) before erroring — never two PRs for one branch.
5. **Polling cadence simplified**: on-demand + active-worktree 60s tick + 2.5s post-push
   burst; daemon publishes `PrChanged { worktree_id }` on its global broadcast. No budget
   governor in v1.
6. **Linkage**: success stamps `WorktreeRecord.linked_pr_url`; auto-cleared when the
   branch's push target diverges from the PR head (checked during status refresh).

## Data model

```
ForgeInfo        { provider: "github"|"unsupported", owner_repo: Option<String> }
BlockedReason    enum serde kebab-case: DetachedHead | ExistingReview | UnsupportedProvider |
                 DefaultBranch | Dirty | NoUpstream | NeedsSync | AuthRequired | NeedsPush |
                 BaseNotOnRemote | GhMissing | GhNotAuthed
Eligibility      { eligible: bool, blocked_reason: Option<BlockedReason>, base_ref: Option<String>,
                   owner_repo: Option<String>, existing_pr_url: Option<String> }
PrStatus         { number, title, url, state ("open"|"closed"|"merged"), draft,
                   mergeable ("mergeable"|"conflicting"|"unknown"),
                   checks: Vec<CheckRun { name, state ("passing"|"failing"|"pending"|"skipping") }>,
                   fetched_at_ms }
```

## gh command contract

| Purpose | Invocation |
|---|---|
| preflight auth | `gh auth status` (exit 0 ⇒ ok; stderr contains "not logged in" ⇒ GhNotAuthed) |
| base resolution | `git symbolic-ref refs/remotes/origin/HEAD` → probe `origin/main`, `origin/master`; must exist on remote |
| create | `gh pr create --repo <owner/repo> --base <base> [--head <branch>] [--draft] --body-file <tmp>` |
| lookup by head | `gh pr view <branch> --json number,title,url,state,isDraft,statusCheckRollup,mergeable,baseRefName,headRefName` (missing ⇒ no PR) |
| checks rollup | statusCheckRollup from the same view call (v1 single-call; separate graphql deferred) |
| recovery probe | `gh pr list --repo <o/r> --head <branch> --json number,url --limit 5` |

All gh calls honor `GH_TOKEN` env inheritance; timeout kill at 60s.

## Renderer

- Composer section inside GitSourceControl panel above sync row: when forge=github shows
  "Create Pull Request" affordance → form (title, body textarea, draft checkbox) prefilled
  from AI-generate button (reuses generateCommitMessage-style agent exec against combined
  diff vs base). Blocked states render human copy per reason incl. fix hints.
- Checks card: after linked_pr exists — PR number/title/state, check rows w/ colored dots,
  refresh button, Open PR deep link (opener plugin already present).
- Worktree cards gain small PR badge (number + state dot) when record has linked_pr_url.
- Store: prSlice-ish additions in git slice (eligibility/prStatus keyed by worktree id);
  listens for PrChanged event debounced like git-changed.

## Testing strategy

Fake `gh` shim script (cmd + sh) standing in as PATH-resolvable binary for ALL automated
tests: scripted JSON outputs, exit codes, delay mode for timeout test. Eligibility ladder
unit tests per rung against temp repos. Pipe integration: eligibility→create→link→status→
diverge-clears-link flow over real socket with shim injected via daemon env PATH. Opt-in
live smoke (real gh, only if authed) excluded from default suites. Vitest: composer states,
blocked copy mapping, checks card, badge.

## Security notes

No tokens ever read/stored by oppa — gh owns auth. Body file created in std temp dir with
0600-equivalent perms best-effort, deleted after spawn. Branch/ref names validated as in M2.
