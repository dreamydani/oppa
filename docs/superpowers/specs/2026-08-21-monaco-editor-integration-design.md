# Monaco Editor Integration Design Specification

**Date:** 2026-08-21  
**Status:** Approved  
**Branch:** `feat/editor-ui-redesign`  
**Topic:** Monaco Editor Integration with Full Syntax Highlighting, Custom OPPA Dark/Light Themes, Native DiffEditor, and Vitest Mocking.

---

## 1. Overview & Objectives

Integrate Microsoft Monaco Editor (the engine powering VS Code) into OPPA to replace the native `<textarea>` in [`src/components/editor/CodeEditor.tsx`](file:///C:/oppa/oppa/src/components/editor/CodeEditor.tsx):
1. **Rich Syntax Highlighting**: Full token colorization for HTML, JavaScript, TypeScript, Rust, Python, CSS, JSON, Markdown, YAML, TOML, SQL, and Shell scripts.
2. **VS Code Editing Capabilities**: Multi-cursor, bracket pair colorization, line numbers, indentation guides, code folding, auto-closing brackets/quotes, and `Ctrl+S` / `Cmd+S` save handling.
3. **OPPA Theme Harmonization**: Custom `oppa-dark` and `oppa-light` themes matching OPPA's dark minimal aesthetic (`#141414` / `#18181b` canvas, `#ededec` foreground, `#58a6ff` accents).
4. **Native Monaco DiffEditor**: Green/red diff comparison for AI-suggested changes (`AiDiffBanner`) and manual file diffs.
5. **Robust Test Support**: Graceful fallback / mock configuration for fast and reliable Vitest execution under `happy-dom`.

---

## 2. Architecture & Component Changes

### A. Dependency Addition (`package.json`)
- Add `@monaco-editor/react` (`^4.7.0`): Official lightweight React wrapper for Monaco Editor (MIT licensed).

### B. Language Mapping & Detection (`src/components/editor/monacoTheme.ts`)
- Map detected file extensions to Monaco language IDs:
  - `html`, `htm` &rarr; `"html"`
  - `js`, `jsx`, `mjs`, `cjs` &rarr; `"javascript"`
  - `ts`, `tsx`, `mts`, `cts` &rarr; `"typescript"`
  - `rs` &rarr; `"rust"`
  - `py`, `pyw` &rarr; `"python"`
  - `json` &rarr; `"json"`
  - `css`, `scss`, `less` &rarr; `"css"`
  - `md`, `markdown` &rarr; `"markdown"`
  - `yaml`, `yml` &rarr; `"yaml"`
  - `toml` &rarr; `"toml"`
  - `sh`, `bash`, `zsh` &rarr; `"shell"`
  - `sql` &rarr; `"sql"`
  - default &rarr; `"plaintext"`

### C. OPPA Monaco Theme Definition
- Define `oppa-dark` and `oppa-light` in Monaco:
  - Background: `#141414` (dark) / `#fbfbfa` (light)
  - Line numbers & gutter: `#71717a`
  - Caret: `#ededec`
  - Selection: `rgba(88, 166, 255, 0.25)`
  - Indent guide: `rgba(255, 255, 255, 0.08)`

### D. `CodeEditor.tsx` Refactoring
- Replace `<textarea>` canvas with `<Editor />` from `@monaco-editor/react`.
- When in diff mode or pending AI change, render `<DiffEditor />` from `@monaco-editor/react`.
- Pass editor options:
  - `fontSize`: 13
  - `fontFamily`: `'Geist Mono', 'SF Mono', Consolas, 'Cascadia Code', monospace`
  - `lineHeight`: 20
  - `minimap`: `{ enabled: false }`
  - `scrollBeyondLastLine`: false
  - `automaticLayout`: true
  - `tabSize`: 2
  - `wordWrap`: dynamic based on Zustand `settings.general.editorWordWrap`
- Intercept `Ctrl+S` / `Cmd+S` via Monaco command action to trigger `saveActiveFile()`.

### E. Vitest Testing Compatibility
- Provide a clean component mock or environment fallback for `@monaco-editor/react` in test suites so tests run instantly and deterministically without requiring a live browser DOM web worker.

---

## 3. Scope Isolation

Modifications are strictly limited to:
- `package.json` (add `@monaco-editor/react`)
- `src/components/editor/` (`CodeEditor.tsx`, `monacoTheme.ts`, `EditorViewport.css`, `CodeEditor.test.tsx`)
- `docs/superpowers/` (spec and plan)

---

## 4. Verification & Validation
- Run unit tests: `pnpm vitest run src/components/editor`
- Run full Vitest suite: `pnpm vitest run`
- Run TypeScript build: `pnpm build`
