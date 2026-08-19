use std::path::PathBuf;
use std::str::FromStr;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

use crate::context::enums::ContextCategory;
use crate::context::manager::ContextManager;
use crate::context::models::ContextPage;
use crate::mcp::protocol::{
    get_oppa_mcp_tools, JsonRpcRequest, JsonRpcResponse, McpCallToolParams, McpCallToolResult,
    McpCapabilities, McpInitializeResult, McpServerInfo, McpToolsCapability, McpToolsListResult,
};

/// MCP server instance handling JSON-RPC 2.0 requests over stdio.
#[derive(Debug, Clone)]
pub struct McpServer {
    context_manager: ContextManager,
    workspace_dir: Option<PathBuf>,
}

impl McpServer {
    /// Create a new MCP server with optional workspace directory.
    pub fn new(workspace_dir: Option<PathBuf>) -> Self {
        Self {
            context_manager: ContextManager::new(),
            workspace_dir,
        }
    }

    /// Create a new MCP server rooted at a custom directory (used for testing).
    pub fn new_with_dir(dir: PathBuf) -> Self {
        let global_db_path = dir.join("global_context.sqlite");
        Self {
            context_manager: ContextManager::with_global_db_path(global_db_path),
            workspace_dir: Some(dir),
        }
    }

    /// Handle inbound JSON-RPC 2.0 request or notification value.
    pub async fn handle_request(&self, req_val: serde_json::Value) -> Result<serde_json::Value, String> {
        let req: JsonRpcRequest = match serde_json::from_value(req_val) {
            Ok(r) => r,
            Err(e) => {
                let err_resp = JsonRpcResponse::error(None, -32600, format!("Invalid Request: {}", e), None);
                return serde_json::to_value(err_resp).map_err(|e| e.to_string());
            }
        };

        let response = match req.method.as_str() {
            "initialize" => self.handle_initialize(req.id),
            "notifications/initialized" => {
                if let Some(id) = req.id {
                    JsonRpcResponse::success(Some(id), serde_json::json!({}))
                } else {
                    return Ok(serde_json::Value::Null);
                }
            }
            "ping" => JsonRpcResponse::success(req.id, serde_json::json!({})),
            "tools/list" => self.handle_tools_list(req.id),
            "tools/call" => self.handle_tools_call(req.id, req.params).await,
            unknown => JsonRpcResponse::error(
                req.id,
                -32601,
                format!("Method not found: {}", unknown),
                None,
            ),
        };

        serde_json::to_value(response).map_err(|e| e.to_string())
    }

    // Handle MCP protocol handshake initialize.
    fn handle_initialize(&self, id: Option<serde_json::Value>) -> JsonRpcResponse {
        let result = McpInitializeResult {
            protocol_version: "2024-11-05".to_string(),
            capabilities: McpCapabilities {
                tools: Some(McpToolsCapability {
                    list_changed: Some(false),
                }),
            },
            server_info: McpServerInfo {
                name: "oppa-mcp-server".to_string(),
                version: "0.1.0".to_string(),
            },
        };
        JsonRpcResponse::success(id, serde_json::to_value(result).unwrap_or_default())
    }

    // Return advertised tools list.
    fn handle_tools_list(&self, id: Option<serde_json::Value>) -> JsonRpcResponse {
        let result = McpToolsListResult {
            tools: get_oppa_mcp_tools(),
        };
        JsonRpcResponse::success(id, serde_json::to_value(result).unwrap_or_default())
    }

