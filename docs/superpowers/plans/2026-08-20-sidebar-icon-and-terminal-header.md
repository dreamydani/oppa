# Sidebar Icon Fix and Terminal Header Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove duplicate icons in left sidebar tabs and redesign the terminal pane header with an 80% minimalist + 20% clay fusion aesthetic.

**Architecture:** 
1. Remove `.tab-card-app-icon` inside `src/components/LeftSidebar.tsx`.
2. Update `src/components/TerminalPaneHeader.css` with dark matte basalt surfaces, subtle top specular rim highlight, tactile 26x26px square buttons, and refined dropdown menus.
3. Verify with vitest, TypeScript compiler, production build, and cargo test.

**Tech Stack:** React 19, TypeScript, CSS, Lucide / Minimal Icons, Vitest, Tauri 2 / Rust.

## Global Constraints

- Scope: Strictly confined to `src/components/LeftSidebar.tsx`, `src/components/TerminalPaneHeader.tsx`, `src/components/TerminalPaneHeader.css`, and their corresponding test files.
- Visual Language: 80% Minimalist (clean, sharp, dark monochrome) + 20% Clay (tactile press, subtle top specular highlight, smooth micro-interactions). No legacy bright blue or amber in terminal header.
- TDD: Write/update tests first or alongside, verify tests pass, create clean git commits per task.

---

### Task 1: Remove Duplicate Icon from Left Sidebar Tabs

**Files:**
- Modify: `src/components/LeftSidebar.tsx:206-215`
- Test: `src/components/LeftSidebar.test.tsx`

**Interfaces:**
- Consumes: `tab` object with `isWizard`, `title`, and `cwd`.
- Produces: Clean `.tab-card-row-top` without redundant `.tab-card-app-icon`.

- [ ] **Step 1: Update `src/components/LeftSidebar.tsx`**

Remove `.tab-card-app-icon` from `.tab-card-row-top`:

```tsx
                <div className="tab-card-content">
                  <div className="tab-card-row-top">
                    {isEditing ? (
                      <input
                        ref={editInputRef}
                        type="text"
                        className="tab-rename-input"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        onBlur={() => handleSaveRename(tab.id)}
                        onKeyDown={(e) => handleRenameKeyDown(e, tab.id)}
                        aria-label="Rename tab"
                      />
                    ) : (
                      <span className="tab-card-title" title={title}>
                        {title}
                      </span>
                    )}
                  </div>
```

- [ ] **Step 2: Update tests in `src/components/LeftSidebar.test.tsx`**

Verify that `tab-card-avatar` is present and `tab-card-app-icon` is not rendered.

- [ ] **Step 3: Run LeftSidebar tests**

Run: `pnpm vitest run src/components/LeftSidebar.test.tsx`
Expected: All tests pass.

- [ ] **Step 4: Commit Task 1**

```bash
git add src/components/LeftSidebar.tsx src/components/LeftSidebar.test.tsx
git commit -m "fix(sidebar): remove duplicate icon in tab card title row"
```

---

### Task 2: Redesign Terminal Pane Header (80% Minimalist + 20% Clay Fusion)

**Files:**
- Modify: `src/components/TerminalPaneHeader.css`
- Modify: `src/components/TerminalPaneHeader.tsx`
- Test: `src/components/TerminalPaneHeader.test.tsx`

**Interfaces:**
- Consumes: `TerminalPaneHeaderProps`, `useTerminalStore` actions (`renameSession`, `toggleMaximizePane`, `splitPane`, `closePane`, etc.).
- Produces: Sleek 34px height header with subtle top rim highlight, 26x26px tactile buttons, clean monochrome palette, and polished dropdown menu.

- [ ] **Step 1: Update `src/components/TerminalPaneHeader.css`**

Apply 80% Minimalist + 20% Clay styling:
- Height `34px`, background `#111115`, border-bottom `1px solid rgba(255, 255, 255, 0.06)`, inset shadow `inset 0 1px 0 rgba(255, 255, 255, 0.06)`.
- Focused pane header: `border-bottom-color: rgba(255, 255, 255, 0.12)`.
- Action buttons: 26x26px, border-radius `6px`, color `#71717a`, hover color `#fafafa` and background `rgba(255, 255, 255, 0.06)`, active scale `scale(0.95)` with inset shadow.
- Dropdown menu: `#18181f` background with `1px solid rgba(255, 255, 255, 0.09)`, `8px` border radius, subtle specular highlight, and smooth hover items.
- Restored session badge: minimal slate pill with clean dot.

- [ ] **Step 2: Run TerminalPaneHeader tests**

Run: `pnpm vitest run src/components/TerminalPaneHeader.test.tsx`
Expected: 22/22 tests passing.

- [ ] **Step 3: Commit Task 2**

```bash
git add src/components/TerminalPaneHeader.css src/components/TerminalPaneHeader.tsx src/components/TerminalPaneHeader.test.tsx
git commit -m "feat(ui): redesign terminal pane header with minimalist clay fusion aesthetic"
```

---

### Task 3: Full Project Regression Verification

**Files:**
- None (verification task)

- [ ] **Step 1: Run all vitest tests**

Run: `pnpm vitest run`
Expected: 522/522 tests passing.

- [ ] **Step 2: Run TypeScript compiler and production build**

Run: `pnpm tsc --noEmit && pnpm build`
Expected: 0 errors, clean build.

- [ ] **Step 3: Run Rust unit tests**

Run: `cargo test -p oppa --lib` (in `src-tauri`)
Expected: 77/77 tests passing.
