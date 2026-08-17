# User Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a high-fidelity 3-column developer workspace cockpit in OPPA featuring a collapsible/resizable Left Sidebar (workspaces and navigation), Main Center Section (custom titlebar, workbench tab bar, xterm terminal grid, bottom status bar), and Right Sidebar (live File Explorer and Git Source Control), styled with Orca's sleek dark/light theme tokens and Lucide icons.

**Architecture:** A responsive 3-column flexbox shell (`AppShell`) manages resizable sidebars and layout state in Zustand (`terminalStore`). The Left Sidebar lists active workspace tabs with running/idle status; the Center Section houses the active terminal split grid; the Right Sidebar provides an Activity Bar with live File Explorer and Git Source Control backed by lightweight Rust Tauri commands (`fs_read_dir`, `git_status`).

**Tech Stack:** Tauri 2, Rust, React 19, TypeScript, Vite, Zustand, xterm.js, Lucide React (`lucide-react`), Vitest, Testing Library.

## Global Constraints
- Target platforms: macOS, Linux, Windows.
- Keep comments concise: explain WHY, not HOW (1 line if possible).
- Never use vague file names (`helpers`, `utils`, `misc`).
- State vs transport split: components must never call Tauri `invoke` directly; invoke through dedicated `transport.ts` modules.
- TDD required: write failing test first, verify failure, implement, verify pass, commit.

---

### Task 1: Design Tokens, Theme CSS & Lucide Icons Scaffolding

**Files:**
- Modify: `package.json`
- Create: `src/styles/theme.css`
- Modify: `src/main.tsx:1-15`
- Test: `src/styles/theme.test.ts`

**Interfaces:**
- Consumes: None
- Produces: CSS custom properties (`--background`, `--sidebar`, `--border`, `--card`, `--foreground`, `--muted`, `--git-added`, etc.) and `lucide-react` package.

- [ ] **Step 1: Install `lucide-react` dependency**

Run: `pnpm add lucide-react`

- [ ] **Step 2: Write the failing test for theme CSS tokens**

Create `src/styles/theme.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Theme CSS", () => {
  it("defines all core Orca-matched CSS custom properties", () => {
    const css = readFileSync(resolve(__dirname, "theme.css"), "utf-8");
    expect(css).toContain("--background: #0a0a0a;");
    expect(css).toContain("--sidebar: #121212;");
    expect(css).toContain("--card: #171717;");
    expect(css).toContain("--border: rgba(255, 255, 255, 0.08);");
    expect(css).toContain("--foreground: #fafafa;");
    expect(css).toContain("--git-added: #4ade80;");
    expect(css).toContain("--git-modified: #fbbf24;");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/styles/theme.test.ts`  
Expected: FAIL (file does not exist)

- [ ] **Step 4: Create `src/styles/theme.css` and import in `src/main.tsx`**

Create `src/styles/theme.css`:
```css
:root {
  /* Fonts */
  --font-sans: 'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --font-mono: 'SF Mono', Consolas, 'Cascadia Code', Menlo, monospace;

  /* Sizing & Radius */
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;

  /* Core Colors */
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

  /* Git Status Colors */
  --git-added: #4ade80;
  --git-modified: #fbbf24;
  --git-deleted: #f87171;
  --git-untracked: #a3e635;
}

*, *::before, *::after {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 0;
  background-color: var(--background);
  color: var(--foreground);
  font-family: var(--font-sans);
  overflow: hidden;
  user-select: none;
  -webkit-font-smoothing: antialiased;
}
```