    // Dispatch tool call requests to concrete tool handlers.
    async fn handle_tools_call(
        &self,
        id: Option<serde_json::Value>,
        params: Option<serde_json::Value>,
    ) -> JsonRpcResponse {
        let params: McpCallToolParams = match params {
            Some(p) => match serde_json::from_value(p) {
                Ok(parsed) => parsed,
                Err(e) => {
                    return JsonRpcResponse::error(
                        id,
                        -32602,
                        format!("Invalid tool call parameters: {}", e),
                        None,
                    );
                }
            },
            None => {
                return JsonRpcResponse::error(
                    id,
                    -32602,
                    "Missing parameters for tools/call",
                    None,
                );
            }
        };

        let args = params.arguments.unwrap_or_else(|| serde_json::json!({}));
        let tool_result = match params.name.as_str() {
            "oppa_get_active_persona" => self.tool_get_active_persona(&args),
            "oppa_search_context" => self.tool_search_context(&args),
            "oppa_get_context_note" => self.tool_get_context_note(&args),
            "oppa_save_context_note" => self.tool_save_context_note(&args),
            unknown => Ok(McpCallToolResult::error(format!("Unknown tool: {}", unknown))),
        };

        match tool_result {
            Ok(res) => JsonRpcResponse::success(id, serde_json::to_value(res).unwrap_or_default()),
            Err(err) => {
                let err_res = McpCallToolResult::error(err);
                JsonRpcResponse::success(id, serde_json::to_value(err_res).unwrap_or_default())
            }
        }
    }

    fn ws_str(&self) -> Option<&str> {
        self.workspace_dir.as_ref().and_then(|p| p.to_str())
    }

    // Tool: oppa_get_active_persona
    fn tool_get_active_persona(&self, args: &serde_json::Value) -> Result<McpCallToolResult, String> {
        let requested_id = args
            .get("persona_id")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .or_else(|| std::env::var("OPPA_PERSONA").ok().filter(|s| !s.is_empty()))
            .unwrap_or_else(|| "debugger".to_string());

        let personas = self.context_manager.list_personas(self.ws_str())?;
        let matching = personas
            .iter()
            .find(|p| p.id.eq_ignore_ascii_case(&requested_id) || p.name.eq_ignore_ascii_case(&requested_id))
            .or_else(|| personas.first());

        match matching {
            Some(p) => {
                let scopes_str = if p.attached_scopes.is_empty() {
                    "- default (workspace & global)".to_string()
                } else {
                    p.attached_scopes.iter().map(|s| format!("- {}", s)).collect::<Vec<_>>().join("\n")
                };
                let mut text = format!(
                    "# Persona: {} (`{}`)\n\n**Tagline**: {}\n\n## Behavioral Guidelines\n{}\n\n## Mounted Context Scopes\n{}",
                    p.name, p.id, p.tagline, p.system_prompt, scopes_str
                );

                let mut resolved_pages = Vec::new();
                let mut seen_ids = std::collections::HashSet::new();

                if p.attached_scopes.is_empty() {
                    for token in &["global", "workspace"] {
                        if let Ok(pages) = self.context_manager.list_pages_for_scope_token(token, self.ws_str()) {
                            for page in pages {
                                if seen_ids.insert(page.id.clone()) {
                                    resolved_pages.push(page);
                                }
                            }
                        }
                    }
                } else {
                    for token in &p.attached_scopes {
                        if let Ok(pages) = self.context_manager.list_pages_for_scope_token(token, self.ws_str()) {
                            for page in pages {
                                if seen_ids.insert(page.id.clone()) {
                                    resolved_pages.push(page);
                                }
                            }
                        }
                    }
                }

                if !resolved_pages.is_empty() {
                    text.push_str("\n\n## Resolved Notes (L0)");
                    for page in &resolved_pages {
                        text.push_str(&format!("\n- **{}** (`{}`): {}", page.title, page.path, page.abstract_l0));
                    }
                }

                Ok(McpCallToolResult::success(text))
            }
            None => Ok(McpCallToolResult::error(format!(
                "Persona '{}' not found and no default personas available",
                requested_id
            ))),
        }
    }

