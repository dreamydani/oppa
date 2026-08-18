# OPPA MCP Server & AI Agent Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a pure Rust Model Context Protocol (MCP) server directly into OPPA (`oppa --mcp`) providing 4 tools (`oppa_get_active_persona`, `oppa_search_context`, `oppa_get_context_note`, `oppa_save_context_note`) backed by OPPA's SQLite + FTS5 memory engine, and add a 1-click configuration modal in Context Studio for OpenCode, Claude Code, Cursor, and AGY.

**Architecture:** A stdio JSON-RPC 2.0 MCP server in `src-tauri/src/mcp/` backed by `ContextManager`. Unified CLI binary entrypoint in `src-tauri/src/main.rs` dispatching `oppa --mcp`. Frontend `McpConfigModal` in `src/components/context/` generating ready-to-copy JSON configuration files.

**Tech Stack:** Rust (Tokio, Serde, Serde JSON, Rusqlite FTS5), TypeScript, React 19, Zustand, Vitest, Happy-DOM.

## Global Constraints

- **Pure Rust-first**: Zero external Python, Node, or Docker dependencies; runs from unified binary `oppa --mcp`.
- **State vs Transport Split**: Frontend components interact only via Zustand stores and transport boundaries.
- **Concise comments ONLY**: Explain WHY, not HOW; 1 line if possible.
- **No vague names**: Explicit domain naming for all files, structs, and modules.
- **TDD required**: Write failing test first, verify failure, implement, verify pass, commit.

---

### Task 1: Rust MCP Protocol & Serde Data Models

