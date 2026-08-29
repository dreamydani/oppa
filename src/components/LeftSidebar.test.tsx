import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { LeftSidebar } from "./LeftSidebar";
import { useTerminalStore } from "../store/terminalStore";
import {
  setFrameSchedulerForTests,
  resetFrameSchedulerForTests,
} from "../lib/layout/frameScheduler";
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
  onPtyCwd: vi.fn(),
  onWorktreeChanged: vi.fn().mockResolvedValue(() => {}),
  onGitChanged: vi.fn().mockResolvedValue(() => {}),
  onPrChanged: vi.fn().mockResolvedValue(() => {}),
  requestReviewEligibility: vi.fn().mockResolvedValue({ eligible: true, blocked_reason: null, base_ref: 'main', owner_repo: 'owner/repo', existing_pr_url: null }),
  requestCreateReview: vi.fn().mockResolvedValue({ pr_url: 'https://example.com/pr/1', pr_number: 1, base_ref: 'main', owner_repo: 'owner/repo' }),
  requestReviewStatus: vi.fn().mockResolvedValue({ number: 1, title: 't', url: 'https://example.com/pr/1', state: 'open', draft: false, mergeable: 'unknown', base_ref_name: 'main', head_ref_name: 'feat', checks: [], fetched_at_ms: 0 }),
  onTitleChanged: vi.fn().mockResolvedValue(() => {}),
  onFocusRequested: vi.fn().mockResolvedValue(() => {}),
  onSessionWorking: vi.fn().mockResolvedValue(() => {}),
  onAgentStatus: vi.fn().mockResolvedValue(() => {}),
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

const ptySpawnMock = vi.mocked(transport.ptySpawn);

