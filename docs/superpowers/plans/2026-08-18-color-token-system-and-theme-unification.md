# Color Token System & Theme Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a cohesive, minimalist, high-contrast dark color token system across OPPA's entire desktop UI using `#141414` (main canvas/terminal) and `#212120` (secondary surfaces/sidebars).

**Architecture:** Consolidate all CSS custom property variables in `src/styles/theme.css` and `src/App.css`, synchronize the xterm.js WebGL canvas theme in `TerminalPane.tsx`, and standardize all panel, sidebar, titlebar, and search overlay styles to strictly use the new token system.

**Tech Stack:** React 19, TypeScript, Vanilla CSS (CSS Custom Properties), Vitest, xterm.js.

## Global Constraints

- Main Canvas / Background / Terminal Canvas: `#141414`
- Secondary Surfaces / Sidebars / TitleBar / StatusBar: `#212120`
- Elevated / Active Cards / Search Overlay: `#282827`
- Hover Highlights: `#2e2e2d`
- Active Pressed Highlights: `#383837`
- Text Primary: `#ededec`
- Text Muted: `#9e9e9a`
- Border / Dividers: `rgba(255, 255, 255, 0.07)`
- Active / Focus Rings: `rgba(255, 255, 255, 0.20)`
- All 19 test files (252+ tests) must pass with `pnpm vitest run`.

---

### Task 1: Update Theme Tokens and Unit Tests

**Files:**
- Modify: `src/styles/theme.css`
- Modify: `src/styles/theme.test.ts`

**Interfaces:**
- Consumes: CSS custom property declarations in `:root`.
- Produces: Updated CSS token system for `--background`, `--sidebar`, `--card`, `--foreground`, `--muted`, `--muted-foreground`, `--border`, `--sidebar-border`, `--ring`, `--destructive`.

- [ ] **Step 1: Update `src/styles/theme.test.ts` to expect the new color tokens**

```typescript
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("theme tokens", () => {
  it("defines standard color tokens matching the #141414 and #212120 palette", () => {
    const cssPath = path.resolve(__dirname, "./theme.css");
    const content = fs.readFileSync(cssPath, "utf-8");

    expect(content).toContain("--background: #141414;");
    expect(content).toContain("--sidebar: #212120;");
    expect(content).toContain("--card: #282827;");
    expect(content).toContain("--foreground: #ededec;");
    expect(content).toContain("--muted-foreground: #9e9e9a;");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/styles/theme.test.ts`
Expected: FAIL due to old color values in `theme.css`.

- [ ] **Step 3: Update `src/styles/theme.css` with the new color tokens**

```css
:root {
  /* Fonts */
  --font-sans: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --font-mono: 'SF Mono', Consolas, 'Cascadia Code', Menlo, monospace;

  /* Sizing & Radius */
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;

  /* Core Canvas & Surfaces */
  --background: #141414;
  --foreground: #ededec;
  --card: #282827;
  --card-foreground: #ededec;
  --sidebar: #212120;
  --sidebar-foreground: #ededec;
  --sidebar-border: rgba(255, 255, 255, 0.07);
  --border: rgba(255, 255, 255, 0.07);
  --muted: #2e2e2d;
  --muted-foreground: #9e9e9a;
  --text-faint: #6e6e6a;
  --accent: #383837;
  --accent-foreground: #ffffff;
  --primary: #ededec;
  --primary-foreground: #141414;
  --destructive: #e05252;
  --ring: rgba(255, 255, 255, 0.20);

  /* Functional Tokens */
  --accent-blue: #58a6ff;

  /* Git Status Colors */
  --git-added: #4ade80;
  --git-modified: #fbbf24;
  --git-deleted: #f87171;
  --git-untracked: #a3e635;
}

*, *::before, *::after {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 0;
  background-color: var(--background);
  color: var(--foreground);
  font-family: var(--font-sans);
  overflow: hidden;
  user-select: none;
  -webkit-font-smoothing: antialiased;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/styles/theme.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/styles/theme.css src/styles/theme.test.ts
git commit -m "feat: define #141414 and #212120 color tokens in theme.css"
```

---

### Task 2: Synchronize `src/App.css` and `TerminalPane.tsx`

