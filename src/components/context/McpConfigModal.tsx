import { useState, useEffect, type ReactElement } from "react";
import { IconClose, IconServer, IconCopy, IconCheck, IconFile } from "./ContextIcons";
import "./McpConfigModal.css";

export interface McpConfigModalProps {
  isOpen: boolean;
  onClose: () => void;
  workspacePath?: string;
}

interface ClientTab {
  id: string;
  name: string;
  path: string;
  description: string;
}

const CLIENT_TABS: ClientTab[] = [
  {
    id: "opencode",
    name: "OpenCode",
    path: "~/.config/opencode/opencode.json",
    description: "Add to your OpenCode configuration file:",
  },
  {
    id: "claude",
    name: "Claude Code",
    path: "~/.claude.json / claude_desktop_config.json",
    description: "Add to your Claude Code or Claude Desktop MCP configuration:",
  },
  {
    id: "cursor",
    name: "Cursor",
    path: ".cursor/mcp.json",
    description: "Add to your workspace .cursor/mcp.json file:",
  },
  {
    id: "agy",
    name: "AGY",
    path: "~/.gemini/antigravity-cli/mcp.json",
    description: "Add to your AGY MCP configuration:",
  },
];

export function McpConfigModal({
  isOpen,
  onClose,
  workspacePath,
}: McpConfigModalProps): ReactElement | null {
  const [activeTabId, setActiveTabId] = useState("opencode");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const effectivePath =
    workspacePath && workspacePath.trim().length > 0 ? workspacePath.trim() : ".";

  const activeTab =
    CLIENT_TABS.find((tab) => tab.id === activeTabId) || CLIENT_TABS[0];

  const getConfigSnippet = (tabId: string) => {
    if (tabId === "opencode") {
      return JSON.stringify(
        {
          "$schema": "https://opencode.ai/config.json",
          "mcp": {
            "oppa": {
              "type": "local",
              "command": ["oppa", "--mcp", "--workspace", effectivePath],
              "enabled": true,
            },
          },
        },
        null,
        2
      );
    }

    return JSON.stringify(
      {
        mcpServers: {
          oppa: {
            command: "oppa",
            args: ["--mcp", "--workspace", effectivePath],
          },
        },
      },
      null,
      2
    );
  };

  const configSnippet = getConfigSnippet(activeTabId);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(configSnippet);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // In environments where clipboard write fails
    }
  };

  return (
    <div
      className="mcp-config-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="MCP Server Configuration"
      onClick={onClose}
    >
      <div
        className="mcp-config-modal-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mcp-config-modal-header">
          <div className="mcp-config-modal-title-box">
            <span className="mcp-config-modal-icon-badge">
              <IconServer size={14} />
            </span>
            <h3 className="mcp-config-modal-title">MCP Server Configuration</h3>
          </div>
          <button
            type="button"
            className="mcp-config-modal-close-btn"
            onClick={onClose}
            aria-label="Close"
          >
            <IconClose size={13} />
          </button>
        </div>

        <div className="mcp-config-modal-body">
          <div className="mcp-config-tabs-list" role="tablist">
            {CLIENT_TABS.map((tab) => {
              const isActive = tab.id === activeTab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className={`mcp-config-tab-btn ${isActive ? "active" : ""}`}
                  onClick={() => {
                    setActiveTabId(tab.id);
                    setCopied(false);
                  }}
                >
                  {tab.name}
                </button>
              );
            })}
          </div>

          <div className="mcp-config-path-info">
            <p className="mcp-config-desc">{activeTab.description}</p>
            <div className="mcp-config-target-path">
              <IconFile size={12} />
              <span>{activeTab.path}</span>
            </div>
          </div>

          <div className="mcp-config-code-container">
            <pre className="mcp-config-code" data-testid="mcp-config-code">
              <code>{configSnippet}</code>
            </pre>
          </div>

          <div className="mcp-config-modal-footer">
            <p className="mcp-config-hint">
              Starts OPPA daemon MCP endpoint on stdio for this workspace
            </p>
            <button
              type="button"
              className={`mcp-config-copy-btn ${copied ? "copied" : ""}`}
              onClick={handleCopy}
              aria-label={copied ? "Copied!" : "Copy Configuration"}
            >
              {copied ? (
                <>
                  <IconCheck size={13} />
                  <span>Copied!</span>
                </>
              ) : (
                <>
                  <IconCopy size={13} />
                  <span>Copy Configuration</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
