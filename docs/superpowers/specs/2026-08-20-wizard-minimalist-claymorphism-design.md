# Workspace Setup Wizard: Minimalist + Claymorphism Redesign Specification

## 1. Overview & Goals

This specification details the comprehensive redesign of the **OPPA Workspace Setup Wizard** (`src/components/wizard/`). The redesign fuses two design languages:
1. **Utilitarian Editorial Minimalism** (from `.agents/skills/minimalist-skill/SKILL.md`): Clean typography, macro-whitespace, bento-grid layouts, monospace metadata/keystrokes, and high contrast.
2. **Tactile Claymorphism**: Soft matte 3D volume, dual specular inner rim highlights, recessed sunken input wells, and physical tactile click states on buttons and selector tiles.

The scope of this redesign is **strictly contained within the Workspace Setup Wizard components and styles**, elevating the onboarding experience into a physical, tangible dev workshop while integrating cleanly into OPPA's dark terminal theme.

---

## 2. Visual Architecture & Design Tokens

### Color Palette (Dark Matte Clay & Warm Amber)

```css
:root {
  /* Canvas & Containers */
  --wizard-bg-canvas: #0b0b0e;
  --wizard-bg-surface: #141419;
  --wizard-bg-surface-elevated: #1a1a22;
  --wizard-bg-surface-hover: #22222b;
  --wizard-bg-sunken: #0e0e12;

  /* Clay Borders & Specular Highlights */
  --wizard-border: rgba(255, 255, 255, 0.08);
  --wizard-border-subtle: rgba(255, 255, 255, 0.04);
  --wizard-border-highlight: rgba(255, 255, 255, 0.16);
  --wizard-specular-top: rgba(255, 255, 255, 0.12);

  /* Primary Accent & Amber Tones */
  --wizard-amber-primary: #f59e0b;
  --wizard-amber-hover: #fbbf24;
  --wizard-amber-active: #d97706;
  --wizard-amber-glow: rgba(245, 158, 11, 0.25);
  --wizard-amber-surface: rgba(245, 158, 11, 0.08);
  --wizard-amber-border: rgba(245, 158, 11, 0.3);

  /* Typography */
  --wizard-text-primary: #f4f4f5;
  --wizard-text-secondary: #a1a1aa;
  --wizard-text-muted: #71717a;

  /* Clay Shadows */
  --wizard-shadow-card: 0 10px 30px -5px rgba(0, 0, 0, 0.6), inset 0 1px 1px 0 rgba(255, 255, 255, 0.1), inset 0 -1px 2px 0 rgba(0, 0, 0, 0.4);
  --wizard-shadow-card-elevated: 0 14px 36px -6px rgba(0, 0, 0, 0.7), inset 0 1px 1.5px 0 rgba(255, 255, 255, 0.16), inset 0 -1px 2px 0 rgba(0, 0, 0, 0.4);
  --wizard-shadow-tile-active: 0 8px 24px -2px rgba(245, 158, 11, 0.25), inset 0 1px 1px 0 rgba(255, 255, 255, 0.2), inset 0 -1px 2px 0 rgba(0, 0, 0, 0.3);
  --wizard-shadow-sunken: inset 0 2px 5px 0 rgba(0, 0, 0, 0.5), 0 1px 0 0 rgba(255, 255, 255, 0.04);
  --wizard-shadow-btn-primary: 0 4px 14px rgba(245, 158, 11, 0.35), inset 0 1px 1px rgba(255, 255, 255, 0.35), inset 0 -2px 4px rgba(0, 0, 0, 0.3);
}
```

---

## 3. Detailed Component Specifications

### 3.1 Page Container & Top Header
- **Layout**: Centered container with max-width `760px` and generous macro-whitespace padding (`40px 24px 60px`).
- **Logo Badge**: Soft rounded matte pill with amber rim and subtle inner glow (`OPPA`).
- **Heading**: Editorial typography with tight tracking (`Workspace Setup`).
- **Close Button**: Physical matte square button with rounded corners (`border-radius: 8px`) and tactile hover press.

### 3.2 Pebble Progress Stepper Bar
- **Structure**: Horizontal pill bar containing three tactile pebble buttons:
  - Step 1: `1 Start`
  - Step 2: `2 Layout`
  - Step 3: `3 Agents`
