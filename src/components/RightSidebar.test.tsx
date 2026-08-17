import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RightSidebar } from "./RightSidebar";
import { useTerminalStore } from "../store/terminalStore";
import * as fsTransport from "../lib/fs/transport";

vi.mock("../lib/fs/transport", () => ({
  readDir: vi.fn(),
}));

const readDirMock = vi.mocked(fsTransport.readDir);

describe("RightSidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTerminalStore.setState({
      rightSidebarOpen: true,
      rightSidebarWidth: 280,
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
      { name: "package.json", path: "/mock/workspace/package.json", is_dir: false, size: 1024 },
    ]);
  });

  it("renders File Explorer header with collapse button", () => {
    render(<RightSidebar />);
    expect(screen.getByText("File Explorer")).toBeDefined();
    expect(screen.getByTitle(/collapse file explorer/i)).toBeDefined();
  });

  it("toggles right sidebar when collapse button is clicked", () => {
    render(<RightSidebar />);
    const collapseBtn = screen.getByTitle(/collapse file explorer/i);
    fireEvent.click(collapseBtn);

    expect(useTerminalStore.getState().rightSidebarOpen).toBe(false);
  });

  it("renders File Explorer file tree with directories and files and expands subdirectories", async () => {
    readDirMock.mockImplementation(async (path: string) => {
      if (path === "/mock/workspace") {
        return [
          { name: "src", path: "/mock/workspace/src", is_dir: true, size: 0 },
          { name: "package.json", path: "/mock/workspace/package.json", is_dir: false, size: 1024 },
        ];
      }
      if (path === "/mock/workspace/src") {
        return [
          { name: "index.ts", path: "/mock/workspace/src/index.ts", is_dir: false, size: 512 },
        ];
      }
      return [];
    });

    render(<RightSidebar />);

    await waitFor(() => {
      expect(screen.getByText("src")).toBeDefined();
      expect(screen.getByText("package.json")).toBeDefined();
    });

    // Expand the "src" directory
    const srcDir = screen.getByText("src");
    fireEvent.click(srcDir);

    await waitFor(() => {
      expect(screen.getByText("index.ts")).toBeDefined();
    });

    // Collapse the "src" directory
    fireEvent.click(srcDir);

    await waitFor(() => {
      expect(screen.queryByText("index.ts")).toBeNull();
    });
  });

  it("renders empty state when no active workspace cwd", async () => {
    useTerminalStore.setState({
      sessions: {},
      tabs: [],
    });

    render(<RightSidebar />);

    await waitFor(() => {
      expect(screen.getByText(/no active workspace directory/i)).toBeDefined();
    });
  });

  it("renders empty directory state when directory has no entries", async () => {
    readDirMock.mockResolvedValue([]);

    render(<RightSidebar />);

    await waitFor(() => {
      expect(screen.getByText(/empty directory/i)).toBeDefined();
    });
  });

  it("resizes sidebar on left handle drag within bounds [200, 480]", () => {
    const { container } = render(<RightSidebar />);
    const resizeHandle = container.querySelector(".resize-handle-left")!;
    expect(resizeHandle).toBeDefined();

    fireEvent.mouseDown(resizeHandle, { clientX: 800 });

    fireEvent.mouseMove(window, { clientX: 730 });
    expect(useTerminalStore.getState().rightSidebarWidth).toBe(350);

    fireEvent.mouseMove(window, { clientX: 500 });
    expect(useTerminalStore.getState().rightSidebarWidth).toBe(480);

    fireEvent.mouseMove(window, { clientX: 950 });
    expect(useTerminalStore.getState().rightSidebarWidth).toBe(200);

    fireEvent.mouseUp(window);
  });
});
