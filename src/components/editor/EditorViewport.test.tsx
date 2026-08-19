import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useTerminalStore } from "../../store/terminalStore";
import { EditorViewport } from "./EditorViewport";

describe("EditorViewport", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      editorTabs: [
        {
          path: "/workspace/src/main.ts",
          name: "main.ts",
          content: "console.log('hello');",
          originalContent: "console.log('hello');",
          isDirty: false,
          language: "typescript",
          isMarkdown: false,
        },
      ],
      activeEditorPath: "/workspace/src/main.ts",
      editorViewMode: "edit",
      pendingAiDiff: null,
    });
  });

  it("renders empty state when there are no editor tabs open", () => {
    useTerminalStore.setState({ editorTabs: [], activeEditorPath: null });
    render(<EditorViewport />);

    expect(screen.getByText(/No File Open/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create New File" })).toBeInTheDocument();
  });

  it("creates a new file when clicking Create New File in empty state", () => {
    useTerminalStore.setState({ editorTabs: [], activeEditorPath: null });
    render(<EditorViewport />);

    const newBtn = screen.getByRole("button", { name: "Create New File" });
    fireEvent.click(newBtn);

    const tabs = useTerminalStore.getState().editorTabs;
    expect(tabs.length).toBe(1);
    expect(tabs[0].name).toMatch(/Untitled|untitled/);
  });

  it("renders CodeEditor in edit mode", () => {
    render(<EditorViewport />);

    expect(screen.getAllByText("main.ts").length).toBeGreaterThan(0);
    const textarea = screen.getByRole("textbox");
    expect(textarea).toHaveValue("console.log('hello');");
  });

  it("updates store content when typing in CodeEditor", () => {
    render(<EditorViewport />);

    const textarea = screen.getByRole("textbox");
    fireEvent.change(textarea, { target: { value: "console.log('updated');" } });

    const activeTab = useTerminalStore
      .getState()
      .editorTabs.find((t) => t.path === "/workspace/src/main.ts");
    expect(activeTab?.content).toBe("console.log('updated');");
    expect(activeTab?.isDirty).toBe(true);
  });

  it("renders AiDiffBanner and diff view when editorViewMode is 'diff'", () => {
    useTerminalStore.setState({
      editorViewMode: "diff",
      pendingAiDiff: {
        path: "/workspace/src/main.ts",
        original: "console.log('hello');",
        modified: "console.log('hello world');",
        summary: "Add world to console log",
      },
    });

    render(<EditorViewport />);

    expect(screen.getByText(/AI Proposed Changes/i)).toBeInTheDocument();
    expect(screen.getByText("Add world to console log")).toBeInTheDocument();
  });

  it("renders MarkdownViewer when editorViewMode is 'markdown-preview'", () => {
    useTerminalStore.setState({
      editorTabs: [
        {
          path: "/workspace/DOCS.md",
          name: "DOCS.md",
          content: "# Documentation Heading\nSome docs text",
          originalContent: "# Documentation Heading\nSome docs text",
          isDirty: false,
          language: "markdown",
          isMarkdown: true,
        },
      ],
      activeEditorPath: "/workspace/DOCS.md",
      editorViewMode: "markdown-preview",
    });

    render(<EditorViewport />);

    expect(screen.getByRole("heading", { name: "Documentation Heading" })).toBeInTheDocument();
    expect(screen.getByText("Some docs text")).toBeInTheDocument();
  });

  it("renders split view (CodeEditor + MarkdownViewer) when editorViewMode is 'markdown-split'", () => {
    useTerminalStore.setState({
      editorTabs: [
        {
          path: "/workspace/DOCS.md",
          name: "DOCS.md",
          content: "# Documentation Heading\nSome docs text",
          originalContent: "# Documentation Heading\nSome docs text",
          isDirty: false,
          language: "markdown",
          isMarkdown: true,
        },
      ],
      activeEditorPath: "/workspace/DOCS.md",
      editorViewMode: "markdown-split",
    });

    render(<EditorViewport />);

    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Documentation Heading" })).toBeInTheDocument();
  });

  it("triggers save on Ctrl+S / Cmd+S in editor", () => {
    const saveSpy = vi.spyOn(useTerminalStore.getState(), "saveActiveFile");
    render(<EditorViewport />);

    const textarea = screen.getByRole("textbox");
    fireEvent.keyDown(textarea, { key: "s", ctrlKey: true });

    expect(saveSpy).toHaveBeenCalled();
  });

  it("applies editorWordWrap setting to textarea wrap and data attributes", () => {
    useTerminalStore.setState({
      settings: {
        ...useTerminalStore.getState().settings,
        general: {
          ...useTerminalStore.getState().settings.general,
          editorWordWrap: false,
        },
      },
    });

    const { rerender } = render(<EditorViewport />);
    let textarea = screen.getByRole("textbox");
    expect(textarea.getAttribute("wrap")).toBe("off");
    expect(textarea.getAttribute("data-word-wrap")).toBe("off");

    useTerminalStore.setState({
      settings: {
        ...useTerminalStore.getState().settings,
        general: {
          ...useTerminalStore.getState().settings.general,
          editorWordWrap: true,
        },
      },
    });

    rerender(<EditorViewport />);
    textarea = screen.getByRole("textbox");
    expect(textarea.getAttribute("wrap")).toBe("soft");
    expect(textarea.getAttribute("data-word-wrap")).toBe("on");
  });
});
