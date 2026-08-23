import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { WorktreePane } from "./WorktreePane";
import { useTerminalStore } from "../../store/terminalStore";
import * as transport from "../../lib/pty/transport";
import type { WorktreeRecord } from "../../lib/pty/transport";

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

const worktreeSetMock = vi.mocked(transport.worktreeSet);
const worktreeRemoveMock = vi.mocked(transport.worktreeRemove);

function record(overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
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
    ...overrides,
  };
}

describe("WorktreePane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTerminalStore.setState({
      worktrees: [
        {
          record: record({
            id: "demo::C:/ws/feat-a",
            name: "feat-a",
            display_name: "Feat A",
            branch: "feat-a",
            workspace_status: "in-progress",
          }),
          missing_on_disk: false,
        },
        {
          record: record({
            id: "demo::C:/ws/old-thing",
            name: "old-thing",
            display_name: null,
            branch: "old-thing",
            workspace_status: "completed",
            retired: true,
            created_at_ms: 1723900000001,
          }),
          missing_on_disk: true,
        },
      ],
      worktreeLiveSessions: { "demo::C:/ws/feat-a": 2 },
    });
  });

  it("renders active and retired cards with status chips and warning states", () => {
    const { container } = render(<WorktreePane />);

    expect(screen.getByText("Feat A")).toBeDefined();
    expect(screen.getByText("In Progress")).toBeDefined();
    expect(screen.getByText("2 live")).toBeDefined();

    const retiredCard = screen.getByText("retired").closest(".worktree-card")!;
    expect(retiredCard.className).toContain("retired");
    expect(retiredCard.className).toContain("missing");
    expect(screen.getByText("retired")).toBeDefined();
    expect(screen.getByText(/missing on disk/i)).toBeDefined();

    // Active card keeps a status chip; tombstone does not
    const activeCard = screen.getByText("Feat A").closest(".worktree-card")!;
    expect(activeCard.querySelectorAll(".worktree-status-chip").length).toBe(1);
    expect(retiredCard.querySelectorAll(".worktree-status-chip").length).toBe(0);
    void container;
  });

  it("card kebab menu triggers the set-status action", async () => {
    render(<WorktreePane />);

    fireEvent.click(screen.getByRole("button", { name: /actions for feat a/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Completed" }));

    await vi.waitFor(() => {
      expect(worktreeSetMock).toHaveBeenCalledWith("demo::C:/ws/feat-a", {
        workspaceStatus: "completed",
      });
    });
  });

  it("remove flow surfaces the teardown-refusal reason inside the confirm dialog", async () => {
    worktreeRemoveMock.mockRejectedValue(
      "cannot remove worktree demo::C:/ws/feat-a: live sessions present: s-1 (cwd inside worktree)",
    );

    render(<WorktreePane />);
    fireEvent.click(screen.getByRole("button", { name: /actions for feat a/i }));
    fireEvent.click(screen.getByRole("menuitem", { name: /remove/i }));

    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));

    await vi.waitFor(() => {
      expect(screen.getByRole("alert").textContent).toMatch(/live sessions present/);
    });
  });

  it("purge is only offered for retired tombstones", () => {
    render(<WorktreePane />);

    fireEvent.click(screen.getByRole("button", { name: /actions for feat a/i }));
    expect(screen.queryByRole("menuitem", { name: /purge/i })).toBeNull();

    fireEvent.click(document.body);
    fireEvent.click(screen.getByRole("button", { name: /actions for old-thing/i }));
    expect(screen.getByRole("menuitem", { name: /purge/i })).toBeDefined();
    expect(screen.queryByRole("menuitem", { name: /open terminal here/i })).toBeNull();
  });

  it("renders empty state with a create button when no worktrees exist", () => {
    useTerminalStore.setState({ worktrees: [] });
    render(<WorktreePane />);

    expect(screen.getByText(/no workspaces yet/i)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: /new worktree/i }));
    expect(useTerminalStore.getState().isWorktreeCreateOpen).toBe(true);
  });
});
