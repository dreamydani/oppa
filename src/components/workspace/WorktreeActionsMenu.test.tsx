import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { WorktreeActionsMenu } from "./WorktreeActionsMenu";
import { useTerminalStore } from "../../store/terminalStore";
import type { WorktreeRecord } from "../../lib/worktree/transport";

vi.mock("../../lib/pty/transport", () => ({
  onTitleChanged: vi.fn().mockResolvedValue(() => {}),
  onFocusRequested: vi.fn().mockResolvedValue(() => {}),
  onSessionWorking: vi.fn().mockResolvedValue(() => {}),
  onAgentStatus: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("../../lib/worktree/transport", () => ({
  onWorktreeChanged: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("../../lib/git/transport", () => ({
  onGitChanged: vi.fn().mockResolvedValue(() => {}),
  onPrChanged: vi.fn().mockResolvedValue(() => {}),
}));

function record(overrides: Partial<WorktreeRecord> = {}): WorktreeRecord {
  return {
    id: "wt-1",
    repo_id: "demo",
    name: "feat-a",
    display_name: "PERF web runtime render",
    branch: "perf/render",
    path: "C:/projects/oppa/wt-1",
    base_ref: "main",
    parent_worktree_id: null,
    child_worktree_ids: [],
    workspace_status: "in-progress",
    retired: false,
    created_at_ms: 0,
    linked_pr_url: null,
    ...overrides,
  };
}

describe("WorktreeActionsMenu", () => {
  beforeEach(() => {
    useTerminalStore.setState({ worktrees: [], sessions: {} });
  });

  it("opens the menu and lists finish/merge/remove actions for a live worktree", () => {
    const rec = record();
    render(
      <WorktreeActionsMenu
        record={rec}
        onActionFinished={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /actions for/i }));

    expect(screen.getByText("Finish…")).toBeInTheDocument();
    expect(screen.getByText("Merge into main…")).toBeInTheDocument();
    expect(screen.getByText("Remove…")).toBeInTheDocument();
  });

  it("shows purge instead of remove for a retired worktree", () => {
    render(
      <WorktreeActionsMenu
        record={record({ retired: true })}
        onActionFinished={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /actions for/i }));

    expect(screen.getByText("Purge…")).toBeInTheDocument();
    expect(screen.queryByText("Remove…")).not.toBeInTheDocument();
  });

  it("runs the finish chain and surfaces the created PR", async () => {
    const finishWorktree = vi
      .spyOn(useTerminalStore.getState(), "finishWorktree")
      .mockResolvedValue({ ok: true, prUrl: "https://example.com/pull/9", pushedTo: "origin/perf/render" });
    const loadWorktrees = vi
      .spyOn(useTerminalStore.getState(), "loadWorktrees")
      .mockResolvedValue(undefined);

    render(
      <WorktreeActionsMenu
        record={record()}
        onActionFinished={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /actions for/i }));
    fireEvent.click(screen.getByText("Finish…"));

    await waitFor(() => {
      expect(finishWorktree).toHaveBeenCalledWith({ worktreeId: "wt-1" });
      expect(loadWorktrees).toHaveBeenCalled();
      expect(screen.getByText(/pr #9 created/i)).toBeInTheDocument();
    });
  });

  it("merge confirm dialog runs mergeWorktreeToBase with the chosen mode", async () => {
    const mergeWorktreeToBase = vi
      .spyOn(useTerminalStore.getState(), "mergeWorktreeToBase")
      .mockResolvedValue({ merged_commit: "abc1234", mode: "merge", files_changed: 3 });

    render(
      <WorktreeActionsMenu
        record={record()}
        onActionFinished={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /actions for/i }));
    fireEvent.click(screen.getByText("Merge into main…"));

    expect(screen.getByText(/merge “perf web runtime render” into main/i)).toBeInTheDocument();

    fireEvent.click(screen.getByText("Keep a merge commit"));
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));

    await waitFor(() => {
      expect(mergeWorktreeToBase).toHaveBeenCalledWith({
        worktreeId: "wt-1",
        mode: "merge",
      });
    });
  });

  it("remove confirm offers force remove when live sessions block it", async () => {
    const removeWorktree = vi
      .spyOn(useTerminalStore.getState(), "removeWorktree")
      .mockRejectedValueOnce(new Error("worktree has live sessions present"))
      .mockResolvedValue(undefined);

    render(
      <WorktreeActionsMenu
        record={record()}
        onActionFinished={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /actions for/i }));
    fireEvent.click(screen.getByText("Remove…"));

    expect(screen.getByText(/remove “perf web runtime render”/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(removeWorktree).toHaveBeenCalledWith("wt-1", false);
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Force Remove" })).toBeInTheDocument();
    });
  });

  it("opens the linked PR url from the menu", async () => {
    const rec = record({ linked_pr_url: "https://example.com/pull/12" });
    render(
      <WorktreeActionsMenu
        record={rec}
        onActionFinished={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /actions for/i }));
    const prButton = screen.getByTitle("Open PR");
    expect(prButton).toBeInTheDocument();
  });
});
