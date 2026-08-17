# Workspace Setup Wizard Implementation Plan

Implement the 3-step Workspace Setup Wizard (Start -> Layout -> Agents) for the `+` button in OPPA with visual terminal grid layouts (1, 2, 4, 6, 8, 10, 12), working folder picker with `cd` jump, dynamic recents, presets, and agent/startup command configuration.

**Spec:** `docs/superpowers/specs/2026-08-18-workspace-setup-wizard-design.md`

## Tasks

### Task 1: Rust Backend & Transport for Recents and Presets Persistence
- Files: `src-tauri/src/workspace_presets.rs`, `src-tauri/src/lib.rs`, `src/lib/workspace/transport.ts`
- Implement `save_recents`, `load_recents`, `save_presets`, `load_presets` Tauri commands saving JSON to `app_data_dir()`.
- Register in `src-tauri/src/lib.rs`.
- Implement TypeScript transport functions in `src/lib/workspace/transport.ts`.
- Tests: Rust unit tests in `workspace_presets.rs`.
- Commit: `feat(rust): add recents and presets persistence backend`

### Task 2: Recursive Grid Layout Generator & Store Extensions
- Files: `src/lib/pane-manager/gridLayout.ts`, `src/lib/pane-manager/gridLayout.test.ts`, `src/store/terminalStore.ts`, `src/store/terminalStore.test.ts`
- Implement `createGridLayout(count: number, sessionIds: string[]): Layout` generating balanced binary split trees for 1, 2, 4, 6, 8, 10, 12 panes.
- Extend `TerminalState` with wizard state (`isSetupWizardOpen`, `wizardStep`, `recentWorkspaces`, `workspacePresets`, `openSetupWizard`, `closeSetupWizard`, `setWizardStep`, `launchCustomWorkspace`, `addRecentWorkspace`, `saveWorkspacePreset`).
- Tests: Unit tests for grid generator and store actions.
- Commit: `feat: add grid layout generator and wizard store actions`

### Task 3: Wizard Step 1 (Start) & Wizard Step 2 (Layout & Folder)
- Files: `src/components/wizard/WizardStepStart.tsx`, `src/components/wizard/WizardStepLayout.tsx`, `src/components/wizard/WizardStepLayout.test.tsx`
- Step 1: Workspace title input, shell dropdown.
- Step 2: Working folder input + browse icon + quick `> cd <path>` command jump, visual grid tiles (1, 2, 4, 6, 8, 10, 12) with preview badge, dynamic recents with clean empty state, presets chips with `+ NEW`.
- Tests: Component tests for folder selection, `cd` resolution, grid tile selection, and presets.
- Commit: `feat(wizard): add start and layout step components`

### Task 4: Wizard Step 3 (Agents & Startup Commands) & Full Wizard Assembly
- Files: `src/components/wizard/WizardStepAgents.tsx`, `src/components/wizard/WorkspaceSetupWizard.tsx`, `src/components/wizard/WorkspaceSetupWizard.css`, `src/components/wizard/WorkspaceSetupWizard.test.tsx`
- Step 3: AI agent persona/model selector, per-terminal startup commands inputs, env vars, save preset checkbox.
- Assembly: 3-step progress bar (`(1) Start`, `(2) Layout`, `(3) Agents`), `< Back`, `Quick Spawn`, `Launch Workspace` (orange accent).
- Tests: Component tests for step transitions, validation, and launching custom workspace.
- Commit: `feat(wizard): add agents step and full WorkspaceSetupWizard component`

### Task 5: App Integration & Shortcut Wiring
- Files: `src/components/layout/AppShell.tsx`, `src/components/TabBar.tsx`, `src/components/sidebar/WorkspaceList.tsx`, `src/App.tsx`, test files
- Update `+` button in TabBar and WorkspaceList to call `openSetupWizard()`.
- Update `AppShell.tsx` to render `<WorkspaceSetupWizard />` when `isSetupWizardOpen` is true.
- Wire `Ctrl+T` / `Cmd+T` to quick spawn bypassing the wizard.
- Run full suites: `pnpm vitest run`, `cargo test -p oppa --lib`, `pnpm build`.
- Commit: `feat: integrate WorkspaceSetupWizard into AppShell and TabBar`
