import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { FileExplorer } from "./FileExplorer";
import { useTerminalStore } from "../../store/terminalStore";
import * as fsTransport from "../../lib/fs/transport";

vi.mock("../../lib/fs/transport", () => ({
  readDir: vi.fn(),
  readFile: vi.fn().mockResolvedValue(""),
  writeFile: vi.fn(),
  createFile: vi.fn().mockResolvedValue(true),
  createDir: vi.fn().mockResolvedValue(true),
  detectEditors: vi
    .fn()
    .mockResolvedValue([
      { name: "VS Code", command: "code" },
      { name: "Notepad", command: "notepad" },
    ]),
  openWith: vi.fn().mockResolvedValue(true),
}));

const readDirMock = vi.mocked(fsTransport.readDir);
const createFileMock = vi.mocked(fsTransport.createFile);
const createDirMock = vi.mocked(fsTransport.createDir);
const openWithMock = vi.mocked(fsTransport.openWith);

function setupStore(): void {
  useTerminalStore.setState({
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
  });
}

function mockStaticTree(): void {
  readDirMock.mockImplementation(async (path: string) => {
    if (path === "/mock/workspace") {
      return [
        { name: "src", path: "/mock/workspace/src", is_dir: true, size: 0 },
        { name: "package.json", path: "/mock/workspace/package.json", is_dir: false, size: 1024 },
      ];
    }
    if (path === "/mock/workspace/src") {
      return [
        { name: "main.rs", path: "/mock/workspace/src/main.rs", is_dir: false, size: 256 },
      ];
    }
    return [];
  });
}

// Root starts with only "src"; after createFile resolves, the refreshed root
// listing includes the new file so the test exercises the real refresh path
function mockTreeGrowingTo(extraName: string): void {
  let created = false;
  createFileMock.mockImplementation(async () => {
    created = true;
  });
  readDirMock.mockImplementation(async (path: string) => {
    if (path === "/mock/workspace") {
      const base = [{ name: "src", path: "/mock/workspace/src", is_dir: true, size: 0 }];
      return created
        ? [...base, { name: extraName, path: `/mock/workspace/${extraName}`, is_dir: false, size: 8 }]
        : base;
    }
    if (path === "/mock/workspace/src") {
      return [
        { name: "main.rs", path: "/mock/workspace/src/main.rs", is_dir: false, size: 256 },
      ];
    }
    return [];
  });
}

async function renderExplorer(): Promise<HTMLElement> {
  const { container } = render(<FileExplorer />);
  await waitFor(() => {
    expect(screen.getByText("src")).toBeDefined();
  });
  return container;
}

