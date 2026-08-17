# OPPA — Color Token System & Theme Unification Design

Date: 2026-08-18
Status: Approved

## Purpose

Establish a cohesive, minimalist, high-contrast dark color token system across OPPA's entire desktop UI based on the user's selected palette:
- **Main Canvas / Background**: `#141414` (Deep warm dark)
- **Secondary Surfaces / Sidebars**: `#212120` (Warm charcoal panel surface)

This document standardizes all CSS custom properties, eliminates legacy/conflicting color variables, harmonizes typography and borders, and unifies the styling across all frontend components.

---

## 1. Design Token System

### Surface & Background Tokens
- `--bg-canvas` / `--background` / `--bg-terminal`: `#141414` (Window background, terminal pane viewport, and xterm canvas background)
- `--bg-surface` / `--sidebar` / `--bg-sidebar`: `#212120` (Sidebars, titlebar, status bar)
- `--bg-card` / `--card` / `--bg-card-active`: `#282827` (Active tab cards, search overlays, elevated modals)
- `--bg-hover` / `--bg-card-hover`: `#2e2e2d` (Hover states on tabs, buttons, tree items)
- `--bg-active`: `#383837` (Pressed button states, drag handles)

### Border & Divider Tokens
- `--border-subtle` / `--border-divider` / `--sidebar-border` / `--border`: `rgba(255, 255, 255, 0.07)` (1px divider borders between sidebars, titlebar, and panes)
- `--border-active` / `--ring`: `rgba(255, 255, 255, 0.20)` (Focused split pane outline, input focus border)
- `--divider-hover`: `#4a4a48` (Split pane divider on hover)

### Typography & Foreground Tokens
- `--text-primary` / `--foreground`: `#ededec` (High-contrast warm off-white display and body text)
- `--text-muted` / `--muted-foreground`: `#9e9e9a` (Secondary labels, CWD paths, inactive icons, file tree entries)
- `--text-faint`: `#6e6e6a` (Placeholders, subtle shortcuts, inactive timestamps)

### Functional & Status Tokens
- `--accent-primary`: `#e0e0dc` (Neutral high-contrast accent)
- `--accent-blue`: `#58a6ff` (Terminal hyperlinks and active interactive badges)
- `--destructive`: `#e05252` (Close button hover, error indicators)
- `--git-added`: `#4ade80` (Git added badge & indicator)
- `--git-modified`: `#fbbf24` (Git modified badge)
- `--git-deleted`: `#f87171` (Git deleted badge)
- `--git-untracked`: `#a3e635` (Git untracked badge)

---

## 2. Component Updates

1. **`src/styles/theme.css` & `src/App.css`**:
   - Consolidate all CSS custom property definitions into a unified root stylesheet.
   - Replace old mid-slate grays (`#1e1f24`, `#21242b`, `#323846`) with the new warm charcoal palette (`#141414`, `#212120`, `#282827`, `#2e2e2d`).

2. **`src/components/TerminalPane.tsx`**:
   - Update xterm.js theme background to `#141414` and foreground to `#ededec` so terminal output blends with the UI canvas.

3. **`src/components/TerminalSearch.tsx`**:
   - Align search overlay background to `var(--bg-card)` (`#282827`) and border to `var(--border-subtle)`.

4. **`src/components/LeftSidebar.tsx` & `src/components/sidebar/LeftSidebar.css`**:
   - Tab cards, search strip, and resize handles use unified token variables.

5. **`src/components/RightSidebar.tsx` & `src/components/right-sidebar/RightSidebar.css`**:
   - File explorer tree, git source control badges, and activity bar use unified token variables.

6. **`src/components/TitleBar.tsx` & `src/components/layout/Titlebar.css` / `StatusBar.css`**:
   - TitleBar and StatusBar use `var(--bg-surface)` (`#212120`) and `var(--border-subtle)`.

---

## 3. Testing & Verification

1. Run unit and component test suites:
   `pnpm vitest run`
2. Run build verification:
   `pnpm build`
