import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useTerminalStore } from "../../store/terminalStore";
import { EditorBreadcrumbs } from "./EditorBreadcrumbs";

describe("EditorBreadcrumbs", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      editorTabs: [
        {
          path: "src/components/TitleBar.tsx",
          name: "TitleBar.tsx",
          content: "export const x = 1;",
          originalContent: "export const x = 1;",
          isDirty: true,
          language: "typescript",
          isMarkdown: false,
        },
        {
          path: "docs/superpowers/specs/design.md",
          name: "design.md",
          content: "# Spec\nDescription",
          originalContent: "# Spec\nDescription",
          isDirty: false,
          language: "markdown",
          isMarkdown: true,
        },
        {
          path: "config.json",
          name: "config.json",
          content: '{"foo": "bar", "num": 42}',
          originalContent: '{"foo": "bar", "num": 42}',
          isDirty: false,
          language: "json",
          isMarkdown: false,
        },
      ],
      activeEditorPath: "src/components/TitleBar.tsx",
      editorViewMode: "edit",
    });
  });

  it("renders path segments trail for active file", () => {
    render(<EditorBreadcrumbs />);
    expect(screen.getByText("src")).toBeInTheDocument();
    expect(screen.getByText("components")).toBeInTheDocument();
    expect(screen.getByText("TitleBar.tsx")).toBeInTheDocument();
  });

  it("calls saveActiveFile when clicking Save button", async () => {
    const saveSpy = vi.spyOn(useTerminalStore.getState(), "saveActiveFile");
    render(<EditorBreadcrumbs />);

    const saveBtn = screen.getByRole("button", { name: /save/i });
    fireEvent.click(saveBtn);

    expect(saveSpy).toHaveBeenCalled();
  });

  it("toggles diff view mode when clicking diff toggle button", () => {
    render(<EditorBreadcrumbs />);

    const diffBtn = screen.getByRole("button", { name: /diff/i });
    fireEvent.click(diffBtn);

    expect(useTerminalStore.getState().editorViewMode).toBe("diff");

    // Toggle back to edit
    fireEvent.click(diffBtn);
    expect(useTerminalStore.getState().editorViewMode).toBe("edit");
  });

  it("renders 3-way toggle for markdown files (Code, Preview, Split)", () => {
    useTerminalStore.setState({
      activeEditorPath: "docs/superpowers/specs/design.md",
      editorViewMode: "markdown-split",
    });

    render(<EditorBreadcrumbs />);

    const codeBtn = screen.getByRole("button", { name: /^code/i });
    const previewBtn = screen.getByRole("button", { name: /preview/i });
    const splitBtn = screen.getByRole("button", { name: /split/i });

    expect(codeBtn).toBeInTheDocument();
    expect(previewBtn).toBeInTheDocument();
    expect(splitBtn).toBeInTheDocument();

    fireEvent.click(previewBtn);
    expect(useTerminalStore.getState().editorViewMode).toBe("markdown-preview");

    fireEvent.click(codeBtn);
    expect(useTerminalStore.getState().editorViewMode).toBe("edit");

    fireEvent.click(splitBtn);
    expect(useTerminalStore.getState().editorViewMode).toBe("markdown-split");
  });

  it("formats JSON content when clicking Format button", () => {
    useTerminalStore.setState({
      activeEditorPath: "config.json",
    });

    render(<EditorBreadcrumbs />);

    const formatBtn = screen.getByRole("button", { name: /format/i });
    fireEvent.click(formatBtn);

    const activeTab = useTerminalStore
      .getState()
      .editorTabs.find((t) => t.path === "config.json");
    expect(activeTab?.content).toContain('{\n  "foo": "bar",\n  "num": 42\n}');
  });
});
