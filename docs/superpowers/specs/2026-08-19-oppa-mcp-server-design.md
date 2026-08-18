# OPPA MCP Server & AI Agent Integration Specification

**Date:** 2026-08-19  
**Status:** Approved  
**Milestone:** Context & AI Agent Superpowers  

---

## 1. Overview & Objective

OPPA provides a pure Rust, local-first **Model Context Protocol (MCP)** server built directly into the unified binary (`oppa --mcp` or `oppa mcp`). 

This allows external AI coding agents (such as **OpenCode**, **Claude Code**, **Cursor**, and **AGY**) running inside OPPA's terminal or locally on the developer's machine to seamlessly:
1. Detect and obey the active terminal pane's assigned **Persona** (e.g. `Debugger`, `Optimizer`, `Researcher`, `Test Architect`) and its behavioral rules.
2. Query project-specific memory notes, architecture blueprints, quirks, and runbooks in real-time via **SQLite + FTS5 full-text search**.
3. Retrieve full **L0/L1/L2 progressive tier** documentation on demand.
4. Persist newly discovered bug fixes, quirks, and runbooks back into OPPA's local database.

---

## 2. Architecture & Protocol Design

### 2.1 Unified Binary CLI Entrypoint
In `src-tauri/src/main.rs`:
- When invoked as `oppa --mcp` or `oppa mcp`:
  - Enters `run_mcp_server(workspace_dir: Option<PathBuf>)`.
  - Communicates over standard input/output (`stdin`/`stdout`) using standard newline-delimited JSON-RPC 2.0 MCP messages.
  - Zero external Python, Node, or Docker dependencies.

```
┌────────────────────────────────────────────────────────┐
│   AI Agent (OpenCode / Claude Code / Cursor / AGY)     │
└───────────────────────────┬────────────────────────────┘
                            │ stdio (JSON-RPC 2.0 MCP)
┌───────────────────────────▼────────────────────────────┐
│                  oppa --mcp (Rust)                     │
├────────────────────────────────────────────────────────┤
│  • oppa_get_active_persona                             │
│  • oppa_search_context (SQLite FTS5 + BM25)            │
│  • oppa_get_context_note (L0/L1/L2 details)            │
│  • oppa_save_context_note (Write back newly found bugs)│
└───────────────────────────┬────────────────────────────┘
                            │
┌───────────────────────────▼────────────────────────────┐
│      OPPA SQLite DB (<workspace>/.oppa/context.sqlite) │
└────────────────────────────────────────────────────────┘
```

---

## 3. MCP Protocol Specification (JSON-RPC 2.0)

The server implements the standard Model Context Protocol:

### 3.1 Handshake & Initialization
- **Request**: `initialize`
  ```json
  {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": { "tools": {} },
      "clientInfo": { "name": "opencode", "version": "1.0.0" }
    }
  }
  ```
- **Response**:
  ```json
  {
    "jsonrpc": "2.0",
    "id": 1,
    "result": {
      "protocolVersion": "2024-11-05",
      "capabilities": {
        "tools": { "listChanged": false }
      },
      "serverInfo": {
        "name": "oppa-mcp-server",
        "version": "0.1.0"
      }
    }
  }
  ```

### 3.2 Tool Definitions (`tools/list`)
The server advertises 4 primary tools:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "tools": [
      {
        "name": "oppa_get_active_persona",
        "description": "Get the currently assigned terminal persona, behavioral guidelines, and mounted memory scopes.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "persona_id": {
              "type": "string",
              "description": "Optional persona ID. If omitted, uses OPPA_PERSONA environment variable or default."
            }
          }
        }
      },
      {
        "name": "oppa_search_context",
        "description": "Search OPPA project memory notes and knowledge base using SQLite FTS5 with BM25 ranking.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "query": { "type": "string", "description": "Keywords or search term" },
            "category": {
              "type": "string",
              "enum": ["architecture", "quirk", "runbook", "persona", "preferences", "standards"],
              "description": "Optional category filter"
            },
            "limit": { "type": "integer", "description": "Max results (default: 5)" }
          },
          "required": ["query"]
        }
      },
      {
        "name": "oppa_get_context_note",
        "description": "Retrieve the complete L0 abstract, L1 markdown overview, and L2 details for a specific context path or ID.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "path": { "type": "string", "description": "Category and slug path (e.g. quirks/conpty-newline)" },
            "id": { "type": "string", "description": "Optional direct note ID" }
          }
        }
      },
      {
        "name": "oppa_save_context_note",
        "description": "Persist a new quirk, architecture note, or runbook into OPPA memory database.",
        "inputSchema": {
          "type": "object",
          "properties": {
            "category": { "type": "string", "enum": ["architecture", "quirk", "runbook", "persona", "preferences", "standards"] },
            "title": { "type": "string" },
            "abstract_l0": { "type": "string", "description": "1-2 sentence dense summary (~100 tokens)" },
            "overview_l1": { "type": "string", "description": "Structured markdown resolution or overview" },
            "details_l2": { "type": "string", "description": "Optional raw stack traces, diffs, or compiler logs" },
            "scope": { "type": "string", "enum": ["workspace", "global"], "default": "workspace" }
          },
          "required": ["category", "title", "abstract_l0", "overview_l1"]
        }
      }
    ]
  }
}
```

---

## 4. Rust Backend Implementation (`src-tauri/src/mcp/`)

1. **`src-tauri/src/mcp/mod.rs`**: Module exports and server lifecycle.
2. **`src-tauri/src/mcp/protocol.rs`**: Serde models for JSON-RPC 2.0 requests, responses, tool definitions, and tool call dispatches.
3. **`src-tauri/src/mcp/server.rs`**: Tokio asynchronous stdio reader/writer loop dispatching tool calls to `ContextManager`.
4. **`src-tauri/src/main.rs`**: CLI flag parsing for `--mcp` / `mcp` subcommands.

---

## 5. Frontend 1-Click Setup in Context Studio

1. **Header Action**: An **`[ MCP Config ]`** button with an icon in the Context Studio header.
2. **Modal (`McpConfigModal.tsx`)**:
   - Tabbed snippets for:
     - **OpenCode** (`opencode.json` mcpServers block)
     - **Claude Code** (`claude.json` / `claude_desktop_config.json`)
     - **Cursor** (`.cursor/mcp.json`)
     - **Antigravity / AGY** (`agy.json`)
   - Auto-resolves current binary path and active workspace path.
   - 1-Click **"Copy Configuration"** button with feedback tooltip.

---

## 6. Testing & Quality Standards

1. **Rust Unit Tests**:
   - `test_mcp_initialize_and_tool_list`: Validates protocol initialization.
   - `test_mcp_tool_search_context`: Verifies FTS5 query results.
   - `test_mcp_tool_get_active_persona`: Checks persona payload.
   - `test_mcp_tool_save_and_retrieve_note`: Verifies roundtrip note persistence.
2. **Frontend Vitest Tests**:
   - `McpConfigModal.test.tsx`: Tests tab switching, snippet generation, and clipboard copying.
   - `ContextStudio.test.tsx`: Verifies `MCP Config` button opening modal.
