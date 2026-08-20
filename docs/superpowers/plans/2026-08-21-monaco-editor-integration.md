# Monaco Editor Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate Monaco Editor (`@monaco-editor/react`) into OPPA's Code Editor Workbench for full syntax highlighting (HTML, JS, TS, Rust, Python, CSS, JSON, etc.), VS Code editing features, and custom OPPA dark theme.

**Architecture:** Use `@monaco-editor/react` inside `src/components/editor/CodeEditor.tsx`, configure custom `oppa-dark` and `oppa-light` themes via `src/components/editor/monacoTheme.ts`, wire save shortcuts to Zustand store, and support Monaco `DiffEditor` for AI diff reviews.

**Tech Stack:** React 19, TypeScript, `@monaco-editor/react`, Monaco Editor, Zustand, Vitest.

## Global Constraints

- **Scope Isolation**: Only files in `package.json`, `src/components/editor/`, and `docs/superpowers/` may be modified.
- **Git Branch**: `feat/editor-ui-redesign`.
- **Aesthetic**: Custom `oppa-dark` theme matching `#141414` / `#18181b` canvas and OPPA design tokens.
- **Tests**: All Vitest unit tests in `src/components/editor/` must pass cleanly.

---

### Task 1: Install `@monaco-editor/react` & Create `monacoTheme.ts`

**Files:**
- Modify: `package.json`
- Create: `src/components/editor/monacoTheme.ts`
- Create: `src/components/editor/monacoTheme.test.ts`

- [ ] **Step 1: Install `@monaco-editor/react`**

Run: `pnpm add @monaco-editor/react`

- [ ] **Step 2: Create `monacoTheme.ts`**

Define `mapToMonacoLanguage(filePath, fallbackLang)` and `defineOppaMonacoThemes(monaco)`.

- [ ] **Step 3: Write tests in `monacoTheme.test.ts`**

Test language mappings for HTML, JS, TS, Rust, Python, CSS, JSON, etc., and theme definition structures.

- [ ] **Step 4: Run tests to verify**

Run: `pnpm vitest run src/components/editor/monacoTheme.test.ts`

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml src/components/editor/monacoTheme.ts src/components/editor/monacoTheme.test.ts
git commit -m "feat(editor): install @monaco-editor/react and add monacoTheme configuration"
```

---

### Task 2: Refactor `CodeEditor.tsx` with Monaco Editor & DiffEditor

**Files:**
- Modify: `src/components/editor/CodeEditor.tsx`
- Create: `src/components/editor/CodeEditor.test.tsx`
- Modify: `src/components/editor/EditorViewport.css`

- [ ] **Step 1: Write tests in `CodeEditor.test.tsx`**

Verify editor rendering, content update trigger, save shortcut handling, diff mode rendering, and readOnly prop.

- [ ] **Step 2: Implement Monaco Editor in `CodeEditor.tsx`**

Integrate `<Editor />` and `<DiffEditor />` with:
- `oppa-dark` / `oppa-light` theme
- `fontSize: 13`, `lineHeight: 20`, `fontFamily: 'Geist Mono', monospace`
- `Ctrl+S` / `Cmd+S` keyboard shortcut handler
- `updateEditorContent` on change
- Dynamic `wordWrap` from Zustand store

- [ ] **Step 3: Run all editor test files**

Run: `pnpm vitest run src/components/editor`

- [ ] **Step 4: Commit**

```bash
git add src/components/editor/CodeEditor.tsx src/components/editor/CodeEditor.test.tsx src/components/editor/EditorViewport.css
git commit -m "feat(editor): integrate Monaco Editor with syntax highlighting and diff review"
```

---

### Task 3: Full Verification & Build Check

**Files:**
- Verify: `src/components/editor/`

- [ ] **Step 1: Run full Vitest suite**

Run: `pnpm vitest run`

- [ ] **Step 2: Run TypeScript build**

Run: `pnpm build`

- [ ] **Step 3: Verify clean git status**

Run: `git status`

- [ ] **Step 4: Final commit & summary**
