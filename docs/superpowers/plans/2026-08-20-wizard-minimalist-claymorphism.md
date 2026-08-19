# Workspace Setup Wizard: Minimalist + Claymorphism Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Workspace Setup Wizard components and styles into an editorial Minimalist + tactile Claymorphism aesthetic using Dark Matte Clay & Warm Amber.

**Architecture:** Update `WorkspaceSetupWizard.css` with clay token variables, recessed input wells, and tactile bevel shadows; update `WorkspaceSetupWizard.tsx`, `WizardStepStart.tsx`, `WizardStepLayout.tsx`, and `WizardStepAgents.tsx` with bento-grid layouts, keycap grid selector tiles, clay persona badges, and 3D action buttons while preserving all data flow and state store bindings.

**Tech Stack:** React 19, TypeScript, Vitest, CSS3 Custom Properties (Claymorphism box-shadows, transforms, transitions).

## Global Constraints

- **Scope:** Styles and component structure changes must be strictly contained within `src/components/wizard/`.
- **Theme:** Dark Matte Clay (`#0b0b0e` canvas, `#141419` surfaces, `#1a1a22` elevated) with Warm Amber (`#f59e0b` / `#d97706`) accents.
- **Micro-motion:** Smooth 60fps animations utilizing only `transform`, `opacity`, and `box-shadow`.
- **TDD:** All existing and new automated tests must pass (`pnpm vitest run`).

---

### Task 1: Claymorphic & Minimalist CSS Tokens and Layout Foundation

**Files:**
- Modify: `src/components/wizard/WorkspaceSetupWizard.css`
- Test: `src/components/wizard/WorkspaceSetupWizard.test.tsx`

**Interfaces:**
- Consumes: CSS theme custom properties from `src/styles/theme.css`.
- Produces: `--wizard-*` design tokens, `.wizard-workbench-page`, `.wizard-content-container`, `.wizard-section`, and `.wizard-input-wrapper` sunken well styles.

- [ ] **Step 1: Write unit test verifying wizard container and tokens**

Add a test in `src/components/wizard/WorkspaceSetupWizard.test.tsx`:
```tsx
it("renders wizard workbench page with container and minimalist clay styling", () => {
  render(<WorkspaceSetupWizard tabId="tab-test" />);
  const page = screen.getByRole("region", { name: /workspace setup wizard/i });
  expect(page.className).toContain("wizard-workbench-page");
  expect(page.querySelector(".wizard-content-container")).not.toBeNull();
});
```

- [ ] **Step 2: Run test to verify it passes/fails**

Run: `pnpm vitest run src/components/wizard/WorkspaceSetupWizard.test.tsx`

- [ ] **Step 3: Implement core CSS tokens and container styles in WorkspaceSetupWizard.css**

Define root design variables and container styles:
```css
/* Minimalist + Claymorphism Design Tokens */
.wizard-workbench-page {
  --wizard-bg-canvas: #0b0b0e;
  --wizard-bg-surface: #141419;
  --wizard-bg-surface-elevated: #1a1a22;
  --wizard-bg-surface-hover: #22222b;
  --wizard-bg-sunken: #0e0e12;
  --wizard-border: rgba(255, 255, 255, 0.08);
  --wizard-border-highlight: rgba(255, 255, 255, 0.16);
  --wizard-amber-primary: #f59e0b;
  --wizard-amber-hover: #fbbf24;
  --wizard-amber-glow: rgba(245, 158, 11, 0.25);
  --wizard-amber-surface: rgba(245, 158, 11, 0.08);
  --wizard-text-primary: #f4f4f5;
  --wizard-text-secondary: #a1a1aa;
  --wizard-text-muted: #71717a;
  --wizard-shadow-card: 0 10px 30px -5px rgba(0, 0, 0, 0.6), inset 0 1px 1px 0 rgba(255, 255, 255, 0.1), inset 0 -1px 2px 0 rgba(0, 0, 0, 0.4);
  --wizard-shadow-card-elevated: 0 14px 36px -6px rgba(0, 0, 0, 0.7), inset 0 1px 1.5px 0 rgba(255, 255, 255, 0.16), inset 0 -1px 2px 0 rgba(0, 0, 0, 0.4);
  --wizard-shadow-sunken: inset 0 2px 5px 0 rgba(0, 0, 0, 0.5), 0 1px 0 0 rgba(255, 255, 255, 0.04);
  --wizard-shadow-btn-primary: 0 4px 14px rgba(245, 158, 11, 0.35), inset 0 1px 1px rgba(255, 255, 255, 0.35), inset 0 -2px 4px rgba(0, 0, 0, 0.3);

  width: 100%;
  height: 100%;
  overflow-y: auto;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 40px 24px 60px 24px;
  background: var(--wizard-bg-canvas);
  color: var(--wizard-text-primary);
  box-sizing: border-box;
}

.wizard-content-container {
  width: 100%;
  max-width: 760px;
  display: flex;
  flex-direction: column;
  gap: 22px;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/wizard/WorkspaceSetupWizard.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/wizard/WorkspaceSetupWizard.css src/components/wizard/WorkspaceSetupWizard.test.tsx
git commit -m "feat(wizard): add minimalist claymorphic css design tokens"
```