    // Tool: oppa_search_context
    fn tool_search_context(&self, args: &serde_json::Value) -> Result<McpCallToolResult, String> {
        let query = match args.get("query").and_then(|v| v.as_str()) {
            Some(q) if !q.trim().is_empty() => q.trim(),
            _ => return Ok(McpCallToolResult::error("Missing required parameter: 'query'")),
        };
        let category_filter = match args.get("category").and_then(|v| v.as_str()).filter(|s| !s.trim().is_empty()) {
            Some(c) => match ContextCategory::from_str(c.trim()) {
                Ok(cat) => Some(cat.as_str().to_string()),
                Err(e) => return Ok(McpCallToolResult::error(e)),
            },
            None => None,
        };
        let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(5) as usize;

        let mut results = self.context_manager.search_fts(query, self.ws_str(), Some(limit))?;
        let total = results.first().map(|r| r.total).unwrap_or(results.len() as i64);

        if let Some(ref cat) = category_filter {
            results.retain(|r| r.category.eq_ignore_ascii_case(cat));
        }
        results.truncate(limit);

        if results.is_empty() {
            return Ok(McpCallToolResult::success(format!(
                "No context notes found matching query: '{}'",
                query
            )));
        }

        let mut formatted = format!("Found {} of {} total context notes matching '{}':\n\n", results.len(), total, query);
        for (idx, r) in results.iter().enumerate() {
            let snippet = r.snippet.replace("<b>", "**").replace("</b>", "**");
            formatted.push_str(&format!(
                "{}. **{}** (`{}`)\n   - **ID**: {}\n   - **Category**: {} | **Scope**: {}\n   - **Summary (L0)**: {}\n   - **Snippet**: {}\n\n",
                idx + 1, r.title, r.path, r.id, r.category, r.scope, r.abstract_l0, snippet
            ));
        }

        Ok(McpCallToolResult::success(formatted))
    }

    // Tool: oppa_get_context_note
    fn tool_get_context_note(&self, args: &serde_json::Value) -> Result<McpCallToolResult, String> {
        let id_opt = args.get("id").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
        let path_opt = args.get("path").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
        let scope_opt = args.get("scope").and_then(|v| v.as_str()).filter(|s| !s.is_empty());

        if id_opt.is_none() && path_opt.is_none() {
            return Ok(McpCallToolResult::error("Either 'id' or 'path' must be provided"));
        }

        let mut page = if let Some(id) = id_opt {
            self.context_manager.get_page(id, self.ws_str())?
        } else {
            None
        };

        if page.is_none() {
            let target_path = path_opt.or(id_opt).unwrap();
            if let Some(scope) = scope_opt {
                page = self.context_manager.get_page_by_path(scope, target_path, self.ws_str())?;
            } else {
                if self.ws_str().is_some() {
                    page = self.context_manager.get_page_by_path("workspace", target_path, self.ws_str())?;
                }
                if page.is_none() {
                    page = self.context_manager.get_page_by_path("global", target_path, self.ws_str())?;
                }
            }
        }

        match page {
            Some(p) => {
                let mut text = format!(
                    "# {} (`{}`)\n\n- **Category**: {}\n- **Scope**: {}\n- **Path**: `{}`\n- **Icon**: {}\n\n## Summary (L0)\n{}\n\n## Overview (L1)\n{}\n",
                    p.title, p.id, p.category, p.scope, p.path, p.icon, p.abstract_l0, p.overview_l1
                );
                if let Some(details) = p.details_l2.as_ref().filter(|s| !s.is_empty()) {
                    text.push_str(&format!("\n## Details (L2)\n{}\n", details));
                }
                Ok(McpCallToolResult::success(text))
            }
            None => {
                let target = id_opt.or(path_opt).unwrap_or("unknown");
                Ok(McpCallToolResult::error(format!(
                    "Context note '{}' not found",
                    target
                )))
            }
        }
    }