describe("FileExplorer context menus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    setupStore();
    mockStaticTree();
  });

  it("opens blank-area menu with New Folder and New File on right click", async () => {
    const container = await renderExplorer();

    fireEvent.contextMenu(container.querySelector(".file-explorer")!);

    expect(screen.getByText("New Folder")).toBeDefined();
    expect(screen.getByText("New File")).toBeDefined();
  });

  it("shows Open in Editor, Open via and Copy as Path for files", async () => {
    await renderExplorer();

    fireEvent.contextMenu(screen.getByText("package.json"));

    expect(screen.getByText("Open in Editor")).toBeDefined();
    expect(screen.getByText("Open via")).toBeDefined();
    expect(screen.getByText("Copy as Path")).toBeDefined();
    // Blank-area creation items must not leak into file menus
    expect(screen.queryByText("New Folder")).toBeNull();
  });

  it("shows creation items plus Copy as Path for folders", async () => {
    await renderExplorer();

    fireEvent.contextMenu(screen.getByText("src"));

    expect(screen.getByText("New Folder")).toBeDefined();
    expect(screen.getByText("New File")).toBeDefined();
    expect(screen.getByText("Copy as Path")).toBeDefined();
    expect(screen.queryByText("Open in Editor")).toBeNull();
  });

  it("closes the menu when clicking elsewhere", async () => {
    const container = await renderExplorer();

    fireEvent.contextMenu(container.querySelector(".file-explorer")!);
    expect(screen.getByText("New Folder")).toBeDefined();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("New Folder")).toBeNull();
  });

  it("creates a file from blank-area menu at workspace root and refreshes tree", async () => {
    mockTreeGrowingTo("notes.md");
    const container = await renderExplorer();
    expect(screen.queryByText("notes.md")).toBeNull();

    fireEvent.contextMenu(container.querySelector(".file-explorer")!);
    fireEvent.click(screen.getByText("New File"));

    const input = screen.getByLabelText("New file name");
    fireEvent.change(input, { target: { value: "notes.md" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(createFileMock).toHaveBeenCalledWith("/mock/workspace/notes.md");
    });
    await waitFor(() => {
      expect(screen.getByText("notes.md")).toBeDefined();
    });
  });

  it("creates a folder inside a right-clicked directory", async () => {
    await renderExplorer();

    fireEvent.contextMenu(screen.getByText("src"));
    fireEvent.click(screen.getByText("New Folder"));

    const input = screen.getByLabelText("New folder name");
    fireEvent.change(input, { target: { value: "sub" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(createDirMock).toHaveBeenCalledWith("/mock/workspace/src/sub");
    });
  });

  it("cancels inline creation on Escape without calling backend", async () => {
    const container = await renderExplorer();

    fireEvent.contextMenu(container.querySelector(".file-explorer")!);
    fireEvent.click(screen.getByText("New File"));

    const input = screen.getByLabelText("New file name");
    fireEvent.change(input, { target: { value: "draft.txt" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByLabelText("New file name")).toBeNull();
    expect(createFileMock).not.toHaveBeenCalled();
  });

  it("rejects duplicate names with an inline error before hitting the backend", async () => {
    const container = await renderExplorer();

    fireEvent.contextMenu(container.querySelector(".file-explorer")!);
    fireEvent.click(screen.getByText("New Folder"));

    const input = screen.getByLabelText("New folder name");
    fireEvent.change(input, { target: { value: "src" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByText(/already exists/i)).toBeDefined();
    });
    expect(createDirMock).not.toHaveBeenCalled();
  });

  it("surfaces an error when backend creation fails", async () => {
    createDirMock.mockResolvedValue(false);
    const container = await renderExplorer();

    fireEvent.contextMenu(container.querySelector(".file-explorer")!);
    fireEvent.click(screen.getByText("New Folder"));

    const input = screen.getByLabelText("New folder name");
    fireEvent.change(input, { target: { value: "denied" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(screen.getByText(/could not create/i)).toBeDefined();
    });
  });

  it("opens internal editor from the file context menu", async () => {
    await renderExplorer();

    fireEvent.contextMenu(screen.getByText("package.json"));
    fireEvent.click(screen.getByText("Open in Editor"));

    await waitFor(() => {
      const state = useTerminalStore.getState();
      expect(state.activeAppMode).toBe("editor");
      expect(state.activeEditorPath).toBe("/mock/workspace/package.json");
    });
  });

  it("lists detected apps under Open via and launches the chosen one", async () => {
    await renderExplorer();

    fireEvent.contextMenu(screen.getByText("package.json"));
    fireEvent.click(screen.getByText("Open via"));

    expect(await screen.findByText("VS Code")).toBeDefined();
    expect(screen.getByText("Notepad")).toBeDefined();

    fireEvent.click(screen.getByText("VS Code"));
    await waitFor(() => {
      expect(openWithMock).toHaveBeenCalledWith("/mock/workspace/package.json", "code");
    });
  });

  it("offers System Default that opens via OS handler", async () => {
    await renderExplorer();

    fireEvent.contextMenu(screen.getByText("package.json"));
    fireEvent.click(screen.getByText("Open via"));
    fireEvent.click(await screen.findByText("System Default"));

    await waitFor(() => {
      expect(openWithMock).toHaveBeenCalledWith("/mock/workspace/package.json", undefined);
    });
  });

  it("copies the full native path to clipboard", async () => {
    await renderExplorer();

    fireEvent.contextMenu(screen.getByText("package.json"));
    fireEvent.click(screen.getByText("Copy as Path"));

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "/mock/workspace/package.json",
      );
    });
  });

  it("selects the row under the right-clicked cursor", async () => {
    await renderExplorer();

    fireEvent.contextMenu(screen.getByText("src"));

    const row = screen.getByText("src").closest(".file-tree-item")!;
    expect(row.className).toContain("selected");
  });
});

describe("FileExplorer large-directory cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
    setupStore();
  });

  function mockHugeDir(count: number): void {
    readDirMock.mockImplementation(async (path: string) => {
      if (path === "/mock/workspace") {
        return [
          { name: "big", path: "/mock/workspace/big", is_dir: true, size: 0 },
        ];
      }
      if (path === "/mock/workspace/big") {
        return Array.from({ length: count }, (_, i) => ({
          name: `file-${String(i).padStart(4, "0")}.txt`,
          path: `/mock/workspace/big/file-${String(i).padStart(4, "0")}.txt`,
          is_dir: false,
          size: i,
        }));
      }
      return [];
    });
  }

  it("caps rendered children and reveals the rest on demand", async () => {
    mockHugeDir(250);
    const { container } = render(<FileExplorer />);
    await waitFor(() => {
      expect(screen.getByText("big")).toBeDefined();
    });
    fireEvent.click(screen.getByText("big"));
    await waitFor(() => {
      expect(screen.getByText("file-0000.txt")).toBeDefined();
    });

    const rows = container.querySelectorAll(".file-tree-item");
    // 1 dir row + capped children + the "show more" toggle
    expect(rows.length).toBe(202);
    expect(screen.queryByText("file-0249.txt")).toBeNull();
    expect(screen.getByText(/show 50 more/i)).toBeDefined();

    fireEvent.click(screen.getByText(/show 50 more/i));
    expect(screen.getByText("file-0249.txt")).toBeDefined();
    // 1 dir row + all children, toggle gone
    expect(container.querySelectorAll(".file-tree-item").length).toBe(251);
  });

  it("does not cap small directories", async () => {
    mockStaticTree();
    const { container } = render(<FileExplorer />);
    await waitFor(() => {
      expect(screen.getByText("src")).toBeDefined();
    });
    fireEvent.click(screen.getByText("src"));
    await waitFor(() => {
      expect(screen.getByText("main.rs")).toBeDefined();
    });
    expect(screen.queryByText(/show \d+ more/i)).toBeNull();
    // 2 root rows + 1 child under src
    expect(container.querySelectorAll(".file-tree-item").length).toBe(3);
  });
});
