# OPPA User Interface Design Specification

**Date:** 2026-08-17  
**Branch:** `User-Interface`  
**Status:** Approved by User  
**Reference:** Orca Desktop Terminal (`D:\orca\orca`)

---

## 1. Overview & Objective

OPPA is a high-performance, low-memory desktop terminal built with Tauri 2, Rust, React 19, TypeScript, and Vite.

This milestone implements the **User Interface (UI)** foundation, elevating OPPA from a standalone terminal split-view into a full 3-column developer workspace cockpit inspired by Orca's aesthetics and architecture:
- **Collapsible & Resizable Left Sidebar**: Workspaces, tab/session management, and view navigation.
- **Center Main Section**: Custom titlebar/chrome, advanced tab bar, multi-pane terminal grid (`xterm.js`), and bottom status bar.
- **Collapsible & Resizable Right Sidebar**: Activity panel featuring live **File Explorer** and **Git Source Control**.
- **Orca Visual Design System**: Modern dark/light theme CSS variables, typography, and crisp Lucide icons.
- **Functional Rust Backend**: Native Tauri commands for directory inspection (`fs_read_dir`) and git status inspection (`git_status`).

---

## 2. Layout Architecture

The top-level shell layout consists of a flexbox 3-column grid bounded by a top Titlebar and a bottom Status Bar:

