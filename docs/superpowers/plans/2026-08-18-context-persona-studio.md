# OPPA Context & Persona Studio Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a zero-ops, local-first Context & Persona Studio inside OPPA by embedding a pure Rust SQLite + FTS5 memory engine, introducing a 4th top-level workbench mode (`🧠 Context`), and enabling deliberate AI Persona assignment via terminal pane headers.

**Architecture:** 
- **Rust Backend (`src-tauri/src/context/`)**: Embedded SQLite via `rusqlite` with FTS5 virtual tables and automated triggers. Dual-scope resolver (`~/.oppa/global_context.sqlite` + `<workspace>/.oppa/context.sqlite`).
- **Frontend (`src/components/context/`, `src/store/contextStore.ts`)**: 4th workbench mode (`[Terminal] [Editor] [Browser] [Context]`) with a 3-column studio (Hierarchy Tree, L0/L1/L2 Inspector, Live Agent Status).
- **Terminal Header (`src/components/TerminalPaneHeader.tsx`)**: Explicit persona assignment via the `...` More Options menu and interactive `[ 🎭 Persona ]` header badge.
- **State vs. Transport**: `src/lib/context/transport.ts` is the single boundary for Tauri IPC invocations.

**Tech Stack:** Rust, `rusqlite` (bundled + FTS5), Tauri 2, React 19, TypeScript, Zustand, Lucide Icons, Vitest, Happy-DOM.

## Global Constraints

- **Rust-First Architecture**: All database storage, FTS5 queries, and dual-scope file resolution live in `src-tauri/src/context/`. No external Python or Docker runtime.
- **State vs. Transport Split**: Frontend components never call Tauri `invoke` directly. All IPC calls go through `src/lib/context/transport.ts`.
- **Zero Token Bloat (L0/L1/L2)**: All memory notes and personas support L0 (Abstract ~100 tokens), L1 (Overview/Rules ~1-2k tokens), and L2 (Raw Details).
- **Explicit Persona Assignment**: Terminal pane persona assignment is deliberate via the `...` header menu, never automatic.
- **Live Terminal Preservation**: Existing PTY sessions, split grids, drag-reorder, browser, and editor functionality must remain completely intact.
- **Testing**: TDD with unit tests in Rust (`cargo test -p oppa --lib`) and React (`pnpm vitest run`).

---

### Task 1: Rust Dependencies, Core Context Data Models & SQLite Schema

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/context/mod.rs`
- Create: `src-tauri/src/context/models.rs`
- Create: `src-tauri/src/context/schema.rs`
- Test: `src-tauri/src/context/schema.rs` (embedded unit tests)

**Interfaces:**
- Produces:
  ```rust
  #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
  pub struct ContextPage {
      pub id: String,
      pub scope: String,       // "global" | "workspace"
      pub category: String,    // "architecture" | "quirk" | "runbook" | "preference" | "persona"
      pub path: String,        // e.g. "quirks/pty-ack", "personas/debugger"
      pub title: String,
      pub icon: String,
      pub abstract_l0: String, // ~100 tokens
      pub overview_l1: String, // ~1-2k tokens
      pub details_l2: Option<String>,
      pub pinned: bool,
      pub created_at: i64,
      pub updated_at: i64,
  }

  #[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
  pub struct AgentPersona {
      pub id: String,
      pub name: String,
      pub icon: String,
      pub tagline: String,
      pub system_prompt: String,
      pub attached_scopes: Vec<String>,
      pub is_built_in: bool,
  }
  ```

- [ ] **Step 1: Write failing Rust unit test for SQLite initialization & schema creation**

```rust
// in src-tauri/src/context/schema.rs
#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn test_initialize_context_schema_creates_tables_and_fts5() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_schema(&conn).unwrap();

        // Verify context_pages table exists
        let mut stmt = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='context_pages'").unwrap();
        let exists: bool = stmt.exists([]).unwrap();
        assert!(exists);

        // Verify FTS5 virtual table exists
        let mut stmt_fts = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='context_pages_fts'").unwrap();
        let fts_exists: bool = stmt_fts.exists([]).unwrap();
        assert!(fts_exists);
    }
}
```

- [ ] **Step 2: Run cargo test to verify it fails**

Run: `cargo test -p oppa --lib context::schema`
Expected: FAIL (missing dependency / module)

- [ ] **Step 3: Add `rusqlite` to `Cargo.toml` and implement models & schema**

1. In `src-tauri/Cargo.toml`, add:
   ```toml
   rusqlite = { version = "0.32", features = ["bundled", "bundled-full"] }
   chrono = "0.4"
   ```
2. In `src-tauri/src/context/schema.rs`, implement `initialize_schema(&Connection) -> Result<(), rusqlite::Error>` executing SQL for `context_pages`, `context_pages_fts`, triggers, and seed built-in personas (`Debugger`, `Optimizer`, `Researcher`, `Test Architect`).
3. In `src-tauri/src/context/models.rs`, implement `ContextPage` and `AgentPersona` structs with Serde derives.

- [ ] **Step 4: Run cargo test to verify it passes**

Run: `cargo test -p oppa --lib context::schema`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/src/context/
git commit -m "feat(context): add rusqlite with FTS5, context data models, and schema migrations"
```

