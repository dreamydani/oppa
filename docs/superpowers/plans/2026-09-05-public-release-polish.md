# Public Release Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the OPPA repository legally sound and professionally presentable for public publication with zero runtime changes.

**Architecture:** Metadata-and-docs pass. Sequential file writes across license, identity manifests, contributor guides, README, curated docs, community files, and test-fixture renames, verified by grep plus the existing Rust and renderer suites.

**Tech Stack:** Tauri 2, Rust (portable-pty, vt100), React 19 + TypeScript + Vite, zustand, xterm.js, Monaco.

**Spec:** `docs/superpowers/specs/2026-09-05-public-release-polish-design.md`

## Global Constraints

- No runtime behavior changes; version stays `0.2.4` in every manifest.
- Concise WHY-comments only; concrete module names, never `utils`/`helpers`.
- Cross-platform: runtime platform checks, never hardcoded shell paths or separators outside the documented detection chain.
- Every task ends with a commit in conventional style (`docs:`, `chore:`).
- Verification commands: `pnpm build`, `cargo check` in `src-tauri`, `cargo test -p oppa --lib` in `src-tauri`, `pnpm vitest run` at root.

---

### Task 1: License + product identity

**Files:**
- Create: `LICENSE`
- Create: `THIRD-PARTY-NOTICES.md`
- Modify: `src-tauri/Cargo.toml:5-6`
- Modify: `src-tauri/tauri.conf.json:3-5,15`
- Modify: `package.json:1-5`
- Delete: `THIRD-PARTY-NOTICES` (extensionless, misnamed MIT text)

**Interfaces:**
- Consumes: spec R1, R2.
- Produces: `LICENSE` path and identity strings (`Oppa`, `com.dreamydani.oppa`, `dreamydani`) that README, CONTRIBUTING, and templates reference verbatim.

- [ ] **Step 1: Write `LICENSE` with MIT text, holder dreamydani**

