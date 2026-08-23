import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { WorktreeCreateModal } from "./WorktreeCreateModal";
import { useTerminalStore } from "../../store/terminalStore";
import * as transport from "../../lib/pty/transport";
import type { WorktreeRecord, RepoRecord } from "../../lib/pty/transport";

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
  onPtyCwd: vi.fn(),
  onWorktreeChanged: vi.fn().mockResolvedValue(() => {}),
  worktreeList: vi.fn().mockResolvedValue([]),
  worktreePs: vi.fn().mockResolvedValue([]),
  worktreeCreate: vi.fn(),
  worktreeSet: vi.fn().mockResolvedValue(null),
  worktreeShow: vi.fn().mockResolvedValue(null),
  worktreeCurrent: vi.fn().mockResolvedValue(null),
  worktreeRemove: vi.fn().mockResolvedValue(undefined),
  worktreePurge: vi.fn().mockResolvedValue(undefined),
  worktreeLineage: vi.fn().mockResolvedValue([]),
  repoAdd: vi.fn().mockResolvedValue([]),
  repoList: vi.fn().mockResolvedValue([]),
}));

const worktreeCreateMock = vi.mocked(transport.worktreeCreate);
const repoListMock = vi.mocked(transport.repoList);
const repoAddMock = vi.mocked(transport.repoAdd);

const demoRepo: RepoRecord = {
  repo_id: "demo",
  path: "C:/repos/demo",
  default_base_ref: "main",
  worktree_base_path: null,
};

function createdRecord(): WorktreeRecord {
  return {
    id: "demo::C:/repos/demo-workspaces/feat-a",
    repo_id: "demo",
    name: "feat-a",
    display_name: null,
    branch: "feat-a",
    path: "C:/repos/demo-workspaces/feat-a",
    base_ref: "main",
    parent_worktree_id: null,
    child_worktree_ids: [],
    workspace_status: "todo",
    retired: false,
    created_at_ms: 1723900000000,
    linked_pr_url: null,
  };
}

describe("WorktreeCreateModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repoListMock.mockResolvedValue([demoRepo]);
    useTerminalStore.setState({
      isWorktreeCreateOpen: true,
      repos: [demoRepo],
      leftSidebarView: "tabs",
      tabs: [],
      activeTabId: "",
      sessions: {},
      layout: { type: "leaf", id: "" },
      focusedPath: [],
      ready: true,
      settings: useTerminalStore.getState().settings,
    });
  });

  it("lists registered repos in the picker", async () => {
    render(<WorktreeCreateModal />);

    await vi.waitFor(() => {
      expect(screen.getByRole("combobox", { name: /repository/i }).textContent).toContain(
        "C:/repos/demo",
      );
    });
  });

  it("adds an unregistered repo path and selects it", async () => {
    const freshRepo: RepoRecord = { ...demoRepo, repo_id: "fresh", path: "C:/repos/fresh" };
    repoAddMock.mockResolvedValue([freshRepo]);
    repoListMock.mockResolvedValue([demoRepo, freshRepo]);

    render(<WorktreeCreateModal />);

    fireEvent.click(await screen.findByRole("button", { name: /\+ add repo/i }));
    const input = screen.getByLabelText(/repository path/i);
    fireEvent.change(input, { target: { value: "C:/repos/fresh" } });
    fireEvent.click(screen.getByRole("button", { name: /^register$/i }));

    await vi.waitFor(() => {
      expect(repoAddMock).toHaveBeenCalledWith("C:/repos/fresh");
    });
    await vi.waitFor(() => {
      const select = screen.getByRole("combobox", { name: /repository/i }) as HTMLSelectElement;
      expect(select.value).toBe("C:/repos/fresh");
    });
  });

  it("creates the worktree, switches to the worktrees view, and opens a bound terminal", async () => {
    worktreeCreateMock.mockResolvedValue(createdRecord());

    render(<WorktreeCreateModal />);

    const repoSelect = await screen.findByRole("combobox", { name: /repository/i });
    fireEvent.change(repoSelect, { target: { value: demoRepo.path } });
    fireEvent.change(screen.getByLabelText(/worktree name/i), {
      target: { value: "feat-a" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^create worktree$/i }));

    await vi.waitFor(() => {
      expect(worktreeCreateMock).toHaveBeenCalledWith({
        repoPath: demoRepo.path,
        name: "feat-a",
        baseRef: undefined,
        parentWorktreeId: undefined,
      });
    });
    await vi.waitFor(() => {
      expect(useTerminalStore.getState().leftSidebarView).toBe("worktrees");
      expect(useTerminalStore.getState().isWorktreeCreateOpen).toBe(false);
    });
    // Terminal must be bound to the new worktree id, not just its cwd
    await vi.waitFor(() => {
      const spawnCalls = vi.mocked(transport.ptySpawn).mock.calls;
      expect(spawnCalls.length).toBeGreaterThan(0);
      const args = spawnCalls[0][0];
      expect(args?.cwd).toBe(createdRecord().path);
      expect(args?.worktreeId).toBe(createdRecord().id);
    });
  });

  it("surfaces server validation errors instead of closing", async () => {
    worktreeCreateMock.mockRejectedValue("worktree name already in use");

    render(<WorktreeCreateModal />);

    const repoSelect = await screen.findByRole("combobox", { name: /repository/i });
    fireEvent.change(repoSelect, { target: { value: demoRepo.path } });
    fireEvent.change(screen.getByLabelText(/worktree name/i), {
      target: { value: "feat-a" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^create worktree$/i }));

    await vi.waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/name already in use/);
    });
    expect(useTerminalStore.getState().isWorktreeCreateOpen).toBe(true);
  });

  it("shows the deferred agent launcher placeholder", async () => {
    render(<WorktreeCreateModal />);

    const agentSelect = await screen.findByRole("combobox", { name: /agent/i });
    expect(agentSelect.hasAttribute("disabled")).toBe(true);
    expect(agentSelect.textContent).toMatch(/task 12/i);
  });
});
