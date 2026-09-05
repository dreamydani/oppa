# Contributing to Oppa

Thank you for contributing to Oppa.

## Before you start

- Keep changes scoped to a clear improvement, fix, or refactor.
- Oppa targets macOS, Linux, and Windows. Every change must remain compatible with all three platforms unless it is explicitly guarded by a runtime platform check.
- For keyboard shortcuts, use a runtime platform check in renderer code (`metaKey` on Mac, `ctrlKey` elsewhere).
- For file paths, use `PathBuf` and Tauri path APIs in Rust and path joins in TypeScript. Never assume a separator.
- Rust owns PTY, session, and flow-control logic. Renderer components must not call Tauri APIs directly; use `src/lib/pty/transport.ts`.
- For UI work, follow `docs/STYLEGUIDE.md` and verify light and dark themes.
- Write concise WHY-comments and name modules after their domain concept. See `AGENTS.md`.

## Local setup

```bash
pnpm install
pnpm tauri dev
```

Web-only UI preview:

```bash
pnpm dev
```

## Branch naming

Use a clear, descriptive branch name that reflects the change.

Good examples:

- `fix/pty-process-group-cleanup`
- `feat/workspace-layout-persistence`
- `chore/update-contributor-guide`

Avoid vague names such as `test`, `misc`, or `changes`.

## Before opening a PR

Run the same checks reviewers will run:

```bash
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test -p oppa --lib --manifest-path src-tauri/Cargo.toml
pnpm vitest run
```

Add tests that would catch a regression, not shallow coverage of the happy path. If the change affects terminal behavior, cover startup, resize, large output, and close.

## Pull requests

Follow `.github/pull_request_template.md`. Keep each PR small and focused, explain what changed and why in plain language, and attach before and after screenshots for visual changes (or write `No visual change` with a reason).

## Releases

Version bumps, tags, and releases are maintainer-managed. Do not include release version changes in a contribution unless a maintainer asks for them.
