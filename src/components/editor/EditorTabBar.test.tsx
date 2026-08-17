import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useTerminalStore } from "../../store/terminalStore";
import { EditorTabBar } from "./EditorTabBar";

describe("EditorTabBar", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      editorTabs: [
        {
          path: "/workspace/src/App.tsx",
          name: "App.tsx",
          content: "export function App() {}",
          originalContent: "export function App() {}",
          isDirty: false,
          language: "typescript",
          isMarkdown: false,
        },
        {
          path: "/workspace/README.md",
          name: "README.md",
          content: "# OPPA\nDraft changes",
          originalContent: "# OPPA",
          isDirty: true,
          language: "markdown",
          isMarkdown: true,
        },
      ],
      activeEditorPath: "/workspace/src/App.tsx",
    });
  });

  it("renders all open editor tabs", () => {
    render(<EditorTabBar />);
    expect(screen.getByText("App.tsx")).toBeInTheDocument();
    expect(screen.getByText("README.md")).toBeInTheDocument();
  });

  it("marks active tab and displays dirty indicator on dirty tabs", () => {
    render(<EditorTabBar />);
    const appTab = screen.getByText("App.tsx").closest(".editor-tab");
    const readmeTab = screen.getByText("README.md").closest(".editor-tab");

    expect(appTab).toHaveClass("active");
    expect(readmeTab).not.toHaveClass("active");

    expect(readmeTab?.querySelector(".editor-tab-dirty")).toBeInTheDocument();
    expect(appTab?.querySelector(".editor-tab-dirty")).not.toBeInTheDocument();
  });

  it("switches active tab when clicked", () => {
    render(<EditorTabBar />);
    const readmeTab = screen.getByText("README.md");
    fireEvent.click(readmeTab);

    expect(useTerminalStore.getState().activeEditorPath).toBe("/workspace/README.md");
  });

  it("closes tab when close button is clicked", () => {
    render(<EditorTabBar />);
    const closeButtons = screen.getAllByRole("button", { name: /close/i });
    expect(closeButtons.length).toBe(2);

    fireEvent.click(closeButtons[0]);
    const tabs = useTerminalStore.getState().editorTabs;
    expect(tabs.find((t) => t.path === "/workspace/src/App.tsx")).toBeUndefined();
  });

  it("opens a new untitled tab when clicking the new tab button", () => {
    render(<EditorTabBar />);
    const newTabBtn = screen.getByRole("button", { name: /new file|new tab/i });
    fireEvent.click(newTabBtn);

    const tabs = useTerminalStore.getState().editorTabs;
    expect(tabs.length).toBe(3);
    const newTab = tabs.find((t) => t.name.startsWith("Untitled") || t.path.includes("untitled"));
    expect(newTab).toBeDefined();
  });
});