**Files:**
- Create: `src-tauri/src/mcp/protocol.rs`
- Create: `src-tauri/src/mcp/mod.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `src-tauri/src/mcp/protocol.rs`

**Interfaces:**
- Consumes: `serde`, `serde_json`
- Produces: `McpRequest`, `McpResponse`, `McpTool`, `McpToolCall`, `McpInitializeResult`, `McpToolsListResult`, `McpCallToolResult`

- [ ] **Step 1: Write the failing unit tests for MCP protocol serialization & deserialization**

```rust
// in src-tauri/src/mcp/protocol.rs
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mcp_initialize_request_deserialization() {
        let json = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"opencode","version":"1.0"}}}"#;
        let req: JsonRpcRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.method, "initialize");
        assert_eq!(req.id, Some(serde_json::json!(1)));
    }

    #[test]
    fn test_mcp_tools_list_response_serialization() {
        let tools = get_oppa_mcp_tools();
        assert_eq!(tools.len(), 4);
        assert_eq!(tools[0].name, "oppa_get_active_persona");
        assert_eq!(tools[1].name, "oppa_search_context");
        assert_eq!(tools[2].name, "oppa_get_context_note");
        assert_eq!(tools[3].name, "oppa_save_context_note");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p oppa --lib mcp::protocol` in `src-tauri`  
Expected: FAIL with module not found / types not defined.

- [ ] **Step 3: Implement MCP JSON-RPC protocol types and tool definitions**

Implement `src-tauri/src/mcp/protocol.rs` with `JsonRpcRequest`, `JsonRpcResponse`, `McpTool`, `get_oppa_mcp_tools()`, and export in `src-tauri/src/mcp/mod.rs` and `src-tauri/src/lib.rs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p oppa --lib mcp::protocol` in `src-tauri`  
Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/mcp/protocol.rs src-tauri/src/mcp/mod.rs src-tauri/src/lib.rs
git commit -m "feat(mcp): implement MCP protocol models and tool definitions"
```

---

### Task 2: Rust MCP Server Execution & Tool Handlers

**Files:**
- Create: `src-tauri/src/mcp/server.rs`
- Modify: `src-tauri/src/mcp/mod.rs`
- Test: `src-tauri/src/mcp/server.rs`

**Interfaces:**
- Consumes: `ContextManager`, `JsonRpcRequest`, `get_oppa_mcp_tools()`
- Produces: `McpServer::handle_request()`, `run_mcp_stdio()`

- [ ] **Step 1: Write failing unit tests for tool dispatching**

```rust
// in src-tauri/src/mcp/server.rs
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[tokio::test]
    async fn test_mcp_handle_initialize_and_tools_list() {
        let temp_dir = TempDir::new().unwrap();
        let server = McpServer::new_with_dir(temp_dir.path().to_path_buf());
        let init_req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": { "protocolVersion": "2024-11-05" }
        });
        let res = server.handle_request(init_req).await.unwrap();
        assert_eq!(res["result"]["serverInfo"]["name"], "oppa-mcp-server");
    }

    #[tokio::test]
    async fn test_mcp_handle_tool_search_and_save() {
        let temp_dir = TempDir::new().unwrap();
        let server = McpServer::new_with_dir(temp_dir.path().to_path_buf());
        
        // Save note
        let save_req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": "oppa_save_context_note",
                "arguments": {
                    "category": "quirk",
                    "title": "ConPTY Newline Bug",
                    "abstract_l0": "ConPTY duplicate newline handling",
                    "overview_l1": "Sanitize escape sequences"
                }
            }
        });
        let save_res = server.handle_request(save_req).await.unwrap();
        assert!(!save_res["result"]["isError"].as_bool().unwrap_or(false));

        // Search note
        let search_req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {
                "name": "oppa_search_context",
                "arguments": { "query": "ConPTY" }
            }
        });
        let search_res = server.handle_request(search_req).await.unwrap();
        let content = search_res["result"]["content"][0]["text"].as_str().unwrap();
        assert!(content.contains("ConPTY Newline Bug"));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p oppa --lib mcp::server` in `src-tauri`  
Expected: FAIL with `McpServer` not defined.

- [ ] **Step 3: Implement `McpServer` and tool dispatch logic**

Implement `McpServer` in `src-tauri/src/mcp/server.rs` connecting tool calls to `ContextManager` methods:
- `oppa_get_active_persona`: Reads persona by ID or environment variable `OPPA_PERSONA`.
- `oppa_search_context`: Calls `context_manager.search_pages()`.
- `oppa_get_context_note`: Calls `context_manager.get_page_by_id()` / slug resolution.
- `oppa_save_context_note`: Calls `context_manager.upsert_page()`.
- `run_mcp_stdio()`: Async loop reading lines from `tokio::io::stdin()` and writing to `tokio::io::stdout()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p oppa --lib mcp::server` in `src-tauri`  
Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/mcp/server.rs src-tauri/src/mcp/mod.rs
git commit -m "feat(mcp): implement MCP server request handler and stdio loop"
```

---

### Task 3: CLI Subcommand Integration

**Files:**
- Modify: `src-tauri/src/main.rs`
- Test: `src-tauri/src/main.rs`

**Interfaces:**
- Consumes: `oppa::mcp::run_mcp_stdio`, `std::env::args()`
- Produces: CLI handler for `oppa --mcp` and `oppa mcp`

- [ ] **Step 1: Write CLI dispatch handling in `src-tauri/src/main.rs`**

Add CLI argument parsing for `--mcp` / `mcp` with optional `--workspace <dir>` argument to start `run_mcp_stdio(workspace)`.

- [ ] **Step 2: Verify cargo compilation and test suite**

Run: `cargo test -p oppa --lib` in `src-tauri`  
Expected: PASS with all tests passing.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/main.rs
git commit -m "feat(cli): add --mcp subcommand to launch stdio MCP server"
```

---

### Task 4: Frontend MCP Config Modal & Context Studio Integration

**Files:**
- Create: `src/components/context/McpConfigModal.tsx`
- Create: `src/components/context/McpConfigModal.css`
- Create: `src/components/context/McpConfigModal.test.tsx`
- Modify: `src/components/context/ContextStudio.tsx`
- Modify: `src/components/context/ContextIcons.tsx`
- Test: `src/components/context/McpConfigModal.test.tsx` and `src/components/context/ContextStudio.test.tsx`

**Interfaces:**
- Consumes: Active workspace path, Minimalist theme tokens
- Produces: `McpConfigModal` component with 1-click copy snippets for OpenCode, Claude Code, Cursor, AGY.

- [ ] **Step 1: Write failing tests in `src/components/context/McpConfigModal.test.tsx`**

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { McpConfigModal } from "./McpConfigModal";

describe("McpConfigModal", () => {
  it("renders tabs for OpenCode, Claude Code, Cursor, and AGY", () => {
    render(<McpConfigModal isOpen={true} onClose={vi.fn()} workspacePath="D:/oppa/oppa" />);
    expect(screen.getByText("OpenCode")).toBeInTheDocument();
    expect(screen.getByText("Claude Code")).toBeInTheDocument();
    expect(screen.getByText("Cursor")).toBeInTheDocument();
    expect(screen.getByText("AGY")).toBeInTheDocument();
  });

  it("copies configuration to clipboard on button click", async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText: writeTextMock } });

    render(<McpConfigModal isOpen={true} onClose={vi.fn()} workspacePath="D:/oppa/oppa" />);
    const copyBtn = screen.getByRole("button", { name: /copy configuration/i });
    fireEvent.click(copyBtn);
    expect(writeTextMock).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/components/context/McpConfigModal.test.tsx`  
Expected: FAIL with component not found.

- [ ] **Step 3: Implement `McpConfigModal.tsx`, `ContextIcons.tsx`, and `ContextStudio.tsx`**

1. Add `IconServer` and `IconCopy` to `ContextIcons.tsx`.
2. Implement `McpConfigModal.tsx` and `McpConfigModal.css` with tabbed snippet views and copy button.
3. Wire the `[ MCP Config ]` button into `ContextStudio.tsx` header to open the modal.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/components/context/`  
Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
git add src/components/context/
git commit -m "feat(context): add MCP config modal with 1-click setup for OpenCode, Claude, Cursor"
```

---

### Task 5: End-to-End Verification

**Files:**
- Test: All Rust & frontend test suites

- [ ] **Step 1: Run full frontend test suite**

Run: `pnpm vitest run`  
Expected: All test files passing.

- [ ] **Step 2: Run production TypeScript and Vite build**

Run: `pnpm build`  
Expected: Clean build with 0 errors.

- [ ] **Step 3: Run full Rust test suite and daemon integration tests**

Run: `cargo test -p oppa --lib` and `cargo test -p oppa --test daemon_integration_test` in `src-tauri`  
Expected: All Rust tests passing.

- [ ] **Step 4: Commit and finalize**

```bash
git commit --allow-empty -m "chore: complete OPPA MCP server and agent integration verification"
```