**Files:**
- Modify: `src/App.css`
- Modify: `src/components/TerminalPane.tsx:58-65`

**Interfaces:**
- Consumes: Theme variables from `theme.css`.
- Produces: Standardized styles for `.app-container`, `.title-bar`, `.left-sidebar`, `.main-viewport`, `.pane-divider`, `.tab-card`, and `.terminal-search-overlay`.

- [ ] **Step 1: Update `src/App.css` to align all variables and element styles**

Ensure `:root` in `src/App.css` maps to the unified token palette:
```css
:root {
  --bg-window: var(--background, #141414);
  --bg-sidebar: var(--sidebar, #212120);
  --bg-terminal: var(--background, #141414);
  --bg-card-active: var(--card, #282827);
  --bg-card-hover: var(--muted, #2e2e2d);
  --border-divider: var(--border, rgba(255, 255, 255, 0.07));
  --border-active: var(--ring, rgba(255, 255, 255, 0.20));
  --text-primary: var(--foreground, #ededec);
  --text-muted: var(--muted-foreground, #9e9e9a);
  --accent-blue: #58a6ff;
  --destructive: var(--destructive, #e05252);
  --font-sans: 'Geist', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --font-mono: 'SF Mono', Consolas, 'Cascadia Code', Menlo, monospace;
}
```
And update `.tab-card-avatar` background to `#1b1b1a` and active background to `#212120`.

- [ ] **Step 2: Update `TerminalPane.tsx` xterm theme to `#141414` background and `#ededec` foreground**

```typescript
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "Menlo, Consolas, monospace",
      theme: {
        background: "#141414",
        foreground: "#ededec",
        cursor: "#ededec",
        selectionBackground: "rgba(255, 255, 255, 0.15)",
      },
      allowProposedApi: true,
    });
```

- [ ] **Step 3: Run component tests to verify**

Run: `pnpm vitest run src/components/TerminalPane.test.tsx src/App.test.tsx`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/App.css src/components/TerminalPane.tsx
git commit -m "feat: align App.css and TerminalPane xterm theme with unified tokens"
```

---

### Task 3: Standardize Component Stylesheets

**Files:**
- Modify: `src/components/sidebar/LeftSidebar.css`
- Modify: `src/components/right-sidebar/RightSidebar.css`
- Modify: `src/components/layout/Titlebar.css`
- Modify: `src/components/layout/StatusBar.css`
- Modify: `src/components/layout/AppShell.css`

**Interfaces:**
- Consumes: CSS variables `--background`, `--sidebar`, `--card`, `--foreground`, `--muted-foreground`, `--border`, `--ring`, `--destructive`.
- Produces: Consistent styling across all sub-components and modular views.

- [ ] **Step 1: Check and update any hardcoded colors in component CSS files**

Ensure:
- `.workspace-card:hover` uses `rgba(255, 255, 255, 0.04)` / `var(--muted)`
- `.workspace-card.active` uses `var(--card)` (`#282827`)
- `.file-tree-item:hover` uses `var(--muted)` (`#2e2e2d`)
- `.git-branch-header` uses `var(--card)` (`#282827`)
- `.status-bar` uses `var(--sidebar)` (`#212120`) and `var(--border)` (`rgba(255, 255, 255, 0.07)`)

- [ ] **Step 2: Run all component tests**

Run: `pnpm vitest run`
Expected: PASS for all 19 test files.

- [ ] **Step 3: Commit**

```bash
git add src/components/sidebar/LeftSidebar.css src/components/right-sidebar/RightSidebar.css src/components/layout/Titlebar.css src/components/layout/StatusBar.css src/components/layout/AppShell.css
git commit -m "feat: standardize component styles across sidebar, titlebar, and status bar"
```

---

### Task 4: Full System Verification and Build Check

**Files:**
- Verification only

- [ ] **Step 1: Run full test suite**

Run: `pnpm vitest run`
Expected: All 252+ tests pass.

- [ ] **Step 2: Run TypeScript and Vite build**

Run: `pnpm build`
Expected: Build passes with 0 errors.

- [ ] **Step 3: Run Cargo check on Rust backend**

Run: `cargo check --manifest-path src-tauri/Cargo.toml`
Expected: Cargo check passes.
