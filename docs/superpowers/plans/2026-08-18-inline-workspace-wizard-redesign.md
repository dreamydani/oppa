# Inline Workspace Wizard & Minimalist UI Redesign Plan

Redesign the Workspace Setup Wizard as an inline, full-page workbench experience with high-end dark technical minimalism (`taste-skill` & `minimalist-ui`). Clicking `+` creates a dedicated "New Workspace" tab and displays the wizard inside the center main section without affecting other running terminals.

**Spec:** `docs/superpowers/specs/2026-08-18-inline-workspace-wizard-redesign.md`

## Tasks

### Task 1: Store Support for Wizard Tabs & In-Place Workspace Launching
- Files: `src/store/terminalStore.ts`, `src/store/terminalStore.test.ts`
- Extend `TabState` with `isWizard?: boolean`.
- Add `createWizardTab: () => string` in store.
- Add `launchWorkspaceForTab: (tabId: string, config: WorkspaceConfig) => Promise<void>` in store.
- Tests: Unit tests for creating wizard tabs, switching between terminal and wizard tabs, and launching into a live multi-terminal grid.
- Commit: `feat(store): add createWizardTab and launchWorkspaceForTab`

### Task 2: Full-Page Inline Redesign of WorkspaceSetupWizard (`taste-skill` & `minimalist-ui`)
- Files: `src/components/wizard/WorkspaceSetupWizard.tsx`, `src/components/wizard/WorkspaceSetupWizard.css`, `src/components/wizard/WizardStepStart.tsx`, `src/components/wizard/WizardStepLayout.tsx`, `src/components/wizard/WizardStepAgents.tsx`, test files
- Remove modal overlay and dialog wrapper; render as full-bleed `.wizard-workbench-page`.
- Apply minimalist UI design tokens (dark zinc `#09090b`, `#121214` cards, `1px solid rgba(255,255,255,0.07)` borders, warm amber spot accent `#f59e0b`, high-contrast typography).
- Refactor stepper, folder picker with `cd` jump, visual grid tiles (1, 2, 4, 6, 8, 10, 12), recents, presets, and agent persona cards.
- Tests: Update component unit tests for inline rendering and step progression.
- Commit: `feat(wizard): redesign WorkspaceSetupWizard as minimalist full-page workbench view`

### Task 3: Main Section & AppShell Integration (Workbench Tab Switching & Toolbar Hiding)
- Files: `src/components/layout/AppShell.tsx`, `src/components/TabBar.tsx`, `src/components/sidebar/WorkspaceList.tsx`, `src/App.tsx`, test files
- In `AppShell.tsx`, render `<WorkspaceSetupWizard tabId={activeTab.id} />` in `.terminal-workbench` when active tab is a wizard tab; hide Toolbar.
- Wire `+` button in TabBar and LeftSidebar to `createWizardTab()`.
- Update tests in `App.test.tsx`, `AppShell.test.tsx`, `TabBar.test.tsx`, `LeftSidebar.test.tsx`.
- Verify full test suite (`pnpm vitest run`, `cargo test -p oppa --lib`, `pnpm build`).
- Commit: `feat: integrate inline wizard tab into AppShell, TabBar, and LeftSidebar`