---

### Task 2: Wizard Header & Pebble Progress Stepper Redesign

**Files:**
- Modify: `src/components/wizard/WorkspaceSetupWizard.tsx`
- Modify: `src/components/wizard/WorkspaceSetupWizard.css`
- Test: `src/components/wizard/WorkspaceSetupWizard.test.tsx`

**Interfaces:**
- Consumes: `STEPS` navigation array and active `step` state.
- Produces: Tactile pebble stepper buttons with glowing step numbers and responsive dividers.

- [ ] **Step 1: Write test for tactile pebble stepper states**

In `src/components/wizard/WorkspaceSetupWizard.test.tsx`:
```tsx
it("renders pebble stepper with active clay glow and step numbers", () => {
  render(<WorkspaceSetupWizard tabId="tab-test" />);
  const step1 = screen.getByTestId("wizard-progress-step-1");
  expect(step1.className).toContain("active");
  expect(step1.querySelector(".wizard-step-num")?.textContent).toBe("1");
});
```

- [ ] **Step 2: Run test to verify it passes/fails**

Run: `pnpm vitest run src/components/wizard/WorkspaceSetupWizard.test.tsx`

- [ ] **Step 3: Implement pebble stepper markup and CSS**

Update header and stepper in `WorkspaceSetupWizard.tsx` and `WorkspaceSetupWizard.css`:
```css
.wizard-progress-nav {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 10px 16px;
  background: var(--wizard-bg-surface);
  border: 1px solid var(--wizard-border);
  border-radius: 12px;
  box-shadow: var(--wizard-shadow-card);
}

.wizard-step-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 14px;
  border-radius: 9999px;
  background: var(--wizard-bg-sunken);
  border: 1px solid var(--wizard-border);
  color: var(--wizard-text-muted);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  box-shadow: var(--wizard-shadow-sunken);
  transition: all 0.18s cubic-bezier(0.16, 1, 0.3, 1);
}

.wizard-step-pill.active {
  background: var(--wizard-bg-surface-elevated);
  border-color: var(--wizard-amber-primary);
  color: var(--wizard-amber-primary);
  font-weight: 600;
  box-shadow: var(--wizard-shadow-tile-active);
  transform: translateY(-1px);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/wizard/WorkspaceSetupWizard.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/wizard/WorkspaceSetupWizard.tsx src/components/wizard/WorkspaceSetupWizard.css src/components/wizard/WorkspaceSetupWizard.test.tsx
git commit -m "feat(wizard): redesign header and pebble progress stepper"
```

---

### Task 3: Step 1 (Start) & Step 2 (Layout & Presets) Redesign

**Files:**
- Modify: `src/components/wizard/WizardStepStart.tsx`
- Modify: `src/components/wizard/WizardStepLayout.tsx`
- Modify: `src/components/wizard/WorkspaceSetupWizard.css`
- Test: `src/components/wizard/WizardStepLayout.test.tsx`

**Interfaces:**
- Consumes: `cwd`, `terminalCount`, `recentWorkspaces`, `workspacePresets`.
- Produces: Recessed sunken input wells, mechanical keycap grid selector tiles, and bento cards.

- [ ] **Step 1: Write test for keycap tiles and quick jump cd well**

