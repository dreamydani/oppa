# Oppa UI Style Guide

This is the visual-design companion to `AGENTS.md`. It documents design tokens, component rules, and review expectations for renderer work. Token values live in `src/styles/theme.css` (canonical); this file documents roles and rules for using them.

## Source of truth

| Concern | Canonical location |
| --- | --- |
| Color, type, radius, and motion tokens | `src/styles/theme.css` (`:root`, `[data-theme="dark"]`) |
| Component styles | CSS file beside its component (for example `TerminalPane.css` next to `TerminalPane`) |
| Terminal rendering | xterm instance fed by `src/lib/pty/transport.ts` and the zustand store |

Never define a global custom property outside `theme.css`. Never hardcode a hex value when a variable already covers the role. When a new token is needed, add it to `theme.css` for both themes, then use it.

## Color roles

- `background` and `foreground` carry the app canvas and default text.
- Panels, popovers, and the sidebar use their own surface tokens; do not reuse the canvas tokens for lifted surfaces.
- Color is reserved for state: selection ring, destructive actions, and terminal or git decorations.
- Tints use `color-mix` against an existing token rather than a new hex value.

## Typography and motion

- Body text uses the sans token; terminal and code surfaces use the mono token.
- Motion follows the tier ladder in `theme.css`: micro for hover and press feedback, fast for toggles and inline reveals, base for popovers, mid for modals, slow for view swaps. Match the tier to the distance traveled and the importance of the change.
- Curves encode intent: ease-out for entrances, ease-in for exits, ease-in-out for travel between settled poses, spring for weighted overshoot. The CSS default `ease` is intentionally unused.

## Components

- Prefer the existing component beside the work before building a new one.
- Keep pane chrome quiet. The terminal, browser, and editor panes host dense third-party surfaces (xterm, webview, Monaco); Oppa chrome should frame that content, not compete with it.
- List rows share one behavior: transparent at rest, accent wash on hover, a distinct persistent treatment for the active row. Never invent a one-off selected color.

## Naming and comments

- Name files after the concrete domain concept they contain. Never `helpers`, `utils`, `common`, or `misc`.
- Explain WHY in one line when the reason is not obvious from the code. Do not narrate the obvious.

## Platform and review checklist

- Verify light and dark themes, macOS / Windows / Linux chrome, and window-resize behavior for any UI change.
- Use platform checks for shortcuts (`metaKey` on Mac, `ctrlKey` elsewhere) and path joins instead of literal separators.
- Attach before and after screenshots for visual changes; write `No visual change` with a reason when there is none.
