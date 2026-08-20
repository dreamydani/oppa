import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useTerminalStore } from "../../store/terminalStore";
import { CodeEditor } from "./CodeEditor";

// Mock @monaco-editor/react for fast and deterministic DOM unit testing
vi.mock("@monaco-editor/react", () => {
  return {
    __esModule: true,
    default: ({ value, language, theme, onChange, onMount, options }: any) => {
      if (onMount) {
        onMount(
          {
            addCommand: vi.fn(),
          },
          {
            KeyMod: { CtrlCmd: 2048 },
            KeyCode: { KeyS: 49 },
          },
        );
      }
      return (
        <div data-testid="monaco-editor-mock" data-language={language} data-theme={theme}>
          <textarea
            data-testid="monaco-mock-textarea"
            value={value}
            readOnly={options?.readOnly}
            onChange={(e) => onChange && onChange(e.target.value)}
          />
        </div>
      );
    },
    DiffEditor: ({ original, modified, language, theme, options }: any) => (
      <div
        data-testid="monaco-diff-mock"
        data-language={language}
        data-theme={theme}
        data-side-by-side={options?.renderSideBySide ? "true" : "false"}
      >
        <div data-testid="diff-original">{original}</div>
        <div data-testid="diff-modified">{modified}</div>
      </div>
    ),
  };
});

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
          theme: "dark",
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

    const textarea = screen.getByTestId("monaco-mock-textarea");
    expect((textarea as HTMLTextAreaElement).value).toBe('fn main() { println!("Hello OPPA"); }');
  });

  it("updates store content when code changes", () => {
    render(<CodeEditor />);
    const textarea = screen.getByTestId("monaco-mock-textarea");
    fireEvent.change(textarea, { target: { value: 'fn main() { println!("Updated"); }' } });

    const activeTab = useTerminalStore.getState().editorTabs.find((t) => t.path === "src/main.rs");
    expect(activeTab?.content).toBe('fn main() { println!("Updated"); }');
    expect(activeTab?.isDirty).toBe(true);
  });

  it("calls custom onChange prop when provided", () => {
    const customOnChange = vi.fn();
    render(<CodeEditor value="initial code" onChange={customOnChange} language="html" />);

    const textarea = screen.getByTestId("monaco-mock-textarea");
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
});
