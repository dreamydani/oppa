import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { FleetSpawnSheet } from "./FleetSpawnSheet";
import { useTerminalStore } from "../../store/terminalStore";
import * as transport from "../../lib/pty/transport";
import type { WorktreeRecord, RepoRecord, FleetSlotResult } from "../../lib/pty/transport";

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
  onPrChanged: vi.fn().mockResolvedValue(() => {}),
  onTitleChanged: vi.fn().mockResolvedValue(() => {}),
  onFocusRequested: vi.fn().mockResolvedValue(() => {}),
  onSessionWorking: vi.fn().mockResolvedValue(() => {}),
  onAgentStatus: vi.fn().mockResolvedValue(() => {}),
  requestReviewEligibility: vi.fn().mockResolvedValue({ eligible: true, blocked_reason: null, base_ref: 'main', owner_repo: 'owner/repo', existing_pr_url: null }),
  requestCreateReview: vi.fn().mockResolvedValue({ pr_url: 'https://example.com/pr/1', pr_number: 1, base_ref: 'main', owner_repo: 'owner/repo' }),
  requestReviewStatus: vi.fn().mockResolvedValue({ number: 1, title: 't', url: 'https://example.com/pr/1', state: 'open', draft: false, mergeable: 'unknown', base_ref_name: 'main', head_ref_name: 'feat', checks: [], fetched_at_ms: 0 }),
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
  worktreeCreateFleet: vi.fn(),
}));

const worktreeCreateFleetMock = vi.mocked(transport.worktreeCreateFleet);
const agentProfilesMock = vi.mocked(transport.agentProfiles);
const repoListMock = vi.mocked(transport.repoList);

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

function okSlot(index: number): FleetSlotResult {
  const stem = index === 0 ? "fix-login" : `fix-login-${index}`;
  const record: WorktreeRecord = {
    id: `demo::wt-${index}`,
    repo_id: "demo",
    name: stem,
    display_name: null,
    branch: stem,
    path: `C:/repos/demo-workspaces/${stem}-${index}`,
    base_ref: "main",
    parent_worktree_id: null,
    child_worktree_ids: [],
    workspace_status: "todo",
    retired: false,
    created_at_ms: 1723900000000,
    linked_pr_url: null,
  };
  return { index, ok: true, record, session_id: `agent-${index}`, error: null };
}

function failedSlot(index: number, error: string): FleetSlotResult {
  return { index, ok: false, record: null, session_id: null, error };
}

/** Select the agent on a slot row (rows are addressed 1-based in labels). */
function setSlotAgent(row: number, displayName: string) {
  fireEvent.change(screen.getByRole("combobox", { name: `Slot ${row} agent` }), {
    target: { value: valueForAgent(displayName) },
  });
}

function valueForAgent(displayName: string): string {
  const profile = demoProfiles.find((p) => p.displayName === displayName);
  if (!profile) throw new Error(`unknown profile ${displayName}`);
  return profile.id;
}

