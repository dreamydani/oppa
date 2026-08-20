# OPPA Editor UI Redesign Specification

**Date:** 2026-08-21  
**Branch:** `feat/editor-ui-redesign`  
**Target Scope:** `src/components/editor/` (`EditorTabBar.tsx`, `EditorBreadcrumbs.tsx`, `EditorViewport.tsx`, `CodeEditor.tsx`, `EditorViewport.css`, and related tests)  

---

## 1. Problem Statement & Aesthetic Goals

The current editor header and tabs (shown in the screenshot) suffer from:
1. **Outdated Tab Aesthetics**: Harsh top border highlight (`border-top: 2px solid #58a6ff`), boxy shape, and crude square letter badges (`[PL]`, `[TS]`) that look disconnected from OPPA's sleek aesthetic.
2. **Clunky Action Bar**: Raw text buttons with emoji prefixes (`⇄ Diff`, `⌥ Format`) and harsh rectangular borders in the breadcrumbs bar.
3. **Color & Hierarchy Issues**: Mismatched background contrasts, harsh borders, and lack of visual polish matching the rest of OPPA (e.g., `Titlebar`, `TerminalPaneHeader`, and `RightSidebar`).

### Redesign Goals
- **OPPA Dark Minimalist Aesthetic**: 80% Minimalist + 20% subtle depth fusion, using Geist/Geist Mono typography, refined borders (`rgba(255, 255, 255, 0.07)`), and subtle translucent hover/active states.
- **Sleek Floating Tabs**:
  - Soft pill-style rounded tabs (`border-radius: 6px`).
  - Sleek file-type icons (using clean SVG icons with subtle language accents) instead of clunky text blocks.
  - Active tab uses subtle elevated surface (`var(--bg-card-active, #282827)` or `rgba(255, 255, 255, 0.08)`) with fine border highlight, eliminating the harsh top colored strip.
  - Smooth hover fade, rounded close button (`✕`) that appears cleanly on hover or remains subtle.
  - New tab button (`+`) styled to match OPPA's icon button system.
- **Polished Breadcrumbs & Toolbar**:
  - Segmented breadcrumbs trail with folder/file icon and subtle `ChevronRight` separators.
  - Segmented pill group for Markdown modes (`Code`, `Preview`, `Split`) using Lucide icons.
  - Icon-enhanced action buttons for `Diff` (`GitCompare`), `Format` (`Sparkles`), and `Save` (`Save` / `Check` with sleek `Ctrl+S` shortcut badge).
- **Refined Editor Canvas**:
  - Seamless gutter integration with Geist Mono font and subtle line numbers.
  - Clean focused styling with no harsh outlines.

---

## 2. Proposed UI Architecture & Component Changes

### A. `EditorTabBar.tsx`
- Replace primitive `PL`/`TS` text badges with streamlined file type icons with subtle language tinting.
- Modernize tab container to use a pill/segmented layout matching OPPA's titlebar and terminal pane headers.
- Refine active/hover states with smooth CSS transitions.

### B. `EditorBreadcrumbs.tsx`
- Replace unicode characters (`›`, `⇄`, `⌥`) with consistent Lucide icons (`ChevronRight`, `GitCompare`, `Sparkles`, `Save`, `Check`, `Code`, `Eye`, `Columns2`).
- Restyle the breadcrumb trail to show subtle folder icons and highlighted active file name.
- Redesign action buttons into sleek micro-buttons with consistent padding, subtle borders, and smooth hover effects.

### C. `EditorViewport.css`
- Modernize all color tokens to reference OPPA's unified theme variables:
  - Surface: `var(--workspace-bg)`, `var(--sidebar)`, `var(--card)`
  - Borders: `var(--border, rgba(255, 255, 255, 0.07))`
  - Accents: `var(--accent-blue)`, `var(--git-modified)`
- Add smooth transitions, micro-shadows, and polished hover states.
- Ensure 100% theme consistency in both dark and light modes.

---

## 3. Scope Isolation

Only files inside `src/components/editor/` will be modified:
- `src/components/editor/EditorTabBar.tsx`
- `src/components/editor/EditorBreadcrumbs.tsx`
- `src/components/editor/EditorViewport.tsx`
- `src/components/editor/CodeEditor.tsx`
- `src/components/editor/EditorViewport.css`
- Corresponding unit tests in `src/components/editor/`

No external stores, terminal components, daemon code, or unrelated modules will be touched.
