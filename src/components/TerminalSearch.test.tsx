import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { TerminalSearch } from "./TerminalSearch";
import type { SearchAddon } from "@xterm/addon-search";

describe("TerminalSearch", () => {
  const createMockSearchAddon = () =>
    ({
      findNext: vi.fn(),
      findPrevious: vi.fn(),
      clearDecorations: vi.fn(),
    }) as unknown as SearchAddon;

  it("renders search input and auto-focuses", () => {
    const mockSearchAddon = createMockSearchAddon();
    const onClose = vi.fn();
    render(<TerminalSearch searchAddon={mockSearchAddon} onClose={onClose} />);
    const input = screen.getByPlaceholderText("Find...");
    expect(input).toBeDefined();
    expect(document.activeElement).toBe(input);
  });

  it("calls findNext on input change and Enter", () => {
    const mockSearchAddon = createMockSearchAddon();
    const onClose = vi.fn();
    render(<TerminalSearch searchAddon={mockSearchAddon} onClose={onClose} />);
    const input = screen.getByPlaceholderText("Find...");
    fireEvent.change(input, { target: { value: "error" } });
    expect(mockSearchAddon.findNext).toHaveBeenCalledWith("error", {
      regex: false,
      caseSensitive: false,
    });

    fireEvent.keyDown(input, { key: "Enter" });
    expect(mockSearchAddon.findNext).toHaveBeenCalledTimes(2);
  });

  it("calls findPrevious on Shift+Enter or Previous button", () => {
    const mockSearchAddon = createMockSearchAddon();
    const onClose = vi.fn();
    render(
      <TerminalSearch
        searchAddon={mockSearchAddon}
        onClose={onClose}
        initialQuery="test"
      />
    );
    const input = screen.getByPlaceholderText("Find...");
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(mockSearchAddon.findPrevious).toHaveBeenCalledWith("test", {
      regex: false,
      caseSensitive: false,
    });

    const prevBtn = screen.getByTitle("Previous match (Shift+Enter)");
    fireEvent.click(prevBtn);
    expect(mockSearchAddon.findPrevious).toHaveBeenCalledTimes(2);
  });

  it("calls findNext when Next button is clicked", () => {
    const mockSearchAddon = createMockSearchAddon();
    const onClose = vi.fn();
    render(
      <TerminalSearch
        searchAddon={mockSearchAddon}
        onClose={onClose}
        initialQuery="test"
      />
    );
    const nextBtn = screen.getByTitle("Next match (Enter)");
    fireEvent.click(nextBtn);
    expect(mockSearchAddon.findNext).toHaveBeenCalledWith("test", {
      regex: false,
      caseSensitive: false,
    });
  });

  it("toggles case sensitivity and re-executes search", () => {
    const mockSearchAddon = createMockSearchAddon();
    const onClose = vi.fn();
    render(
      <TerminalSearch
        searchAddon={mockSearchAddon}
        onClose={onClose}
        initialQuery="test"
      />
    );
    const caseBtn = screen.getByTitle("Match Case (Alt+C)");
    fireEvent.click(caseBtn);
    expect(mockSearchAddon.findNext).toHaveBeenCalledWith("test", {
      regex: false,
      caseSensitive: true,
    });
  });

  it("toggles regex and re-executes search", () => {
    const mockSearchAddon = createMockSearchAddon();
    const onClose = vi.fn();
    render(
      <TerminalSearch
        searchAddon={mockSearchAddon}
        onClose={onClose}
        initialQuery="test"
      />
    );
    const regexBtn = screen.getByTitle("Use Regular Expression (Alt+R)");
    fireEvent.click(regexBtn);
    expect(mockSearchAddon.findNext).toHaveBeenCalledWith("test", {
      regex: true,
      caseSensitive: false,
    });
  });

  it("calls clearDecorations when query is cleared", () => {
    const mockSearchAddon = createMockSearchAddon();
    const onClose = vi.fn();
    render(
      <TerminalSearch
        searchAddon={mockSearchAddon}
        onClose={onClose}
        initialQuery="test"
      />
    );
    const input = screen.getByPlaceholderText("Find...");
    fireEvent.change(input, { target: { value: "" } });
    expect(mockSearchAddon.clearDecorations).toHaveBeenCalled();
  });

  it("calls onClose on Escape key or Close button", () => {
    const mockSearchAddon = createMockSearchAddon();
    const onClose = vi.fn();
    render(<TerminalSearch searchAddon={mockSearchAddon} onClose={onClose} />);
    const input = screen.getByPlaceholderText("Find...");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    const closeBtn = screen.getByTitle("Close (Esc)");
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