```
┌────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│  TITLEBAR: [Toggle Left]  ──  📁 ~/projects/oppa  ── [🌿 main]  ──  [Toggle Right] [— □ ✕]            │
├──────────────┬─────────────────────────────────────────────────────────┬───────────────────────────────┤
│ LEFT SIDEBAR │ CENTER MAIN SECTION                                     │ RIGHT SIDEBAR                 │
│              │                                                         │                               │
│ [💻] [⚙️]    │ ┌─────────────────────────────────────────────────────┐ │ [📁 Explorer] [🌿 Git]        │
│              │ │ Tab 1: powershell ✕  │  Tab 2: bash ✕   │ [+]       │ │                               │
│ WORKSPACES   │ ├─────────────────────────┬───────────────────────────┤ │ 📁 oppa                       │
│ • oppa (main)│ │                         │                           │ │   ▸ src/                      │
│ • backend    │ │                         │                           │ │   ▸ src-tauri/                │
│              │ │   Terminal Pane 1       │   Terminal Pane 2         │ │   📄 package.json             │
│              │ │   (xterm.js)            │   (xterm.js)              │ │   📄 Cargo.toml               │
│              │ │                         │                           │ │                               │
│              │ └─────────────────────────┴───────────────────────────┘ │ (or Git Status: 3 modified)   │
├──────────────┴─────────────────────────────────────────────────────────┴───────────────────────────────┤
│ STATUS BAR: 🌿 main (±0)  │  📁 D:/oppa/oppa  │  80x24  │  Ready                                      │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Dimensions & Resizing Constraints
- **Left Sidebar**:
  - Default width: `240px`
  - Min width: `180px`, Max width: `420px`
  - Collapsible to `0px` via toggle button or shortcut (`Ctrl+B` / `Cmd+B`).
  - Draggable resize divider on the right edge.
- **Right Sidebar**:
  - Default width: `280px`
  - Min width: `200px`, Max width: `480px`
  - Collapsible to `0px` via toggle button or shortcut (`Ctrl+Shift+B` / `Cmd+Shift+B`).
  - Draggable resize divider on the left edge.
- **Titlebar**: Height `38px` with non-drag interactive button zones and drag region for moving the Tauri window.
- **Status Bar**: Height `26px` at the bottom edge.

---

## 3. Visual Design System & Theme Tokens

We implement a Vanilla CSS token system directly matching Orca's refined neutral palette.

### 3.1 CSS Design Variables (`src/styles/theme.css`)

```css
:root {
  /* Font Families */
  --font-sans: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --font-mono: 'SF Mono', Consolas, 'Cascadia Code', Menlo, monospace;

  /* Typography & Sizing */
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;

  /* Dark Theme (Default) */
  --background: #0a0a0a;
  --foreground: #fafafa;
  --card: #171717;
  --card-foreground: #fafafa;
  --sidebar: #121212;
  --sidebar-foreground: #fafafa;
  --sidebar-border: rgba(255, 255, 255, 0.08);
  --border: rgba(255, 255, 255, 0.08);
  --muted: #262626;
  --muted-foreground: #a1a1a1;
  --accent: #2c2c2c;
  --accent-foreground: #ffffff;
  --primary: #e5e5e5;
  --primary-foreground: #171717;
  --destructive: #ff6568;
  --ring: #737373;
  --git-added: #4ade80;
  --git-modified: #fbbf24;
  --git-deleted: #f87171;
  --git-untracked: #a3e635;
}
```

---

## 4. Component Structure & Data Flow

### 4.1 Component Hierarchy
```
src/
├── components/
│   ├── layout/
│   │   ├── AppShell.tsx            # Main 3-column container & resize management
│   │   ├── Titlebar.tsx            # Top window bar with breadcrumbs & sidebar toggles
│   │   ├── StatusBar.tsx           # Bottom bar with git branch, CWD, terminal stats
│   │   └── ResizeHandle.tsx        # Draggable vertical splitter handles
│   ├── sidebar/
│   │   ├── LeftSidebar.tsx         # Left sidebar root
│   │   ├── WorkspaceNav.tsx        # Vertical/top icon navigation
│   │   └── WorkspaceList.tsx       # Live tabs & sessions list with CWD and status dots
│   ├── right-sidebar/
│   │   ├── RightSidebar.tsx        # Right sidebar root
│   │   ├── ActivityBar.tsx         # Explorer / Git tab switcher
│   │   ├── FileExplorer.tsx        # Directory tree viewer with collapsible folders
│   │   └── GitSourceControl.tsx    # Live git changes, branch name, file status badges
│   ├── TabBar.tsx                  # Tab bar (multi-tab switcher, add tab, close tab)
│   ├── Toolbar.tsx                 # Split horizontal/vertical buttons, close pane
│   ├── PaneSplit.tsx               # Recursive binary terminal split tree
│   ├── SessionLeaf.tsx             # Terminal pane container
│   ├── TerminalPane.tsx            # xterm.js instance with PTY bindings
│   └── TerminalSearch.tsx          # Terminal buffer search bar
```

### 4.2 State Management (`src/store/terminalStore.ts`)
The Zustand store is extended to manage UI state seamlessly alongside terminal sessions:
- **UI State**:
  - `leftSidebarOpen: boolean` (default `true`)
  - `leftSidebarWidth: number` (default `240`)
  - `rightSidebarOpen: boolean` (default `true`)
  - `rightSidebarWidth: number` (default `280`)
  - `rightSidebarTab: 'explorer' | 'git'` (default `'explorer'`)
  - `toggleLeftSidebar: () => void`
  - `setLeftSidebarWidth: (width: number) => void`
  - `toggleRightSidebar: () => void`
  - `setRightSidebarWidth: (width: number) => void`
  - `setRightSidebarTab: (tab: 'explorer' | 'git') => void`
- **Active Workspace / CWD Accessor**:
  - Computed active session's working directory (`cwd`) for live File Explorer and Git status updates.

---

## 5. Backend Additions (`src-tauri`)

### 5.1 Native Tauri Commands

1. **`fs_read_dir(path: String) -> Result<Vec<FileEntry>, String>`**
   - Path traversal in Rust using `std::fs::read_dir`.
   - Returns structured `FileEntry` objects:
     ```rust
     #[derive(Serialize)]
     pub struct FileEntry {
         pub name: String,
         pub path: String,
         pub is_dir: bool,
         pub size: u64,
     }
     ```
   - Sorts directories first, followed by alphabetical file names.

2. **`git_status(path: String) -> Result<GitStatusResult, String>`**
   - Executes `git status --porcelain=v1 -b` in the target working directory.
   - Parses the output to extract:
     ```rust
     #[derive(Serialize)]
     pub struct GitStatusResult {
         pub branch: String,
         pub files: Vec<GitFileStatus>,
         pub ahead: usize,
         pub behind: usize,
     }
     
     #[derive(Serialize)]
     pub struct GitFileStatus {
         pub path: String,
         pub status: String, // "M", "A", "D", "??", "R"
     }
     ```
   - Gracefully handles non-git folders without crashing or throwing unhandled errors.

---

## 6. Testing Strategy

1. **Rust Tests (`cargo test -p oppa --lib`)**:
   - Unit tests for `fs_read_dir`: valid paths, sorting order, hidden files, non-existent directories.
   - Unit tests for `git_status`: porcelain parser correctness, non-git directory handling.
2. **Renderer Tests (`pnpm vitest run`)**:
   - Unit tests for `AppShell`, `LeftSidebar`, `RightSidebar`, `FileExplorer`, `GitSourceControl`, `Titlebar`, and `StatusBar`.
   - Interaction tests for collapsing, resizing, switching tabs, and selecting files.
3. **End-to-End Verification**:
   - Build verification with `pnpm build` (TypeScript + Vite) and `cargo check`.

---

## 7. Next Steps
Upon user review and confirmation of this spec document, transition directly to the **`writing-plans`** skill to draft the granular, task-by-task implementation plan.
