import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useTerminalStore } from "../../store/terminalStore";
import { CodeEditor } from "./CodeEditor";

describe("CodeEditor", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      editorTabs: [
        {
          path: "src/main.rs",
          name: "main.rs",
          content: 'fn main() { println!("Hello OPPA"); }',
          originalContent: 'fn main() { println!("Hello OPPA"); }',
          isDirty: false,
          language: "rust",
          isMarkdown: false,
        },
      ],
      activeEditorPath: "src/main.rs",
      pendingAiDiff: null,
      settings: {
        ...useTerminalStore.getState().settings,
        appearance: {
          ...useTerminalStore.getState().settings.appearance,
          appTheme: "dark",
        },
        general: {
          ...useTerminalStore.getState().settings.general,
          editorWordWrap: true,
        },
      },
    });
  });

  it("renders Monaco Editor with active tab content and language", () => {
    render(<CodeEditor />);
    const editor = screen.getByTestId("monaco-editor-mock");
    expect(editor).toBeInTheDocument();
    expect(editor).toHaveAttribute("data-language", "rust");
    expect(editor).toHaveAttribute("data-theme", "oppa-dark");

    const textarea = screen.getByLabelText("Code Editor");
    expect((textarea as HTMLTextAreaElement).value).toBe('fn main() { println!("Hello OPPA"); }');
  });

  it("updates store content when code changes", () => {
    render(<CodeEditor />);
    const textarea = screen.getByLabelText("Code Editor");
    fireEvent.change(textarea, { target: { value: 'fn main() { println!("Updated"); }' } });

    const activeTab = useTerminalStore.getState().editorTabs.find((t) => t.path === "src/main.rs");
    expect(activeTab?.content).toBe('fn main() { println!("Updated"); }');
    expect(activeTab?.isDirty).toBe(true);
  });

  it("calls custom onChange prop when provided", () => {
    const customOnChange = vi.fn();
    render(<CodeEditor value="initial code" onChange={customOnChange} language="html" />);

    const textarea = screen.getByLabelText("Code Editor");
    fireEvent.change(textarea, { target: { value: "<div>hello</div>" } });

    expect(customOnChange).toHaveBeenCalledWith("<div>hello</div>");
  });

  it("renders DiffEditor when in diffMode or when pendingAiDiff exists", () => {
    useTerminalStore.setState({
      pendingAiDiff: {
        path: "src/main.rs",
        original: "fn old() {}",
        modified: "fn new() {}",
      },
    });

    render(<CodeEditor diffMode />);
    const diffView = screen.getByTestId("monaco-diff-mock");
    expect(diffView).toBeInTheDocument();
    expect(screen.getByTestId("diff-original")).toHaveTextContent("fn old() {}");
    expect(screen.getByTestId("diff-modified")).toHaveTextContent("fn new() {}");
  });

  it("renders a read-only DiffEditor from viewOnlyDiff", () => {
    useTerminalStore.setState({
      viewOnlyDiff: {
        path: "src/lib/mod.rs",
        original: "old line",
        modified: "new line",
      },
    });

    render(<CodeEditor />);
    expect(screen.getByTestId("monaco-diff-mock")).toBeInTheDocument();
    expect(screen.getByTestId("diff-original")).toHaveTextContent("old line");
    expect(screen.getByTestId("diff-modified")).toHaveTextContent("new line");
  });
});