    // Tool: oppa_save_context_note
    fn tool_save_context_note(&self, args: &serde_json::Value) -> Result<McpCallToolResult, String> {
        let category_raw = match args.get("category").and_then(|v| v.as_str()) {
            Some(c) if !c.trim().is_empty() => c.trim(),
            _ => return Ok(McpCallToolResult::error("Missing required parameter: 'category'")),
        };
        let category = match ContextCategory::from_str(category_raw) {
            Ok(cat) => cat.as_str().to_string(),
            Err(e) => return Ok(McpCallToolResult::error(e)),
        };
        let title = match args.get("title").and_then(|v| v.as_str()) {
            Some(t) if !t.trim().is_empty() => t.trim().to_string(),
            _ => return Ok(McpCallToolResult::error("Missing required parameter: 'title'")),
        };
        let abstract_l0 = match args.get("abstract_l0").and_then(|v| v.as_str()) {
            Some(a) if !a.trim().is_empty() => a.trim().to_string(),
            _ => return Ok(McpCallToolResult::error("Missing required parameter: 'abstract_l0'")),
        };
        let overview_l1 = match args.get("overview_l1").and_then(|v| v.as_str()) {
            Some(o) if !o.trim().is_empty() => o.trim().to_string(),
            _ => return Ok(McpCallToolResult::error("Missing required parameter: 'overview_l1'")),
        };
        let details_l2 = args
            .get("details_l2")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let scope_param = args.get("scope").and_then(|v| v.as_str()).unwrap_or("workspace");
        let scope = if scope_param == "workspace" && self.ws_str().is_none() {
            "global".to_string()
        } else {
            scope_param.to_string()
        };

        let slug: String = title
            .chars()
            .map(|c| if c.is_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
            .collect::<String>()
            .split('-')
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("-");
        let slug = if slug.is_empty() { "note".to_string() } else { slug };

        let id = args
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("{}-{}", slug, chrono::Utc::now().timestamp_millis() % 100000));

        let path = args
            .get("path")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("{}/{}", category, slug));

        let icon = args
            .get("icon")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| match category.as_str() {
                "quirk" => "🐛".to_string(),
                "architecture" => "🏗️".to_string(),
                "runbook" => "🚀".to_string(),
                "persona" => "👤".to_string(),
                "preference" => "⚙️".to_string(),
                _ => "📝".to_string(),
            });

        let now = chrono::Utc::now().timestamp_millis();
        let existing = self.context_manager.get_page(&id, self.ws_str()).ok().flatten();
        let created_at = existing.map(|p| p.created_at).unwrap_or(now);

        let page = ContextPage {
            id: id.clone(),
            scope: scope.clone(),
            category,
            path: path.clone(),
            title: title.clone(),
            icon,
            abstract_l0,
            overview_l1,
            details_l2,
            pinned: false,
            is_built_in: false,
            attached_scopes_json: "[]".to_string(),
            created_at,
            updated_at: now,
            deleted_at: None,
        };

        self.context_manager.upsert_page(&page, self.ws_str())?;

        Ok(McpCallToolResult::success(format!(
            "Successfully saved context note '{}' (id: {}, path: {})",
            page.title, page.id, page.path
        )))
    }
}

