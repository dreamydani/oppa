pub mod protocol;
pub mod server;

pub use protocol::{
    get_oppa_mcp_tools, JsonRpcError, JsonRpcRequest, JsonRpcResponse, McpCallToolParams,
    McpCallToolResult, McpCapabilities, McpClientInfo, McpContent, McpInitializeParams,
    McpInitializeResult, McpServerInfo, McpTool, McpToolInputSchema, McpToolsCapability,
    McpToolsListResult,
};
pub use server::{run_mcp_stdio, McpServer};
