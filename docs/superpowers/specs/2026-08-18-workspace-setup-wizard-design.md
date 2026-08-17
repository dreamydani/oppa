# Workspace Setup Wizard Design Specification

## Overview

Replace the basic instant `+` tab action with a rich, full-workbench **Workspace Setup Wizard** inspired by modern terminal cockpits. The wizard guides users through project initialization across 3 steps (Start -> Layout -> Agents), offering visual grid layout selection (1, 2, 4, 6, 8, 10, 12 terminals), folder navigation with `cd` command jump, persistent dynamic Recents, and Presets.

A direct bypass (`Ctrl+T` / `Cmd+T` or "Quick Spawn" button) remains available for instant 1-click single terminal creation.

---

## 1. Flow & User Experience

### Navigation Header
- **3-Step Progress Bar** at the top:
  - `(1) Start`
  - `(2) Layout` (Active with vibrant orange accent)
  - `(3) Agents`
- **Bottom Navigation**:
  - `< Back` button (disabled on Step 1)
  - `Quick Spawn` bypass button (creates 1 terminal in current CWD immediately)
  - `Next →` / `Launch Workspace` primary action button

---

## 2. Step Details

### Step 1: Start (Project / Workspace Setup)
- **Workspace Name**: Custom name (defaults to folder basename or `workspace-N`).
- **Shell Environment**: Dropdown choosing default shell (PowerShell, Cmd, Git Bash, WSL, Bash, Zsh).
- **Template Mode**: "Blank Workspace" or "From Preset".

### Step 2: Layout & Working Directory
- **Working Folder**:
  - Folder path input with folder browse icon.
  - Quick terminal navigation box: `> cd <subpath>` with `→` button to immediately resolve subfolders.
- **Terminal Grid Layout Selector**:
  - Visual interactive tiles for: `1`, `2`, `4`, `6`, `8`, `10`, `12` terminals.
  - Live preview badge: `X terminals   NxM grid`.
  - Generates balanced recursive binary split trees (`h` and `v` splits) upon launch.
- **Recent Workspaces**:
  - Dynamic list loaded from `recents.json`.
  - Empty state when fresh ("No recent workspaces yet").
  - 1-click cards to populate folder path and terminal count.
- **Presets**:
  - Chips representing saved workspace setups (e.g. `Dev Stack`, `Full Grid`, `OBS`, `Grok`, `+ NEW`).
  - Clicking a preset pre-fills the layout, startup commands, and agent configuration.
  - `+ NEW` creates a new preset from current settings.

### Step 3: Agents & Startup Configuration
- **AI Agent Persona & Model Selector**: Choose assistant configuration (e.g., General Assistant, Code Reviewer, Terminal Copilot, Grok, GPT, Claude).
- **Startup Commands per Pane**: List of initial command inputs for each spawned pane (e.g. Pane 1: `pnpm dev`, Pane 2: `cargo watch`, Pane 3: `git status`).
- **Environment Variables**: Optional key-value pairs passed to spawned shells.
- **Save as Preset**: Checkbox to save the configured setup into `presets.json`.
- **Primary CTA**: `Launch Workspace` (orange accent button).

---

## 3. Architecture & Persistence

### Recursive Split Tree Generator
A utility `createGridLayout(count: number, sessionIds: string[]): Layout` that generates balanced binary split trees:
- `1` terminal: `{ type: "leaf", id: ids[0] }`
- `2` terminals: `{ type: "split", dir: "h", ratio: 0.5, a: leaf(0), b: leaf(1) }`
- `4` terminals: 2x2 grid (vertical split of two horizontal splits)
- `6` terminals: 2x3 or 3x2 grid
- `8` terminals: 2x4 grid
- `10`, `12` terminals: balanced MxN recursive split trees

### Backend Persistence (`src-tauri/src/workspace_presets.rs`)
- `save_recents(recents: Vec<RecentWorkspace>) -> Result<(), String>`
- `load_recents() -> Result<Vec<RecentWorkspace>, String>`
- `save_presets(presets: Vec<WorkspacePreset>) -> Result<(), String>`
- `load_presets() -> Result<Vec<WorkspacePreset>, String>`
- Stored under `appDataDir/recents.json` and `appDataDir/presets.json`.

### Frontend State & Transport
- `src/lib/workspace/transport.ts`: Invokes Tauri commands for recents and presets.
- `src/store/terminalStore.ts`:
  - `isSetupWizardOpen: boolean`
  - `wizardStep: 1 | 2 | 3`
  - `openSetupWizard: () => void`
  - `closeSetupWizard: () => void`
  - `launchCustomWorkspace: (config: WorkspaceConfig) => Promise<void>`
  - `recentWorkspaces: RecentWorkspace[]`
  - `workspacePresets: WorkspacePreset[]`
