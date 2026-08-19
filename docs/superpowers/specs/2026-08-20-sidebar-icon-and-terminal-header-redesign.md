# Design Specification: Sidebar Icon Fix & Terminal Header Redesign (Minimalist + Clay Fusion)

**Date:** 2026-08-20  
**Features:**
1. Remove duplicate icon in Left Sidebar tabs (`src/components/LeftSidebar.tsx`).
2. Redesign Terminal Pane Header with 80% Minimalist + 20% Clay Fusion (`src/components/TerminalPaneHeader.tsx`, `src/components/TerminalPaneHeader.css`).

---

## 1. Overview & Objectives

### 1.1 Item 1: Sidebar Duplicate Icon Removal
- In `src/components/LeftSidebar.tsx`, the tab card currently renders an avatar icon on the left (`.tab-card-avatar`) and also renders a duplicate icon in the title row (`.tab-card-app-icon`).
- **Fix**: Remove the redundant `.tab-card-app-icon` element from `.tab-card-row-top` so each tab card has exactly one clean icon badge on the left.

### 1.2 Item 2: Terminal Pane Header Redesign (80% Minimalist + 20% Clay Fusion)
- Align the Terminal Pane Header (`.terminal-pane-header`) with the Minimalist design system (`.agents/skills/minimalist-skill/SKILL.md`) blended with subtle tactile claymorphism (80% minimalist utilitarianism, 20% tactile clay depth).
- Refine header background, subtle specular rim highlights, clean typographic treatment, tactile micro-button actions, and minimalist dropdown menu.

---

## 2. Detailed Technical Design

### 2.1 Left Sidebar (`src/components/LeftSidebar.tsx`)
Update `.tab-card-row-top`:
```tsx
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

### 2.2 Terminal Pane Header Styling (`src/components/TerminalPaneHeader.css`)
- **Header Container (`.terminal-pane-header`)**:
  - Height: `34px`
  - Background: `#111115` (matte dark basalt)
  - Border-bottom: `1px solid rgba(255, 255, 255, 0.06)`
  - Inset shadow: `inset 0 1px 0 rgba(255, 255, 255, 0.06)` (subtle top specular highlight)
  - Focus state on active pane: `border-bottom-color: rgba(255, 255, 255, 0.12)`
- **Title (`.terminal-pane-title`)**:
  - Color: `#a1a1aa` (slate muted), active/focused color: `#fafafa`
  - Font size: `12px`, letter-spacing: `-0.01em`, font-weight: `500`
  - Hover: background `rgba(255, 255, 255, 0.05)`, border-radius `4px`
- **Rename Input (`.terminal-pane-header-rename-input`)**:
  - Background: `#0e0e12`, border: `1px solid rgba(255, 255, 255, 0.2)`
  - Color: `#fafafa`, font-size: `11.5px`, border-radius: `4px`
  - Box-shadow: `inset 0 1px 3px rgba(0, 0, 0, 0.5)`
- **Action Buttons (`.terminal-pane-header-btn`)**:
  - Size: `26px x 26px`, border-radius: `6px`
  - Color: `#71717a`
  - Hover: background `rgba(255, 255, 255, 0.06)`, border `1px solid rgba(255, 255, 255, 0.08)`, color `#fafafa`, transform `translateY(-0.5px)`
  - Active: transform `scale(0.95)`, box-shadow `inset 0 1px 2px rgba(0, 0, 0, 0.4)`
  - Active/Open Menu state: background `rgba(255, 255, 255, 0.1)`, border `1px solid rgba(255, 255, 255, 0.15)`, color `#fafafa`
  - Close button hover: background `rgba(239, 68, 68, 0.15)`, color `#f87171`, border `1px solid rgba(239, 68, 68, 0.3)`
- **Dropdown Menu (`.terminal-pane-header-menu`)**:
  - Background: `#18181f`, border: `1px solid rgba(255, 255, 255, 0.09)`
  - Border-radius: `8px`, box-shadow: `0 12px 28px -4px rgba(0, 0, 0, 0.7), inset 0 1px 1px rgba(255, 255, 255, 0.08)`
  - Menu items: hover background `rgba(255, 255, 255, 0.06)`, color `#f4f4f5`

---

## 3. Testing & Verification

1. **Unit & Component Tests**:
   - `src/components/LeftSidebar.test.tsx`: Verify tab rendering without duplicate icon.
   - `src/components/TerminalPaneHeader.test.tsx`: Verify header actions, renaming, and menu.
2. **Full Regression Suite**:
   - `pnpm vitest run`
   - `pnpm tsc --noEmit && pnpm build`
   - `cargo test -p oppa --lib`