describe("LeftSidebar", () => {
  // Deterministic frame pump for drag coalescing.
  let frameQueue: Array<() => void>;
  function pumpFrames() {
    const q = frameQueue;
    frameQueue = [];
    for (const cb of q) cb();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    frameQueue = [];
    setFrameSchedulerForTests((cb) => {
      frameQueue.push(cb);
    });
    ptySpawnMock.mockResolvedValue({ id: "s-new", is_new: true, pid: 100 });
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

  afterEach(() => {
    resetFrameSchedulerForTests();
  });

  it("renders search strip and workspace cards", () => {
    const { container } = render(<LeftSidebar />);

    expect(screen.getByPlaceholderText(/search workspaces/i)).toBeDefined();
    expect(screen.getByTitle("New Workspace")).toBeDefined();
    expect(screen.getByText("oppa-alpha")).toBeDefined();
    expect(screen.getByText("oppa-beta")).toBeDefined();
    expect(container.querySelectorAll(".ws-card").length).toBe(2);
  });

  it("shows the active workspace's terminal rows; collapsed workspaces hide theirs", () => {
    render(<LeftSidebar />);

    // Active workspace (alpha) is expanded: its terminal row shows (title
    // falls back to the cwd basename when the session title is synthetic).
    expect(screen.getByText("repo-root")).toBeDefined();
    // Beta is collapsed: its row is hidden.
    expect(screen.queryByText("service-app")).toBeNull();
  });

  it("selects a workspace when its card header is clicked", () => {
    render(<LeftSidebar />);

    const betaHeader = screen.getByText("oppa-beta").closest(".ws-card-header")!;
    fireEvent.click(betaHeader);

    expect(useTerminalStore.getState().activeTabId).toBe("tab-beta");
  });

  it("creates and activates wizard tab when + button is clicked", () => {
    render(<LeftSidebar />);

    const addBtn = screen.getByTitle("New Workspace");
    fireEvent.click(addBtn);

    const state = useTerminalStore.getState();
    expect(state.tabs).toHaveLength(3);
    expect(state.tabs[2].isWizard).toBe(true);
    expect(state.activeTabId).toBe(state.tabs[2].id);
  });

  it("renders wizard tab with New Workspace title", () => {
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

    render(<LeftSidebar />);
    expect(screen.getByText("New Workspace")).toBeDefined();
  });

  it("closes a workspace when close button is clicked", async () => {
    render(<LeftSidebar />);

    const closeBtns = screen.getAllByTitle("Close Workspace");
    expect(closeBtns.length).toBe(2);

    fireEvent.click(closeBtns[1]);

    await vi.waitFor(() => {
      expect(useTerminalStore.getState().tabs).toHaveLength(1);
      expect(useTerminalStore.getState().tabs[0].id).toBe("tab-alpha");
    });
  });

  it("resizes sidebar when drag handle is moved", () => {
    const { container } = render(<LeftSidebar />);
    const resizeHandle = container.querySelector(".resize-handle-right")!;
    expect(resizeHandle).toBeDefined();

    fireEvent.mouseDown(resizeHandle, { clientX: 240 });

    fireEvent.mouseMove(window, { clientX: 300 });
    pumpFrames(); // coalescer commits on frame
    expect(useTerminalStore.getState().leftSidebarWidth).toBe(300);

    fireEvent.mouseMove(window, { clientX: 500 });
    pumpFrames();
    expect(useTerminalStore.getState().leftSidebarWidth).toBe(420);

    fireEvent.mouseMove(window, { clientX: 100 });
    pumpFrames();
    expect(useTerminalStore.getState().leftSidebarWidth).toBe(200);

    fireEvent.mouseUp(window);
  });

  it("renders empty state when there are no workspaces open", () => {
    useTerminalStore.setState({
      tabs: [],
      activeTabId: "",
      sessions: {},
      layout: { type: "leaf", id: "" },
    });

    render(<LeftSidebar />);

    expect(screen.getByText("No Workspaces")).toBeDefined();
    expect(screen.getByText("No project workspaces open.")).toBeDefined();
    // The empty state's own New Workspace button (header + is also present).
    const newWorkspaceBtn = screen.getAllByRole("button", { name: /new workspace/i })[0];
    expect(newWorkspaceBtn).toBeDefined();

    fireEvent.click(newWorkspaceBtn);
    const tabs = useTerminalStore.getState().tabs;
    expect(tabs.length).toBe(1);
    expect(tabs[0].isWizard).toBe(true);
  });

  it("renders No Matches state when search query does not match any workspace", () => {
    render(<LeftSidebar />);

    const searchInput = screen.getByPlaceholderText(/search workspaces/i);
    fireEvent.change(searchInput, { target: { value: "nonexistent-query" } });

    expect(screen.getByText("No Matches")).toBeDefined();
  });

  it("renders sidebar footer with settings and shortcuts buttons", () => {
    const { container } = render(<LeftSidebar />);
    const footer = container.querySelector(".left-sidebar-footer");
    expect(footer).not.toBeNull();

    const settingsBtn = screen.getByRole("button", { name: "Settings" });
    expect(settingsBtn).toBeDefined();
    expect(settingsBtn.getAttribute("title")).toBe("Settings (Ctrl+, / Cmd+,)");

    const shortcutsBtn = screen.getByRole("button", { name: "Keyboard Shortcuts" });
    expect(shortcutsBtn).toBeDefined();
    expect(shortcutsBtn.getAttribute("title")).toBe("Keyboard Shortcuts (F1 / Ctrl+/)");
  });

  it("opens settings tab when settings button is clicked", () => {
    render(<LeftSidebar />);

    const settingsBtn = screen.getByRole("button", { name: "Settings" });
    fireEvent.click(settingsBtn);

    const state = useTerminalStore.getState();
    expect(state.isSettingsOpen).toBe(true);
    expect(state.activeSettingsTab).toBe("general");
  });

  it("opens shortcuts settings tab when shortcuts button is clicked", () => {
    render(<LeftSidebar />);

    const shortcutsBtn = screen.getByRole("button", { name: "Keyboard Shortcuts" });
    fireEvent.click(shortcutsBtn);

    const state = useTerminalStore.getState();
    expect(state.isSettingsOpen).toBe(true);
    expect(state.activeSettingsTab).toBe("shortcuts");
  });

  it("clears search query when clear button is clicked", () => {
    render(<LeftSidebar />);

    const searchInput = screen.getByPlaceholderText(/search workspaces/i) as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: "test" } });
    expect(searchInput.value).toBe("test");

    const clearBtn = screen.getByRole("button", { name: /clear search/i });
    expect(clearBtn).toBeDefined();

    fireEvent.click(clearBtn);
    expect(searchInput.value).toBe("");
  });

  it("displays live session count status in the footer", () => {
    const { container } = render(<LeftSidebar />);
    const statusText = container.querySelector(".sidebar-status-text");
    expect(statusText?.textContent).toBe("2 live");
  });

  it("shows the search shortcut hint only while the search box is empty", () => {
    const { container } = render(<LeftSidebar />);
    expect(container.querySelector(".sidebar-search-hint")).not.toBeNull();

    const searchInput = screen.getByPlaceholderText(/search workspaces/i);
    fireEvent.change(searchInput, { target: { value: "test" } });

    expect(container.querySelector(".sidebar-search-hint")).toBeNull();
  });

  it("focuses search input when Ctrl+K is pressed", () => {
    render(<LeftSidebar />);
    const searchInput = screen.getByPlaceholderText(/search workspaces/i);

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(document.activeElement).toBe(searchInput);
  });

  it("keeps a closed sidebar mounted, hidden via the drawer instead of unmounting", () => {
    useTerminalStore.setState({ leftSidebarOpen: false });
    const { container } = render(<LeftSidebar />);
    const aside = container.querySelector("aside.left-sidebar");
    expect(aside).not.toBeNull();
    // Drawer snap path (pre-boot suppression in tests): detached + hidden.
    expect((aside as HTMLElement).style.visibility).toBe("hidden");
    expect((aside as HTMLElement).style.position).toBe("absolute");
  });
});

