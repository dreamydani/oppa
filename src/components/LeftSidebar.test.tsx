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

  it("renders search strip and tab cards with avatar badges and no duplicate icon", () => {
    const { container } = render(<LeftSidebar />);

    expect(screen.getByPlaceholderText(/search tabs/i)).toBeDefined();
    expect(screen.getByTitle("New Tab")).toBeDefined();
    expect(screen.getByText("oppa-alpha")).toBeDefined();
    expect(screen.getByText("oppa-beta")).toBeDefined();
    // CWD is shortened to ~/last-two-segments
    expect(screen.getByText("~/projects/repo-root")).toBeDefined();
    expect(container.querySelectorAll(".tab-card-avatar").length).toBe(2);
    expect(container.querySelector(".tab-card-app-icon")).toBeNull();
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

  it("creates and activates wizard tab when + button is clicked", () => {
    render(<LeftSidebar />);

    const addBtn = screen.getByTitle("New Tab");
    fireEvent.click(addBtn);

    const state = useTerminalStore.getState();
    expect(state.tabs).toHaveLength(3);
    expect(state.tabs[2].isWizard).toBe(true);
    expect(state.activeTabId).toBe(state.tabs[2].id);
  });

  it("renders wizard tab with New Workspace title in tab card", () => {
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
    const newWorkspaceBtn = screen.getByRole("button", { name: /new workspace/i });
    expect(newWorkspaceBtn).toBeDefined();

    fireEvent.click(newWorkspaceBtn);
    const tabs = useTerminalStore.getState().tabs;
    expect(tabs.length).toBe(1);
    expect(tabs[0].isWizard).toBe(true);
  });

  it("renders No Matches state when search query does not match any workspace", () => {
    render(<LeftSidebar />);

    const searchInput = screen.getByPlaceholderText(/search tabs/i);
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

  it("toggles to the worktrees view and renders worktree cards", () => {
    useTerminalStore.setState({
      leftSidebarView: "tabs",
      worktrees: [
        {
          record: {
            id: "demo::C:/ws/feat-a",
            repo_id: "demo",
            name: "feat-a",
            display_name: null,
            branch: "feat-a",
            path: "C:/ws/feat-a",
            base_ref: "main",
            parent_worktree_id: null,
            child_worktree_ids: [],
            workspace_status: "todo",
            retired: false,
            created_at_ms: 1723900000000,
            linked_pr_url: null,
          },
          missing_on_disk: false,
        },
      ],
      worktreeLiveSessions: {},
    });

    render(<LeftSidebar />);

    expect(screen.queryByText("feat-a")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /worktrees/i }));

    expect(useTerminalStore.getState().leftSidebarView).toBe("worktrees");
    expect(screen.getAllByText("feat-a").length).toBeGreaterThan(0);
    expect(screen.getByText("Todo")).toBeDefined();
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

  it("exposes the store width via the --sidebar-w custom property", () => {
    const { container } = render(<LeftSidebar />);
    const aside = container.querySelector<HTMLElement>("aside.left-sidebar")!;
    expect(aside.style.getPropertyValue("--sidebar-w")).toBe("240px");
  });

  it("marks the sidebar as resizing during a drag and clears it on release", () => {
    const { container } = render(<LeftSidebar />);
    const aside = container.querySelector<HTMLElement>("aside.left-sidebar")!;
    const resizeHandle = container.querySelector(".resize-handle-right")!;

    fireEvent.mouseDown(resizeHandle, { clientX: 300, button: 0 });
    expect(aside.className).toContain("is-resizing");

    fireEvent.mouseUp(window);
    expect(aside.className).not.toContain("is-resizing");
  });
});
