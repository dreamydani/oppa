# Public Release Polish — Design Spec

**Status:** Approved for implementation
**Date:** 2026-09-05
**Scope:** Repository presentation for public publication. No runtime behavior changes.

## Goal

Publish OPPA as a credible, professional open-source desktop terminal. A first-time visitor must conclude within 60 seconds that this project is maintained, legally sound, and safe to install — without encountering scaffold defaults, internal paths, or missing legal files.

## Non-Goals

- No PTY, daemon, IPC, or UI behavior changes.
- No new features, performance work, or refactoring beyond fixture renames.
- No multi-language READMEs, website, or store listings in this pass.
- No CI, Dependabot, or release-automation changes in this pass.

## Decisions (settled with maintainer)

1. **License:** MIT, holder `dreamydani`, year 2026.
2. **Identity:** Product `Oppa`, bundle `com.dreamydani.oppa`, author `dreamydani`, repository `github.com/dreamydani/oppa`. `package.json` is public (`private: false`).
3. **AGENTS.md:** Revamp to a concise public contributor-agent guide modeled on established OSS practice. Remove internal lineage, local paths, and private workflow.
4. **Internals:** `docs/superpowers/` excluded from published archives via `export-ignore`. Curated public docs replace history.
5. **Community:** Full set now — CONTRIBUTING, SECURITY, Code of Conduct, issue and PR templates, public style guide.
6. **Fixtures:** `danial` neutralized to `oppa-user` in source tests and comments.
7. **Support:** GitHub Issues only. No Discord or social handles in this pass.
8. **Hero image:** Maintainer-supplied home screenshot (six-pane terminal grid with workspaces sidebar and Browser/Terminal/Editor tabs) ships as `docs/assets/hero.png`.

## Requirements

### R1 — Legal standing

- `LICENSE` exists at repo root with the full MIT text and `Copyright (c) 2026 dreamydani`.
- `README.md` links to `LICENSE`; `package.json` declares `license: MIT`.
- `THIRD-PARTY-NOTICES.md` contains the project MIT notice plus attributed top-level runtime dependencies: Tauri, React, xterm.js, portable-pty, vt100, Monaco. Generated lockfile excerpts are acceptable; invented versions are not.

### R2 — Consistent product identity

- `src-tauri/Cargo.toml`: `description` is a one-sentence product description; `authors` is `["dreamydani"]`. Version untouched (`0.2.4`).
- `src-tauri/tauri.conf.json`: `productName` is `Oppa`, `identifier` is `com.dreamydani.oppa`, window `title` is `Oppa`. Updater endpoint and bundle icon list untouched.
- `package.json`: `description`, `author`, `license`, `repository`, `homepage` present and consistent with the above. `private` is `false`. Scripts and dependency ranges untouched.

### R3 — Professional agent guide

Public `AGENTS.md` is rule-focused and self-contained:

- Opens with product definition and stack (Tauri 2 + Rust backend, React 19 + TypeScript + Vite frontend).
- Documents architecture boundaries that matter to contributors: Rust-owned PTY/session/backpressure, detached daemon lifecycle, `src/lib/pty/transport.ts` as the sole Tauri API boundary, zustand store for renderer state.
- States style, testing, cross-platform, and workflow rules with exact commands.
- Contains zero local filesystem paths, zero references to private tooling or removed docs, and links only to files that exist in the public tree.

### R4 — README that earns trust

Structure, in order:

1. Centered header (`Oppa`), badges (release, license, platforms), one-line value proposition, download call to action.
2. Hero screenshot with caption describing what is shown.
3. `Why Oppa` — three durable differentiators (session survival, instant reattachment, zero-drop flow control).
4. `Features` — six current capabilities, present tense, no vapor.
5. `How it works` — condensed daemon/IPC diagram and lifecycle, under 40 lines.
6. `Install` — per-OS via GitHub Releases plus source-dev commands.
7. `Developing` — three commands plus pointer to CONTRIBUTING.
8. `Community` — GitHub Issues only.
9. `License` — MIT with link.

Tone: confident, specific, and verifiable. No superlatives without evidence. No roadmap promises. No copied passages from reference projects.

### R5 — Curated public docs

- `docs/ARCHITECTURE.md`: distilled daemon, IPC, ScreenMirror, backpressure watermarks (256 KB high / 32 KB low), shell detection, and persistence fallback. No local paths.
- `docs/STYLEGUIDE.md`: public subset — token source of truth (`src/styles/theme.css`), component CSS placement, concise WHY-comments, concrete module naming, platform-check rules.
- `docs/superpowers/` remains in git for local history but is excluded from published archives via `.gitattributes` `export-ignore`.

### R6 — Community files

- `CONTRIBUTING.md` (root or `.github/`): scope discipline, three-OS compatibility, setup, branch naming, pre-PR checks with exact commands, test expectations.
- `SECURITY.md`: scoped to a terminal/PTY application — shell-escape and RCE report path via private advisory, no public proof-of-concept, process-group cleanup note.
- `CODE_OF_CONDUCT.md`: Contributor Covenant v2.1, standard text, contact via Issues.
- `.github/ISSUE_TEMPLATE/bug_report.yml` and `feature_request.yml`: structured forms (environment, repro, expected).
- `.github/pull_request_template.md`: ELI5, what changed, testing with platform checklist, focused-scope checklist.
- All documents use professional, neutral language.

### R7 — Fixture hygiene

- Every `danial` occurrence in buildable source and its doc comments becomes `oppa-user` (paths, slugs, branch fixtures). `docs/superpowers/` occurrences are out of scope (excluded from public archives).
- `cargo test -p oppa --lib` and `pnpm vitest run` pass after the rename.

## Acceptance

- [ ] GitHub license badge resolves to MIT; `LICENSE` holder is `dreamydani`.
- [ ] No occurrence of `A Tauri App`, `authors = ["you"]`, `com.pc.oppa`, `"private": true`, `Lovecast`, bare `danial`, or `D:\` paths in the public tree (`docs/superpowers/` excepted by design).
- [ ] `README.md` renders header, badges, hero image, and all R4 sections with working relative links.
- [ ] `AGENTS.md` links resolve; every referenced path exists.
- [ ] Full test verification: `pnpm build`, `cargo check`, `cargo test -p oppa --lib`, `pnpm vitest run`.
