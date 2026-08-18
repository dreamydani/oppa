import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { McpConfigModal } from "./McpConfigModal";

describe("McpConfigModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not render when isOpen is false", () => {
    const { container } = render(
      <McpConfigModal isOpen={false} onClose={vi.fn()} workspacePath="/test/workspace" />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders modal with header and 4 client tabs when isOpen is true", () => {
    render(
      <McpConfigModal isOpen={true} onClose={vi.fn()} workspacePath="/test/workspace" />
    );

    expect(screen.getByRole("dialog", { name: /mcp/i })).toBeTruthy();
    expect(screen.getByText(/MCP Server Configuration/i)).toBeTruthy();

    expect(screen.getByRole("tab", { name: /OpenCode/i })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Claude Code/i })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Cursor/i })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /AGY/i })).toBeTruthy();
  });

  it("renders correct default OpenCode config snippet with workspace path", () => {
    render(
      <McpConfigModal isOpen={true} onClose={vi.fn()} workspacePath="D:/my/workspace" />
    );

    expect(screen.getAllByText(/~[/\\]\.config[/\\]opencode[/\\]opencode\.json/i).length).toBeGreaterThan(0);
    const codeBlock = screen.getByTestId("mcp-config-code");
    expect(codeBlock.textContent).toContain('"mcp": {');
    expect(codeBlock.textContent).toContain('"type": "local"');
    expect(codeBlock.textContent).toContain('"command": [');
    expect(codeBlock.textContent).toContain('"oppa"');
    expect(codeBlock.textContent).toContain('"--workspace"');
    expect(codeBlock.textContent).toContain('"D:/my/workspace"');
  });

  it("switches tabs and displays corresponding paths and configs", () => {
    render(
      <McpConfigModal isOpen={true} onClose={vi.fn()} workspacePath="/repo" />
    );

    // Click Claude Code tab
    const claudeTab = screen.getByRole("tab", { name: /Claude Code/i });
    fireEvent.click(claudeTab);
    expect(screen.getAllByText(/~[/\\]\.claude\.json/i).length).toBeGreaterThan(0);

    // Click Cursor tab
    const cursorTab = screen.getByRole("tab", { name: /Cursor/i });
    fireEvent.click(cursorTab);
    expect(screen.getAllByText(/\.cursor[/\\]mcp\.json/i).length).toBeGreaterThan(0);

    // Click AGY tab
    const agyTab = screen.getByRole("tab", { name: /AGY/i });
    fireEvent.click(agyTab);
    expect(screen.getAllByText(/~[/\\]\.gemini[/\\]antigravity-cli[/\\]mcp\.json/i).length).toBeGreaterThan(0);
  });

  it("copies configuration to clipboard and shows feedback", async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: writeTextMock,
      },
      writable: true,
      configurable: true,
    });

    render(
      <McpConfigModal isOpen={true} onClose={vi.fn()} workspacePath="/test/repo" />
    );

    const copyBtn = screen.getByRole("button", { name: /copy configuration/i });
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalled();
    });
    const copiedContent = writeTextMock.mock.calls[0][0];
    expect(copiedContent).toContain('"oppa"');
    expect(copiedContent).toContain('"--workspace"');
    expect(copiedContent).toContain('"/test/repo"');
    expect(copiedContent).toContain('"mcp"');

    expect(screen.getByText(/copied!/i)).toBeTruthy();
  });

  it("calls onClose when close button is clicked", () => {
    const onClose = vi.fn();
    render(
      <McpConfigModal isOpen={true} onClose={onClose} workspacePath="/test/workspace" />
    );

    const closeBtn = screen.getByRole("button", { name: /close/i });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when clicking outside modal card", () => {
    const onClose = vi.fn();
    render(
      <McpConfigModal isOpen={true} onClose={onClose} workspacePath="/test/workspace" />
    );

    const overlay = screen.getByRole("dialog", { name: /mcp/i });
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Escape key is pressed", () => {
    const onClose = vi.fn();
    render(
      <McpConfigModal isOpen={true} onClose={onClose} workspacePath="/test/workspace" />
    );

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("falls back gracefully when workspacePath is not provided", () => {
    render(<McpConfigModal isOpen={true} onClose={vi.fn()} />);

    const codeBlock = screen.getByTestId("mcp-config-code");
    expect(codeBlock.textContent).toContain('"oppa"');
    expect(codeBlock.textContent).toContain('"."');
  });
});