Update `src/main.tsx`:
```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/theme.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/styles/theme.test.ts`  
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/styles/theme.css src/styles/theme.test.ts src/main.tsx
git commit -m "feat: add design tokens, theme CSS, and lucide-react"
```

---

### Task 2: Rust Backend Commands for File System & Git

**Files:**
- Create: `src-tauri/src/fs.rs`
- Create: `src-tauri/src/git.rs`
- Modify: `src-tauri/src/lib.rs:1-40`
- Test: `src-tauri/src/fs.rs`, `src-tauri/src/git.rs`

**Interfaces:**
- Consumes: `std::fs`, `std::process::Command`
- Produces: Tauri commands `fs_read_dir` and `git_status`

- [ ] **Step 1: Write `src-tauri/src/fs.rs` with tests**

Create `src-tauri/src/fs.rs`:
```rust
use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
}

#[tauri::command]
pub fn fs_read_dir(path: String) -> Result<Vec<FileEntry>, String> {
    let dir_path = Path::new(&path);
    if !dir_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    if !dir_path.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    let mut entries = Vec::new();
    let read_dir = fs::read_dir(dir_path).map_err(|e| e.to_string())?;

    for entry in read_dir {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let metadata = entry.metadata().ok();
        let name = entry.file_name().to_string_lossy().to_string();
        let full_path = entry.path().to_string_lossy().to_string();
        let is_dir = file_type.is_dir();
        let size = metadata.map(|m| m.len()).unwrap_or(0);

        entries.push(FileEntry {
            name,
            path: full_path,
            is_dir,
            size,
        });
    }

    // Sort directories first, then alphabetical by name
    entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });

    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use tempfile::tempdir;

    #[test]
    fn test_fs_read_dir_returns_sorted_entries() {
        let dir = tempdir().unwrap();
        let dir_path = dir.path();

        File::create(dir_path.join("b_file.txt")).unwrap();
        File::create(dir_path.join("a_file.txt")).unwrap();
        fs::create_dir(dir_path.join("z_folder")).unwrap();
        fs::create_dir(dir_path.join("a_folder")).unwrap();

        let entries = fs_read_dir(dir_path.to_string_lossy().to_string()).unwrap();
        assert_eq!(entries.len(), 4);
        assert!(entries[0].is_dir && entries[0].name == "a_folder");
        assert!(entries[1].is_dir && entries[1].name == "z_folder");
        assert!(!entries[2].is_dir && entries[2].name == "a_file.txt");
        assert!(!entries[3].is_dir && entries[3].name == "b_file.txt");
    }

    #[test]
    fn test_fs_read_dir_nonexistent_returns_err() {
        let res = fs_read_dir("/nonexistent/path/for/oppa/test".to_string());
        assert!(res.is_err());
    }
}
```

- [ ] **Step 2: Write `src-tauri/src/git.rs` with tests**

Create `src-tauri/src/git.rs`:
```rust
use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GitFileStatus {
    pub path: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GitStatusResult {
    pub is_git: bool,
    pub branch: String,
    pub files: Vec<GitFileStatus>,
    pub ahead: usize,
    pub behind: usize,
}

#[tauri::command]
pub fn git_status(path: String) -> Result<GitStatusResult, String> {
    let dir = Path::new(&path);
    if !dir.exists() {
        return Err(format!("Directory does not exist: {}", path));
    }

    let output = Command::new("git")
        .arg("status")
        .arg("--porcelain=v1")
        .arg("-b")
        .current_dir(dir)
        .output();

    let output = match output {
        Ok(o) if o.status.success() => o,
        _ => {
            return Ok(GitStatusResult {
                is_git: false,
                branch: String::new(),
                files: Vec::new(),
                ahead: 0,
                behind: 0,
            });
        }
    };

    let text = String::from_utf8_lossy(&output.stdout);
    let mut lines = text.lines();

    let mut branch = "HEAD".to_string();
    let mut ahead = 0;
    let mut behind = 0;

    if let Some(branch_line) = lines.next() {
        let raw = branch_line.trim_start_matches("## ");
        let parts: Vec<&str> = raw.split("...").collect();
        let local_part = parts[0];
        branch = local_part.split(' ').next().unwrap_or("HEAD").to_string();

        if raw.contains("[ahead ") {
            if let Some(count_str) = raw.split("[ahead ").nth(1) {
                ahead = count_str.split(|c| c == ']' || c == ',').next().and_then(|s| s.parse().ok()).unwrap_or(0);
            }
        }
        if raw.contains("behind ") {
            if let Some(count_str) = raw.split("behind ").nth(1) {
                behind = count_str.split(']').next().and_then(|s| s.parse().ok()).unwrap_or(0);
            }
        }
    }

    let mut files = Vec::new();
    for line in lines {
        if line.len() < 3 {
            continue;
        }
        let status = line[0..2].trim().to_string();
        let file_path = line[3..].trim().to_string();
        files.push(GitFileStatus {
            path: file_path,
            status,
        });
    }

    Ok(GitStatusResult {
        is_git: true,
        branch,
        files,
        ahead,
        behind,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_git_status_non_git_folder() {
        let temp = tempfile::tempdir().unwrap();
        let result = git_status(temp.path().to_string_lossy().to_string()).unwrap();
        assert!(!result.is_git);
        assert_eq!(result.branch, "");
        assert_eq!(result.files.len(), 0);
    }
}
```

- [ ] **Step 3: Register `fs` and `git` modules in `src-tauri/src/lib.rs`**

Update `src-tauri/src/lib.rs`:
```rust
mod fs;
mod git;
mod layout;
mod pty;

// add fs::fs_read_dir, git::git_status to invoke_handler
```

- [ ] **Step 4: Run Rust tests to verify they pass**

Run: `cargo test -p oppa --lib` (in `src-tauri`)  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/fs.rs src-tauri/src/git.rs src-tauri/src/lib.rs
git commit -m "feat(rust): add fs_read_dir and git_status tauri commands"
```

---

### Task 3: Transport Layer & Store Extension for UI Layout & Workspace State

**Files:**
- Create: `src/lib/fs/transport.ts`
- Create: `src/lib/git/transport.ts`
- Modify: `src/store/terminalStore.ts`
- Test: `src/store/terminalStore.test.ts`

**Interfaces:**
- Consumes: `src/lib/fs/transport.ts`, `src/lib/git/transport.ts`
- Produces: `useTerminalStore` state properties: `leftSidebarOpen`, `leftSidebarWidth`, `rightSidebarOpen`, `rightSidebarWidth`, `rightSidebarTab`, `toggleLeftSidebar`, `toggleRightSidebar`, `setRightSidebarTab`, `getActiveCwd`.

- [ ] **Step 1: Create `src/lib/fs/transport.ts` and `src/lib/git/transport.ts`**

Create `src/lib/fs/transport.ts`:
```ts
import { invoke } from "@tauri-apps/api/core";

export interface FileEntry {
  name: String;
  path: String;
  is_dir: boolean;
  size: number;
}

export async function readDir(path: string): Promise<FileEntry[]> {
  return invoke<FileEntry[]>("fs_read_dir", { path });
}
```

Create `src/lib/git/transport.ts`:
```ts
import { invoke } from "@tauri-apps/api/core";

export interface GitFileStatus {
  path: string;
  status: string;
}

export interface GitStatusResult {
  is_git: boolean;
  branch: string;
  files: GitFileStatus[];
  ahead: number;
  behind: number;
}

export async function getGitStatus(path: string): Promise<GitStatusResult> {
  return invoke<GitStatusResult>("git_status", { path });
}
```

- [ ] **Step 2: Write tests for store UI slice in `src/store/terminalStore.test.ts`**

Update `src/store/terminalStore.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { useTerminalStore } from "./terminalStore";

describe("TerminalStore UI State", () => {
  it("initializes with sidebars open and default widths", () => {
    const s = useTerminalStore.getState();
    expect(s.leftSidebarOpen).toBe(true);
    expect(s.leftSidebarWidth).toBe(240);
    expect(s.rightSidebarOpen).toBe(true);
    expect(s.rightSidebarWidth).toBe(280);
    expect(s.rightSidebarTab).toBe("explorer");
  });

  it("toggles left sidebar visibility", () => {
    useTerminalStore.getState().toggleLeftSidebar();
    expect(useTerminalStore.getState().leftSidebarOpen).toBe(false);
    useTerminalStore.getState().toggleLeftSidebar();
    expect(useTerminalStore.getState().leftSidebarOpen).toBe(true);
  });

  it("updates right sidebar tab", () => {
    useTerminalStore.getState().setRightSidebarTab("git");
    expect(useTerminalStore.getState().rightSidebarTab).toBe("git");
  });
});
```

- [ ] **Step 3: Update `src/store/terminalStore.ts` with UI state slice**

Add UI state fields and methods to `TerminalState` and `useTerminalStore`:
```ts
export interface TerminalState {
  // existing fields...
  leftSidebarOpen: boolean;
  leftSidebarWidth: number;
  rightSidebarOpen: boolean;
  rightSidebarWidth: number;
  rightSidebarTab: "explorer" | "git";
  toggleLeftSidebar: () => void;
  setLeftSidebarWidth: (width: number) => void;
  toggleRightSidebar: () => void;
  setRightSidebarWidth: (width: number) => void;
  setRightSidebarTab: (tab: "explorer" | "git") => void;
  getActiveCwd: () => string | undefined;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/store/terminalStore.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/fs/transport.ts src/lib/git/transport.ts src/store/terminalStore.ts src/store/terminalStore.test.ts
git commit -m "feat: add fs/git transport helpers and store UI state"
```

---

### Task 4: Left Sidebar (View Nav Strip + Workspaces & Tabs List + Resize Handle)

**Files:**
- Create: `src/components/sidebar/LeftSidebar.tsx`
- Create: `src/components/sidebar/WorkspaceNav.tsx`
- Create: `src/components/sidebar/WorkspaceList.tsx`
- Create: `src/components/sidebar/LeftSidebar.css`
- Test: `src/components/sidebar/LeftSidebar.test.tsx`

**Interfaces:**
- Consumes: `useTerminalStore` (`tabs`, `activeTabId`, `selectTab`, `createTab`, `closeTab`, `renameTab`, `leftSidebarOpen`, `leftSidebarWidth`, `setLeftSidebarWidth`)
- Produces: `<LeftSidebar />` component

- [ ] **Step 1: Write failing component test for `LeftSidebar`**

Create `src/components/sidebar/LeftSidebar.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LeftSidebar } from "./LeftSidebar";
import { useTerminalStore } from "../../store/terminalStore";

describe("LeftSidebar", () => {
  it("renders workspace tabs list and add workspace button", () => {
    render(<LeftSidebar />);
    expect(screen.getByText("WORKSPACES")).toBeDefined();
    expect(screen.getByTitle("New Workspace")).toBeDefined();
  });

  it("adds a new tab when clicking new workspace button", async () => {
    render(<LeftSidebar />);
    const addBtn = screen.getByTitle("New Workspace");
    fireEvent.click(addBtn);
    expect(useTerminalStore.getState().tabs.length).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/sidebar/LeftSidebar.test.tsx`  
Expected: FAIL

- [ ] **Step 3: Implement `LeftSidebar`, `WorkspaceNav`, `WorkspaceList`, and `LeftSidebar.css`**

Create `src/components/sidebar/LeftSidebar.css`:
```css
.left-sidebar {
  display: flex;
  flex-direction: row;
  height: 100%;
  background-color: var(--sidebar);
  border-right: 1px solid var(--sidebar-border);
  position: relative;
  flex-shrink: 0;
}
.workspace-nav {
  width: 44px;
  border-right: 1px solid var(--sidebar-border);
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 8px 0;
  gap: 8px;
}
.workspace-nav-btn {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-md);
  border: none;
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}
.workspace-nav-btn.active, .workspace-nav-btn:hover {
  background: var(--accent);
  color: var(--accent-foreground);
}
.workspace-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.workspace-header {
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  font-size: 11px;
  font-weight: 600;
  color: var(--muted-foreground);
  letter-spacing: 0.05em;
  border-bottom: 1px solid var(--sidebar-border);
}
.workspace-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.workspace-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 12px;
  color: var(--foreground);
}
.workspace-card.active {
  background: var(--accent);
  color: var(--accent-foreground);
}
.resize-handle-right {
  position: absolute;
  top: 0;
  right: -3px;
  width: 6px;
  height: 100%;
  cursor: col-resize;
  z-index: 10;
}
```

Implement `LeftSidebar.tsx`, `WorkspaceNav.tsx`, and `WorkspaceList.tsx` using `lucide-react` icons (`Terminal`, `Settings`, `Plus`, `Trash2`, `Folder`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/sidebar/LeftSidebar.test.tsx`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/sidebar/
git commit -m "feat: add LeftSidebar with workspace navigation and tabs hub"
```

---

### Task 5: Right Sidebar (Activity Bar + File Explorer + Git Source Control + Resize Handle)

**Files:**
- Create: `src/components/right-sidebar/RightSidebar.tsx`
- Create: `src/components/right-sidebar/ActivityBar.tsx`
- Create: `src/components/right-sidebar/FileExplorer.tsx`
- Create: `src/components/right-sidebar/GitSourceControl.tsx`
- Create: `src/components/right-sidebar/RightSidebar.css`
- Test: `src/components/right-sidebar/RightSidebar.test.tsx`

**Interfaces:**
- Consumes: `src/lib/fs/transport.ts`, `src/lib/git/transport.ts`, `useTerminalStore`
- Produces: `<RightSidebar />` component

- [ ] **Step 1: Write failing component test for `RightSidebar`**

Create `src/components/right-sidebar/RightSidebar.test.tsx`:
```tsx
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RightSidebar } from "./RightSidebar";
import { useTerminalStore } from "../../store/terminalStore";

describe("RightSidebar", () => {
  it("renders Activity Bar tabs for Explorer and Git", () => {
    render(<RightSidebar />);
    expect(screen.getByTitle("File Explorer")).toBeDefined();
    expect(screen.getByTitle("Source Control")).toBeDefined();
  });

  it("switches tabs between Explorer and Git", () => {
    render(<RightSidebar />);
    const gitTab = screen.getByTitle("Source Control");
    fireEvent.click(gitTab);
    expect(useTerminalStore.getState().rightSidebarTab).toBe("git");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/right-sidebar/RightSidebar.test.tsx`  
Expected: FAIL

- [ ] **Step 3: Implement `RightSidebar`, `ActivityBar`, `FileExplorer`, `GitSourceControl`, and `RightSidebar.css`**

Implement `RightSidebar.css` and the components:
- `ActivityBar.tsx`: Top/side switcher between 📁 Explorer and 🌿 Git using Lucide icons (`Files`, `GitBranch`, `RefreshCw`).
- `FileExplorer.tsx`: Fetches `readDir(cwd)` and renders collapsible directories and files.
- `GitSourceControl.tsx`: Fetches `getGitStatus(cwd)` and renders branch badge, modified/staged files with colored status tags (`M`, `A`, `D`, `??`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/components/right-sidebar/RightSidebar.test.tsx`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/right-sidebar/
git commit -m "feat: add RightSidebar with File Explorer and Git Source Control"
```

---

### Task 6: Center Main Section (Custom Titlebar + Workbench Integration + Status Bar)

**Files:**
- Create: `src/components/layout/Titlebar.tsx`
- Create: `src/components/layout/StatusBar.tsx`
- Create: `src/components/layout/Titlebar.css`
- Create: `src/components/layout/StatusBar.css`
- Modify: `src/components/TabBar.tsx`
- Modify: `src/components/Toolbar.tsx`
- Test: `src/components/layout/Titlebar.test.tsx`, `src/components/layout/StatusBar.test.tsx`

**Interfaces:**
- Consumes: `useTerminalStore`
- Produces: `<Titlebar />`, `<StatusBar />` components

- [ ] **Step 1: Write tests for Titlebar and StatusBar**

Create `src/components/layout/Titlebar.test.tsx` and `src/components/layout/StatusBar.test.tsx`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/components/layout/`  
Expected: FAIL

- [ ] **Step 3: Implement `Titlebar`, `StatusBar`, and refine `TabBar`/`Toolbar`**

- `Titlebar.tsx`: Left sidebar toggle button, workspace/CWD breadcrumbs, right sidebar toggle button.
- `StatusBar.tsx`: Git branch indicator, current working directory, terminal dimension pill, status message.
- Style `TabBar.tsx` and `Toolbar.tsx` to seamlessly integrate with Orca's sleek tab strip look.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/components/layout/`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/layout/ src/components/TabBar.tsx src/components/Toolbar.tsx
git commit -m "feat: add Titlebar, StatusBar, and style TabBar/Toolbar"
```

---

### Task 7: AppShell Integration & Keyboard Shortcuts

**Files:**
- Create: `src/components/layout/AppShell.tsx`
- Modify: `src/App.tsx`
- Modify: `src/App.css`
- Test: `src/App.test.tsx`

**Interfaces:**
- Consumes: `<LeftSidebar />`, `<Titlebar />`, `<TabBar />`, `<Toolbar />`, `<PaneSplit />`, `<RightSidebar />`, `<StatusBar />`
- Produces: Unified OPPA Workspace App

- [ ] **Step 1: Write integration tests in `src/App.test.tsx`**

Verify that `App` renders the 3-column shell with LeftSidebar, Titlebar, Terminal Workbench, RightSidebar, and StatusBar.

- [ ] **Step 2: Implement `src/components/layout/AppShell.tsx` and wire in `src/App.tsx`**

Create `src/components/layout/AppShell.tsx`:
```tsx
import React from "react";
import { LeftSidebar } from "../sidebar/LeftSidebar";
import { RightSidebar } from "../right-sidebar/RightSidebar";
import { Titlebar } from "./Titlebar";
import { StatusBar } from "./StatusBar";
import { TabBar } from "../TabBar";
import { Toolbar } from "../Toolbar";
import { PaneSplit } from "../PaneSplit";
import { useTerminalStore } from "../../store/terminalStore";
import "./AppShell.css";

export function AppShell() {
  const leftSidebarOpen = useTerminalStore((s) => s.leftSidebarOpen);
  const leftSidebarWidth = useTerminalStore((s) => s.leftSidebarWidth);
  const rightSidebarOpen = useTerminalStore((s) => s.rightSidebarOpen);
  const rightSidebarWidth = useTerminalStore((s) => s.rightSidebarWidth);

  return (
    <div className="app-shell">
      <Titlebar />
      <div className="app-body">
        {leftSidebarOpen && <LeftSidebar style={{ width: `${leftSidebarWidth}px` }} />}
        <main className="app-main">
          <TabBar />
          <Toolbar />
          <div className="terminal-workbench">
            <PaneSplit />
          </div>
        </main>
        {rightSidebarOpen && <RightSidebar style={{ width: `${rightSidebarWidth}px` }} />}
      </div>
      <StatusBar />
    </div>
  );
}
```

Update `src/App.tsx` with global keyboard shortcuts:
- `Ctrl+B` / `Cmd+B`: Toggle Left Sidebar
- `Ctrl+Shift+B` / `Cmd+Shift+B`: Toggle Right Sidebar

- [ ] **Step 3: Run full test suite & build validation**

Run:
1. `pnpm vitest run`
2. `cargo test -p oppa --lib` (in `src-tauri`)
3. `pnpm build`

Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx src/App.css src/App.test.tsx src/components/layout/AppShell.tsx src/components/layout/AppShell.css
git commit -m "feat: integrate 3-column AppShell layout and shortcuts"
```
