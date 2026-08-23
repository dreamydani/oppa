# Plan — M3: Hosted Reviews (GitHub-first)

Spec: docs/superpowers/specs/2026-08-23-m3-hosted-reviews-design.md
Workflow: subagent-driven, controller review per task, ledger .superpowers/sdd/2026-08-23-m3-hosted-reviews/. TDD.

## Step 0 — merge M2 + branch + docs (done before task 1)

## Task 1 — forge detect + eligibility engine
`src-tauri/src/git/hosted_reviews.rs`: ForgeInfo from `git remote get-url origin`
(https+ssh github.com forms; else UnsupportedProvider); gh presence/auth probe; base-ref
resolution chain (symbolic-ref origin/HEAD → origin/main → origin/master, remote-existence
check); full BlockedReason ladder function `review_eligibility(cwd) -> Eligibility`.
Fake-gh shim fixture in test_support (scripted outputs). Tests per rung incl. order
(detached beats dirty etc.), auth probe paths.
Commit: `feat(reviews): forge detection and eligibility ladder`

## Task 2 — PR creation + recovery + linkage
`create_pull_request(cwd, title, body, draft)` — re-runs eligibility as last gate;
body temp file; argv per spec; ambiguous ⇒ recovery probe; success stamps
linked_pr_url via registry save (extend WorktreeRecord write path — field exists);
existing_pr short-circuits to that URL. Tests w/ shim incl. duplicate-probe path,
timeout kill, divergence-clears-link on later status refresh.
Commit: `feat(reviews): pr creation with recovery probe and worktree linkage`

## Task 3 — PR status/checks poller + PrChanged event
`pr_status(cwd)` via gh pr view JSON parse into PrStatus (rollup → checks vec);
daemon-side lightweight poller task for active worktrees w/ linked_pr (60s tick,
2.5s burst after push event hook), publishes DaemonEvent::PrChanged { worktree_id }.
Divergence check clears link. Shim tests: json shapes, failing/pending checks, poller
fires event, backoff after gh failure.
Commit: `feat(reviews): pr checks polling with pr-changed events`

## Task 4 — IPC plumbing
Requests: ReviewEligibility { cwd }, CreateReview { cwd, title, body, draft },
PrStatusFor { cwd }, plus responses; Tauri commands sc_* prefix; transport.ts wrappers +
TS types serde-exact; store git slice additions (eligibility/prStatus keyed by cwd→worktree)
+ PrChanged subscription. Roundtrip + pipe tests; CLI verbs `oppa-cli review status|create`
(+ drift-guard updates).
Commit: `feat(daemon): hosted review IPC surface and plumbing`

## Task 5 — composer UI
GitSourceControl gains review section: eligible ⇒ composer form (title/body/draft +
AI-generate button using agent print-mode over diff-vs-base context builder — extend
commit_message.rs pattern to range diff); blocked ⇒ human copy per reason with fix hint;
submit → create → link appears immediately. Vitest all states.
Commit: `feat(ui): pull request composer with ai generation`

## Task 6 — checks card + badges
Checks card in panel (number/title/state/check dots/refresh/open link); WorktreePane cards
PR badge from linked_pr_url + latest known state; open external via opener plugin.
Vitest coverage.
Commit: `feat(ui): pr checks card and worktree badges`

## Task 7 — e2e + smoke
Full pipe-level flow test (eligibility→create→status→diverge-clear) with shim; opt-in live
smoke binary flag if real gh present+authed (skipped by default, documented).
Commit: `test(reviews): end-to-end hosted review flows`

## Task 8 (stretch) — stacked-PR hint ruling
If base resolves to another registered worktree's branch, composer shows "stacked onto
<branch>" info chip (display-only v1). Ruling recorded in ledger either way.
