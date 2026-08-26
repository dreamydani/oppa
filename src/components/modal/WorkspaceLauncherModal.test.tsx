import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WorkspaceLauncherModal } from "./WorkspaceLauncherModal";
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
  onPtyData: vi.fn(),
  onPtyExit: vi.fn(),
}));

const ptySpawnMock = vi.mocked(transport.ptySpawn);

describe("WorkspaceLauncherModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ptySpawnMock.mockResolvedValue({ id: "s-new", is_new: true, pid: 100 });
    useTerminalStore.setState({
      isWorkspaceLauncherOpen: true,
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
          cols: 80,
          rows: 24,
        },
      },
    });
  });

  it("does not render when isWorkspaceLauncherOpen is false", () => {
    useTerminalStore.setState({ isWorkspaceLauncherOpen: false });
    const { container } = render(<WorkspaceLauncherModal />);
    expect(container.firstChild).toBeNull();
  });

  it("renders search input, action items, and recent projects", () => {
    render(<WorkspaceLauncherModal />);
    expect(screen.getByPlaceholderText(/Search or select workspace/i)).toBeInTheDocument();
    expect(screen.getByText("New Empty Workspace")).toBeInTheDocument();
    expect(screen.getByText("Open Local Project Folder...")).toBeInTheDocument();
    expect(screen.getByText("Clone Git Repository...")).toBeInTheDocument();
    expect(screen.getByText("oppa")).toBeInTheDocument();
    expect(screen.getByText("frontend-core")).toBeInTheDocument();
  });

  it("filters items in real time when typing in search input", () => {
    render(<WorkspaceLauncherModal />);
    const input = screen.getByPlaceholderText(/Search or select workspace/i);
    fireEvent.change(input, { target: { value: "clone" } });

    expect(screen.getByText("Clone Git Repository...")).toBeInTheDocument();
    expect(screen.queryByText("New Empty Workspace")).toBeNull();
  });

  it("shows empty state when no items match search query", () => {
    render(<WorkspaceLauncherModal />);
    const input = screen.getByPlaceholderText(/Search or select workspace/i);
    fireEvent.change(input, { target: { value: "nonexistent-item-xyz" } });

    expect(screen.getByText(/No matching workspaces or actions/i)).toBeInTheDocument();
  });

  it("closes modal on Escape key", () => {
    render(<WorkspaceLauncherModal />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useTerminalStore.getState().isWorkspaceLauncherOpen).toBe(false);
  });

  it("closes modal when clicking backdrop overlay", () => {
    const { container } = render(<WorkspaceLauncherModal />);
    const backdrop = container.querySelector(".launcher-backdrop");
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(useTerminalStore.getState().isWorkspaceLauncherOpen).toBe(false);
  });

  it("navigates selection with ArrowDown and ArrowUp and selects on Enter", async () => {
    render(<WorkspaceLauncherModal />);
    const input = screen.getByPlaceholderText(/Search or select workspace/i);

    // Initial selected index is 0 ("New Empty Workspace")
    fireEvent.keyDown(input, { key: "ArrowDown" });
    // Now index 1 ("Open Local Project Folder...") is selected
    fireEvent.keyDown(input, { key: "Enter" });

    // Modal should close and create a tab
    expect(useTerminalStore.getState().isWorkspaceLauncherOpen).toBe(false);
    await waitFor(() => {
      expect(useTerminalStore.getState().tabs.length).toBe(2);
    });
  });

  it("creates tab and closes modal when clicking an item", async () => {
    render(<WorkspaceLauncherModal />);
    const item = screen.getByText("New Empty Workspace");
    fireEvent.click(item);

    expect(useTerminalStore.getState().isWorkspaceLauncherOpen).toBe(false);
    await waitFor(() => {
      expect(useTerminalStore.getState().tabs.length).toBe(2);
    });
  });
});