---

### Task 2: Dual-Scope Context Engine & FTS5 Full-Text Queries

**Files:**
- Create: `src-tauri/src/context/manager.rs`
- Modify: `src-tauri/src/context/mod.rs`
- Test: `src-tauri/src/context/manager.rs` (embedded unit tests)

**Interfaces:**
- Produces:
  ```rust
  pub struct ContextManager;

  impl ContextManager {
      pub fn new() -> Self;
      pub fn get_global_db_path() -> PathBuf;
      pub fn get_workspace_db_path(workspace_path: &str) -> PathBuf;
      pub fn upsert_page(&self, page: &ContextPage, workspace_path: Option<&str>) -> Result<(), String>;
      pub fn get_page(&self, id: &str, workspace_path: Option<&str>) -> Result<Option<ContextPage>, String>;
      pub fn list_pages(&self, workspace_path: Option<&str>, category: Option<&str>) -> Result<Vec<ContextPage>, String>;
      pub fn search_fts(&self, query: &str, workspace_path: Option<&str>) -> Result<Vec<ContextSearchResult>, String>;
      pub fn delete_page(&self, id: &str, scope: &str, workspace_path: Option<&str>) -> Result<(), String>;
      pub fn list_personas(&self, workspace_path: Option<&str>) -> Result<Vec<AgentPersona>, String>;
      pub fn upsert_persona(&self, persona: &AgentPersona, workspace_path: Option<&str>) -> Result<(), String>;
  }
  ```

- [ ] **Step 1: Write failing Rust unit tests for ContextManager dual-scope CRUD and FTS5 search**

```rust
// in src-tauri/src/context/manager.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_context_manager_crud_and_fts5_search() {
        let temp_dir = tempfile::tempdir().unwrap();
        let ws_path = temp_dir.path().to_str().unwrap();
        let manager = ContextManager::new();

        let page = ContextPage {
            id: "quirk-1".to_string(),
            scope: "workspace".to_string(),
            category: "quirk".to_string(),
            path: "quirks/pty-ack".to_string(),
            title: "PTY ACK Flow Control".to_string(),
            icon: "🐛".to_string(),
            abstract_l0: "High watermark backpressure fix using ACK channel.".to_string(),
            overview_l1: "Rust pauses PTY read loop at 256KB and resumes at 32KB.".to_string(),
            details_l2: Some("Full stack trace and ACK implementation log.".to_string()),
            pinned: true,
            created_at: 1000,
            updated_at: 1000,
        };

        manager.upsert_page(&page, Some(ws_path)).unwrap();

        // Test exact retrieval
        let retrieved = manager.get_page("quirk-1", Some(ws_path)).unwrap().unwrap();
        assert_eq!(retrieved.title, "PTY ACK Flow Control");

        // Test FTS5 search
        let results = manager.search_fts("backpressure", Some(ws_path)).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].id, "quirk-1");
    }
}
```

