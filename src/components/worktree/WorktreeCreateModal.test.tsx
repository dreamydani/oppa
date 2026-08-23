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
onGitChanged: vi.fn().mockResolvedValue(() => {}),
  onTitleChanged: vi.fn().mockResolvedValue(() => {}),
  onFocusRequested: vi.fn().mockResolvedValue(() => {}),
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
  ptyList: vi.fn().mockResolvedValue([]),
  agentProfiles: vi.fn().mockResolvedValue([]),
  worktreeCreateAgent: vi.fn(),
}));

const worktreeCreateMock = vi.mocked(transport.worktreeCreate);
const worktreeCreateAgentMock = vi.mocked(transport.worktreeCreateAgent);
const agentProfilesMock = vi.mocked(transport.agentProfiles);
const ptyListMock = vi.mocked(transport.ptyList);
const repoListMock = vi.mocked(transport.repoList);
const repoAddMock = vi.mocked(transport.repoAdd);

const demoProfiles: transport.AgentProfile[] = [
  { id: "claude", displayName: "Claude Code", promptDelivery: "arg" },
  { id: "qwen", displayName: "Qwen Code", promptDelivery: "stdin" },
  { id: "generic", displayName: "Custom command", promptDelivery: "arg" },
];

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
    agentProfilesMock.mockResolvedValue(demoProfiles);
    ptyListMock.mockResolvedValue([]);
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

  it("renders real agent profiles with a No-agent default", async () => {
    render(<WorktreeCreateModal />);

    const select = await screen.findByRole("combobox", { name: /agent/i });
    expect(select.hasAttribute("disabled")).toBe(false);
    await vi.waitFor(() => {
      expect(agentProfilesMock).toHaveBeenCalled();
    });
    expect(screen.getByRole("option", { name: /no agent/i })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Claude Code" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Qwen Code" })).toBeTruthy();
    expect(select.textContent).toContain("Custom command");
  });

  it("reveals the first-prompt field only when an agent is selected", async () => {
    render(<WorktreeCreateModal />);

    expect(screen.queryByLabelText(/first prompt/i)).toBeNull();

    fireEvent.change(await screen.findByRole("combobox", { name: /agent/i }), {
      target: { value: "claude" },
    });
    expect(screen.getByLabelText(/first prompt/i)).toBeTruthy();

    fireEvent.change(screen.getByRole("combobox", { name: /agent/i }), {
      target: { value: "" },
    });
    expect(screen.queryByLabelText(/first prompt/i)).toBeNull();
  });

  it("custom-command profile reveals a command input instead of the prompt", async () => {
    render(<WorktreeCreateModal />);

    fireEvent.change(await screen.findByRole("combobox", { name: /agent/i }), {
      target: { value: "generic" },
    });

    expect(screen.getByLabelText(/^command$/i)).toBeTruthy();
    expect(screen.queryByLabelText(/first prompt/i)).toBeNull();
  });

  it("submits the handoff branch and opens the returned agent session", async () => {
    const record = createdRecord();
    worktreeCreateAgentMock.mockResolvedValue({ record, session_id: "agent-1" });
    ptyListMock.mockResolvedValue(["agent-1"]);
    vi.mocked(transport.ptySpawn).mockResolvedValue({
      id: "agent-1",
      is_new: false,
      snapshot: null,
    });

    render(<WorktreeCreateModal />);

    fireEvent.change(await screen.findByRole("combobox", { name: /repository/i }), {
      target: { value: demoRepo.path },
    });
    fireEvent.change(screen.getByLabelText(/worktree name/i), {
      target: { value: "feat-a" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: /agent/i }), {
      target: { value: "claude" },
    });
    fireEvent.change(screen.getByLabelText(/first prompt/i), {
      target: { value: "ship it" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^create worktree$/i }));

    await vi.waitFor(() => {
      expect(worktreeCreateAgentMock).toHaveBeenCalledWith({
        repoPath: demoRepo.path,
        name: "feat-a",
        baseRef: undefined,
        parentWorktreeId: undefined,
        agent: "claude",
        prompt: "ship it",
      });
    });
    expect(worktreeCreateMock).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(useTerminalStore.getState().isWorktreeCreateOpen).toBe(false);
    });
    // Terminal must bind the daemon's session id directly
    const spawnCalls = vi.mocked(transport.ptySpawn).mock.calls;
    expect(spawnCalls[0][0]?.id).toBe("agent-1");
    expect(spawnCalls[0][0]?.cwd).toBe(record.path);
    expect(spawnCalls[0][0]?.worktreeId).toBe(record.id);
  });

  it("generic profile submits the handoff with a raw command and no agent id", async () => {
    worktreeCreateAgentMock.mockResolvedValue({
      record: createdRecord(),
      session_id: "agent-2",
    });

    render(<WorktreeCreateModal />);

    fireEvent.change(await screen.findByRole("combobox", { name: /repository/i }), {
      target: { value: demoRepo.path },
    });
    fireEvent.change(screen.getByLabelText(/worktree name/i), {
      target: { value: "feat-a" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: /agent/i }), {
      target: { value: "generic" },
    });
    fireEvent.change(screen.getByLabelText(/^command$/i), {
      target: { value: "my-agent --yolo" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^create worktree$/i }));

    await vi.waitFor(() => {
      expect(worktreeCreateAgentMock).toHaveBeenCalledWith({
        repoPath: demoRepo.path,
        name: "feat-a",
        baseRef: undefined,
        parentWorktreeId: undefined,
        agent: undefined,
        prompt: undefined,
        command: "my-agent --yolo",
      });
    });
  });

  it("blocks custom-command submission without a command line", async () => {
    render(<WorktreeCreateModal />);

    fireEvent.change(await screen.findByRole("combobox", { name: /repository/i }), {
      target: { value: demoRepo.path },
    });
    fireEvent.change(screen.getByLabelText(/worktree name/i), {
      target: { value: "feat-a" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: /agent/i }), {
      target: { value: "generic" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^create worktree$/i }));

    await vi.waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/enter a command/i);
    });
    expect(worktreeCreateAgentMock).not.toHaveBeenCalled();
  });

  it("surfaces handoff server errors instead of closing", async () => {
    worktreeCreateAgentMock.mockRejectedValue(
      "agent executable not found on PATH: claude",
    );

    render(<WorktreeCreateModal />);

    fireEvent.change(await screen.findByRole("combobox", { name: /repository/i }), {
      target: { value: demoRepo.path },
    });
    fireEvent.change(screen.getByLabelText(/worktree name/i), {
      target: { value: "feat-a" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: /agent/i }), {
      target: { value: "claude" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^create worktree$/i }));

    await vi.waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/not found on PATH/);
    });
    expect(useTerminalStore.getState().isWorktreeCreateOpen).toBe(true);
  });
});
