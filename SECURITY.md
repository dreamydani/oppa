# Security Policy

## Supported versions

Oppa is pre-1.0 and under active development. Security fixes are provided for the latest stable release published on GitHub Releases.

| Version | Supported |
| --- | --- |
| Latest stable (0.2.x) | Yes |
| Older releases | Best effort |

## Reporting a vulnerability

Oppa is a terminal emulator. It spawns interactive shells, manages PTY process groups, and passes bytes between untrusted child output and the renderer. Reports concerning shell escape, PTY handling, daemon IPC, update integrity, or renderer injection are treated with priority.

- **Do not open a public issue for a suspected vulnerability.**
- Report via a [GitHub private security advisory](https://github.com/dreamydani/oppa/security/advisories/new).
- Include the affected version, platform, shell, repro steps, and observed versus expected behavior. Attach logs only after redacting secrets, tokens, and hostnames.

We will acknowledge receipt, investigate, and coordinate a fix and disclosure timeline with you. As a solo-maintained project, response times are best effort; critical remote-code-execution reports are handled first.

## Handling expectations

- Do not publish proof-of-concept exploits before a fix is released.
- Session and layout files under the app data directory may contain shell history and working-directory paths. Treat bug-report attachments as sensitive and redact them before sharing.
- The daemon terminates PTY process groups on session close. A report demonstrating a leaked or surviving process after `Kill` is in scope.
