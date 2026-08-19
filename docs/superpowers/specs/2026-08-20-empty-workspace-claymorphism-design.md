# Design Specification: Empty Workspace View Redesign (Minimalist Claymorphism)

**Date:** 2026-08-20  
**Feature:** Redesign `No Open Workspaces` Empty View to Minimalist Claymorphism  
**Branch:** `feat/wizard-minimalist-claymorphism`

---

## 1. Overview & Objectives

Align the empty state screen rendered when no workspace tabs are open (`.empty-workspace-view` in `src/App.tsx`) with the new **Minimalist + Claymorphism** design system established in the Workspace Setup Wizard.

### Key Changes
1. **Remove `+ New Terminal` Button**: Eliminate the standalone raw terminal creation button on this screen.
2. **Single Dominant CTA: `New Workspace`**: Render a single, dominant 3D tactile white clay button labeled **"New Workspace"** that triggers `createWizardTab()`.
3. **Claymorphic Visual Language**: Elevated dark clay card (`#141419` / `#18181f`), specular rim highlight (`inset 0 1px 1px rgba(255, 255, 255, 0.12)`), tactile monochrome icon box (`>_`), and 3D `<kbd>` shortcut badges.

---

## 2. Component & UI Architecture

### 2.1 Component Structure (`src/App.tsx`)
```tsx
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
```

### 2.2 CSS Styles (`src/App.css`)
- **Card (`.empty-workspace-card`)**:
  - Background: `#141419`
  - Border: `1px solid rgba(255, 255, 255, 0.08)`
  - Box-shadow: `0 14px 36px -6px rgba(0, 0, 0, 0.7), inset 0 1px 1.5px rgba(255, 255, 255, 0.12), inset 0 -1px 2px rgba(0, 0, 0, 0.4)`
  - Border-radius: `14px`
  - Padding: `38px 32px`
- **Icon Container (`.empty-workspace-icon`)**:
  - Raised clay container (`48px x 48px`, border radius `10px`, background `#18181f`, border `1px solid rgba(255, 255, 255, 0.1)`, box-shadow `0 4px 12px rgba(0, 0, 0, 0.4)`)
  - Icon: Monochrome slate / white terminal glyph (`#e4e4e7`).
- **Single Primary Button (`.empty-action-btn.primary`)**:
  - Background: `#fafafa`
  - Border: `1px solid #fafafa`
  - Color: `#09090b`
  - Font weight: `600`
  - Padding: `10px 22px`
  - Border-radius: `10px`
  - Box-shadow: `0 4px 14px rgba(0, 0, 0, 0.5), inset 0 1px 1px rgba(255, 255, 255, 0.8), inset 0 -2px 3px rgba(0, 0, 0, 0.25)`
  - Hover: `background: #ffffff; transform: translateY(-1px); box-shadow: 0 6px 18px rgba(0, 0, 0, 0.6), inset 0 1px 1.5px rgba(255, 255, 255, 0.9);`
  - Active: `transform: translateY(1px) scale(0.985); box-shadow: inset 0 2px 5px rgba(0, 0, 0, 0.5);`
- **Shortcut Keycaps (`.empty-workspace-shortcut-hint kbd`)**:
  - Monospace font, background `#18181f`, border `1px solid rgba(255, 255, 255, 0.08)`, border-radius `4px`, padding `2px 6px`, box-shadow `inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 1px 2px rgba(0, 0, 0, 0.4)`.

---

## 3. Testing & Verification Plan

1. **Unit Tests (`src/App.test.tsx`)**:
   - Update tests expecting `+ New Terminal` or `Setup Wizard` to assert the single `New Workspace` button.
   - Verify clicking `New Workspace` calls `createWizardTab()`.
   - Verify keycap shortcut text is present.
2. **Full Regression Test Suite**:
   - `pnpm vitest run`
   - `pnpm tsc --noEmit` & `pnpm build`
   - `cargo test -p oppa --lib`
