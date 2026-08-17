# Inline Workspace Wizard & Minimalist UI Redesign Specification

## Design Read
> Reading this as: Developer workstation setup cockpit for technical terminal users, with a high-end utilitarian minimalist aesthetic (warm zinc-monochrome, crisp 1px borders, bespoke typographic contrast, airy macro-whitespace, no popup modals, full workbench integration per `taste-skill` & `minimalist-ui`).

---

## 1. Interaction Model & Architecture

### Full-Page Center Section Integration
1. **`+` Button Flow**:
   - Clicking `+` in either the **TabBar** or the **Left Sidebar** calls `createWizardTab()`.
   - Adds a new workspace entry to `tabs` with `{ id: tabId, title: "New Workspace", isWizard: true, layout: { type: "leaf", id: "" } }` and selects it as `activeTabId`.
   - The **Left Sidebar** immediately lists this new workspace card (`New Workspace`) alongside existing workspaces.
   - The **Main Center Section** detects `activeTab.isWizard === true`:
     - Hides the terminal split Toolbar.
     - Renders `<WorkspaceSetupWizard tabId={activeTab.id} />` full-bleed inside the center section workbench.
     - **Left Sidebar** and **Right Sidebar** remain visible, interactive, and resizable.
2. **Multi-Tab Isolation (Zero Conflict)**:
   - Other terminal tabs remain running in the background.
   - Users can freely click between existing terminal workspaces and the "New Workspace" setup tab via TabBar or Left Sidebar.
3. **Completion & Transition**:
   - Clicking `Launch Workspace` or `Quick Spawn` calls `launchWorkspaceForTab(tabId, config)`:
     - Spawns configured session(s) in `config.cwd`.
     - Generates the recursive split tree layout.
     - Updates the tab (`isWizard: false`, `layout: newLayout`, `title: resolvedTitle`).
     - Closes the wizard view in-place, instantly revealing the live terminal grid.
4. **Cancellation**:
   - Closing the tab (`X` in TabBar or Left Sidebar, or clicking `Cancel`) simply calls `closeTab(tabId)`, returning focus to the previous workspace without disrupting any shells.

---

## 2. Minimalist UI & Aesthetic Directives (`taste-skill` & `minimalist-ui`)

### Color & Materiality
- **Background**: `#09090b` (pure dark canvas)
- **Surfaces / Cards**: `#121214` (subtle elevation, no heavy drop shadows)
- **Borders & Dividers**: `1px solid rgba(255, 255, 255, 0.07)` (crisp hairline borders)
- **Text Hierarchy**:
  - Primary: `#fafafa`
  - Secondary / Muted: `#71717a`
  - Meta / Code: `#a1a1aa` (`var(--font-mono)`)
- **Spot Accent**: Warm amber (`#f59e0b` / `rgba(245, 158, 11, 0.15)`) for the active step pill and selected grid tile indicator.

### Component Design
1. **Header & Progress Indicator**:
   - Minimalist stepper with numbered circle chips `1 Start`, `2 Layout`, `3 Agents` connected by subtle hairline dividers.
   - Title: `Set up your workspace` with tight tracking (`letter-spacing: -0.02em`), and clean subtext `Pick a folder to work in and choose how many terminals you want.`
2. **Working Folder & `cd` Jump**:
   - Clean dark input with folder icon and search button.
   - Integrated mono `> cd <subpath>` jump line with `<kbd>` trigger and arrow button.
3. **Terminal Grid Layout Tiles**:
   - Clean square tiles for `1`, `2`, `4`, `6`, `8`, `10`, `12` terminals with minimalist micro-grid preview boxes.
   - Live badge: `X terminals   NxM grid`.
4. **Recent Workspaces & Presets**:
   - 2-column cards for Recents with clean empty state when no recents exist.
   - Subtle preset chips with `+ NEW` custom template trigger.
5. **Agents & Startup Commands (Step 3)**:
   - Clean assistant persona selector cards.
   - Per-terminal startup command inputs with mono font.
6. **Action Footer**:
   - Left: `< Back` button (or `Cancel`).
   - Center: `⚡ Quick Spawn` link for 1-click single shell.
   - Right: High-contrast `#fafafa` `Launch Workspace` button.

---

## 3. Testing Strategy
- Unit & integration tests for:
  - Store: `createWizardTab`, `launchWorkspaceForTab`, multi-tab wizard switching.
  - Component: `WorkspaceSetupWizard` rendering inline full-page in center section, step progression, layout generation, folder navigation, preset pre-fill, and launching live grid.
  - Shell integration: `AppShell` and `TabBar` rendering wizard tab and hiding toolbar on wizard active tab.
