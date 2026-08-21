import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { useTerminalStore } from "../store/terminalStore";
import { TabBar } from "./TabBar";
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

describe("TabBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ptySpawnMock.mockResolvedValue({ id: "s-new", is_new: true, pid: 100 });
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
          cwd: "/home/user/my-project",
          cols: 80,
          rows: 24,
        },
      },
      layout: { type: "leaf", id: "s1" },
      focusedPath: [],
    });
  });

  it("renders tabs with correct active class and aria-selected", () => {
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-1",
          layout: { type: "leaf", id: "s1" },
          focusedPath: [],
        },
        {
          id: "tab-2",
          layout: { type: "leaf", id: "s2" },
          focusedPath: [],
        },
      ],
      activeTabId: "tab-1",
      sessions: {
        s1: {
          id: "s1",
          title: "s1",
          status: "running",
          cwd: "/home/user/project-a",
          cols: 80,
          rows: 24,
        },
        s2: {
          id: "s2",
          title: "s2",
          status: "running",
          cwd: "/home/user/project-b",
          cols: 80,
          rows: 24,
        },
      },
    });

    const { container } = render(<TabBar />);
    const tabElements = container.querySelectorAll(".tab-item");
    expect(tabElements).toHaveLength(2);

    expect(tabElements[0].classList.contains("active")).toBe(true);
    expect(tabElements[0].getAttribute("aria-selected")).toBe("true");
    expect(tabElements[0].textContent).toContain("project-a");

    expect(tabElements[1].classList.contains("active")).toBe(false);
    expect(tabElements[1].getAttribute("aria-selected")).toBe("false");
    expect(tabElements[1].textContent).toContain("project-b");
  });

  it("displays explicit tab title when set", () => {
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-1",
          title: "Custom Tab Title",
          layout: { type: "leaf", id: "s1" },
          focusedPath: [],
        },
      ],
      activeTabId: "tab-1",
    });

    const { getByText } = render(<TabBar />);
    expect(getByText("Custom Tab Title")).toBeTruthy();
  });

  it("derives title from Windows path or fallback", () => {
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-1",
          layout: { type: "leaf", id: "s1" },
          focusedPath: [],
        },
        {
          id: "tab-2",
          layout: { type: "leaf", id: "s2" },
          focusedPath: [],
        },
      ],
      activeTabId: "tab-1",
      sessions: {
        s1: {
          id: "s1",
          title: "s1",
          status: "running",
          cwd: "C:\\Users\\admin\\workspace\\my-app",
          cols: 80,
          rows: 24,
        },
        s2: {
          id: "s2",
          title: "s2",
          status: "running",
          cols: 80,
          rows: 24,
        },
      },
    });

    const { getByText } = render(<TabBar />);
    expect(getByText("my-app")).toBeTruthy();
    expect(getByText("terminal")).toBeTruthy();
  });

  it("switches active tab when an inactive tab is clicked", () => {
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-1",
          layout: { type: "leaf", id: "s1" },
          focusedPath: [],
        },
        {
          id: "tab-2",
          layout: { type: "leaf", id: "s2" },
          focusedPath: [],
        },
      ],
      activeTabId: "tab-1",
    });

    const { container } = render(<TabBar />);
    const tabElements = container.querySelectorAll(".tab-item");
    fireEvent.click(tabElements[1]);

    expect(useTerminalStore.getState().activeTabId).toBe("tab-2");
  });

  it("creates and activates a wizard tab when the add button is clicked", () => {
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-1",
          layout: { type: "leaf", id: "s1" },
          focusedPath: [],
        },
      ],
      activeTabId: "tab-1",
    });
    const { getByRole } = render(<TabBar />);
    const addBtn = getByRole("button", { name: /new tab/i });
    fireEvent.click(addBtn);

    const state = useTerminalStore.getState();
    expect(state.tabs).toHaveLength(2);
    expect(state.tabs[1].isWizard).toBe(true);
    expect(state.activeTabId).toBe(state.tabs[1].id);
  });

  it("renders wizard tab with New Workspace title and sparkles icon", () => {
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-wizard",
          layout: { type: "leaf", id: "" },
          focusedPath: [],
          isWizard: true,
        },
      ],
      activeTabId: "tab-wizard",
    });

    const { container, getByText } = render(<TabBar />);
    expect(getByText("New Workspace")).toBeTruthy();
    expect(container.querySelector(".tab-wizard-icon")).toBeTruthy();
  });

  it("renders close buttons only when more than one tab exists", () => {
    const { container, rerender } = render(<TabBar />);
    expect(container.querySelectorAll(".tab-close-btn")).toHaveLength(0);

    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-1",
          layout: { type: "leaf", id: "s1" },
          focusedPath: [],
        },
        {
          id: "tab-2",
          layout: { type: "leaf", id: "s2" },
          focusedPath: [],
        },
      ],
    });

    rerender(<TabBar />);
    expect(container.querySelectorAll(".tab-close-btn")).toHaveLength(2);
  });

  it("closes the tab when close button is clicked without selecting it", async () => {
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-1",
          layout: { type: "leaf", id: "s1" },
          focusedPath: [],
        },
        {
          id: "tab-2",
          layout: { type: "leaf", id: "s2" },
          focusedPath: [],
        },
      ],
      activeTabId: "tab-1",
      sessions: {
        s1: { id: "s1", title: "s1", status: "running", cols: 80, rows: 24 },
        s2: { id: "s2", title: "s2", status: "running", cols: 80, rows: 24 },
      },
    });

    const { container } = render(<TabBar />);
    const closeBtns = container.querySelectorAll(".tab-close-btn");
    fireEvent.click(closeBtns[1]);

    await vi.waitFor(() => {
      const state = useTerminalStore.getState();
      expect(state.tabs).toHaveLength(1);
      expect(state.tabs[0].id).toBe("tab-1");
      expect(state.activeTabId).toBe("tab-1");
    });
  });

  it("switches to inline rename mode on double-click and saves on Enter", async () => {
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
        s1: { id: "s1", title: "s1", status: "running", cwd: "/test/dir", cols: 80, rows: 24 },
      },
    });

    const { container } = render(<TabBar />);
    const tabItem = container.querySelector(".tab-item")!;
    fireEvent.doubleClick(tabItem);

    const input = screen.getByRole("textbox", { name: /rename tab/i }) as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.value).toBe("dir");

    fireEvent.change(input, { target: { value: "renamed-tab" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await vi.waitFor(() => {
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(useTerminalStore.getState().tabs[0].title).toBe("renamed-tab");
    });
  });

  it("saves inline rename on blur", async () => {
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-1",
          layout: { type: "leaf", id: "s1" },
          focusedPath: [],
        },
      ],
      activeTabId: "tab-1",
    });

    const { container } = render(<TabBar />);
    const tabItem = container.querySelector(".tab-item")!;
    fireEvent.doubleClick(tabItem);

    const input = screen.getByRole("textbox", { name: /rename tab/i });
    fireEvent.change(input, { target: { value: "blurred-title" } });
    fireEvent.blur(input);

    await vi.waitFor(() => {
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(useTerminalStore.getState().tabs[0].title).toBe("blurred-title");
    });
  });

  it("cancels inline rename on Escape without changing title", async () => {
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-1",
          title: "original-title",
          layout: { type: "leaf", id: "s1" },
          focusedPath: [],
        },
      ],
      activeTabId: "tab-1",
    });

    const { container } = render(<TabBar />);
    const tabItem = container.querySelector(".tab-item")!;
    fireEvent.doubleClick(tabItem);

    const input = screen.getByRole("textbox", { name: /rename tab/i });
    fireEvent.change(input, { target: { value: "cancelled-title" } });
    fireEvent.keyDown(input, { key: "Escape", code: "Escape" });

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(useTerminalStore.getState().tabs[0].title).toBe("original-title");
  });

  it("renders working directory or title for sleeping tabs", () => {
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-active",
          layout: { type: "leaf", id: "s-active" },
          focusedPath: [],
          isSleeping: false,
        },
        {
          id: "tab-sleeping-cwd",
          layout: { type: "leaf", id: "s-sleeping-1" },
          focusedPath: [],
          isSleeping: true,
        },
        {
          id: "tab-sleeping-title",
          layout: { type: "leaf", id: "s-sleeping-2" },
          focusedPath: [],
          isSleeping: true,
        },
      ],
      activeTabId: "tab-active",
      sessions: {
        "s-active": {
          id: "s-active",
          title: "s-active",
          status: "running",
          cwd: "/home/user/active-app",
          cols: 80,
          rows: 24,
        },
        "s-sleeping-1": {
          id: "s-sleeping-1",
          title: "s-sleeping-1",
          status: "sleeping",
          cwd: "C:\\workspaces\\sleeping-project",
          cols: 80,
          rows: 24,
        },
        "s-sleeping-2": {
          id: "s-sleeping-2",
          title: "Custom Sleeping Name",
          status: "sleeping",
          cols: 80,
          rows: 24,
        },
      },
    });

    const { container } = render(<TabBar />);
    const tabElements = container.querySelectorAll(".tab-item");
    expect(tabElements).toHaveLength(3);

    expect(tabElements[0].textContent).toContain("active-app");
    expect(tabElements[1].textContent).toContain("sleeping-project");
    expect(tabElements[2].textContent).toContain("Custom Sleeping Name");
  });
});
