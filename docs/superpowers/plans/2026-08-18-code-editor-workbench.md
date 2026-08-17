# OPPA Code Editor Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a complete VS Code-style Code Editor Workbench inside OPPA with Monaco Editor, AI Diff Review Mode (Accept/Reject), Markdown live preview/split mode, Rust file read/write backend, right-sidebar File Explorer integration, and Top Bar mode switcher activation.

**Architecture:** Implement Rust backend file commands (`fs_read_file`, `fs_write_file`, `fs_create_file`). Extend `terminalStore.ts` with open editor tabs, active file, dirty unsaved changes, and AI diff staging. Create modular editor components in `src/components/editor/` (Monaco CodeEditor, EditorTabBar, EditorBreadcrumbs, AiDiffBanner, MarkdownViewer, EditorViewport). Connect FileExplorer and TitleBar.

**Tech Stack:** React 19, TypeScript, Monaco Editor, Tauri 2 (Rust), Vitest, `@testing-library/react`.

## Global Constraints

- **Theme Palette**: Obsidian `#000000` / `#09090b` topbar and footer, dark neutral `#18181b` / `#1c1c1f` content surfaces, card `#222225`, text `#ededec` / `#71717a`.
- **Top Bar Integration**: All 3 tabs (`browser` | `terminal` | `editor`) in `TitleBar.tsx` switch `activeAppMode` seamlessly.
- **State vs Transport Split**: All file operations pass through `src/lib/fs/transport.ts`.
- **Testing**: TDD with `pnpm vitest run` and `cargo test -p oppa --lib`.

---

### Task 1: Rust FS Backend (`fs_read_file`, `fs_write_file`, `fs_create_file`) & Transport Layer

**Files:**
- Modify: `src-tauri/src/fs.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/fs/transport.ts`
- Create: `src/lib/fs/transport.test.ts`

- [ ] **Step 1: Write failing Rust tests in `src-tauri/src/fs.rs` and TS tests in `src/lib/fs/transport.test.ts`**

In `src-tauri/src/fs.rs`:
```rust
#[test]
fn test_fs_read_and_write_file_roundtrip() {
    let dir = temp_dir("rw_test");
    let file_path = dir.join("test.txt");
    let full_path = file_path.to_string_lossy().to_string();

    fs_write_file(full_path.clone(), "hello oppa editor".to_string()).unwrap();
    let content = fs_read_file(full_path).unwrap();
    assert_eq!(content, "hello oppa editor");
}
```

In `src/lib/fs/transport.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { readFile, writeFile, createFile } from "./transport";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p oppa --lib` and `pnpm vitest run src/lib/fs/transport.test.ts`  
Expected: FAIL

- [ ] **Step 3: Implement Rust FS commands and TypeScript transport functions**

In `src-tauri/src/fs.rs`:
- Implement `fs_read_file`, `fs_write_file`, and `fs_create_file`.
- Register them in `src-tauri/src/lib.rs`.

