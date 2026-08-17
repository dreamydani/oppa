import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import App from "./App";
import { useTerminalStore } from "./store/terminalStore";
import * as transport from "./lib/pty/transport";

vi.mock("./lib/pty/transport", () => ({
  confirmSaveComplete: vi.fn().mockResolvedValue(undefined),
  onPtyCwd: vi.fn(),
  ptySpawn: vi.fn().mockResolvedValue("s1"),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  ptyResize: vi.fn().mockResolvedValue(undefined),
  ptyAck: vi.fn().mockResolvedValue(undefined),
  ptyWrite: vi.fn(),
  onPtyData: vi.fn().mockResolvedValue(vi.fn()),
  onPtyExit: vi.fn().mockResolvedValue(vi.fn()),
  saveLayout: vi.fn().mockResolvedValue(undefined),
  loadLayout: vi.fn().mockResolvedValue(null),
  saveScrollback: vi.fn().mockResolvedValue(undefined),
  loadScrollback: vi.fn().mockResolvedValue(null),
  deleteScrollback: vi.fn().mockResolvedValue(undefined),
  cleanupStaleScrollbacks: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
  }),
}));

vi.mock("./lib/fs/transport", () => ({
  readDir: vi.fn().mockResolvedValue([]),
}));

vi.mock("./lib/git/transport", () => ({
  getGitStatus: vi.fn().mockResolvedValue({
    is_git: false,
    branch: "",
    files: [],
    ahead: 0,
    behind: 0,
  }),
}));

vi.mock("./components/TerminalPane", () => ({
  TerminalPane: ({ id }: { id: string }) => (
    <div className="terminal-pane" data-session-id={id} />
  ),
}));

describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTerminalStore.setState({
      sessions: {
        s1: { id: "s1", title: "s1", status: "running", cols: 80, rows: 24 },
      },
      tabs: [
        {
          id: "tab-1",
          layout: { type: "leaf", id: "s1" },
          focusedPath: [],
        },
      ],
      activeTabId: "tab-1",
      layout: { type: "leaf", id: "s1" },
      focusedPath: [],
      ready: true,
      leftSidebarOpen: true,
      leftSidebarWidth: 240,
      rightSidebarOpen: true,
      rightSidebarWidth: 280,
      isWorkspaceLauncherOpen: false,
    });
  });

  it("subscribes to onPtyCwd on mount and updates session cwd", async () => {
    let cwdHandler: ((p: { id: string; cwd: string }) => void) | undefined;
    const unlisten = vi.fn();
    vi.mocked(transport.onPtyCwd).mockImplementation(async (cb) => {
      cwdHandler = cb;
      return unlisten;
    });

    const { unmount } = render(<App />);

    expect(transport.onPtyCwd).toHaveBeenCalledTimes(1);
    expect(cwdHandler).toBeDefined();

    cwdHandler?.({ id: "s1", cwd: "/test/dir" });
    expect(useTerminalStore.getState().sessions["s1"].cwd).toBe("/test/dir");

    unmount();
    await vi.waitFor(() => {
      expect(unlisten).toHaveBeenCalled();
    });
  });

  it("renders full 3-column minimalist layout with TitleBar, LeftSidebar, main viewport with PaneSplit, and RightSidebar when ready", () => {
    const { container } = render(<App />);

    expect(container.querySelector(".app-container")).not.toBeNull();
    expect(container.querySelector(".title-bar")).not.toBeNull();
    expect(container.querySelector(".workspace-container")).not.toBeNull();
    expect(container.querySelector(".left-sidebar")).not.toBeNull();
    expect(container.querySelector(".main-viewport")).not.toBeNull();
    expect(container.querySelector(".pane-root")).not.toBeNull();
    expect(container.querySelector(".right-sidebar")).not.toBeNull();
  });

  it("conditionally renders LeftSidebar and RightSidebar based on store state", () => {
    useTerminalStore.setState({
      leftSidebarOpen: false,
      rightSidebarOpen: false,
    });

    const { container } = render(<App />);

    expect(container.querySelector(".app-container")).not.toBeNull();
    expect(container.querySelector(".title-bar")).not.toBeNull();
    expect(container.querySelector(".workspace-container")).not.toBeNull();
    expect(container.querySelector(".left-sidebar")).toBeNull();
    expect(container.querySelector(".main-viewport")).not.toBeNull();
    expect(container.querySelector(".pane-root")).not.toBeNull();
    expect(container.querySelector(".right-sidebar")).toBeNull();
  });

  it("toggles left sidebar with Ctrl+B shortcut", () => {
    render(<App />);

    expect(useTerminalStore.getState().leftSidebarOpen).toBe(true);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true }),
    );
    expect(useTerminalStore.getState().leftSidebarOpen).toBe(false);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true }),
    );
    expect(useTerminalStore.getState().leftSidebarOpen).toBe(true);
  });

  it("toggles right sidebar with Ctrl+Shift+B shortcut", () => {
    render(<App />);

    expect(useTerminalStore.getState().rightSidebarOpen).toBe(true);

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "b",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(useTerminalStore.getState().rightSidebarOpen).toBe(false);

    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "B",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(useTerminalStore.getState().rightSidebarOpen).toBe(true);
  });

  it("creates a new tab on Ctrl+T or Cmd+T", async () => {
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

    render(<App />);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "t", ctrlKey: true, bubbles: true }),
    );

    await vi.waitFor(() => {
      expect(useTerminalStore.getState().tabs).toHaveLength(2);
    });
  });

  it("closes focused pane or active tab on Ctrl+W", async () => {
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-1",
          layout: {
            type: "split",
            dir: "h",
            ratio: 0.5,
            a: { type: "leaf", id: "s1" },
            b: { type: "leaf", id: "s2" },
          },
          focusedPath: [0],
        },
      ],
      activeTabId: "tab-1",
      sessions: {
        s1: { id: "s1", title: "s1", status: "running", cols: 80, rows: 24 },
        s2: { id: "s2", title: "s2", status: "running", cols: 80, rows: 24 },
      },
    });

    render(<App />);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "w", ctrlKey: true, bubbles: true }),
    );

    await vi.waitFor(() => {
      const activeTab = useTerminalStore.getState().tabs[0];
      expect(activeTab.layout.type).toBe("leaf");
    });
  });

  it("cycles active tab with Ctrl+Tab and Ctrl+Shift+Tab", () => {
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
        {
          id: "tab-3",
          layout: { type: "leaf", id: "s3" },
          focusedPath: [],
        },
      ],
      activeTabId: "tab-1",
      sessions: {
        s1: { id: "s1", title: "s1", status: "running", cols: 80, rows: 24 },
        s2: { id: "s2", title: "s2", status: "running", cols: 80, rows: 24 },
        s3: { id: "s3", title: "s3", status: "running", cols: 80, rows: 24 },
      },
    });

    render(<App />);

    // Cycle forward: tab-1 -> tab-2
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, bubbles: true }),
    );
    expect(useTerminalStore.getState().activeTabId).toBe("tab-2");

    // Cycle forward: tab-2 -> tab-3
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, bubbles: true }),
    );
    expect(useTerminalStore.getState().activeTabId).toBe("tab-3");

    // Cycle forward wrap: tab-3 -> tab-1
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, bubbles: true }),
    );
    expect(useTerminalStore.getState().activeTabId).toBe("tab-1");

    // Cycle backward: tab-1 -> tab-3
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(useTerminalStore.getState().activeTabId).toBe("tab-3");
  });

  it("selects tab directly by index with Alt+1..9 or Cmd+1..9", () => {
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
        {
          id: "tab-3",
          layout: { type: "leaf", id: "s3" },
          focusedPath: [],
        },
      ],
      activeTabId: "tab-1",
      sessions: {
        s1: { id: "s1", title: "s1", status: "running", cols: 80, rows: 24 },
        s2: { id: "s2", title: "s2", status: "running", cols: 80, rows: 24 },
        s3: { id: "s3", title: "s3", status: "running", cols: 80, rows: 24 },
      },
    });

    render(<App />);

    // Alt+2 -> tab-2
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "2", altKey: true, bubbles: true }),
    );
    expect(useTerminalStore.getState().activeTabId).toBe("tab-2");

    // Alt+3 -> tab-3
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "3", altKey: true, bubbles: true }),
    );
    expect(useTerminalStore.getState().activeTabId).toBe("tab-3");

    // Alt+1 -> tab-1
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "1", altKey: true, bubbles: true }),
    );
    expect(useTerminalStore.getState().activeTabId).toBe("tab-1");

    // Out of bounds Alt+9 -> stays tab-1
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "9", altKey: true, bubbles: true }),
    );
    expect(useTerminalStore.getState().activeTabId).toBe("tab-1");
  });

  it("triggers split horizontal and vertical shortcuts", async () => {
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
        s1: { id: "s1", title: "s1", status: "running", cols: 80, rows: 24 },
      },
    });

    render(<App />);

    // Ctrl+Shift+D -> horizontal split
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "d",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );

    await vi.waitFor(() => {
      const state = useTerminalStore.getState();
      expect(state.layout.type).toBe("split");
      if (state.layout.type === "split") {
        expect(state.layout.dir).toBe("h");
      }
    });

    // Ctrl+Shift+E -> vertical split
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "e",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );

    await vi.waitFor(() => {
      const state = useTerminalStore.getState();
      expect(state.focusedPath.length).toBeGreaterThan(1);
    });
  });

  it("triggers arrow focus navigation shortcuts", () => {
    const splitLayout: any = {
      type: "split",
      dir: "h",
      ratio: 0.5,
      a: { type: "leaf", id: "s1" },
      b: { type: "leaf", id: "s2" },
    };
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-1",
          layout: splitLayout,
          focusedPath: [0],
        },
      ],
      activeTabId: "tab-1",
      layout: splitLayout,
      focusedPath: [0],
      sessions: {
        s1: { id: "s1", title: "s1", status: "running", cols: 80, rows: 24 },
        s2: { id: "s2", title: "s2", status: "running", cols: 80, rows: 24 },
      },
    });

    render(<App />);

    // Ctrl+ArrowRight -> moves focus to [1]
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowRight",
        ctrlKey: true,
        bubbles: true,
      }),
    );
    expect(useTerminalStore.getState().focusedPath).toEqual([1]);

    // Ctrl+ArrowLeft -> moves focus back to [0]
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "ArrowLeft",
        ctrlKey: true,
        bubbles: true,
      }),
    );
    expect(useTerminalStore.getState().focusedPath).toEqual([0]);
  });

  it("toggles workspace launcher modal on Ctrl+N or Cmd+N", () => {
    useTerminalStore.setState({ isWorkspaceLauncherOpen: false });
    render(<App />);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "n", ctrlKey: true, bubbles: true }),
    );
    expect(useTerminalStore.getState().isWorkspaceLauncherOpen).toBe(true);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "n", ctrlKey: true, bubbles: true }),
    );
    expect(useTerminalStore.getState().isWorkspaceLauncherOpen).toBe(false);
  });

  it("renders WorkspaceSetupWizard when active tab is a wizard tab", () => {
    useTerminalStore.setState({
      tabs: [
        {
          id: "tab-wizard",
          title: "New Workspace",
          isWizard: true,
          layout: { type: "leaf", id: "" },
          focusedPath: [],
        },
      ],
      activeTabId: "tab-wizard",
    });
    const { getByRole } = render(<App />);

    expect(getByRole("region", { name: /workspace setup wizard/i })).toBeTruthy();
  });
});
