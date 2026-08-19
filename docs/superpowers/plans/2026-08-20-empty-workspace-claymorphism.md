# Empty Workspace View Minimalist Claymorphic Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the "No Open Workspaces" empty view into a sleek Minimalist Claymorphic card with a single dominant "New Workspace" button that opens the setup wizard.

**Architecture:** Update `src/App.tsx` empty state markup and `src/App.css` styles with the dark matte clay tokens, tactile 3D white CTA, raised terminal icon box, and mechanical `<kbd>` badges. Update `src/App.test.tsx` to assert the single New Workspace button.

**Tech Stack:** React 19, TypeScript, CSS Variables, Vitest, Testing Library.

## Global Constraints

- Scope: Visual changes strictly contained within `.empty-workspace-*` in `src/App.tsx`, `src/App.css`, and corresponding tests in `src/App.test.tsx`.
- Palette: Dark Matte Clay (`#141419` / `#18181f`), deep basalt canvas (`#09090b`), crisp white primary CTA (`#fafafa` / `#ffffff`), slate typography (`#e4e4e7` / `#a1a1aa` / `#71717a`). No blue or orange.
- Button behavior: Remove `+ New Terminal` button entirely. Only one button labeled `New Workspace` that triggers `createWizardTab()`.
- TDD & verification: All unit, component, build, and rust tests must pass.

---

### Task 1: Redesign Empty Workspace View Component & CSS

**Files:**
- Modify: `src/App.tsx:232-262`
- Modify: `src/App.css:932-1025`

**Interfaces:**
- Consumes: `createWizardTab: () => string` from `useTerminalStore`.
- Produces: Minimalist claymorphic `.empty-workspace-card` with single `.empty-action-btn.primary` button triggering `createWizardTab()`.

- [ ] **Step 1: Update empty workspace markup in `src/App.tsx`**

Replace the two buttons (`+ New Terminal` and `Setup Wizard`) with the single `New Workspace` button:

```tsx
            {!activeTab ? (
              <div className="empty-workspace-view" data-testid="empty-workspace-view">
                <div className="empty-workspace-card">
                  <div className="empty-workspace-icon">
                    <TerminalIcon size={26} />
                  </div>
                  <h2 className="empty-workspace-title">No Open Workspaces</h2>
                  <p className="empty-workspace-subtitle">
                    Configure an active project workspace with terminal layouts, shells, and agent personas.
                  </p>
                  <div className="empty-workspace-actions">
                    <button
                      type="button"
                      className="empty-action-btn primary"
                      onClick={() => createWizardTab()}
                      aria-label="New Workspace"
                    >
                      <PlusIcon size={15} />
                      <span>New Workspace</span>
                    </button>
                  </div>
                  <div className="empty-workspace-shortcut-hint">
                    Press <kbd>Ctrl+N</kbd> / <kbd>Cmd+N</kbd> for Workspace Launcher
                  </div>
                </div>
              </div>
            ) : activeTab.isWizard ? (
```

- [ ] **Step 2: Update CSS in `src/App.css`**

Replace `.empty-workspace-*` CSS rules with the Minimalist Claymorphic design:

```css
.empty-workspace-view {
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  height: 100%;
  width: 100%;
  padding: 32px;
  background-color: var(--wizard-bg-canvas, #09090b);
  box-sizing: border-box;
}

.empty-workspace-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  max-width: 440px;
  padding: 38px 32px;
  background-color: var(--wizard-bg-surface, #141419);
  border: 1px solid var(--wizard-border, rgba(255, 255, 255, 0.08));
  border-radius: 14px;
  box-shadow: 0 14px 36px -6px rgba(0, 0, 0, 0.7), inset 0 1px 1.5px rgba(255, 255, 255, 0.12), inset 0 -1px 2px rgba(0, 0, 0, 0.4);
  box-sizing: border-box;
}

.empty-workspace-icon {
  width: 48px;
  height: 48px;
  border-radius: 10px;
  background-color: var(--wizard-bg-surface-elevated, #18181f);
  border: 1px solid var(--wizard-border-highlight, rgba(255, 255, 255, 0.18));
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--wizard-text-primary, #fafafa);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4), inset 0 1px 1px rgba(255, 255, 255, 0.1);
  margin-bottom: 16px;
}

.empty-workspace-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--wizard-text-primary, #fafafa);
  letter-spacing: -0.01em;
  margin: 0 0 8px 0;
}

.empty-workspace-subtitle {
  font-size: 13px;
  color: var(--wizard-text-muted, #71717a);
  line-height: 1.5;
  margin: 0 0 24px 0;
}

.empty-workspace-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 22px;
}

.empty-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 40px;
  padding: 0 22px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);
  user-select: none;
  box-sizing: border-box;
}

.empty-action-btn.primary {
  background-color: #fafafa;
  border: 1px solid #fafafa;
  color: #09090b;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5), inset 0 1px 1px rgba(255, 255, 255, 0.8), inset 0 -2px 3px rgba(0, 0, 0, 0.25);
}

.empty-action-btn.primary:hover {
  background-color: #ffffff;
  border-color: #ffffff;
  transform: translateY(-1px);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.6), inset 0 1px 1.5px rgba(255, 255, 255, 0.9), inset 0 -2px 3px rgba(0, 0, 0, 0.25);
}

.empty-action-btn.primary:active {
  transform: translateY(1px) scale(0.985);
  box-shadow: inset 0 2px 5px rgba(0, 0, 0, 0.5);
}

.empty-workspace-shortcut-hint {
  font-size: 12px;
  color: var(--wizard-text-muted, #71717a);
  display: flex;
  align-items: center;
  gap: 4px;
}

.empty-workspace-shortcut-hint kbd {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  background-color: var(--wizard-bg-surface-elevated, #18181f);
  color: var(--wizard-text-secondary, #a1a1aa);
  border: 1px solid var(--wizard-border, rgba(255, 255, 255, 0.08));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 1px 2px rgba(0, 0, 0, 0.4);
}
```

- [ ] **Step 3: Commit Task 1**

```bash
git add src/App.tsx src/App.css
git commit -m "feat(ui): redesign empty workspace view with minimalist claymorphic style and single new workspace cta"
```

---

### Task 2: Update Tests and Verify Whole Application

**Files:**
- Modify: `src/App.test.tsx`

**Interfaces:**
- Consumes: Updated `App` component with single "New Workspace" button in empty state.

- [ ] **Step 1: Update `src/App.test.tsx` for single "New Workspace" CTA**

Update any assertions expecting `+ New Terminal` or `Setup Wizard` in the empty workspace card to expect `New Workspace` and verify it calls `createWizardTab`.

- [ ] **Step 2: Run all vitest tests**

Run: `pnpm vitest run`
Expected: 522/522 tests passing.

- [ ] **Step 3: Run TypeScript compiler and production build**

Run: `pnpm tsc --noEmit && pnpm build`
Expected: 0 errors, clean build.

- [ ] **Step 4: Run Rust unit tests**

Run: `cargo test -p oppa --lib` (in `src-tauri`)
Expected: 77/77 tests passing.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/App.test.tsx
git commit -m "test(ui): update app tests for empty workspace view redesign"
```
