# OPPA Code Editor Workbench Design Specification

**Date:** 2026-08-18  
**Status:** Approved  
**Topic:** Code Editor Workbench with Monaco Editor, AI Diff Reviewer, Markdown Live Preview / Split Mode, Rust FS Backend, and File Explorer Integration.

---

## 1. Overview & Goals

Build a fast, full-featured VS Code-style Code Editor Workbench inside OPPA:
1. **Monaco Code Editor**: VS Code core editing engine with syntax highlighting (TypeScript, JavaScript, Rust, Python, Go, CSS, HTML, JSON, Markdown, YAML, Shell), line numbers, multi-cursor, bracket matching, and `Ctrl+S` save.
2. **AI Diff Review Mode**: Native Monaco `DiffEditor` displaying green additions and red deletions, accompanied by a floating AI Review Banner with `[✓ Accept & Apply]` and `[✕ Reject]` buttons.
3. **Markdown (`.md`) Live Preview & Split Mode**: 3-way toggle (`Code` | `Preview` | `Split`) with GitHub-flavored markdown rendering, task checkboxes, code block highlighting, and tables.
4. **File Explorer Integration**: Clicking any file in the right sidebar file tree loads file contents and opens/focuses an editor tab.
5. **Rust FS Backend**: Tauri commands for reading, writing, and creating files (`fs_read_file`, `fs_write_file`, `fs_create_file`).
6. **Top Bar Mode Switcher**: All 3 modes (`browser` | `terminal` | `editor`) are fully interactive in `TitleBar.tsx`.

---

## 2. Architecture & Data Flow

### A. Rust File System Backend (`src-tauri/src/fs.rs`)
- `fs_read_file(path: String) -> Result<String, String>`: Reads UTF-8 file content.
- `fs_write_file(path: String, content: String) -> Result<(), String>`: Writes UTF-8 file content.
- `fs_create_file(path: String) -> Result<(), String>`: Creates a new file.

### B. Transport & Store Layer (`src/lib/fs/transport.ts` & `src/store/terminalStore.ts`)
- **Transport**: `readFile(path)`, `writeFile(path, content)`, `createFile(path)`.
- **Store Extensions**:
  - `activeAppMode: "terminal" | "browser" | "editor"`
  - `editorTabs: Array<{ path: string; name: string; content: string; originalContent: string; isDirty: boolean; language: string; isMarkdown: boolean }>`
  - `activeEditorPath: string | null`
  - `editorViewMode: "edit" | "diff" | "markdown-preview" | "markdown-split"`
  - `pendingAiDiff: { path: string; original: string; modified: string; summary?: string } | null`
  - Actions: `openFileInEditor(path, content?)`, `closeEditorTab(path)`, `updateEditorContent(path, content)`, `saveActiveFile()`, `stageAiDiff(...)`, `acceptAiDiff()`, `rejectAiDiff()`, `setEditorViewMode(mode)`.

### C. Frontend UI Components (`src/components/editor/`)
- `src/components/editor/EditorViewport.tsx`: Main editor workbench layout containing tab bar, breadcrumb/action header, editor canvas, and status.
- `src/components/editor/EditorTabBar.tsx`: Open file tabs with dirty indicators (`●`), icons, and close buttons (`✕`).
- `src/components/editor/EditorBreadcrumbs.tsx`: Path breadcrumbs and action buttons (`Save`, `Diff Toggle`, `Markdown Preview Toggle`, `Format`).
- `src/components/editor/CodeEditor.tsx`: Monaco Editor integration with `vs-dark` theme and fallback text editor.
- `src/components/editor/AiDiffBanner.tsx`: Floating action banner for accepting/rejecting AI diffs with Monaco `DiffEditor`.
- `src/components/editor/MarkdownViewer.tsx`: GitHub-flavored markdown renderer with task lists, code block copies, and headers.
- `src/components/editor/EditorViewport.css`: Dark theme styling matching `--workspace-bg` and `--card`.

---

## 3. User Workflows

1. **Opening a File**:
   - User clicks `src/components/TitleBar.tsx` in the right sidebar File Explorer.
   - The file is read from disk, a tab `TitleBar.tsx` is opened, and the app switches to `"editor"` mode.
2. **Editing & Saving**:
   - User types code; the tab displays `●` indicating unsaved changes.
   - Pressing `Ctrl+S` / `Cmd+S` or clicking "Save" calls `fs_write_file`, clearing the dirty indicator.
3. **AI Agent Diff Review**:
   - When an AI agent or test generates a code change, `stageAiDiff(path, original, modified)` is called.
   - The editor displays the green/red diff view with the top banner. Clicking `[✓ Accept]` applies the change to disk and updates the editor. Clicking `[✕ Reject]` reverts to the original code.
4. **Markdown Preview**:
   - Opening any `.md` file shows the `Code | Preview | Split` switch in the breadcrumb bar, allowing side-by-side editing and live preview.

---

## 4. Verification & Testing
- Unit tests for `fs_read_file` / `fs_write_file` in Rust (`cargo test -p oppa --lib`).
- Component tests for `EditorViewport`, `EditorTabBar`, `AiDiffBanner`, `MarkdownViewer`, and `FileExplorer` integration.
- Full Vitest test suite (`pnpm vitest run`) and TypeScript build (`pnpm build`).