- [ ] **Step 2: Run cargo test to verify failure**

Run: `cargo test -p oppa --lib context::manager`
Expected: FAIL (`ContextManager` not defined)

- [ ] **Step 3: Implement `ContextManager` with SQLite connection pool and FTS5 queries**

Implement `ContextManager` opening connection to `~/.oppa/global_context.sqlite` and `<workspace>/.oppa/context.sqlite`, creating parent directories on demand, and executing parameterized SQL queries.

- [ ] **Step 4: Run cargo test to verify it passes**

Run: `cargo test -p oppa --lib context::manager`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/context/manager.rs src-tauri/src/context/mod.rs
git commit -m "feat(context): implement ContextManager with dual-scope resolution and FTS5 search"
```

---

### Task 3: Tauri IPC Context Commands & App State Integration

**Files:**
- Create: `src-tauri/src/context/commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/context/commands.rs` (embedded unit tests)

**Interfaces:**
- Produces Tauri commands:
  - `context_list(workspace_path: Option<String>, category: Option<String>) -> Result<Vec<ContextPage>, String>`
  - `context_get(id: String, workspace_path: Option<String>) -> Result<Option<ContextPage>, String>`
  - `context_upsert(page: ContextPage, workspace_path: Option<String>) -> Result<(), String>`
  - `context_delete(id: String, scope: String, workspace_path: Option<String>) -> Result<(), String>`
  - `context_search(query: String, workspace_path: Option<String>) -> Result<Vec<ContextSearchResult>, String>`
  - `persona_list(workspace_path: Option<String>) -> Result<Vec<AgentPersona>, String>`
  - `persona_upsert(persona: AgentPersona, workspace_path: Option<String>) -> Result<(), String>`

- [ ] **Step 1: Write failing Rust tests for Tauri context commands**

```rust
// in src-tauri/src/context/commands.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_context_commands_compilation_and_list() {
        let temp_dir = tempfile::tempdir().unwrap();
        let ws_path = temp_dir.path().to_str().unwrap().to_string();
        let manager = std::sync::Arc::new(ContextManager::new());
        let list = context_list_impl(&manager, Some(ws_path), None).unwrap();
        assert!(list.is_empty());
    }
}
```

- [ ] **Step 2: Run cargo test to verify failure**

Run: `cargo test -p oppa --lib context::commands`
Expected: FAIL

- [ ] **Step 3: Implement context commands and register in `src-tauri/src/lib.rs`**

1. In `src-tauri/src/context/commands.rs`, implement all command handlers using `tauri::State<Arc<ContextManager>>`.
2. In `src-tauri/src/lib.rs`, initialize `ContextManager` in `tauri::Builder` app manage state and register context commands in `invoke_handler`.

- [ ] **Step 4: Run cargo test to verify it passes**

Run: `cargo test -p oppa --lib`
Expected: PASS (all 74+ tests passing)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/context/commands.rs src-tauri/src/lib.rs
git commit -m "feat(context): expose Tauri IPC commands for context and persona management"
```

---

### Task 4: Frontend State & Transport Bridge

**Files:**
- Create: `src/lib/context/transport.ts`
- Create: `src/store/contextStore.ts`
- Create: `src/store/contextStore.test.ts`
- Modify: `src/store/terminalStore.ts`

**Interfaces:**
- Produces:
  ```typescript
  export interface ContextPage {
    id: string;
    scope: 'global' | 'workspace';
    category: 'architecture' | 'quirk' | 'runbook' | 'preference' | 'persona';
    path: string;
    title: string;
    icon: string;
    abstract_l0: string;
    overview_l1: string;
    details_l2?: string;
    pinned: boolean;
    created_at: number;
    updated_at: number;
  }

  export interface AgentPersona {
    id: string;
    name: string;
    icon: string;
    tagline: string;
    system_prompt: string;
    attached_scopes: string[];
    is_built_in: boolean;
  }
  ```
