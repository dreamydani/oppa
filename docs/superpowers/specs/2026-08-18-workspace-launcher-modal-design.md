# Workspace & Project Launcher Modal Design Specification

## Overview

This specification defines the visual design, component architecture, keyboard navigation, and interaction model for the **Workspace & Project Launcher Modal** in OPPA. 

When the user clicks the `+` (New Workspace) button in the Left Sidebar or triggers the `Ctrl+N` / `Cmd+N` shortcut, a Raycast / Spotlight-style Command Palette appears in the center of the application window to let the user create a new empty workspace, select a local folder, clone a repository, or open a recent project.

---

## 1. Visual & Layout Design

### Visual Palette
The modal adheres strictly to the `#141414` / `#212120` design token system:
- **Backdrop Overlay**: `rgba(0, 0, 0, 0.65)` with `backdrop-filter: blur(4px)`.
- **Card Container**: `background-color: var(--card, #282827)`, `border: 1px solid var(--border, rgba(255, 255, 255, 0.07))`, `border-radius: var(--radius-lg, 8px)`, `box-shadow: 0 16px 36px rgba(0, 0, 0, 0.6)`.
- **Width / Max Dimensions**: `width: 540px; max-width: 90vw; max-height: 420px`.
- **Search Header**: Pinned at the top with a search icon, clean borderless input (`background: transparent`, `color: var(--foreground, #ededec)`), and an `Esc` badge.
- **Section Headers**: Small uppercase category labels (`color: var(--muted-foreground, #9e9e9a)`, `font-size: 11px`, `letter-spacing: 0.05em`).
- **Item Rows**:
  - Unselected: `background: transparent`, `color: var(--foreground, #ededec)`.
  - Selected / Hovered: `background-color: var(--muted, #2e2e2d)`, `border-radius: var(--radius-sm, 4px)`.
  - Left icon: `16px` lucide icon (`color: var(--muted-foreground)` or `color: var(--foreground)` when selected).
  - Primary text: `font-size: 13px; font-weight: 500`.
  - Subtitle / Path: `font-size: 11px; color: var(--muted-foreground); font-family: var(--font-mono)`.
  - Shortcut badge: `font-family: var(--font-mono); font-size: 11px; padding: 2px 5px; background: rgba(255, 255, 255, 0.06); border-radius: 3px; color: var(--muted-foreground)`.

---

## 2. Items & Data Structure

### Actions Section
1. **New Empty Workspace**
   - Icon: `TerminalSquare`
   - Description: "Start a fresh terminal session"
   - Shortcut Badge: `↵`
2. **Open Local Project Folder...**
   - Icon: `Folder`
   - Description: "Select a folder from your filesystem"
   - Shortcut Badge: `Ctrl+O` (Windows/Linux) or `⌘O` (macOS)
3. **Clone Git Repository...**
   - Icon: `GitBranch`
   - Description: "Clone from GitHub, GitLab, or URL"
   - Shortcut Badge: `Ctrl+G` (Windows/Linux) or `⌘G` (macOS)

### Recent Projects Section
1. **`oppa`** — `D:/oppa/oppa` (Icon: `FolderGit2` or `Folder`)
2. **`frontend-core`** — `~/dev/frontend-core` (Icon: `Folder`)
3. **`terminal-engine`** — `~/projects/terminal-engine` (Icon: `Folder`)

---

## 3. Keyboard Navigation & Interaction

- **Open**:
  - Clicking `+` icon button in Left Sidebar header.
  - Global hotkey: `Ctrl+N` / `Cmd+N`.
- **Search Filtering**: Typing in the search input filters both action titles and recent project names/paths in real time. If no items match, an empty state ("No matching workspaces or actions") is displayed.
- **Selection**:
  - `ArrowDown`: Moves selection down (wraps to top).
  - `ArrowUp`: Moves selection up (wraps to bottom).
  - `Enter` / Mouse Click: Activates selected item.
- **Dismiss**:
  - `Escape` key.
  - Clicking outside the modal container on the backdrop overlay.
- **Action Execution (Visual / Mock Phase)**:
  - **New Empty Workspace**: calls `createTab()` and closes the modal.
  - **Open Project / Recent Project**: creates a new workspace tab initialized with the target title and directory, then closes the modal.

---

## 4. Component Hierarchy

```
src/
├── components/
│   ├── sidebar/
│   │   ├── WorkspaceList.tsx       # Updated to open launcher on '+' click
│   │   └── LeftSidebar.tsx
│   └── modal/
│       ├── WorkspaceLauncherModal.tsx      # Modal component
│       ├── WorkspaceLauncherModal.css      # Modal stylesheet
│       └── WorkspaceLauncherModal.test.tsx # Unit tests
└── store/
    └── terminalStore.ts            # isWorkspaceLauncherOpen state & actions
```

---

## 5. Testing Plan

1. **State Store Unit Tests**:
   - `openWorkspaceLauncher()` sets `isWorkspaceLauncherOpen = true`.
   - `closeWorkspaceLauncher()` sets `isWorkspaceLauncherOpen = false`.
2. **Component Tests (`WorkspaceLauncherModal.test.tsx`)**:
   - Renders search input and action/recent items.
   - Filters list based on search query.
   - Handles `ArrowUp`, `ArrowDown`, and `Enter` keyboard events.
   - Closes on `Escape` key or backdrop click.
   - Calls `createTab` with appropriate project parameters on item selection.
3. **Left Sidebar Integration**:
   - Clicking `+` button invokes `openWorkspaceLauncher`.
