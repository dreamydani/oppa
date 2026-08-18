# OPPA Context & Persona Studio Design Specification

## Overview

OPPA Context & Persona Studio turns OPPA into a context-aware AI Development Studio by uniting the **zero-ops Rust SQLite + FTS5 memory engine** of `ai-memory` with the **hierarchical context tree and L0/L1/L2 progressive disclosure** of `OpenViking`.

It introduces a dedicated **4th top-level workbench mode (`🧠 Context`)** alongside `Terminal`, `Editor`, and `Browser`, providing an interactive 3-column knowledge studio. Users can inspect project memories, curate specialized AI Personas (e.g. `🐛 Debugger`, `⚡ Optimizer`, `🔬 Researcher`), and explicitly assign these personas to any split terminal pane via the header's `...` (More Options) dropdown.

---

## 1. Core Architecture & Storage

### 1.1 Dual-Scope SQLite Storage
- **Global Context (`~/.oppa/global_context.sqlite`)**:
  - Contains user preferences, universal shell configurations, and cross-workspace personas.
- **Workspace Context (`<workspace>/.oppa/context.sqlite` or `appDataDir/workspaces/<id>/context.sqlite`)**:
  - Contains repository-specific architecture, solved bugs/quirks, active ports, and project runbooks.
- **Resolver**: When querying context, OPPA searches the active workspace first, falling back to global context.

### 1.2 Enhanced Tiered Data Model (`context_pages`)
Each context document and persona is partitioned into discrete progressive tiers:
- **`L0 (Abstract)`**: ~100 tokens. A concise 1–2 sentence summary used for hierarchy tree previews and initial system prompt injections.
- **`L1 (Overview / Rules)`**: ~1–2k tokens. Structured markdown overview, architectural bullet points, or behavioral rules.
- **`L2 (Raw Logs / Scopes)`**: Uncompressed text, full compiler stack traces, code diffs, or raw observation history, loaded strictly on demand.

### 1.3 SQLite Schema & FTS5 Indexing
```sql
CREATE TABLE context_pages (
    id            TEXT PRIMARY KEY NOT NULL,
    scope         TEXT NOT NULL CHECK (scope IN ('global', 'workspace')),
    category      TEXT NOT NULL CHECK (category IN ('architecture', 'quirk', 'runbook', 'preference', 'persona')),
    path          TEXT NOT NULL,            -- e.g. 'quirks/pty-ack', 'personas/debugger'
    title         TEXT NOT NULL,
    icon          TEXT NOT NULL DEFAULT '📄',
    abstract_l0   TEXT NOT NULL,
    overview_l1   TEXT NOT NULL,
    details_l2    TEXT,
    pinned        INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
);

-- Full-text keyword search for code identifiers and error messages
CREATE VIRTUAL TABLE context_pages_fts USING fts5(
    title, abstract_l0, overview_l1, details_l2,
    content='context_pages',
    content_rowid='rowid',
    tokenize="unicode61 tokenchars '/_-'"
);

CREATE TRIGGER context_pages_fts_ai AFTER INSERT ON context_pages BEGIN
    INSERT INTO context_pages_fts(rowid, title, abstract_l0, overview_l1, details_l2)
        VALUES (new.rowid, new.title, new.abstract_l0, new.overview_l1, new.details_l2);
END;

CREATE TRIGGER context_pages_fts_ad AFTER DELETE ON context_pages BEGIN
    INSERT INTO context_pages_fts(context_pages_fts, rowid, title, abstract_l0, overview_l1, details_l2)
        VALUES ('delete', old.rowid, old.title, old.abstract_l0, old.overview_l1, old.details_l2);
END;

CREATE TRIGGER context_pages_fts_au AFTER UPDATE ON context_pages BEGIN
    INSERT INTO context_pages_fts(context_pages_fts, rowid, title, abstract_l0, overview_l1, details_l2)
        VALUES ('delete', old.rowid, old.title, old.abstract_l0, old.overview_l1, old.details_l2);
    INSERT INTO context_pages_fts(rowid, title, abstract_l0, overview_l1, details_l2)
        VALUES (new.rowid, new.title, new.abstract_l0, new.overview_l1, new.details_l2);
END;
```

---

## 2. The 4th Top-Level Workbench Mode: `🧠 Context`

### 2.1 Workbench Navigation
The top titlebar mode switcher is expanded:
- `[ >_ Terminal ]`
- `[ 📄 Editor ]`
- `[ 🌐 Browser ]`
- `[ 🧠 Context ]` (Keyboard shortcut: `Cmd/Ctrl+4` or Alt toggle)

