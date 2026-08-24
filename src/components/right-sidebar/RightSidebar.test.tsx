import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { RightSidebar } from "./RightSidebar";
import { useTerminalStore } from "../../store/terminalStore";
import * as fsTransport from "../../lib/fs/transport";
import * as ptyTransport from "../../lib/pty/transport";
import type { SourceControlStatus } from "../../lib/pty/transport";

vi.mock("../../lib/fs/transport", () => ({
  readDir: vi.fn(),
  readFile: vi.fn().mockResolvedValue(""),
  writeFile: vi.fn(),
  createFile: vi.fn().mockResolvedValue(undefined),
  createDir: vi.fn().mockResolvedValue(true),
  detectEditors: vi.fn().mockResolvedValue([]),
  openWith: vi.fn().mockResolvedValue(true),
}));

vi.mock("../../lib/pty/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/pty/transport")>()),
  scStatus: vi.fn(),
  scLocalBranches: vi
    .fn()
    .mockResolvedValue({ branches: ["main"], current: "main" }),
}));

const readDirMock = vi.mocked(fsTransport.readDir);
const scStatusMock = vi.mocked(ptyTransport.scStatus);

function makeGitStatus(): SourceControlStatus {
  return {
    entries: [
      { path: "src/App.tsx", index_status: "M", worktree_status: " ", area: "staged", old_path: null },
      { path: "src/lib/mod.rs", index_status: " ", worktree_status: "M", area: "unstaged", old_path: null },
      { path: "untracked.ts", index_status: "?", worktree_status: "?", area: "untracked", old_path: null },
    ],
    conflict_state: "none",
    branch: "main",
    upstream: { has_upstream: true, ahead: 1, behind: 0, remote_branch: "origin/main" },
    did_hit_limit: false,
    status_length: 3,
  };
}

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

    scStatusMock.mockResolvedValue(makeGitStatus());

    useTerminalStore.setState({
      gitStatus: null,
      gitBranches: null,
      gitHistory: null,
    });
  });

  it("renders Activity Bar tabs for Explorer and Git", () => {
    render(<RightSidebar />);
    expect(screen.getByTitle("File Explorer")).toBeDefined();
    expect(screen.getByTitle("Source Control")).toBeDefined();
    expect(screen.getByTitle("Refresh")).toBeDefined();
  });

  it("keeps a closed sidebar mounted, hidden via the drawer instead of unmounting", () => {
    useTerminalStore.setState({ rightSidebarOpen: false });
    const { container } = render(<RightSidebar />);
    const aside = container.querySelector("aside.right-sidebar");
    expect(aside).not.toBeNull();
    // Drawer snap path (pre-boot suppression in tests): detached + hidden.
    expect((aside as HTMLElement).style.visibility).toBe("hidden");
    expect((aside as HTMLElement).style.position).toBe("absolute");
  });

  it("exposes the store width via the --sidebar-w custom property", () => {
    const { container } = render(<RightSidebar />);
    const aside = container.querySelector<HTMLElement>("aside.right-sidebar")!;
    expect(aside.style.getPropertyValue("--sidebar-w")).toBe("280px");
  });

  it("marks the sidebar as resizing during a drag and clears it on release", () => {
    const { container } = render(<RightSidebar />);
    const aside = container.querySelector<HTMLElement>("aside.right-sidebar")!;
    const resizeHandle = container.querySelector(".resize-handle-left")!;

    fireEvent.mouseDown(resizeHandle, { clientX: 800, button: 0 });
    expect(aside.className).toContain("is-resizing");

    fireEvent.mouseUp(window);
    expect(aside.className).not.toContain("is-resizing");
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

  it("renders Git Source Control branch, upstream badge, and sectioned changes from store status", async () => {
    useTerminalStore.setState({ rightSidebarTab: "git" });
    render(<RightSidebar />);

    await waitFor(() => {
      expect(screen.getByText("main")).toBeInTheDocument();
      expect(screen.getByText("↑1 ↓0")).toBeInTheDocument();
      expect(screen.getByText("App.tsx")).toBeInTheDocument();
      expect(screen.getByText("mod.rs")).toBeInTheDocument();
      expect(screen.getByText("untracked.ts")).toBeInTheDocument();
      const counts = Array.from(document.querySelectorAll(".git-count-badge")).map(
        (el) => el.textContent,
      );
      expect(counts).toEqual(["1", "1", "1"]);
    });
  });

  it("renders clean working tree message when git has no changes", async () => {
    scStatusMock.mockResolvedValue({
      entries: [],
      conflict_state: "none",
      branch: "main",
      upstream: { has_upstream: false, ahead: 0, behind: 0, remote_branch: null },
      did_hit_limit: false,
      status_length: 0,
    });

    useTerminalStore.setState({ rightSidebarTab: "git" });
    render(<RightSidebar />);

    await waitFor(() => {
      expect(screen.getByText(/working tree clean/i)).toBeDefined();
    });
  });

  it("renders non-git repository message when path is not a git repo", async () => {
    scStatusMock.mockRejectedValue(new Error("not a git repository"));

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

  it("opens file in editor and switches app mode to editor when file item is clicked", async () => {
    render(<RightSidebar />);

    await waitFor(() => {
      expect(screen.getByText("package.json")).toBeDefined();
    });

    const fileItem = screen.getByText("package.json");
    fireEvent.click(fileItem);

    await waitFor(() => {
      const state = useTerminalStore.getState();
      expect(state.activeAppMode).toBe("editor");
      expect(state.activeEditorPath).toBe("/mock/workspace/package.json");
      expect(state.editorTabs.some((t) => t.path === "/mock/workspace/package.json")).toBe(true);
    });
  });
});
