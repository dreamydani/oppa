import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, within, act } from "@testing-library/react";
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
  onWorktreeChanged: vi.fn().mockResolvedValue(() => {}),
onGitChanged: vi.fn().mockResolvedValue(() => {}),
  onPrChanged: vi.fn().mockResolvedValue(() => {}),
  requestReviewEligibility: vi.fn().mockResolvedValue({ eligible: true, blocked_reason: null, base_ref: 'main', owner_repo: 'owner/repo', existing_pr_url: null }),
  requestCreateReview: vi.fn().mockResolvedValue({ pr_url: 'https://example.com/pr/1', pr_number: 1, base_ref: 'main', owner_repo: 'owner/repo' }),
  requestReviewStatus: vi.fn().mockResolvedValue({ number: 1, title: 't', url: 'https://example.com/pr/1', state: 'open', draft: false, mergeable: 'unknown', base_ref_name: 'main', head_ref_name: 'feat', checks: [], fetched_at_ms: 0 }),
  onTitleChanged: vi.fn().mockResolvedValue(() => {}),
  onFocusRequested: vi.fn().mockResolvedValue(() => {}),
  worktreeList: vi.fn().mockResolvedValue([]),
  worktreePs: vi.fn().mockResolvedValue([]),
  worktreeCreate: vi.fn(),
  worktreeSet: vi.fn().mockResolvedValue(null),
  worktreeRemove: vi.fn().mockResolvedValue(undefined),
  worktreePurge: vi.fn().mockResolvedValue(undefined),
  repoAdd: vi.fn().mockResolvedValue([]),
  repoList: vi.fn().mockResolvedValue([]),
  ptyList: vi.fn().mockResolvedValue([]),
  agentProfiles: vi.fn().mockResolvedValue([]),
  worktreeCreateAgent: vi.fn(),
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
  readFile: vi.fn().mockResolvedValue(""),
  writeFile: vi.fn(),
  createFile: vi.fn().mockResolvedValue(undefined),
  createDir: vi.fn().mockResolvedValue(true),
  detectEditors: vi.fn().mockResolvedValue([]),
  openWith: vi.fn().mockResolvedValue(true),
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
      activeAppMode: "terminal",
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

  it("renders status bar footer and soft edge curves in app layout", () => {
    const { getByRole, container } = render(<App />);

    expect(getByRole("contentinfo")).not.toBeNull();
    expect(container.querySelector(".status-bar")).not.toBeNull();
    expect(container.querySelector(".soft-edge-left")).not.toBeNull();
    expect(container.querySelector(".soft-edge-right")).not.toBeNull();
  });

  it("keeps sidebars mounted but drawer-hidden when store says closed", () => {
    useTerminalStore.setState({
      leftSidebarOpen: false,
      rightSidebarOpen: false,
    });

    const { container } = render(<App />);

    expect(container.querySelector(".app-container")).not.toBeNull();
    expect(container.querySelector(".title-bar")).not.toBeNull();
    expect(container.querySelector(".workspace-container")).not.toBeNull();
    const left = container.querySelector(".left-sidebar") as HTMLElement | null;
    expect(left).not.toBeNull();
    expect(left!.style.visibility).toBe("hidden");
    expect(container.querySelector(".main-viewport")).not.toBeNull();
    expect(container.querySelector(".pane-root")).not.toBeNull();
    const right = container.querySelector(".right-sidebar") as HTMLElement | null;
    expect(right).not.toBeNull();
    expect(right!.style.visibility).toBe("hidden");
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

  it("triggers Alt+Shift+Arrows directional pane swapping shortcuts", () => {
    const splitLayout: any = {
      type: "split",
      dir: "h",
      ratio: 0.5,
      a: { type: "leaf", id: "s1" },
      b: {
        type: "split",
        dir: "v",
        ratio: 0.5,
        a: { type: "leaf", id: "s2" },
        b: { type: "leaf", id: "s3" },
      },
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
        s3: { id: "s3", title: "s3", status: "running", cols: 80, rows: 24 },
      },
    });

    render(<App />);

    // Alt+Shift+ArrowRight -> swaps s1 (left) with s2 (right top)
    const eventRight = new KeyboardEvent("keydown", {
      key: "ArrowRight",
      altKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(eventRight);
    expect(eventRight.defaultPrevented).toBe(true);

    const layoutAfterRight = useTerminalStore.getState().layout as any;
    expect(layoutAfterRight.a.id).toBe("s2");
    expect(layoutAfterRight.b.a.id).toBe("s1");
    expect(useTerminalStore.getState().focusedPath).toEqual([1, 0]);

    // Alt+Shift+ArrowDown -> swaps s1 at [1, 0] with s3 at [1, 1]
    const eventDown = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      altKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(eventDown);
    expect(eventDown.defaultPrevented).toBe(true);

    const layoutAfterDown = useTerminalStore.getState().layout as any;
    expect(layoutAfterDown.b.a.id).toBe("s3");
    expect(layoutAfterDown.b.b.id).toBe("s1");
    expect(useTerminalStore.getState().focusedPath).toEqual([1, 1]);

    // Alt+Shift+ArrowUp -> swaps s1 at [1, 1] back with s3 at [1, 0]
    const eventUp = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      altKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(eventUp);
    expect(eventUp.defaultPrevented).toBe(true);

    const layoutAfterUp = useTerminalStore.getState().layout as any;
    expect(layoutAfterUp.b.a.id).toBe("s1");
    expect(layoutAfterUp.b.b.id).toBe("s3");
    expect(useTerminalStore.getState().focusedPath).toEqual([1, 0]);

    // Alt+Shift+ArrowLeft -> swaps s1 at [1, 0] back with s2 at [0]
    const eventLeft = new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      altKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(eventLeft);
    expect(eventLeft.defaultPrevented).toBe(true);

    const layoutAfterLeft = useTerminalStore.getState().layout as any;
    expect(layoutAfterLeft.a.id).toBe("s1");
    expect(layoutAfterLeft.b.a.id).toBe("s2");
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

  it("navigates to WorkspaceSetupWizard when clicking the + button in left sidebar with existing tabs", () => {
    useTerminalStore.setState({
      tabs: [
        { id: "tab-1", title: "fixing", layout: { type: "leaf", id: "s1" }, focusedPath: [] },
        { id: "tab-2", title: "taste-skills", layout: { type: "leaf", id: "s2" }, focusedPath: [] },
      ],
      activeTabId: "tab-2",
      ready: true,
      leftSidebarOpen: true,
      activeAppMode: "terminal",
      sessions: {
        s1: { id: "s1", title: "s1", status: "running", cols: 80, rows: 24 },
        s2: { id: "s2", title: "s2", status: "running", cols: 80, rows: 24 },
      },
    });
    const { getByRole, getByTitle } = render(<App />);

    const newTabBtn = getByTitle("New Tab");
    fireEvent.click(newTabBtn);

    expect(getByRole("region", { name: /workspace setup wizard/i })).toBeTruthy();
  });

  it("renders BrowserViewport when switching to browser mode while wizard tab is open", () => {
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
      activeAppMode: "browser",
      leftSidebarOpen: true,
      ready: true,
    });
    const { container } = render(<App />);

    expect(container.querySelector(".main-viewport .browser-viewport")).not.toBeNull();
    const browserWrapper = container.querySelector(".browser-viewport-view") as HTMLElement;
    const terminalWrapper = container.querySelector(".terminal-viewport-view") as HTMLElement;
    expect(browserWrapper.style.display).toBe("flex");
    expect(terminalWrapper.style.display).toBe("none");
  });

  it("renders BrowserViewport in main-viewport when activeAppMode is 'browser' and hides sidebars", () => {
    useTerminalStore.setState({
      activeAppMode: "browser",
      leftSidebarOpen: true,
      rightSidebarOpen: true,
    });
    const { container } = render(<App />);

    expect(container.querySelector(".main-viewport .browser-viewport")).not.toBeNull();
    const browserWrapper = container.querySelector(".browser-viewport-view") as HTMLElement;
    const terminalWrapper = container.querySelector(".terminal-viewport-view") as HTMLElement;
    expect(browserWrapper.style.display).toBe("flex");
    expect(terminalWrapper.style.display).toBe("none");
    expect(container.querySelector(".left-sidebar")).toBeNull();
    expect(container.querySelector(".right-sidebar")).toBeNull();
  });

  it("switches between terminal PaneSplit and BrowserViewport when mode changes and toggles sidebars", async () => {
    useTerminalStore.setState({
      activeAppMode: "terminal",
      leftSidebarOpen: true,
      rightSidebarOpen: true,
    });
    const { container } = render(<App />);

    const browserWrapper = container.querySelector(".browser-viewport-view") as HTMLElement;
    const terminalWrapper = container.querySelector(".terminal-viewport-view") as HTMLElement;
    expect(terminalWrapper.style.display).toBe("flex");
    expect(browserWrapper.style.display).toBe("none");
    expect(container.querySelector(".left-sidebar")).not.toBeNull();

    // Switch to browser
    useTerminalStore.getState().setAppMode("browser");

    await vi.waitFor(() => {
      expect(browserWrapper.style.display).toBe("flex");
      expect(terminalWrapper.style.display).toBe("none");
      expect(container.querySelector(".left-sidebar")).toBeNull();
    });

    // Switch back to terminal
    useTerminalStore.getState().setAppMode("terminal");

    await vi.waitFor(() => {
      expect(terminalWrapper.style.display).toBe("flex");
      expect(browserWrapper.style.display).toBe("none");
      expect(container.querySelector(".left-sidebar")).not.toBeNull();
    });
  });

  it("renders EditorViewport in main-viewport when activeAppMode is 'editor'", () => {
    useTerminalStore.setState({
      activeAppMode: "editor",
      leftSidebarOpen: true,
      rightSidebarOpen: true,
    });
    const { container } = render(<App />);

    expect(container.querySelector(".main-viewport .editor-viewport")).not.toBeNull();
    const editorWrapper = container.querySelector(".editor-viewport-view") as HTMLElement;
    const terminalWrapper = container.querySelector(".terminal-viewport-view") as HTMLElement;
    expect(editorWrapper.style.display).toBe("flex");
    expect(terminalWrapper.style.display).toBe("none");
    expect(container.querySelector(".left-sidebar")).not.toBeNull();
    expect(container.querySelector(".right-sidebar")).not.toBeNull();
  });

  it("switches between terminal PaneSplit and EditorViewport when mode changes", async () => {
    useTerminalStore.setState({
      activeAppMode: "terminal",
    });
    const { container } = render(<App />);

    const editorWrapper = container.querySelector(".editor-viewport-view") as HTMLElement;
    const terminalWrapper = container.querySelector(".terminal-viewport-view") as HTMLElement;
    expect(terminalWrapper.style.display).toBe("flex");
    expect(editorWrapper.style.display).toBe("none");

    // Switch to editor
    useTerminalStore.getState().setAppMode("editor");

    await vi.waitFor(() => {
      expect(editorWrapper.style.display).toBe("flex");
      expect(terminalWrapper.style.display).toBe("none");
    });

    // Switch back to terminal
    useTerminalStore.getState().setAppMode("terminal");

    await vi.waitFor(() => {
      expect(terminalWrapper.style.display).toBe("flex");
      expect(editorWrapper.style.display).toBe("none");
    });
  });

  it("renders empty workspace view when there are no active tabs/workspaces", () => {
    useTerminalStore.setState({
      tabs: [],
      activeTabId: "",
      sessions: {},
      layout: { type: "leaf", id: "" },
    });

    const createWizardTabSpy = vi.spyOn(useTerminalStore.getState(), "createWizardTab");

    const { container } = render(<App />);

    const emptyView = container.querySelector('[data-testid="empty-workspace-view"]');
    expect(emptyView).not.toBeNull();
    const emptyScope = within(emptyView as HTMLElement);

    expect(emptyScope.getByText("No Open Workspaces")).toBeTruthy();

    const newWorkspaceBtn = emptyScope.getByRole("button", { name: /New Workspace/i });
    expect(newWorkspaceBtn).toBeTruthy();
    expect(newWorkspaceBtn.getAttribute("aria-label")).toBe("New Workspace");

    expect(emptyScope.queryByRole("button", { name: /\+ New Terminal/i })).toBeNull();
    expect(emptyScope.queryByRole("button", { name: /Setup Wizard/i })).toBeNull();

    fireEvent.click(newWorkspaceBtn);
    expect(createWizardTabSpy).toHaveBeenCalledTimes(1);
  });

  it("renders SettingsView instead of workspace container when isSettingsOpen is true", () => {
    useTerminalStore.setState({
      isSettingsOpen: true,
      activeSettingsTab: "general",
    });

    const { container } = render(<App />);

    expect(container.querySelector(".settings-view")).not.toBeNull();
    expect(container.querySelector(".workspace-container")).toBeNull();
  });

  it("opens general settings with Ctrl+, shortcut", () => {
    useTerminalStore.setState({ isSettingsOpen: false });
    render(<App />);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: ",", ctrlKey: true, bubbles: true }),
    );

    expect(useTerminalStore.getState().isSettingsOpen).toBe(true);
    expect(useTerminalStore.getState().activeSettingsTab).toBe("general");
  });

  it("opens shortcuts reference with Ctrl+/ and F1 shortcuts", () => {
    useTerminalStore.setState({ isSettingsOpen: false });
    render(<App />);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "/", ctrlKey: true, bubbles: true }),
    );
    expect(useTerminalStore.getState().isSettingsOpen).toBe(true);
    expect(useTerminalStore.getState().activeSettingsTab).toBe("shortcuts");

    useTerminalStore.setState({ isSettingsOpen: false });

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "F1", bubbles: true }),
    );
    expect(useTerminalStore.getState().isSettingsOpen).toBe(true);
    expect(useTerminalStore.getState().activeSettingsTab).toBe("shortcuts");
  });

  it("closes settings on Escape key when isSettingsOpen is true", () => {
    useTerminalStore.setState({ isSettingsOpen: true });
    render(<App />);

    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );

    expect(useTerminalStore.getState().isSettingsOpen).toBe(false);
  });

  it("cycles tabs using MRU history when tabSwitchMode is 'mru'", () => {
    useTerminalStore.setState({
      tabs: [
        { id: "tab-1", layout: { type: "leaf", id: "s1" }, focusedPath: [] },
        { id: "tab-2", layout: { type: "leaf", id: "s2" }, focusedPath: [] },
        { id: "tab-3", layout: { type: "leaf", id: "s3" }, focusedPath: [] },
      ],
      activeTabId: "tab-3",
      tabFocusHistory: ["tab-3", "tab-1", "tab-2"],
      settings: {
        ...useTerminalStore.getState().settings,
        general: {
          ...useTerminalStore.getState().settings.general,
          tabSwitchMode: "mru",
        },
      },
    });

    render(<App />);

    // Ctrl+Tab: should switch from tab-3 to tab-1 (most recently active)
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, bubbles: true }),
    );
    expect(useTerminalStore.getState().activeTabId).toBe("tab-1");
  });

  it("triggers workspace launcher modal on startup when startupBehavior is workspace_launcher", async () => {
    useTerminalStore.setState({
      isWorkspaceLauncherOpen: false,
      settings: {
        ...useTerminalStore.getState().settings,
        general: {
          ...useTerminalStore.getState().settings.general,
          startupBehavior: "workspace_launcher",
        },
      },
    });

    render(<App />);

    await vi.waitFor(() => {
      expect(useTerminalStore.getState().isWorkspaceLauncherOpen).toBe(true);
    });
  });

  it("creates a fresh terminal tab on startup when startupBehavior is fresh_terminal and no tabs exist", async () => {
    useTerminalStore.setState({
      tabs: [],
      activeTabId: "",
      settings: {
        ...useTerminalStore.getState().settings,
        general: {
          ...useTerminalStore.getState().settings.general,
          startupBehavior: "fresh_terminal",
        },
      },
    });

    render(<App />);

    await vi.waitFor(() => {
      expect(useTerminalStore.getState().tabs.length).toBeGreaterThan(0);
    });
  });

  it("updates data-theme, uiZoom, and --font-sans on documentElement when appearance changes", () => {
    render(<App />);

    act(() => {
      useTerminalStore.getState().updateAppearanceSettings({
        appTheme: "light",
        uiZoom: 1.1,
        appFontFamily: "Inter, sans-serif",
      });
    });

    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.style.zoom).toBe("1.1");
    expect(document.documentElement.style.getPropertyValue("--font-sans")).toBe("Inter, sans-serif");

    act(() => {
      useTerminalStore.getState().updateAppearanceSettings({
        appTheme: "dark",
        uiZoom: 0.9,
        appFontFamily: "Geist, sans-serif",
      });
    });

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.style.zoom).toBe("0.9");
    expect(document.documentElement.style.getPropertyValue("--font-sans")).toBe("Geist, sans-serif");
  });

  it("resolves and tracks system media query when appTheme is system", () => {
    let matchMediaListener: ((e: { matches: boolean }) => void) | undefined;
    const addEventListenerMock = vi.fn((event: string, handler: any) => {
      if (event === "change") {
        matchMediaListener = handler;
      }
    });
    const removeEventListenerMock = vi.fn();

    let matchesDark = true;

    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: matchesDark,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: addEventListenerMock,
      removeEventListener: removeEventListenerMock,
      dispatchEvent: vi.fn(),
    }));

    const { unmount } = render(<App />);

    act(() => {
      useTerminalStore.getState().updateAppearanceSettings({
        appTheme: "system",
      });
    });

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(addEventListenerMock).toHaveBeenCalled();

    // Simulate system preference change to light
    matchesDark = false;
    act(() => {
      matchMediaListener?.({ matches: false });
    });
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");

    unmount();
    expect(removeEventListenerMock).toHaveBeenCalled();
  });

  it("renders StatusBar when showStatusBar is true", () => {
    useTerminalStore.setState({
      settings: {
        ...useTerminalStore.getState().settings,
        appearance: {
          ...useTerminalStore.getState().settings.appearance,
          showStatusBar: true,
        },
      },
    });
    const { container } = render(<App />);
    expect(container.querySelector(".status-bar")).not.toBeNull();
  });

  it("does not render StatusBar when showStatusBar is false", () => {
    useTerminalStore.setState({
      settings: {
        ...useTerminalStore.getState().settings,
        appearance: {
          ...useTerminalStore.getState().settings.appearance,
          showStatusBar: false,
        },
      },
    });
    const { container } = render(<App />);
    expect(container.querySelector(".status-bar")).toBeNull();
  });

  it("collapses left sidebar on initial load when sidebarOnLaunch is 'collapsed'", async () => {
    useTerminalStore.setState({
      leftSidebarOpen: true,
      settings: {
        ...useTerminalStore.getState().settings,
        appearance: {
          ...useTerminalStore.getState().settings.appearance,
          sidebarOnLaunch: "collapsed",
        },
      },
    });

    render(<App />);

    await vi.waitFor(() => {
      expect(useTerminalStore.getState().leftSidebarOpen).toBe(false);
    });
  });

  it("opens left sidebar on initial load when sidebarOnLaunch is 'open'", async () => {
    useTerminalStore.setState({
      leftSidebarOpen: false,
      settings: {
        ...useTerminalStore.getState().settings,
        appearance: {
          ...useTerminalStore.getState().settings.appearance,
          sidebarOnLaunch: "open",
        },
      },
    });

    render(<App />);

    await vi.waitFor(() => {
      expect(useTerminalStore.getState().leftSidebarOpen).toBe(true);
    });
  });

  it("preserves left sidebar state on initial load when sidebarOnLaunch is 'remember_last'", async () => {
    useTerminalStore.setState({
      leftSidebarOpen: false,
      settings: {
        ...useTerminalStore.getState().settings,
        appearance: {
          ...useTerminalStore.getState().settings.appearance,
          sidebarOnLaunch: "remember_last",
        },
      },
    });

    render(<App />);

    await vi.waitFor(() => {
      expect(useTerminalStore.getState().leftSidebarOpen).toBe(false);
    });
  });
});


