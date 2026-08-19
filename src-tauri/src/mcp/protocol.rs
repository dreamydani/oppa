use serde::{Deserialize, Serialize};

// Default JSON-RPC 2.0 version string.
fn default_jsonrpc_version() -> String {
    "2.0".to_string()
}

/// JSON-RPC 2.0 inbound request or notification.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JsonRpcRequest {
    #[serde(default = "default_jsonrpc_version")]
    pub jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<serde_json::Value>,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

/// JSON-RPC 2.0 protocol error payload.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

/// JSON-RPC 2.0 outbound response.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

impl JsonRpcResponse {
    pub fn success(id: Option<serde_json::Value>, result: serde_json::Value) -> Self {
        Self {
            jsonrpc: default_jsonrpc_version(),
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(
        id: Option<serde_json::Value>,
        code: i32,
        message: impl Into<String>,
        data: Option<serde_json::Value>,
    ) -> Self {
        Self {
            jsonrpc: default_jsonrpc_version(),
            id,
            result: None,
            error: Some(JsonRpcError {
                code,
                message: message.into(),
                data,
            }),
        }
    }
}

/// Client metadata provided during MCP initialize handshake.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpClientInfo {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// Inbound MCP initialization parameters.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpInitializeParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_info: Option<McpClientInfo>,
}

/// Server metadata returned during MCP initialize response.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpServerInfo {
    pub name: String,
    pub version: String,
}

/// Tool capabilities supported by OPPA MCP server.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpToolsCapability {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub list_changed: Option<bool>,
}

/// Root capabilities object advertised during initialization.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct McpCapabilities {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<McpToolsCapability>,
}

/// Outbound MCP initialize result.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpInitializeResult {
    pub protocol_version: String,
    pub capabilities: McpCapabilities,
    pub server_info: McpServerInfo,
}

/// JSON Schema for an MCP tool input parameters.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpToolInputSchema {
    #[serde(rename = "type")]
    pub schema_type: String,
    pub properties: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub required: Option<Vec<String>>,
}

/// MCP tool descriptor advertised in tools/list.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpTool {
    pub name: String,
    pub description: String,
    pub input_schema: McpToolInputSchema,
}

/// Outbound payload for tools/list response.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpToolsListResult {
    pub tools: Vec<McpTool>,
}

/// Inbound payload for tools/call request params.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpCallToolParams {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arguments: Option<serde_json::Value>,
}

/// Text content block in MCP tool results.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct McpContent {
    #[serde(rename = "type")]
    pub content_type: String,
    pub text: String,
}

impl McpContent {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            content_type: "text".to_string(),
            text: text.into(),
        }
    }
}

/// Outbound payload for tools/call result.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpCallToolResult {
    pub content: Vec<McpContent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
}

impl McpCallToolResult {
    pub fn success(text: impl Into<String>) -> Self {
        Self {
            content: vec![McpContent::text(text)],
            is_error: None,
        }
    }

    pub fn error(text: impl Into<String>) -> Self {
        Self {
            content: vec![McpContent::text(text)],
            is_error: Some(true),
        }
    }
}