- **States**:
  - *Active*: Raised clay pill with amber border, glowing step number circle, and soft bottom drop shadow.
  - *Completed*: Subtle elevated matte pill with white number badge.
  - *Upcoming*: Muted recessed pill.
- **Divider**: Smooth glowing amber horizontal connector between steps.

### 3.3 Step 1: Start (Name & Shell)
- **Sections**: Asymmetrical bento card layout.
- **Inputs**:
  - Sunken well container with recessed inner shadow (`--wizard-shadow-sunken`).
  - Warm amber glowing outline on `:focus-within`.
  - Placeholder styling in muted charcoal with monospace hints.
- **Shell Dropdown**: Custom clay selector with subtle chevron and styled options.

### 3.4 Step 2: Layout & Presets
- **Tactile Keycap Grid Selector Tiles (1, 2, 4, 6, 8, 10, 12)**:
  - Modeled after mechanical keycaps with top bevel highlights (`inset 0 1px 1px rgba(255,255,255,0.15)`).
  - Terminal miniature layout boxes visually render the grid partition (e.g. 2x2, 2x3, 3x4).
  - Selected state glows in amber with tactile depression and indicator dot.
- **Quick Jump `cd` Bar**:
  - Sunken command bar with prefix `> cd`, input, and physical `<kbd>Enter ↵</kbd>` badge.
  - Tactile forward arrow jump button.
- **Recents & Presets Bento Grid**:
  - Recents rendered as interactive cards with folder icon, title, path, and badge.
  - Presets displayed as clay pill chips with a dashed `+ NEW` preset creator chip.

### 3.5 Step 3: Agents & Startup Commands
- **AI Persona Cards (Copilot, Code Assistant, Reviewer, Grok, GPT-5, None)**:
  - 3-column bento grid of clay cards.
  - Each card contains an icon in a raised clay container, status badge, title, and concise description.
  - Active card features warm amber border and soft amber inner glow.
- **Startup Commands List**:
  - Numbered physical clay tags (`P1`, `P2`, `...`, `Pn`) paired with sunken input wells.
- **Preset Save Toggle**:
  - Custom clay checkbox with tactile checkmark and smooth expand transition for the preset name field.

### 3.6 Bottom Action Footer
- **Back Button**: Ghost clay button with left arrow icon (`ArrowLeft`).
- **Quick Spawn**: Secondary tactile amber pill with lighting icon (`Zap`) for instant 1x1 terminal launch.
- **Next / Launch Workspace**: Dominant 3D clay CTA with rich amber gradient, top specular highlight, and tactile press animation.

---

## 4. Micro-Interactions & Animation Standards

1. **Card Hover**: Smooth lift (`transform: translateY(-2px)`) with expanded shadow over `180ms ease`.
2. **Tactile Press (Active)**: Crisp physical down-press (`transform: translateY(1px) scale(0.985)`) over `100ms ease`.
3. **Step Transition**: Gentle slide-fade between steps (`opacity` + `translateY(8px)` resolving in `220ms cubic-bezier(0.16, 1, 0.3, 1)`).
4. **Performance**: Animations exclusively use `transform`, `opacity`, and `box-shadow` to ensure 60fps GPU acceleration.

---

## 5. File Architecture & Changes

- `src/components/wizard/WorkspaceSetupWizard.css`: Complete redesign of all wizard styling with minimalist clay tokens.
- `src/components/wizard/WorkspaceSetupWizard.tsx`: Updated component markup, semantic attributes, and structure.
- `src/components/wizard/WizardStepStart.tsx`: Refined typography, input wrappers, and clay containers.
- `src/components/wizard/WizardStepLayout.tsx`: Updated grid keycap tiles, cd quick-jump bar, and bento cards.
- `src/components/wizard/WizardStepAgents.tsx`: Updated persona grid, command rows, and preset save section.
- `src/components/wizard/WorkspaceSetupWizard.test.tsx` & `WizardStepLayout.test.tsx`: Verified and updated test suites.

---

## 6. Verification Plan

1. **Automated Vitest Suite**: Run all wizard unit tests (`WorkspaceSetupWizard.test.tsx`, `WizardStepLayout.test.tsx`, `App.test.tsx`).
2. **Build Verification**: Run `pnpm build` (`tsc && vite build`) to confirm zero type errors or bundle issues.
3. **Desktop Tauri Verification**: Verify responsive layout and keyboard accessibility (Esc, Enter, Tab).