### 2.2 Studio 3-Column Layout
1. **Left Column: Hierarchy Tree (`📁 HIERARCHY TREE`)**:
   - `▼ 📁 Workspace (<current-project>)`:
     - `▶ 🏗️ Architecture`
     - `▶ 🐛 Solved Quirks & Bugs`
     - `▶ ⚡ Runbooks & Commands`
     - `▼ 🎭 Personas & Roles` (`🐛 Debugger`, `⚡ Optimizer`, `🔬 Researcher`, `🧪 Test Architect`, `[+ New Persona]`)
   - `▼ 🌐 Global (User Profile)`:
     - `• Tooling & Shell Preferences`
     - `• Global Coding Standards`
2. **Middle Column: Context & Persona Inspector (`📄 CONTEXT & PERSONA INSPECTOR`)**:
   - Tabbed view: `[ L0 Abstract ]`, `[ L1 Overview / Rules ]`, `[ L2 Raw Details / Scopes ]`.
   - Rich rendered Markdown view with inline editing (`[ ✏️ Edit ]`, `[ 💾 Save ]`).
   - Pin / unpin toggle (`[ 📌 Pin Memory ]`).
3. **Right Column: Live Agent / MCP Activity & Sandbox (`⚡ AGENT & MCP LIVE STATUS`)**:
   - Displays active terminal panes running assigned personas.
   - Shows live memory read/write event stream.
   - Interactive Search Sandbox: Type test queries to preview what an agent would retrieve in real-time.

---

## 3. Persona Management & Terminal Pane Assignment

### 3.1 Persona Data Structure
A Persona is stored in `context_pages` with `category = 'persona'`:
- `title`: Name of the persona (e.g., `Debugger`, `Optimizer`).
- `icon`: Emoji or Lucide icon tag (e.g., `🐛`, `⚡`, `🔬`).
- `abstract_l0`: Short role summary (e.g. *"Root-cause isolation and fix verification expert"*).
- `overview_l1`: Complete system prompt and behavioral guidelines.
- `details_l2`: JSON list of mounted memory paths (e.g. `["quirks/*", "architecture/*"]`).

### 3.2 Terminal Pane Header Assignment (`TerminalPaneHeader.tsx`)
1. **Deliberate User Assignment**: Assignment is **not automatic**; the user explicitly picks a persona for that terminal pane.
2. **The `...` Dropdown**:
   - Clicking `...` (More Options) includes an **Assign Persona** submenu:
     - `○ None (Default Shell)`
     - `● 🐛 Debugger`
     - `○ ⚡ Optimizer`
     - `○ 🔬 Researcher`
     - `○ 🧪 Test Architect`
     - `+ Manage in Context Studio...`
3. **Header Persona Badge**:
   - When active, a distinct badge appears next to the pane title: `[ 🐛 Debugger ]`.
   - Clicking the badge opens the quick persona switcher.

### 3.3 Runtime Context Injection
When an AI CLI (Claude Code, Codex, Aider) or command runs in that pane:
- OPPA daemon sets environment variables (`OPPA_PERSONA="debugger"`, `OPPA_WORKSPACE="oppa"`).
- The daemon's embedded MCP server mounts the persona's prompt and the L0/L1 summaries of attached memory folders.
- Observations produced by the agent are auto-tagged with `author_persona: "debugger"`.

---

## 4. State vs. Transport Architecture

- **Rust Daemon (`src-tauri/src/context/`)**:
  - `context_db.rs`: SQLite connection manager, migrations, and FTS5 query runner.
  - `context_manager.rs`: Dual-scope resolver and memory CRUD.
  - `commands.rs`: Exposes Tauri IPC commands (`context_list`, `context_get`, `context_upsert`, `context_delete`, `context_search_fts`, `persona_list`, `persona_upsert`).
- **Transport (`src/lib/context/transport.ts`)**:
  - The *only* frontend file invoking Tauri context commands.
- **Zustand Store (`src/store/contextStore.ts`)**:
  - Manages active selected node, active L0/L1/L2 tab, search query, persona list, and memory cache.
  - `terminalStore.ts` holds `personaId?: string` on each session in `sessions[id]`.

---

## 5. Testing & Verification Strategy

1. **Rust Unit Tests (`src-tauri/src/context/`)**:
   - SQLite migration initialization and FTS5 triggers.
   - Dual-scope fallback resolution (Workspace -> Global).
   - L0/L1/L2 CRUD and keyword search.
2. **Frontend Vitest Suites (`src/components/context/`, `src/store/`)**:
   - `contextStore.test.ts`: Tree navigation, search queries, persona creation.
   - `ContextStudio.test.tsx`: 3-column layout rendering, tab switching, markdown editing.
   - `TerminalPaneHeader.test.tsx`: Persona assignment via `...` menu and badge rendering.
3. **End-to-End Verification**:
   - Full Vitest suite passing.
   - Production bundle `pnpm build` verified clean.
   - `cargo test -p oppa --lib` passing.