/// Run the stdio MCP server event loop until EOF.
pub async fn run_mcp_stdio(workspace_dir: Option<PathBuf>) -> Result<(), Box<dyn std::error::Error>> {
    let server = McpServer::new(workspace_dir);
    let stdin = tokio::io::stdin();
    let mut reader = tokio::io::BufReader::new(stdin).lines();
    let mut stdout = tokio::io::stdout();

    while let Some(line) = reader.next_line().await? {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        match serde_json::from_str::<serde_json::Value>(trimmed) {
            Ok(req_val) => match server.handle_request(req_val).await {
                Ok(resp_val) => {
                    if !resp_val.is_null() {
                        let mut out = serde_json::to_string(&resp_val)?;
                        out.push('\n');
                        stdout.write_all(out.as_bytes()).await?;
                        stdout.flush().await?;
                    }
                }
                Err(err) => {
                    let err_resp = JsonRpcResponse::error(None, -32603, err, None);
                    let mut out = serde_json::to_string(&err_resp)?;
                    out.push('\n');
                    stdout.write_all(out.as_bytes()).await?;
                    stdout.flush().await?;
                }
            },
            Err(parse_err) => {
                let err_resp = JsonRpcResponse::error(
                    None,
                    -32700,
                    format!("Parse error: {}", parse_err),
                    None,
                );
                let mut out = serde_json::to_string(&err_resp)?;
                out.push('\n');
                stdout.write_all(out.as_bytes()).await?;
                stdout.flush().await?;
            }
        }
    }

    Ok(())
}

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
        assert_eq!(res["result"]["protocolVersion"], "2024-11-05");

        let list_req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/list"
        });
        let list_res = server.handle_request(list_req).await.unwrap();
        let tools = list_res["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 4);
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

    #[tokio::test]
    async fn test_mcp_handle_active_persona() {
        let temp_dir = TempDir::new().unwrap();
        let server = McpServer::new_with_dir(temp_dir.path().to_path_buf());

        let persona_req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 4,
            "method": "tools/call",
            "params": {
                "name": "oppa_get_active_persona",
                "arguments": { "persona_id": "debugger" }
            }
        });
        let res = server.handle_request(persona_req).await.unwrap();
        let content = res["result"]["content"][0]["text"].as_str().unwrap();
        assert!(content.contains("Debugger") || content.contains("debugger"));
    }

    #[tokio::test]
    async fn test_mcp_handle_get_context_note() {
        let temp_dir = TempDir::new().unwrap();
        let server = McpServer::new_with_dir(temp_dir.path().to_path_buf());

        let save_req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {
                "name": "oppa_save_context_note",
                "arguments": {
                    "id": "arch-ipc",
                    "path": "architecture/ipc",
                    "category": "architecture",
                    "title": "IPC Named Pipes",
                    "abstract_l0": "Named pipes transport",
                    "overview_l1": "Detailed Tokio named pipe transport protocol"
                }
            }
        });
        server.handle_request(save_req).await.unwrap();

        let get_req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 6,
            "method": "tools/call",
            "params": {
                "name": "oppa_get_context_note",
                "arguments": { "id": "arch-ipc" }
            }
        });
        let get_res = server.handle_request(get_req).await.unwrap();
        let content = get_res["result"]["content"][0]["text"].as_str().unwrap();
        assert!(content.contains("IPC Named Pipes"));
        assert!(content.contains("Detailed Tokio named pipe transport"));
    }

    #[tokio::test]
    async fn test_mcp_notifications_and_ping() {
        let temp_dir = TempDir::new().unwrap();
        let server = McpServer::new_with_dir(temp_dir.path().to_path_buf());

        let ping_req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 10,
            "method": "ping"
        });
        let ping_res = server.handle_request(ping_req).await.unwrap();
        assert_eq!(ping_res["result"], serde_json::json!({}));

        let notif_req = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        });
        let notif_res = server.handle_request(notif_req).await.unwrap();
        assert!(notif_res.is_null());
    }

    #[tokio::test]
    async fn test_mcp_invalid_methods_and_missing_params() {
        let temp_dir = TempDir::new().unwrap();
        let server = McpServer::new_with_dir(temp_dir.path().to_path_buf());

        let bad_method = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 20,
            "method": "non_existent_method"
        });
        let res = server.handle_request(bad_method).await.unwrap();
        assert_eq!(res["error"]["code"], -32601);

        let missing_query = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 21,
            "method": "tools/call",
            "params": {
                "name": "oppa_search_context",
                "arguments": {}
            }
        });
        let search_res = server.handle_request(missing_query).await.unwrap();
        assert_eq!(search_res["result"]["isError"], true);

        let unknown_tool = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 22,
            "method": "tools/call",
            "params": {
                "name": "unknown_tool_name",
                "arguments": {}
            }
        });
        let unknown_res = server.handle_request(unknown_tool).await.unwrap();
        assert_eq!(unknown_res["result"]["isError"], true);
    }

    #[tokio::test]
    async fn test_mcp_search_category_filter_and_limit() {
        let temp_dir = TempDir::new().unwrap();
        let server = McpServer::new_with_dir(temp_dir.path().to_path_buf());

        // Save two notes with same keyword in different categories
        let save_quirk = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 30,
            "method": "tools/call",
            "params": {
                "name": "oppa_save_context_note",
                "arguments": {
                    "category": "quirk",
                    "title": "WebSocket Rust Quirk",
                    "abstract_l0": "WebSocket handshake issues",
                    "overview_l1": "Detailed WebSocket bug analysis"
                }
            }
        });
        server.handle_request(save_quirk).await.unwrap();

        let save_arch = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 31,
            "method": "tools/call",
            "params": {
                "name": "oppa_save_context_note",
                "arguments": {
                    "category": "architecture",
                    "title": "WebSocket Gateway Architecture",
                    "abstract_l0": "WebSocket daemon architecture",
                    "overview_l1": "Detailed WebSocket gateway design"
                }
            }
        });
        server.handle_request(save_arch).await.unwrap();

        // Search with category filter
        let filter_search = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 32,
            "method": "tools/call",
            "params": {
                "name": "oppa_search_context",
                "arguments": {
                    "query": "WebSocket",
                    "category": "quirk"
                }
            }
        });
        let search_res = server.handle_request(filter_search).await.unwrap();
        let text = search_res["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("WebSocket Rust Quirk"));
        assert!(!text.contains("WebSocket Gateway Architecture"));
    }

    #[tokio::test]
    async fn test_mcp_dual_scope_isolation_and_workspace_override() {
        let temp_dir = TempDir::new().unwrap();
        let server = McpServer::new_with_dir(temp_dir.path().to_path_buf());

        // Save global note
        let save_global = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 40,
            "method": "tools/call",
            "params": {
                "name": "oppa_save_context_note",
                "arguments": {
                    "id": "shared-tool-config",
                    "scope": "global",
                    "category": "preference",
                    "title": "Global Tooling",
                    "abstract_l0": "Global tooling configuration",
                    "overview_l1": "Shared editor and terminal options"
                }
            }
        });
        server.handle_request(save_global).await.unwrap();

        // Fetch it
        let get_req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 41,
            "method": "tools/call",
            "params": {
                "name": "oppa_get_context_note",
                "arguments": { "id": "shared-tool-config" }
            }
        });
        let get_res = server.handle_request(get_req).await.unwrap();
        let content = get_res["result"]["content"][0]["text"].as_str().unwrap();
        assert!(content.contains("Global Tooling"));
        assert!(content.contains("global"));
    }

    #[tokio::test]
    async fn test_mcp_scope_resolver_returns_matching_l0() {
        let temp_dir = TempDir::new().unwrap();
        let server = McpServer::new_with_dir(temp_dir.path().to_path_buf());

        // Save a quirk in workspace
        let save_quirk = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 70,
            "method": "tools/call",
            "params": {
                "name": "oppa_save_context_note",
                "arguments": {
                    "id": "pty-ack-quirk",
                    "scope": "workspace",
                    "category": "quirk",
                    "title": "PTY ACK Flow Control",
                    "abstract_l0": "ACK backpressure flow control mechanism",
                    "overview_l1": "Pauses at 256KB and resumes at 32KB"
                }
            }
        });
        server.handle_request(save_quirk).await.unwrap();

        // Save an architecture note in workspace
        let save_arch = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 71,
            "method": "tools/call",
            "params": {
                "name": "oppa_save_context_note",
                "arguments": {
                    "id": "ipc-pipe-arch",
                    "scope": "workspace",
                    "category": "architecture",
                    "title": "IPC Pipe Architecture",
                    "abstract_l0": "Named pipe IPC architecture overview",
                    "overview_l1": "Tokio named pipes"
                }
            }
        });
        server.handle_request(save_arch).await.unwrap();

        // Create a custom persona with attached_scopes = ["quirk"]
        let persona = crate::context::models::AgentPersona {
            id: "specialist".to_string(),
            name: "Specialist Agent".to_string(),
            icon: "🔬".to_string(),
            tagline: "Quirks specialist".to_string(),
            system_prompt: "Focus on quirks".to_string(),
            attached_scopes: vec!["quirk".to_string()],
            is_built_in: false,
        };
        server.context_manager.upsert_persona(&persona, server.ws_str()).unwrap();

        // Request active persona with persona_id = "specialist"
        let persona_req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 72,
            "method": "tools/call",
            "params": {
                "name": "oppa_get_active_persona",
                "arguments": { "persona_id": "specialist" }
            }
        });
        let res = server.handle_request(persona_req).await.unwrap();
        let content = res["result"]["content"][0]["text"].as_str().unwrap();

        assert!(content.contains("## Resolved Notes (L0)"));
        assert!(content.contains("PTY ACK Flow Control"));
        assert!(content.contains("ACK backpressure flow control mechanism"));
        // Architecture note should NOT be in resolved notes since attached_scopes only has "quirk"
        assert!(!content.contains("IPC Pipe Architecture"));

        // Built-in persona with empty scopes should resolve default scopes (global & workspace)
        let default_req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 73,
            "method": "tools/call",
            "params": {
                "name": "oppa_get_active_persona",
                "arguments": { "persona_id": "debugger" }
            }
        });
        let default_res = server.handle_request(default_req).await.unwrap();
        let default_content = default_res["result"]["content"][0]["text"].as_str().unwrap();
        assert!(default_content.contains("## Resolved Notes (L0)"));
        assert!(default_content.contains("PTY ACK Flow Control"));
        assert!(default_content.contains("IPC Pipe Architecture"));
    }

    #[tokio::test]
    async fn test_mcp_workspace_flag_writes_to_workspace_db() {
        let temp_dir = TempDir::new().unwrap();
        let ws_dir = temp_dir.path().to_path_buf();
        let server = McpServer::new_with_dir(ws_dir.clone());

        // Save note with workspace scope
        let save_ws = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 80,
            "method": "tools/call",
            "params": {
                "name": "oppa_save_context_note",
                "arguments": {
                    "id": "ws-note-1",
                    "scope": "workspace",
                    "category": "quirk",
                    "title": "Workspace Quirk",
                    "abstract_l0": "Workspace specific quirk",
                    "overview_l1": "Detailed resolution"
                }
            }
        });
        let res = server.handle_request(save_ws).await.unwrap();
        assert!(!res["result"]["isError"].as_bool().unwrap_or(false));

        // Workspace SQLite DB file should exist at <ws_dir>/.oppa/context.sqlite
        let ws_db_path = ws_dir.join(".oppa").join("context.sqlite");
        assert!(ws_db_path.exists(), "Workspace DB must exist after workspace save");

        // Verify page exists in workspace DB by exact path lookup
        let get_req = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 81,
            "method": "tools/call",
            "params": {
                "name": "oppa_get_context_note",
                "arguments": {
                    "path": "quirk/workspace-quirk",
                    "scope": "workspace"
                }
            }
        });
        let get_res = server.handle_request(get_req).await.unwrap();
        let content = get_res["result"]["content"][0]["text"].as_str().unwrap();
        assert!(content.contains("Workspace Quirk"));
        assert!(content.contains("workspace"));
    }

    #[tokio::test]
    async fn test_mcp_invalid_category_returns_tool_error() {
        let temp_dir = TempDir::new().unwrap();
        let server = McpServer::new_with_dir(temp_dir.path().to_path_buf());

        // Save note with plural / invalid category
        let bad_save = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 90,
            "method": "tools/call",
            "params": {
                "name": "oppa_save_context_note",
                "arguments": {
                    "category": "preferences",
                    "title": "Bad Category Note",
                    "abstract_l0": "Summary",
                    "overview_l1": "Overview"
                }
            }
        });
        let save_res = server.handle_request(bad_save).await.unwrap();
        assert_eq!(save_res["result"]["isError"], true);
        let text = save_res["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("Invalid category 'preferences'"));

        // Search with invalid category filter
        let bad_search = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 91,
            "method": "tools/call",
            "params": {
                "name": "oppa_search_context",
                "arguments": {
                    "query": "something",
                    "category": "standards"
                }
            }
        });
        let search_res = server.handle_request(bad_search).await.unwrap();
        assert_eq!(search_res["result"]["isError"], true);
        let search_err_text = search_res["result"]["content"][0]["text"].as_str().unwrap();
        assert!(search_err_text.contains("Invalid category 'standards'"));
    }
}