In `src/lib/fs/transport.ts`:
- Export `readFile(path: string): Promise<string>`.
- Export `writeFile(path: string, content: string): Promise<void>`.
- Export `createFile(path: string): Promise<void>`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p oppa --lib` and `pnpm vitest run src/lib/fs/transport.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/fs.rs src-tauri/src/lib.rs src/lib/fs/
git commit -m "feat(fs): add fs_read_file, fs_write_file, and fs_create_file commands and transport"
```

---

### Task 2: Editor State & AI Diff Actions in Zustand Store

**Files:**
- Modify: `src/store/terminalStore.ts`
- Modify: `src/store/terminalStore.test.ts`

- [ ] **Step 1: Write failing tests for editor store state and AI diff workflows**

In `src/store/terminalStore.test.ts`:
```ts
describe("Editor store state", () => {
  it("opens, updates, dirties, saves, and closes editor tabs", async () => {
    const { openFileInEditor, updateEditorContent, closeEditorTab } = useTerminalStore.getState();
    openFileInEditor("D:/oppa/src/App.tsx", "console.log('hello');");
    expect(useTerminalStore.getState().editorTabs.length).toBe(1);
    expect(useTerminalStore.getState().activeEditorPath).toBe("D:/oppa/src/App.tsx");
    expect(useTerminalStore.getState().editorTabs[0].isDirty).toBe(false);

    updateEditorContent("D:/oppa/src/App.tsx", "console.log('updated');");
    expect(useTerminalStore.getState().editorTabs[0].isDirty).toBe(true);

    closeEditorTab("D:/oppa/src/App.tsx");
    expect(useTerminalStore.getState().editorTabs.length).toBe(0);
    expect(useTerminalStore.getState().activeEditorPath).toBeNull();
  });

  it("handles AI diff staging, accepting, and rejecting", () => {
    const { stageAiDiff, acceptAiDiff, rejectAiDiff } = useTerminalStore.getState();
    stageAiDiff("D:/oppa/src/App.tsx", "old content", "new modified content", "Fix bug in App");
    expect(useTerminalStore.getState().pendingAiDiff).toBeDefined();
    expect(useTerminalStore.getState().editorViewMode).toBe("diff");

    acceptAiDiff();
    expect(useTerminalStore.getState().pendingAiDiff).toBeNull();
    expect(useTerminalStore.getState().editorTabs[0].content).toBe("new modified content");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/store/terminalStore.test.ts`  
Expected: FAIL

- [ ] **Step 3: Implement Editor state and actions in `src/store/terminalStore.ts`**

Implement:
- `editorTabs`: Array of tabs with language detection (`.ts`, `.tsx`, `.rs`, `.py`, `.json`, `.md`, etc.) and `isMarkdown` flag.
- `activeEditorPath`: Active tab pointer.
- `editorViewMode`: `"edit" | "diff" | "markdown-preview" | "markdown-split"`.
- `pendingAiDiff`: Staged AI diff payload.
- Actions: `openFileInEditor`, `closeEditorTab`, `setActiveEditorTab`, `updateEditorContent`, `saveActiveFile`, `stageAiDiff`, `acceptAiDiff`, `rejectAiDiff`, `setEditorViewMode`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/store/terminalStore.test.ts`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/terminalStore.ts src/store/terminalStore.test.ts
git commit -m "feat(editor): add editor tabs, file saving, and AI diff review actions in store"
```

---

### Task 3: Code Editor Components (Monaco Integration, TabBar, Breadcrumbs, AI Diff Banner, Markdown Viewer)

**Files:**
- Create: `src/components/editor/EditorTabBar.tsx`
- Create: `src/components/editor/EditorBreadcrumbs.tsx`
- Create: `src/components/editor/CodeEditor.tsx`
- Create: `src/components/editor/AiDiffBanner.tsx`
- Create: `src/components/editor/MarkdownViewer.tsx`
- Create: `src/components/editor/EditorViewport.tsx`
- Create: `src/components/editor/EditorViewport.css`
- Create: `src/components/editor/EditorTabBar.test.tsx`
- Create: `src/components/editor/EditorBreadcrumbs.test.tsx`
- Create: `src/components/editor/AiDiffBanner.test.tsx`
- Create: `src/components/editor/MarkdownViewer.test.tsx`
- Create: `src/components/editor/EditorViewport.test.tsx`

- [ ] **Step 1: Write failing tests for editor components**

In `EditorTabBar.test.tsx`, `AiDiffBanner.test.tsx`, `MarkdownViewer.test.tsx`, and `EditorViewport.test.tsx`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/components/editor/`  
Expected: FAIL

- [ ] **Step 3: Implement editor components and styles**

Implement:
- `EditorTabBar.tsx`: Tab strip with icons, dirty dot (`●`), active highlight, close `✕`, and new file button.
- `EditorBreadcrumbs.tsx`: File path breadcrumb + actions (Save, Diff toggle, Markdown Mode toggle, Format).
- `CodeEditor.tsx`: Monaco Editor integration with `vs-dark` theme, bracket pairs, line numbers, and fast text editor fallback.
- `AiDiffBanner.tsx`: Floating top review bar with `[✓ Accept & Apply]` and `[✕ Reject / Discard]` buttons.
- `MarkdownViewer.tsx`: GitHub-flavored Markdown viewer with headers, code block copy, task list checkboxes `- [x]`, tables, and blockquotes.
- `EditorViewport.tsx` & `EditorViewport.css`: Top-level workbench assembling TabBar, Breadcrumbs, AI Banner, Editor canvas, and Markdown preview/split container.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/components/editor/`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/
git commit -m "feat(editor): add Monaco CodeEditor, EditorTabBar, AiDiffBanner, and MarkdownViewer"
```

---

### Task 4: File Explorer Integration & Top Bar Mode Switcher

**Files:**
- Modify: `src/components/TitleBar.tsx`
- Modify: `src/components/right-sidebar/FileExplorer.tsx`
- Modify: `src/App.tsx`
- Modify: `src/components/TitleBar.test.tsx`
- Modify: `src/components/right-sidebar/RightSidebar.test.tsx`
- Modify: `src/App.test.tsx`

- [ ] **Step 1: Write failing tests for FileExplorer click-to-open and TitleBar editor mode**

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/components/TitleBar.test.tsx src/components/right-sidebar/RightSidebar.test.tsx src/App.test.tsx`  
Expected: FAIL

- [ ] **Step 3: Update `FileExplorer.tsx`, `TitleBar.tsx`, and `App.tsx`**

In `FileExplorer.tsx`:
- When clicking a file (non-directory), read its content via `readFile(entry.path)`, call `openFileInEditor(entry.path, content)`, and set `activeAppMode("editor")`.

In `TitleBar.tsx`:
- Enable `editor` tab as an interactive button calling `setAppMode("editor")` with dynamic `.active` class.

In `App.tsx`:
- Render `<EditorViewport />` when `activeAppMode === "editor"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/components/TitleBar.test.tsx src/components/right-sidebar/RightSidebar.test.tsx src/App.test.tsx`  
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/TitleBar.tsx src/components/right-sidebar/FileExplorer.tsx src/App.tsx src/components/TitleBar.test.tsx src/components/right-sidebar/RightSidebar.test.tsx src/App.test.tsx
git commit -m "feat(editor): connect FileExplorer click-to-open, TitleBar editor mode, and App mounting"
```

---

### Task 5: End-to-End Integration Verification & Polish

**Files:**
- Full suite verification across all frontend and backend components.

- [ ] **Step 1: Run Rust check and tests**

Run: `cargo test -p oppa --lib` and `cargo check --manifest-path src-tauri/Cargo.toml`  
Expected: PASS

- [ ] **Step 2: Run Vitest test suite and TypeScript production build**

Run: `pnpm vitest run && pnpm build`  
Expected: PASS with 0 errors

- [ ] **Step 3: Commit any final polish**

```bash
git commit --allow-empty -m "feat: complete code editor workbench with Monaco, AI diffs, and markdown preview"
```
