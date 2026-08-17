import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RightSidebar } from "./RightSidebar";
import { useTerminalStore } from "../../store/terminalStore";
import * as fsTransport from "../../lib/fs/transport";
import * as gitTransport from "../../lib/git/transport";

vi.mock("../../lib/fs/transport", () => ({
  readDir: vi.fn(),
}));

vi.mock("../../lib/git/transport", () => ({
  getGitStatus: vi.fn(),
}));

const readDirMock = vi.mocked(fsTransport.readDir);
const getGitStatusMock = vi.mocked(gitTransport.getGitStatus);

describe("RightSidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTerminalStore.setState({
      rightSidebarOpen: true,
      rightSidebarWidth: 280,
      rightSidebarTab: "explorer",
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

    getGitStatusMock.mockResolvedValue({
      is_git: true,
      branch: "main",
      ahead: 1,
      behind: 0,
      files: [
        { path: "src/App.tsx", status: "M" },
        { path: "src/components/New.tsx", status: "A" },
        { path: "deleted.txt", status: "D" },
        { path: "untracked.ts", status: "??" },
      ],
    });
  });

  it("renders Activity Bar tabs for Explorer and Git", () => {
    render(<RightSidebar />);
    expect(screen.getByTitle("File Explorer")).toBeDefined();
    expect(screen.getByTitle("Source Control")).toBeDefined();
    expect(screen.getByTitle("Refresh")).toBeDefined();
  });

  it("does not render when rightSidebarOpen is false", () => {
    useTerminalStore.setState({ rightSidebarOpen: false });
    const { container } = render(<RightSidebar />);
    expect(container.firstChild).toBeNull();
  });

  it("switches tabs between Explorer and Git", async () => {
    render(<RightSidebar />);
    const gitTab = screen.getByTitle("Source Control");
    fireEvent.click(gitTab);

    expect(useTerminalStore.getState().rightSidebarTab).toBe("git");
    await waitFor(() => {
      expect(screen.getByText("main")).toBeDefined();
    });
  });

  it("renders File Explorer with directories and files and expands subdirectories", async () => {
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

  it("renders empty state in File Explorer when no CWD is active", async () => {
    useTerminalStore.setState({
      sessions: {},
      tabs: [],
    });

    render(<RightSidebar />);

    await waitFor(() => {
      expect(screen.getByText(/no active workspace directory/i)).toBeDefined();
    });
  });

  it("renders Git Source Control branch, ahead/behind count, and changed files with status badges", async () => {
    useTerminalStore.setState({ rightSidebarTab: "git" });
    render(<RightSidebar />);

    await waitFor(() => {
      expect(screen.getByText("main")).toBeDefined();
      expect(screen.getByText(/src\/App\.tsx/)).toBeDefined();
      expect(screen.getByText(/src\/components\/New\.tsx/)).toBeDefined();
      expect(screen.getByText(/deleted\.txt/)).toBeDefined();
      expect(screen.getByText(/untracked\.ts/)).toBeDefined();
      expect(screen.getByText("M")).toBeDefined();
      expect(screen.getByText("A")).toBeDefined();
      expect(screen.getByText("D")).toBeDefined();
      expect(screen.getByText("U")).toBeDefined();
    });
  });

  it("renders clean working tree message when git has no changes", async () => {
    getGitStatusMock.mockResolvedValue({
      is_git: true,
      branch: "main",
      ahead: 0,
      behind: 0,
      files: [],
    });

    useTerminalStore.setState({ rightSidebarTab: "git" });
    render(<RightSidebar />);

    await waitFor(() => {
      expect(screen.getByText(/no changes/i)).toBeDefined();
    });
  });

  it("renders non-git repository message when path is not a git repo", async () => {
    getGitStatusMock.mockResolvedValue({
      is_git: false,
      branch: "",
      ahead: 0,
      behind: 0,
      files: [],
    });

    useTerminalStore.setState({ rightSidebarTab: "git" });
    render(<RightSidebar />);

    await waitFor(() => {
      expect(screen.getByText(/not a git repository/i)).toBeDefined();
    });
  });

  it("resizes the sidebar on drag within bounds [200, 480]", () => {
    const { container } = render(<RightSidebar />);
    const resizeHandle = container.querySelector(".resize-handle-left")!;
    expect(resizeHandle).toBeDefined();

    // Start mouse drag at clientX = 800 (initial width = 280)
    fireEvent.mouseDown(resizeHandle, { clientX: 800 });

    // Drag left by 70px (clientX = 730 -> width = 280 + (800 - 730) = 350)
    fireEvent.mouseMove(window, { clientX: 730 });
    expect(useTerminalStore.getState().rightSidebarWidth).toBe(350);

    // Drag beyond max bound 480 (clientX = 500 -> delta 300 -> 280+300 = 580 -> capped at 480)
    fireEvent.mouseMove(window, { clientX: 500 });
    expect(useTerminalStore.getState().rightSidebarWidth).toBe(480);

    // Drag beyond min bound 200 (clientX = 950 -> delta -150 -> 280-150 = 130 -> capped at 200)
    fireEvent.mouseMove(window, { clientX: 950 });
    expect(useTerminalStore.getState().rightSidebarWidth).toBe(200);

    // Release mouse
    fireEvent.mouseUp(window);
  });

  it("refreshes active view when refresh button is clicked", async () => {
    render(<RightSidebar />);

    await waitFor(() => {
      expect(readDirMock).toHaveBeenCalledTimes(1);
    });

    const refreshBtn = screen.getByTitle("Refresh");
    fireEvent.click(refreshBtn);

    await waitFor(() => {
      expect(readDirMock).toHaveBeenCalledTimes(2);
    });
  });
});