- Store actions in `useContextStore`:
  - `loadContext: (workspacePath?: string) => Promise<void>`
  - `selectPage: (id: string | null) => void`
  - `selectPersona: (id: string | null) => void`
  - `setActiveTier: (tier: 'l0' | 'l1' | 'l2') => void`
  - `searchContext: (query: string) => Promise<void>`
  - `savePage: (page: ContextPage) => Promise<void>`
  - `deletePage: (id: string, scope: string) => Promise<void>`
  - `savePersona: (persona: AgentPersona) => Promise<void>`

- [ ] **Step 1: Write failing tests for `contextStore.ts`**

```typescript
// in src/store/contextStore.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useContextStore } from "./contextStore";

describe("contextStore", () => {
  beforeEach(() => {
    useContextStore.setState({
      pages: [],
      personas: [],
      selectedPageId: null,
      selectedPersonaId: null,
      activeTier: "l0",
      searchQuery: "",
    });
  });

  it("selects page and switches active tier", () => {
    useContextStore.getState().selectPage("page-1");
    expect(useContextStore.getState().selectedPageId).toBe("page-1");

    useContextStore.getState().setActiveTier("l1");
    expect(useContextStore.getState().activeTier).toBe("l1");
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm vitest run src/store/contextStore.test.ts`
Expected: FAIL (`contextStore` not found)

- [ ] **Step 3: Implement `src/lib/context/transport.ts` and `src/store/contextStore.ts`**

Implement transport wrapping `@tauri-apps/api/core` `invoke`, and Zustand store with state management and mock fallback for tests. Add `personaId?: string` to `SessionInfo` in `terminalStore.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/store/contextStore.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/context/transport.ts src/store/contextStore.ts src/store/contextStore.test.ts src/store/terminalStore.ts
git commit -m "feat(context): implement context transport and Zustand contextStore"
```

---

### Task 5: The 4th Top-Level Workbench Mode & Context Studio UI

**Files:**
- Create: `src/components/context/ContextStudio.tsx`
- Create: `src/components/context/ContextTree.tsx`
- Create: `src/components/context/ContextInspector.tsx`
- Create: `src/components/context/ContextStatusPanel.tsx`
- Create: `src/components/context/PersonaModal.tsx`
- Create: `src/components/context/ContextStudio.css`
- Modify: `src/components/TitleBar.tsx`
- Modify: `src/components/layout/AppShell.tsx`
- Test: `src/components/context/ContextStudio.test.tsx`

**Interfaces:**
- Produces: 3-column Context Studio rendered when `activeAppMode === 'context'`.

- [ ] **Step 1: Write failing component tests for `ContextStudio`**