```text
MIT License

Copyright (c) 2026 dreamydani

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: Update `src-tauri/Cargo.toml` identity lines**

Run: read `src-tauri/Cargo.toml:1-7`, then replace:
```toml
description = "A Tauri App"
authors = ["you"]
```
with:
```toml
description = "Fast, low-memory desktop terminal with persistent daemon sessions"
authors = ["dreamydani"]
```

- [ ] **Step 3: Update `src-tauri/tauri.conf.json` identity lines**

Replace `"productName": "oppa"` with `"productName": "Oppa"`, `"identifier": "com.pc.oppa"` with `"identifier": "com.dreamydani.oppa"`, and `"title": "oppa"` with `"title": "Oppa"`. Leave `version`, updater endpoint, and icon array untouched.

- [ ] **Step 4: Update `package.json` metadata**

Replace:
```json
{
  "name": "oppa",
  "private": true,
  "version": "0.2.4",
```
with:
```json
{
  "name": "oppa",
  "version": "0.2.4",
  "description": "Fast, low-memory desktop terminal with persistent daemon sessions",
  "author": "dreamydani",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "https://github.com/dreamydani/oppa.git"
  },
  "homepage": "https://github.com/dreamydani/oppa",
  "private": false,
```
Leave all `scripts` and dependency ranges untouched.

- [ ] **Step 5: Replace `THIRD-PARTY-NOTICES` with `THIRD-PARTY-NOTICES.md`**

Delete the extensionless file. Create `THIRD-PARTY-NOTICES.md` containing the MIT notice (holder `dreamydani`) followed by a `## Direct dependencies` section attributing Tauri 2, React 19, xterm.js, portable-pty 0.9.0, vt100 0.15, and Monaco with their upstream URLs and license names as resolved from `Cargo.lock` and `pnpm-lock.yaml`. No invented versions.

- [ ] **Step 6: Verify no scaffold strings remain**

Run: `rg -n "A Tauri App|\"you\"|com\.pc\.oppa|\"private\": true|Lovecast" Cargo.toml src-tauri/tauri.conf.json package.json LICENSE THIRD-PARTY-NOTICES.md`
Expected: no matches in the new files (the old dev-channel string `com.pc.oppa-dev` in README will be handled in Task 3).

- [ ] **Step 7: Commit**

```bash
git add LICENSE THIRD-PARTY-NOTICES THIRD-PARTY-NOTICES.md src-tauri/Cargo.toml src-tauri/tauri.conf.json package.json
git commit -m "chore: establish MIT license and public product identity"
```

### Task 2: Professional AGENTS.md

**Files:**
- Modify: `AGENTS.md` (full rewrite, 79 lines replaced)

**Interfaces:**
- Consumes: spec R3; identity strings from Task 1.
- Produces: public contributor-agent rules that README and CONTRIBUTING link to.

- [ ] **Step 1: Rewrite `AGENTS.md`**

Content (exact structure, prose kept tight and professional):

```markdown
# Oppa — Contributor Agent Guide

Oppa is a fast, low-memory desktop terminal built with Tauri 2 + Rust and React 19 + TypeScript + Vite.

## Architecture

- Rust owns PTY, session, and flow-control logic in `src-tauri/src/pty/`.
- `oppa --daemon` runs the headless Tokio daemon; the GUI connects over named pipes or Unix sockets and auto-spawns the daemon when absent. Sessions survive GUI restarts.
- Renderer components never call Tauri APIs directly. `src/lib/pty/transport.ts` is the sole Tauri boundary; UI reads the zustand store in `src/store/terminalStore.ts`.
- Backpressure is ACK-based (pause above 256 KB, resume below 32 KB). Never drop output.
- Shell detection follows `$SHELL` then fallback shells on macOS/Linux and `$COMSPEC` then fallbacks on Windows. Spawned shells set `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=oppa`.
- Layout persists to `appDataDir/layout.json` and warmly reattaches when the daemon is alive.

## Style

- One-line WHY-comments only. No narration of the obvious.
- Concrete module names after the domain concept. Never `helpers`, `utils`, `common`, or `misc`.
- Concrete types over loose strings. `const` over `let` unless reassigned.
- Match the surrounding file's conventions.

## Testing

- Practice TDD: failing test first, then implementation.
- Rust unit: `cargo test -p oppa --lib` in `src-tauri`.
- Rust daemon integration: `cargo test -p oppa --test daemon_integration_test` in `src-tauri`.
- Renderer: `pnpm vitest run` (`transport.ts` is mocked in component tests).
- End each task with a conventional commit (`feat:`, `fix:`, `docs:`).

## Cross-Platform

- Target macOS, Linux, and Windows behind runtime checks.
- Kill the PTY process group on close; never leak shells.
- Use `PathBuf` / `tauri::Manager::path()` in Rust and path joins in JS. Never assume separators.
- `metaKey` on Mac, `ctrlKey` elsewhere.

## Workflows

- Desktop dev: `pnpm tauri dev`. Web-only UI: `pnpm dev`.
- Build: `pnpm build` plus `cargo check` in `src-tauri`.
- See `README.md`, `docs/ARCHITECTURE.md`, `docs/STYLEGUIDE.md`, and `CONTRIBUTING.md`.
```

Must not contain `D:\`, `Orca`, `superpowers`, `gh CLI`, `CONTEXT.md`, or `docs/adr/`.

- [ ] **Step 2: Verify links resolve**

Run: check that `README.md`, `docs/ARCHITECTURE.md` (Task 4), `docs/STYLEGUIDE.md` (Task 4), `CONTRIBUTING.md` (Task 5) exist or are created in their tasks before final verification. Run `rg -n "D:\\\\|Orca|superpowers|CONTEXT" AGENTS.md` — expected no matches.

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: revamp AGENTS.md as professional public contributor guide"
```

### Task 3: README rewrite with hero image

**Files:**
- Modify: `README.md` (full rewrite, 139 lines replaced)
- Create: `docs/assets/hero.png` (binary, copied from maintainer-supplied screenshot)

**Interfaces:**
- Consumes: spec R4; identity from Task 1; `docs/ARCHITECTURE.md` and `CONTRIBUTING.md` paths from Tasks 4–5.
- Produces: public landing narrative; nothing else depends on its internals.

- [ ] **Step 1: Save the hero image**

Copy the maintainer-supplied home screenshot to `docs/assets/hero.png`. Verify the file renders (six-pane grid, workspaces sidebar, Browser/Terminal/Editor tabs).

- [ ] **Step 2: Rewrite `README.md`**

Exact section order and copy (badges use shields.io; hero uses the relative path):

```markdown
<h1 align="center">Oppa ⚡</h1>

<p align="center">
  <a href="https://github.com/dreamydani/oppa/releases/latest"><img src="https://img.shields.io/github/v/release/dreamydani/oppa?style=flat" alt="Latest release" /></a>
  <img src="https://img.shields.io/badge/license-MIT-08C?style=flat" alt="License: MIT" />
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square" alt="Supported platforms: macOS, Windows, and Linux" />
</p>

<p align="center"><strong>A fast, low-memory terminal that never loses your shell.</strong><br/>Detached daemon sessions, instant reattachment, and zero-drop flow control.</p>

<h3 align="center"><a href="https://github.com/dreamydani/oppa/releases/latest"><ins>Download Oppa</ins></a></h3>

<p align="center"><img src="docs/assets/hero.png" alt="Oppa home — workspaces, split terminal panes, and editor side by side" width="960" /></p>

## Why Oppa

- Sessions survive GUI restarts and window closes.
- Reopening reattaches instantly with full screen state.
- Massive output stays bounded in memory with zero dropped bytes.

## Features

- Detached background daemon with persistent PTY sessions.
- Warm reattachment with VT100 screen mirroring.
- Split panes, tabs, and workspace layouts.
- Browser viewport for local dev servers and docs.
- Editor pane with syntax highlighting and Markdown preview.
- ACK-based backpressure (pause above 256 KB, resume below 32 KB).

## How it works
[condensed diagram + 4-bullet lifecycle: GUI connects or spawns daemon; CreateOrAttach returns snapshot when is_new is false; streaming resumes; Kill terminates the process group]

## Install
[per-OS artifacts from GitHub Releases + source commands `pnpm install`, `pnpm tauri dev`]

## Developing
[`pnpm tauri dev`, `pnpm vitest run`, `cargo test -p oppa --lib` + link to CONTRIBUTING.md]

## Community & Support
- Issues: https://github.com/dreamydani/oppa/issues

## License
Oppa is free and open source under the [MIT License](LICENSE).
```

Keep the dev-channel paragraph (`OPPA_CHANNEL`, `com.dreamydani.oppa-dev`) out of README; it belongs in `docs/ARCHITECTURE.md` if retained. No roadmap promises, no superlatives without evidence.

- [ ] **Step 3: Verify relative links render**

Run: confirm `docs/assets/hero.png`, `LICENSE`, `CONTRIBUTING.md`, `docs/ARCHITECTURE.md` resolve. Open the rendered preview and check badges, hero width, and heading order.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/assets/hero.png
git commit -m "docs: rewrite README with hero image and professional structure"
```

### Task 4: Curated docs + exclusion of internals

**Files:**
- Create: `docs/ARCHITECTURE.md`
- Create: `docs/STYLEGUIDE.md`
- Modify: `.gitattributes` (create if absent)
- Modify: `docs/UPDATE-ROLLOUT.md` only if it references removed internal paths (leave otherwise)

**Interfaces:**
- Consumes: spec R5; terminal-core design at `docs/superpowers/specs/2026-08-16-terminal-core-design.md`; token source `src/styles/theme.css`.
- Produces: `docs/ARCHITECTURE.md` and `docs/STYLEGUIDE.md` paths linked from AGENTS.md and README.

- [ ] **Step 1: Write `docs/ARCHITECTURE.md`**

Sections: detached daemon lifecycle (`--daemon`, auto-spawn, `Disconnect` vs `Kill`), IPC transport (named pipe vs Unix socket, newline-delimited `DaemonRequest`/`DaemonResponse`/`DaemonEvent`), session registry, ScreenMirror snapshot flow (`is_new: false` + ANSI snapshot into xterm), ACK backpressure watermarks, shell detection chain and spawned env, persistence (`layout.json`, warm vs cold restore), build channels (`OPPA_CHANNEL`, stable vs `com.dreamydani.oppa-dev`). No local paths, no author names.

- [ ] **Step 2: Write `docs/STYLEGUIDE.md`**

Sections: source of truth (`src/styles/theme.css` is canonical; component CSS lives beside its component), token roles (reach for variables before hex, `color-mix` for tints), typography and motion tiers as defined in `theme.css`, naming (concrete domain concepts), comments (WHY one-liners), platform checks (`metaKey` vs `ctrlKey`, path joins). Link `AGENTS.md` for enforcement.

- [ ] **Step 3: Exclude internals from published archives**

Ensure `.gitattributes` contains:
```
docs/superpowers/ export-ignore
```
Verify `.superpowers/` remains in `.gitignore` (already at `.gitignore:27`).

- [ ] **Step 4: Commit**

```bash
git add docs/ARCHITECTURE.md docs/STYLEGUIDE.md .gitattributes
git commit -m "docs: curate public architecture and style guides, exclude internals"
```

### Task 5: Community files

**Files:**
- Create: `CONTRIBUTING.md`
- Create: `SECURITY.md`
- Create: `CODE_OF_CONDUCT.md`
- Create: `.github/ISSUE_TEMPLATE/bug_report.yml`
- Create: `.github/ISSUE_TEMPLATE/feature_request.yml`
- Create: `.github/pull_request_template.md`

**Interfaces:**
- Consumes: spec R6; commands from AGENTS.md.
- Produces: contribution entry points linked from README.

- [ ] **Step 1: Write `CONTRIBUTING.md`**

Include: scoped changes, three-OS compatibility, setup (`pnpm install`, `pnpm tauri dev`, `pnpm dev`), branch naming (`feat/`, `fix/`, `chore/` with examples), pre-PR checks (`pnpm build`, `cargo check` in `src-tauri`, `cargo test -p oppa --lib` in `src-tauri`, `pnpm vitest run`), test expectations (regression-catching over shallow coverage), release note (maintainer-managed, do not bump versions in contributions).

- [ ] **Step 2: Write `SECURITY.md`**

Include: report via GitHub private security advisory, no public proof-of-concept, scope emphasis on shell escape / PTY / daemon IPC, process-group cleanup expectation, response-time best effort for a solo-maintained project.

- [ ] **Step 3: Write `CODE_OF_CONDUCT.md`**

Standard Contributor Covenant v2.1 with contact via repository Issues.

- [ ] **Step 4: Write issue and PR templates**

`bug_report.yml`: environment (OS, version, shell), repro steps, expected vs actual, logs. `feature_request.yml`: problem, proposal, alternatives. `pull_request_template.md`: ELI5, what changed, testing with `[ ] I manually tested` and `[ ] Automated tests added/updated`, platform checklist (macOS/Linux/Windows), small-focused-scope checklist.

- [ ] **Step 5: Commit**

```bash
git add CONTRIBUTING.md SECURITY.md CODE_OF_CONDUCT.md .github/ISSUE_TEMPLATE/bug_report.yml .github/ISSUE_TEMPLATE/feature_request.yml .github/pull_request_template.md
git commit -m "docs: add community health files and templates"
```

### Task 6: Fixture hygiene (danial to oppa-user)

**Files:**
- Modify: `src-tauri/src/pty/snapshot.rs:458,478`
- Modify: `src-tauri/src/pty/screen_mirror.rs:127,129`
- Modify: `src-tauri/src/pty/agent_resume.rs:51,463-464,475,483,567`
- Modify: `src-tauri/src/git/worktree_naming.rs:483-484`

**Interfaces:**
- Consumes: spec R7.
- Produces: neutral fixtures; no API changes.

- [ ] **Step 1: Rename fixtures (TDD-adjacent: tests are the safety net)**

Replace every `danial` with `oppa-user` in the four files above, including the doc comment at `agent_resume.rs:51` (`"C:\\Users\\danial"` becomes `"C:\\Users\\oppa-user"`, slug `C--Users-danial` becomes `C--Users-oppa-user`) and the branch fixture (`danial/feature-x` becomes `oppa-user/feature-x`). Leave `docs/superpowers/` occurrences untouched (excluded by design).

- [ ] **Step 2: Run Rust unit tests**

Run: `cargo test -p oppa --lib` in `src-tauri`
Expected: PASS.

- [ ] **Step 3: Run renderer tests**

Run: `pnpm vitest run` at root
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/pty/snapshot.rs src-tauri/src/pty/screen_mirror.rs src-tauri/src/pty/agent_resume.rs src-tauri/src/git/worktree_naming.rs
git commit -m "chore: neutralize personal fixture names to oppa-user"
```

### Task 7: Verification + professionalism-gap report

**Files:**
- Modify: none (report is chat output, not a file).

**Interfaces:**
- Consumes: all prior tasks.
- Produces: go/no-go plus a prioritized follow-up list.

- [ ] **Step 1: Run the full verification ladder**

```bash
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test -p oppa --lib --manifest-path src-tauri/Cargo.toml
pnpm vitest run
rg -n "A Tauri App|authors = \[\"you\"\]|com\.pc\.oppa|Lovecast|danial" --glob '!docs/superpowers/**' --glob '!pnpm-lock.yaml' --glob '!Cargo.lock' .
rg -n "D:\\\\" --glob '!docs/superpowers/**' -g '*.rs' -g '*.ts' -g '*.tsx' -g '*.md' .
```

Expected: builds and suites PASS; first grep empty; second grep shows only intentional user-facing placeholder examples and the updater URL host, each dispositioned in the report.

- [ ] **Step 2: Check public link integrity**

Confirm `README.md` hero, `LICENSE`, `CONTRIBUTING.md`, `docs/ARCHITECTURE.md`, `docs/STYLEGUIDE.md`, and template links resolve; confirm `git archive HEAD --format=zip` excludes `docs/superpowers/`.

- [ ] **Step 3: Deliver the professionalism-gap report**

Report follow-ups outside this plan's scope, ordered by impact: CI badges that actually run, signed-installer provenance note, screenshot refresh cadence, changelog discipline, issue-label taxonomy, disclosure policy review date, dependency-attribution automation (`cargo license` / `pnpm licenses` in release script). No new work starts in this task.