/// Returns the 4 core OPPA MCP tools and their schemas.
pub fn get_oppa_mcp_tools() -> Vec<McpTool> {
    vec![
        McpTool {
            name: "oppa_get_active_persona".to_string(),
            description: "Get the currently assigned terminal persona, behavioral guidelines, and mounted memory scopes.".to_string(),
            input_schema: McpToolInputSchema {
                schema_type: "object".to_string(),
                properties: serde_json::json!({
                    "persona_id": {
                        "type": "string",
                        "description": "Optional persona ID. If omitted, uses OPPA_PERSONA environment variable or default."
                    }
                }),
                required: None,
            },
        },
        McpTool {
            name: "oppa_search_context".to_string(),
            description: "Search OPPA project memory notes and knowledge base using SQLite FTS5 with BM25 ranking.".to_string(),
            input_schema: McpToolInputSchema {
                schema_type: "object".to_string(),
                properties: serde_json::json!({
                    "query": {
                        "type": "string",
                        "description": "Keywords or search term"
                    },
                    "category": {
                        "type": "string",
                        "enum": ["architecture", "quirk", "runbook", "preference", "persona"],
                        "description": "Optional category filter"
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Max results (default: 5)"
                    }
                }),
                required: Some(vec!["query".to_string()]),
            },
        },
        McpTool {
            name: "oppa_get_context_note".to_string(),
            description: "Retrieve the complete L0 abstract, L1 markdown overview, and L2 details for a specific context path or ID.".to_string(),
            input_schema: McpToolInputSchema {
                schema_type: "object".to_string(),
                properties: serde_json::json!({
                    "path": {
                        "type": "string",
                        "description": "Category and slug path (e.g. quirks/conpty-newline)"
                    },
                    "id": {
                        "type": "string",
                        "description": "Optional direct note ID"
                    }
                }),
                required: None,
            },
        },
        McpTool {
            name: "oppa_save_context_note".to_string(),
            description: "Persist a new quirk, architecture note, or runbook into OPPA memory database.".to_string(),
            input_schema: McpToolInputSchema {
                schema_type: "object".to_string(),
                properties: serde_json::json!({
                    "category": {
                        "type": "string",
                        "enum": ["architecture", "quirk", "runbook", "preference", "persona"]
                    },
                    "title": {
                        "type": "string"
                    },
                    "abstract_l0": {
                        "type": "string",
                        "description": "1-2 sentence dense summary (~100 tokens)"
                    },
                    "overview_l1": {
                        "type": "string",
                        "description": "Structured markdown resolution or overview"
                    },
                    "details_l2": {
                        "type": "string",
                        "description": "Optional raw stack traces, diffs, or compiler logs"
                    },
                    "scope": {
                        "type": "string",
                        "enum": ["workspace", "global"],
                        "default": "workspace"
                    }
                }),
                required: Some(vec![
                    "category".to_string(),
                    "title".to_string(),
                    "abstract_l0".to_string(),
                    "overview_l1".to_string(),
                ]),
            },
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mcp_initialize_request_deserialization() {
        let json = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"opencode","version":"1.0"}}}"#;
        let req: JsonRpcRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.method, "initialize");
        assert_eq!(req.id, Some(serde_json::json!(1)));
        assert_eq!(req.jsonrpc, "2.0");

        let params: McpInitializeParams = serde_json::from_value(req.params.unwrap()).unwrap();
        assert_eq!(params.protocol_version.as_deref(), Some("2024-11-05"));
        let client_info = params.client_info.unwrap();
        assert_eq!(client_info.name, "opencode");
        assert_eq!(client_info.version.as_deref(), Some("1.0"));
    }

    #[test]
    fn test_mcp_initialize_response_serialization() {
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
        let resp = JsonRpcResponse::success(Some(serde_json::json!(1)), serde_json::to_value(result).unwrap());
        let val = serde_json::to_value(resp).unwrap();
        assert_eq!(val["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(val["result"]["serverInfo"]["name"], "oppa-mcp-server");
        assert_eq!(val["result"]["serverInfo"]["version"], "0.1.0");
        assert_eq!(val["result"]["capabilities"]["tools"]["listChanged"], false);
    }

    #[test]
    fn test_mcp_tools_list_response_serialization() {
        let tools = get_oppa_mcp_tools();
        assert_eq!(tools.len(), 4);
        assert_eq!(tools[0].name, "oppa_get_active_persona");
        assert_eq!(tools[1].name, "oppa_search_context");
        assert_eq!(tools[2].name, "oppa_get_context_note");
        assert_eq!(tools[3].name, "oppa_save_context_note");

        let result = McpToolsListResult { tools };
        let response = JsonRpcResponse::success(Some(serde_json::json!(2)), serde_json::to_value(result).unwrap());
        let json_str = serde_json::to_string(&response).unwrap();
        assert!(json_str.contains("oppa_get_active_persona"));
        assert!(json_str.contains("oppa_search_context"));
    }

    #[test]
    fn test_mcp_call_tool_request_and_response_serialization() {
        let json = r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"oppa_search_context","arguments":{"query":"ConPTY"}}}"#;
        let req: JsonRpcRequest = serde_json::from_str(json).unwrap();
        let params: McpCallToolParams = serde_json::from_value(req.params.unwrap()).unwrap();
        assert_eq!(params.name, "oppa_search_context");
        assert_eq!(params.arguments.as_ref().unwrap()["query"], "ConPTY");

        let tool_res = McpCallToolResult::success("Found note: ConPTY fix");
        let resp = JsonRpcResponse::success(req.id, serde_json::to_value(tool_res).unwrap());
        let val: serde_json::Value = serde_json::to_value(resp).unwrap();
        assert_eq!(val["result"]["content"][0]["type"], "text");
        assert_eq!(val["result"]["content"][0]["text"], "Found note: ConPTY fix");
        assert!(val["result"].get("isError").is_none());

        let err_res = McpCallToolResult::error("Search query is required");
        let err_val = serde_json::to_value(err_res).unwrap();
        assert_eq!(err_val["isError"], true);
    }

    #[test]
    fn test_mcp_json_rpc_error_serialization() {
        let resp = JsonRpcResponse::error(Some(serde_json::json!(4)), -32601, "Method not found", None);
        let val: serde_json::Value = serde_json::to_value(resp).unwrap();
        assert_eq!(val["error"]["code"], -32601);
        assert_eq!(val["error"]["message"], "Method not found");
        assert!(val.get("result").is_none() || val["result"].is_null());
    }

    #[test]
    fn test_oppa_mcp_tools_definitions_and_schemas() {
        let tools = get_oppa_mcp_tools();
        let persona_tool = tools.iter().find(|t| t.name == "oppa_get_active_persona").unwrap();
        assert_eq!(persona_tool.input_schema.schema_type, "object");

        let search_tool = tools.iter().find(|t| t.name == "oppa_search_context").unwrap();
        assert_eq!(
            search_tool.input_schema.required.as_ref().unwrap(),
            &vec!["query".to_string()]
        );

        let save_tool = tools.iter().find(|t| t.name == "oppa_save_context_note").unwrap();
        let required = save_tool.input_schema.required.as_ref().unwrap();
        assert!(required.contains(&"category".to_string()));
        assert!(required.contains(&"title".to_string()));
        assert!(required.contains(&"abstract_l0".to_string()));
        assert!(required.contains(&"overview_l1".to_string()));

        let save_cats = save_tool.input_schema.properties["category"]["enum"].as_array().unwrap();
        assert_eq!(save_cats, &vec!["architecture", "quirk", "runbook", "preference", "persona"]);
    }
}