describe("FleetSpawnSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repoListMock.mockResolvedValue([demoRepo]);
    agentProfilesMock.mockResolvedValue(demoProfiles);
    useTerminalStore.setState({
      isFleetSheetOpen: true,
      fleetSheetPrefill: null,
      repos: [demoRepo],
      leftSidebarView: "worktrees",
      tabs: [],
      activeTabId: "",
      sessions: {},
      layout: { type: "leaf", id: "" },
      focusedPath: [],
      ready: true,
      settings: useTerminalStore.getState().settings,
    });
  });

  it("starts with two empty rows and enforces repo + non-empty-slot validation inline", async () => {
    render(<FleetSpawnSheet />);

    await vi.waitFor(() => {
      expect(screen.getAllByRole("combobox", { name: /slot \d+ agent/i })).toHaveLength(2);
    });

    // Empty repo rejected first
    fireEvent.click(screen.getByRole("button", { name: /review fleet/i }));
    expect(screen.getByRole("alert").textContent).toMatch(/pick a repository/i);
    expect(worktreeCreateFleetMock).not.toHaveBeenCalled();

    // Agent-less AND prompt-less slots rejected with an inline error
    fireEvent.change(screen.getByRole("combobox", { name: /repository/i }), {
      target: { value: demoRepo.path },
    });
    fireEvent.click(screen.getByRole("button", { name: /review fleet/i }));
    expect(screen.getByRole("alert").textContent).toMatch(/slot 1/i);
    expect(worktreeCreateFleetMock).not.toHaveBeenCalled();
  });

  it("lets prompt-less slots through once an agent is picked and gates launch behind Confirm", async () => {
    render(<FleetSpawnSheet />);

    fireEvent.change(await screen.findByRole("combobox", { name: /repository/i }), {
      target: { value: demoRepo.path },
    });
    setSlotAgent(1, "Claude Code");
    setSlotAgent(2, "Claude Code");

    fireEvent.click(screen.getByRole("button", { name: /review fleet/i }));

    // Summary panel appears; transport must stay untouched until Confirm
    const summary = await screen.findByRole("region", { name: /fleet summary/i });
    expect(summary.textContent).toMatch(/2 × Claude Code/i);
    expect(worktreeCreateFleetMock).not.toHaveBeenCalled();
  });

  it("launches exactly once with the exact payload incl. per-slot overrides after Confirm", async () => {
    worktreeCreateFleetMock.mockResolvedValue({
      results: [okSlot(0), okSlot(1)],
    });
    vi.mocked(transport.ptySpawn).mockResolvedValue({
      id: "agent-0",
      is_new: false,
      snapshot: null,
    });

    render(<FleetSpawnSheet />);

    fireEvent.change(await screen.findByRole("combobox", { name: /repository/i }), {
      target: { value: demoRepo.path },
    });
    fireEvent.change(screen.getByLabelText(/base ref/i), {
      target: { value: "develop" },
    });
    fireEvent.change(screen.getByLabelText(/shared prompt/i), {
      target: { value: "Ship quality" },
    });
    setSlotAgent(1, "Claude Code");
    setSlotAgent(2, "Claude Code");
    // Per-row prompt lives behind the collapsed toggle
    fireEvent.click(screen.getByRole("button", { name: /toggle prompt for slot 1/i }));
    fireEvent.change(screen.getByLabelText("Slot 1 prompt"), {
      target: { value: "Fix login flow" },
    });

    fireEvent.click(screen.getByRole("button", { name: /review fleet/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm launch/i }));

    await vi.waitFor(() => {
      expect(worktreeCreateFleetMock).toHaveBeenCalledTimes(1);
    });
    expect(worktreeCreateFleetMock).toHaveBeenCalledWith({
      repoPath: demoRepo.path,
      baseRef: "develop",
      sharedPrompt: "Ship quality",
      slots: [
        { name: null, agent: "claude", command: null, prompt: "Fix login flow" },
        { name: null, agent: "claude", command: null, prompt: null },
      ],
    });
  });

  it("renders per-slot outcomes from one partial-failure response and opens tabs for successes", async () => {
    worktreeCreateFleetMock.mockResolvedValue({
      results: [okSlot(0), failedSlot(1, "agent executable not found on PATH: qwen")],
    });
    vi.mocked(transport.ptySpawn).mockResolvedValue({
      id: "agent-0",
      is_new: false,
      snapshot: null,
    });

    render(<FleetSpawnSheet />);

    fireEvent.change(await screen.findByRole("combobox", { name: /repository/i }), {
      target: { value: demoRepo.path },
    });
    setSlotAgent(1, "Claude Code");
    setSlotAgent(2, "Qwen Code");
    fireEvent.click(screen.getByRole("button", { name: /review fleet/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm launch/i }));

    await vi.waitFor(() => {
      expect(
        screen.getByRole("button", { name: /spawned: fix-login/i }),
      ).toBeTruthy();
    });
    expect(screen.getByText(/not found on PATH/i)).toBeTruthy();

    // Exactly one tab spawn, bound to the successful slot's record
    await vi.waitFor(() => {
      const spawnCalls = vi.mocked(transport.ptySpawn).mock.calls;
      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0][0]?.id).toBe("agent-0");
      expect(spawnCalls[0][0]?.cwd).toBe("C:/repos/demo-workspaces/fix-login-0");
      expect(spawnCalls[0][0]?.worktreeId).toBe("demo::wt-0");
    });
  });

  it("honors sheet prefill for repo, base ref, and slot count", async () => {
    useTerminalStore.setState({
      isFleetSheetOpen: true,
      fleetSheetPrefill: { repoPath: demoRepo.path, baseRef: "v2", count: 3 },
    });

    render(<FleetSpawnSheet />);

    const repoSelect = (await screen.findByRole("combobox", {
      name: /repository/i,
    })) as HTMLSelectElement;
    expect(repoSelect.value).toBe(demoRepo.path);
    expect((screen.getByLabelText(/base ref/i) as HTMLInputElement).value).toBe("v2");
    await vi.waitFor(() => {
      expect(screen.getAllByRole("combobox", { name: /slot \d+ agent/i })).toHaveLength(3);
    });
  });

  it("closes the sheet when Done is clicked after completion", async () => {
    worktreeCreateFleetMock.mockResolvedValue({
      results: [okSlot(0), okSlot(1)],
    });
    vi.mocked(transport.ptySpawn).mockResolvedValue({
      id: "agent-0",
      is_new: false,
      snapshot: null,
    });

    render(<FleetSpawnSheet />);

    fireEvent.change(await screen.findByRole("combobox", { name: /repository/i }), {
      target: { value: demoRepo.path },
    });
    setSlotAgent(1, "Claude Code");
    setSlotAgent(2, "Claude Code");
    fireEvent.click(screen.getByRole("button", { name: /review fleet/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm launch/i }));

    fireEvent.click(await screen.findByRole("button", { name: /^done$/i }));
    expect(useTerminalStore.getState().isFleetSheetOpen).toBe(false);
  });

  it("caps slots at eight and never removes the last row", async () => {
    render(<FleetSpawnSheet />);

    await vi.waitFor(() => {
      expect(screen.getAllByRole("combobox", { name: /slot \d+ agent/i })).toHaveLength(2);
    });
    const addBtn = screen.getByRole("button", { name: /\+ add slot/i });
    for (let i = 0; i < 10; i += 1) fireEvent.click(addBtn);
    expect(screen.getAllByRole("combobox", { name: /slot \d+ agent/i })).toHaveLength(8);

    const removeButtons = screen.getAllByRole("button", { name: /remove slot/i });
    for (let i = 0; i < 7; i += 1) {
      fireEvent.click(screen.getAllByRole("button", { name: /remove slot/i })[0]);
    }
    expect(screen.getAllByRole("combobox", { name: /slot \d+ agent/i })).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "Remove slot 1" }),
    ).toBeNull();
    expect(removeButtons.length).toBeGreaterThan(0);
  });

  it("handles direct array responses from backend without map errors", async () => {
    // Backend commands return raw arrays (Vec<FleetSlotResult>)
    worktreeCreateFleetMock.mockResolvedValue([okSlot(0), okSlot(1)] as unknown as transport.FleetSpawnResult);
    vi.mocked(transport.ptySpawn).mockResolvedValue({
      id: "agent-0",
      is_new: false,
      snapshot: null,
    });

    render(<FleetSpawnSheet />);

    fireEvent.change(await screen.findByRole("combobox", { name: /repository/i }), {
      target: { value: demoRepo.path },
    });
    setSlotAgent(1, "Claude Code");
    setSlotAgent(2, "Claude Code");
    fireEvent.click(screen.getByRole("button", { name: /review fleet/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm launch/i }));

    await vi.waitFor(() => {
      expect(screen.getByRole("button", { name: /^done$/i })).toBeTruthy();
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("done phase offers Open grid with only successful slots and closes on success", async () => {
    worktreeCreateFleetMock.mockResolvedValue({
      results: [okSlot(0), failedSlot(1, "agent executable not found on PATH: qwen")],
    });
    vi.mocked(transport.ptySpawn).mockResolvedValue({
      id: "agent-0",
      is_new: false,
      snapshot: null,
    });
    const tileSpy = vi
      .spyOn(useTerminalStore.getState(), "tileProjectBranches")
      .mockResolvedValue("grid-tab");

    render(<FleetSpawnSheet />);

    fireEvent.change(await screen.findByRole("combobox", { name: /repository/i }), {
      target: { value: demoRepo.path },
    });
    setSlotAgent(1, "Claude Code");
    setSlotAgent(2, "Qwen Code");
    fireEvent.click(screen.getByRole("button", { name: /review fleet/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm launch/i }));

    fireEvent.click(await screen.findByRole("button", { name: /open grid/i }));

    await vi.waitFor(() => {
      expect(useTerminalStore.getState().isFleetSheetOpen).toBe(false);
    });
    expect(tileSpy).toHaveBeenCalledTimes(1);
    // Only the successful slot's worktree is tiled; the failed one has no record.
    expect(tileSpy).toHaveBeenCalledWith("demo", ["demo::wt-0"]);
  });

  it("Open grid failure keeps the sheet open with an inline error", async () => {
    worktreeCreateFleetMock.mockResolvedValue({ results: [okSlot(0)] });
    vi.mocked(transport.ptySpawn).mockResolvedValue({
      id: "agent-0",
      is_new: false,
      snapshot: null,
    });
    vi.spyOn(useTerminalStore.getState(), "tileProjectBranches")
      .mockRejectedValue(new Error("grid exploded"));

    render(<FleetSpawnSheet />);

    fireEvent.change(await screen.findByRole("combobox", { name: /repository/i }), {
      target: { value: demoRepo.path },
    });
    setSlotAgent(1, "Claude Code");
    setSlotAgent(2, "Claude Code");
    fireEvent.click(screen.getByRole("button", { name: /review fleet/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm launch/i }));

    fireEvent.click(await screen.findByRole("button", { name: /open grid/i }));

    await vi.waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("grid exploded");
    });
    expect(useTerminalStore.getState().isFleetSheetOpen).toBe(true);
  });

  it("done phase hides Open grid when every slot failed", async () => {
    worktreeCreateFleetMock.mockResolvedValue({
      results: [failedSlot(0, "unknown agent: nope"), failedSlot(1, "also bad")],
    });

    render(<FleetSpawnSheet />);

    fireEvent.change(await screen.findByRole("combobox", { name: /repository/i }), {
      target: { value: demoRepo.path },
    });
    setSlotAgent(1, "Qwen Code");
    setSlotAgent(2, "Qwen Code");
    fireEvent.click(screen.getByRole("button", { name: /review fleet/i }));
    fireEvent.click(await screen.findByRole("button", { name: /confirm launch/i }));

    await vi.waitFor(() => {
      expect(screen.getByText(/unknown agent: nope/i)).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: /open grid/i })).toBeNull();
  });
});
