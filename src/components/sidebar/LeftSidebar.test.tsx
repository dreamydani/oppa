import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { LeftSidebar } from "./LeftSidebar";
import { useTerminalStore } from "../../store/terminalStore";
import * as transport from "../../lib/pty/transport";

vi.mock("../../lib/pty/transport", () => ({
  ptySpawn: vi.fn(),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  ptyResize: vi.fn().mockResolvedValue(undefined),
  ptyAck: vi.fn().mockResolvedValue(undefined),
  ptyWrite: vi.fn(),
  saveLayout: vi.fn().mockResolvedValue(undefined),
  loadLayout: vi.fn().mockResolvedValue(null),
  saveScrollback: vi.fn().mockResolvedValue(undefined),
  loadScrollback: vi.fn().mockResolvedValue(null),
  deleteScrollback: vi.fn().mockResolvedValue(undefined),
  cleanupStaleScrollbacks: vi.fn().mockResolvedValue(undefined),
  onPtyData: vi.fn(),
  onPtyExit: vi.fn(),
}));

const ptySpawnMock = vi.mocked(transport.ptySpawn);

describe("LeftSidebar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ptySpawnMock.mockResolvedValue("s-new");
    useTerminalStore.setState({
      leftSidebarOpen: true,
      leftSidebarWidth: 240,
      tabs: [
        {
          id: "tab-alpha",
          layout: { type: "leaf", id: "s1" },
          focusedPath: [],
        },
        {
          id: "tab-beta",
          layout: { type: "leaf", id: "s2" },
          focusedPath: [],
        },
      ],
      activeTabId: "tab-alpha",
      sessions: {
        s1: {
          id: "s1",
          title: "s1",
          status: "running",
          cwd: "/home/user/project-alpha",
          cols: 80,
          rows: 24,
        },
        s2: {
          id: "s2",
          title: "s2",
          status: "running",
          cwd: "/home/user/project-beta",
          cols: 80,
          rows: 24,
        },
      },
      layout: { type: "leaf", id: "s1" },
      focusedPath: [],
    });
  });

  it("renders workspace navigation icons, header, and workspace cards", () => {
    render(<LeftSidebar />);
    expect(screen.getByText("WORKSPACES")).toBeDefined();
    expect(screen.getByTitle("New Workspace")).toBeDefined();
    expect(screen.getByTitle("Terminal Workspaces")).toBeDefined();
    expect(screen.getByTitle("Settings")).toBeDefined();

    expect(screen.getByText("project-alpha")).toBeDefined();
    expect(screen.getByText("project-beta")).toBeDefined();
  });

  it("does not render when leftSidebarOpen is false", () => {
    useTerminalStore.setState({ leftSidebarOpen: false });
    const { container } = render(<LeftSidebar />);
    expect(container.firstChild).toBeNull();
  });

  it("selects a tab when its workspace card is clicked", () => {
    render(<LeftSidebar />);
    const cardBeta = screen.getByText("project-beta").closest(".workspace-card")!;
    fireEvent.click(cardBeta);

    expect(useTerminalStore.getState().activeTabId).toBe("tab-beta");
  });

  it("opens workspace launcher modal when + button is clicked", () => {
    useTerminalStore.setState({ isWorkspaceLauncherOpen: false });
    render(<LeftSidebar />);
    const addBtn = screen.getByTitle("New Workspace");
    fireEvent.click(addBtn);

    expect(useTerminalStore.getState().isWorkspaceLauncherOpen).toBe(true);
  });

  it("closes a workspace tab when close button is clicked", async () => {
    render(<LeftSidebar />);
    const closeBtns = screen.getAllByTitle("Close Workspace");
    expect(closeBtns.length).toBeGreaterThan(0);
    fireEvent.click(closeBtns[1]);

    await vi.waitFor(() => {
      expect(useTerminalStore.getState().tabs).toHaveLength(1);
      expect(useTerminalStore.getState().tabs[0].id).toBe("tab-alpha");
    });
  });

  it("supports inline rename of workspace tab on double click", async () => {
    render(<LeftSidebar />);
    const cardAlpha = screen.getByText("project-alpha").closest(".workspace-card")!;
    fireEvent.doubleClick(cardAlpha);

    const input = screen.getByRole("textbox", { name: /rename workspace/i }) as HTMLInputElement;
    expect(input).toBeDefined();

    fireEvent.change(input, { target: { value: "renamed-workspace" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await vi.waitFor(() => {
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(useTerminalStore.getState().tabs[0].title).toBe("renamed-workspace");
    });
  });

  it("cancels inline rename on Escape", async () => {
    render(<LeftSidebar />);
    const cardAlpha = screen.getByText("project-alpha").closest(".workspace-card")!;
    fireEvent.doubleClick(cardAlpha);

    const input = screen.getByRole("textbox", { name: /rename workspace/i });
    fireEvent.change(input, { target: { value: "cancelled-workspace" } });
    fireEvent.keyDown(input, { key: "Escape", code: "Escape" });

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(useTerminalStore.getState().tabs[0].title).toBeUndefined();
  });

  it("resizes the sidebar on drag within bounds [180, 420]", () => {
    const { container } = render(<LeftSidebar />);
    const resizeHandle = container.querySelector(".resize-handle-right")!;
    expect(resizeHandle).toBeDefined();

    // Start mouse drag
    fireEvent.mouseDown(resizeHandle, { clientX: 240 });

    // Drag to 320px
    fireEvent.mouseMove(window, { clientX: 320 });
    expect(useTerminalStore.getState().leftSidebarWidth).toBe(320);

    // Drag beyond max bound (500 -> 420)
    fireEvent.mouseMove(window, { clientX: 500 });
    expect(useTerminalStore.getState().leftSidebarWidth).toBe(420);

    // Drag below min bound (100 -> 180)
    fireEvent.mouseMove(window, { clientX: 100 });
    expect(useTerminalStore.getState().leftSidebarWidth).toBe(180);

    // Release mouse
    fireEvent.mouseUp(window);
  });
});
