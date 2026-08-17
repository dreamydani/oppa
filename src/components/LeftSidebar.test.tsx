import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { LeftSidebar } from "./LeftSidebar";
import { useTerminalStore } from "../store/terminalStore";
import * as transport from "../lib/pty/transport";

vi.mock("../lib/pty/transport", () => ({
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
          title: "oppa-alpha",
          layout: { type: "leaf", id: "s1" },
          focusedPath: [],
        },
        {
          id: "tab-beta",
          title: "oppa-beta",
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
          cwd: "/home/user/projects/repo-root",
          cols: 80,
          rows: 24,
        },
        s2: {
          id: "s2",
          title: "s2",
          status: "running",
          cwd: "/home/user/work/service-app",
          cols: 80,
          rows: 24,
        },
      },
      layout: { type: "leaf", id: "s1" },
      focusedPath: [],
    });
  });

  it("renders search strip and tab cards with avatar badges", () => {
    render(<LeftSidebar />);

    expect(screen.getByPlaceholderText(/search tabs/i)).toBeDefined();
    expect(screen.getByTitle("New Tab")).toBeDefined();
    expect(screen.getByText("oppa-alpha")).toBeDefined();
    expect(screen.getByText("oppa-beta")).toBeDefined();
    // CWD is shortened to ~/last-two-segments
    expect(screen.getByText("~/projects/repo-root")).toBeDefined();
  });

  it("filters tab cards based on search query", () => {
    render(<LeftSidebar />);

    const searchInput = screen.getByPlaceholderText(/search tabs/i);
    fireEvent.change(searchInput, { target: { value: "beta" } });

    expect(screen.queryByText("oppa-alpha")).toBeNull();
    expect(screen.getByText("oppa-beta")).toBeDefined();

    fireEvent.change(searchInput, { target: { value: "projects" } });
    expect(screen.getByText("oppa-alpha")).toBeDefined();
    expect(screen.queryByText("oppa-beta")).toBeNull();

    fireEvent.change(searchInput, { target: { value: "" } });
    expect(screen.getByText("oppa-alpha")).toBeDefined();
    expect(screen.getByText("oppa-beta")).toBeDefined();
  });

  it("selects a tab when its tab card is clicked", () => {
    render(<LeftSidebar />);

    const cardBeta = screen.getByText("oppa-beta").closest(".tab-card")!;
    fireEvent.click(cardBeta);

    expect(useTerminalStore.getState().activeTabId).toBe("tab-beta");
  });

  it("opens workspace wizard when + button is clicked", () => {
    useTerminalStore.setState({ isSetupWizardOpen: false });
    render(<LeftSidebar />);

    const addBtn = screen.getByTitle("New Tab");
    fireEvent.click(addBtn);

    expect(useTerminalStore.getState().isSetupWizardOpen).toBe(true);
  });

  it("closes a tab when close button is clicked", async () => {
    render(<LeftSidebar />);

    const closeBtns = screen.getAllByTitle("Close Tab");
    expect(closeBtns.length).toBe(2);

    fireEvent.click(closeBtns[1]);

    await vi.waitFor(() => {
      expect(useTerminalStore.getState().tabs).toHaveLength(1);
      expect(useTerminalStore.getState().tabs[0].id).toBe("tab-alpha");
    });
  });

  it("renames a tab on double click and Enter", async () => {
    render(<LeftSidebar />);

    const cardAlpha = screen.getByText("oppa-alpha").closest(".tab-card")!;
    fireEvent.doubleClick(cardAlpha);

    const input = screen.getByRole("textbox", { name: /rename tab/i }) as HTMLInputElement;
    expect(input).toBeDefined();

    fireEvent.change(input, { target: { value: "renamed-tab" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await vi.waitFor(() => {
      expect(screen.queryByRole("textbox", { name: /rename tab/i })).toBeNull();
      expect(useTerminalStore.getState().tabs[0].title).toBe("renamed-tab");
    });
  });

  it("cancels inline rename on Escape", async () => {
    render(<LeftSidebar />);

    const cardAlpha = screen.getByText("oppa-alpha").closest(".tab-card")!;
    fireEvent.doubleClick(cardAlpha);

    const input = screen.getByRole("textbox", { name: /rename tab/i });
    fireEvent.change(input, { target: { value: "cancelled-tab" } });
    fireEvent.keyDown(input, { key: "Escape", code: "Escape" });

    expect(screen.queryByRole("textbox", { name: /rename tab/i })).toBeNull();
    expect(useTerminalStore.getState().tabs[0].title).toBe("oppa-alpha");
  });

  it("resizes sidebar when drag handle is moved", () => {
    const { container } = render(<LeftSidebar />);
    const resizeHandle = container.querySelector(".resize-handle-right")!;
    expect(resizeHandle).toBeDefined();

    fireEvent.mouseDown(resizeHandle, { clientX: 240 });

    fireEvent.mouseMove(window, { clientX: 300 });
    expect(useTerminalStore.getState().leftSidebarWidth).toBe(300);

    fireEvent.mouseMove(window, { clientX: 500 });
    expect(useTerminalStore.getState().leftSidebarWidth).toBe(420);

    fireEvent.mouseMove(window, { clientX: 100 });
    expect(useTerminalStore.getState().leftSidebarWidth).toBe(200);

    fireEvent.mouseUp(window);
  });
});