In `src/components/wizard/WizardStepLayout.test.tsx`:
```tsx
it("renders tactile mechanical keycap tiles for grid options", () => {
  const setTerminalCount = vi.fn();
  render(
    <WizardStepLayout
      cwd="D:\\oppa"
      setCwd={vi.fn()}
      terminalCount={4}
      setTerminalCount={setTerminalCount}
      onSelectRecent={vi.fn()}
      onSelectPreset={vi.fn()}
    />,
  );
  const tile4 = screen.getByLabelText("4 terminals layout");
  expect(tile4.className).toContain("active");
});
```

- [ ] **Step 2: Run test to verify it passes/fails**

Run: `pnpm vitest run src/components/wizard/WizardStepLayout.test.tsx`

- [ ] **Step 3: Implement keycap grid tiles, sunken well inputs, and bento cards**

Update `WizardStepStart.tsx`, `WizardStepLayout.tsx`, and `WorkspaceSetupWizard.css` with sunken well styling, mechanical keycap tiles with 3D tactile press states, and bento recents/presets.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/wizard/WizardStepLayout.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/wizard/WizardStepStart.tsx src/components/wizard/WizardStepLayout.tsx src/components/wizard/WorkspaceSetupWizard.css src/components/wizard/WizardStepLayout.test.tsx
git commit -m "feat(wizard): redesign start step and layout selector with clay keycap tiles"
```

---

### Task 4: Step 3 (Agents & Startup Commands) & Action Footer Redesign

**Files:**
- Modify: `src/components/wizard/WizardStepAgents.tsx`
- Modify: `src/components/wizard/WorkspaceSetupWizard.tsx`
- Modify: `src/components/wizard/WorkspaceSetupWizard.css`
- Test: `src/components/wizard/WorkspaceSetupWizard.test.tsx`

**Interfaces:**
- Consumes: `agentPersona`, `commands`, `saveAsPreset`, `presetName`.
- Produces: Persona bento grid cards, physical numbered clay tags for commands, and 3D tactile CTA buttons.

- [ ] **Step 1: Write test for persona cards and 3D action footer**

In `src/components/wizard/WorkspaceSetupWizard.test.tsx`:
```tsx
it("renders persona bento cards with clay tags and tactile launch button on step 3", () => {
  useTerminalStore.setState({ wizardStep: 3 });
  render(<WorkspaceSetupWizard tabId="tab-test" />);
  expect(screen.getByText(/AI AGENT PERSONA/i)).toBeDefined();
  expect(screen.getByRole("button", { name: /Launch Workspace/i })).toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it passes/fails**

Run: `pnpm vitest run src/components/wizard/WorkspaceSetupWizard.test.tsx`

- [ ] **Step 3: Implement persona cards, command badges, and 3D launch button**

Update `WizardStepAgents.tsx` and `WorkspaceSetupWizard.tsx` with clay persona cards, sunken command wells, and tactile 3D launch button with specular highlight and active press depth.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/wizard/WorkspaceSetupWizard.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/wizard/WizardStepAgents.tsx src/components/wizard/WorkspaceSetupWizard.tsx src/components/wizard/WorkspaceSetupWizard.css src/components/wizard/WorkspaceSetupWizard.test.tsx
git commit -m "feat(wizard): redesign agents step and 3d tactile action footer"
```

---

### Task 5: End-to-End Integration, Accessibility, and Verification

**Files:**
- Modify: `src/components/wizard/WorkspaceSetupWizard.css`
- Test: `src/App.test.tsx`, `src/components/wizard/WorkspaceSetupWizard.test.tsx`

**Interfaces:**
- Consumes: Full wizard flow from tab creation to launch.
- Produces: Polished 60fps micro-animations, keyboard support (Esc, Enter, Tab), and full test coverage.

- [ ] **Step 1: Run full Vitest suite**

Run: `pnpm vitest run`
Expected: All 35+ test files pass.

- [ ] **Step 2: Run production build check**

Run: `pnpm build`
Expected: Zero TypeScript or Vite bundling errors.

- [ ] **Step 3: Run Rust backend test check**

Run: `cargo test -p oppa --lib` (in `src-tauri`)
Expected: All 77 Rust tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/components/wizard/WorkspaceSetupWizard.css
git commit -m "chore(wizard): polish minimalist claymorphic interactions and verified build"
```
