import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RightSidebar } from "./RightSidebar";
import { useTerminalStore } from "../store/terminalStore";
import * as fsTransport from "../lib/fs/transport";

vi.mock("../lib/fs/transport", () => ({
  readDir: vi.fn(),
  readFile: vi.fn().mockResolvedValue(""),
}));

const readDirMock = vi.mocked(fsTransport.readDir);

describe("RightSidebar Re-export", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTerminalStore.setState({
      rightSidebarOpen: true,
      rightSidebarWidth: 280,
      rightSidebarTab: "explorer",
      activeAppMode: "terminal",
      tabs: [
        {
          id: "tab-1",
          layout: { type: "leaf", id: "s1" },
          focusedPath: [],
        },
      ],
      activeTabId: "tab-1",
      sessions: {
        s1: {
          id: "s1",
          title: "s1",
          status: "running",
          cwd: "/mock/workspace",
          cols: 80,
          rows: 24,
        },
      },
      layout: { type: "leaf", id: "s1" },
      focusedPath: [],
    });

    readDirMock.mockResolvedValue([
      { name: "src", path: "/mock/workspace/src", is_dir: true, size: 0 },
      { name: "index.html", path: "/mock/workspace/index.html", is_dir: false, size: 1024 },
    ]);
  });

  it("renders Activity Bar with Explorer tab active", () => {
    render(<RightSidebar />);
    expect(screen.getByText("Explorer")).toBeDefined();
    expect(screen.getByText("Git")).toBeDefined();
  });

  it("renders files and clicking a file opens it in editor", async () => {
    render(<RightSidebar />);

    await waitFor(() => {
      expect(screen.getByText("index.html")).toBeDefined();
    });

    const fileItem = screen.getByText("index.html");
    fireEvent.click(fileItem);

    await waitFor(() => {
      const state = useTerminalStore.getState();
      expect(state.activeAppMode).toBe("editor");
      expect(state.activeEditorPath).toBe("/mock/workspace/index.html");
      expect(state.editorTabs.some((t) => t.path === "/mock/workspace/index.html")).toBe(true);
    });
  });

  it("resizes sidebar on left handle drag within bounds [200, 480]", () => {
    const { container } = render(<RightSidebar />);
    const resizeHandle = container.querySelector(".resize-handle-left")!;
    expect(resizeHandle).toBeDefined();

    fireEvent.mouseDown(resizeHandle, { clientX: 800 });
    fireEvent.mouseMove(window, { clientX: 730 });
    expect(useTerminalStore.getState().rightSidebarWidth).toBe(350);
    fireEvent.mouseUp(window);
  });
});