```typescript
// in src/components/context/ContextStudio.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { ContextStudio } from "./ContextStudio";

describe("ContextStudio", () => {
  it("renders 3 columns: hierarchy tree, inspector, and status panel", () => {
    const { container } = render(<ContextStudio />);
    expect(container.querySelector(".context-tree-panel")).not.toBeNull();
    expect(container.querySelector(".context-inspector-panel")).not.toBeNull();
    expect(container.querySelector(".context-status-panel")).not.toBeNull();
    expect(screen.getByPlaceholderText(/search all context/i)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm vitest run src/components/context/ContextStudio.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement Context Studio components and titlebar mode switcher**

1. In `src/components/TitleBar.tsx`, add `[ 🧠 Context ]` mode button with `setAppMode("context")`.
2. In `src/components/layout/AppShell.tsx`, render `<ContextStudio />` when `activeAppMode === 'context'`.
3. Implement `ContextTree.tsx`, `ContextInspector.tsx` (with L0/L1/L2 sub-tabs and Markdown editor), `ContextStatusPanel.tsx`, and `PersonaModal.tsx`.

- [ ] **Step 4: Run component tests to verify pass**

Run: `pnpm vitest run src/components/context/ContextStudio.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/context/ src/components/TitleBar.tsx src/components/layout/AppShell.tsx
git commit -m "feat(context): implement 4th workbench mode and 3-column Context Studio UI"
```

---

### Task 6: Terminal Pane Header Persona Assignment & Active Badge

**Files:**
- Modify: `src/components/TerminalPaneHeader.tsx`
- Modify: `src/components/TerminalPaneHeader.css`
- Test: `src/components/TerminalPaneHeader.test.tsx`

**Interfaces:**
- Consumes: `personas` from `contextStore`, `sessions` and `setSessionPersona` from `terminalStore`.
- Produces: Persona submenu in `...` dropdown and interactive `[ 🎭 Persona ]` header badge.

- [ ] **Step 1: Write failing component tests for persona assignment in `TerminalPaneHeader`**

```typescript
// in src/components/TerminalPaneHeader.test.tsx
it("renders persona badge and allows changing persona via More Options dropdown", async () => {
  useTerminalStore.setState({
    sessions: {
      s1: { id: "s1", title: "Terminal 1", status: "running", cols: 80, rows: 24, personaId: "debugger" } as any,
    },
  });
  useContextStore.setState({
    personas: [
      { id: "debugger", name: "Debugger", icon: "🐛", tagline: "Fix bugs", system_prompt: "...", attached_scopes: [], is_built_in: true },
    ],
  });

  const { container } = render(<TerminalPaneHeader id="s1" path={[]} />);
  const badge = container.querySelector(".pane-persona-badge");
  expect(badge).not.toBeNull();
  expect(badge?.textContent).toContain("Debugger");
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm vitest run src/components/TerminalPaneHeader.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement persona selector in `TerminalPaneHeader.tsx`**

1. In `TerminalPaneHeader.tsx`, render `.pane-persona-badge` next to the title when `session.personaId` is set.
2. In the `...` More Options menu, add the **"Assign Persona"** submenu with all available personas and "None (Default Shell)".
3. Clicking an option updates `session.personaId` in `terminalStore`.

- [ ] **Step 4: Run component tests to verify pass**

Run: `pnpm vitest run src/components/TerminalPaneHeader.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/TerminalPaneHeader.tsx src/components/TerminalPaneHeader.css src/components/TerminalPaneHeader.test.tsx
git commit -m "feat(terminal): add persona assignment to header More Options menu and badge"
```

---

### Task 7: PTY Persona Environment Injection & Full-Suite Verification

**Files:**
- Modify: `src-tauri/src/pty/commands.rs`
- Modify: `src-tauri/src/pty/manager.rs`
- Test: `src/App.test.tsx`

**Interfaces:**
- Consumes: `personaId` from `pty_spawn` payload and injects `OPPA_PERSONA` into child shell environment.

- [ ] **Step 1: Write integration tests for persona environment and full app mode switching**

```typescript
// in src/App.test.tsx
it("switches to context mode and displays Context Studio", () => {
  useTerminalStore.setState({ activeAppMode: "context" });
  const { container } = render(<App />);
  expect(container.querySelector(".context-studio")).not.toBeNull();
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm vitest run src/App.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement persona env injection in `src-tauri/src/pty/` and verify App mode switching**

1. In `src-tauri/src/pty/commands.rs` and `manager.rs`, inject `OPPA_PERSONA` environment variable into spawned shell if `persona_id` is supplied.
2. Verify full test suite and production build pass.

- [ ] **Step 4: Run all test suites and production build**

Run: `pnpm vitest run`
Run: `pnpm build`
Run: `cargo test -p oppa --lib` (in `src-tauri`)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/pty/ src/App.test.tsx
git commit -m "feat(context): inject OPPA_PERSONA into PTY environment and complete Context Studio MVP"
```
