import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  worktreeCreate,
  agentProfiles,
  worktreeCreateAgent,
  worktreeCreateFleet,
  fleetSpawn,
  worktreeList,
  worktreeShow,
  worktreeCurrent,
  worktreeSet,
  worktreeRemove,
  worktreePurge,
  worktreePs,
  worktreeLineage,
  repoAdd,
  repoList,
  onWorktreeChanged,
} from "./transport";
import type { FleetSlotResult, WorktreeRecord } from "./transport";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

describe("worktree transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("worktreeCreate invokes worktree_create with mapped options", async () => {
    const mockRecord: WorktreeRecord = {
      id: "wt-1",
      repo_id: "repo-1",
      name: "feat-a",
      display_name: null,
      branch: "feat-a",
      path: "/worktrees/feat-a",
      base_ref: "main",
      parent_worktree_id: null,
      child_worktree_ids: [],
      workspace_status: "in-progress",
      retired: false,
      created_at_ms: 1000,
      linked_pr_url: null,
    };
    invokeMock.mockResolvedValue(mockRecord);
    const res = await worktreeCreate({ repoPath: "/repos/demo", name: "feat-a", baseRef: "main" });
    expect(invokeMock).toHaveBeenCalledWith("worktree_create", {
      repoPath: "/repos/demo",
      name: "feat-a",
      baseRef: "main",
    });
    expect(res).toEqual(mockRecord);
  });

  it("agentProfiles invokes agent_profiles and returns profiles", async () => {
    const profiles = [{ id: "claude", displayName: "Claude Code", promptDelivery: "arg" }];
    invokeMock.mockResolvedValue(profiles);
    const res = await agentProfiles();
    expect(invokeMock).toHaveBeenCalledWith("agent_profiles");
    expect(res).toEqual(profiles);
  });

  it("worktreeCreateAgent invokes worktree_create_agent", async () => {
    const handoff = {
      record: { id: "wt-agent" } as WorktreeRecord,
      session_id: "s-123",
    };
    invokeMock.mockResolvedValue(handoff);
    const res = await worktreeCreateAgent({
      repoPath: "/repos/demo",
      agent: "claude",
      prompt: "do work",
    });
    expect(invokeMock).toHaveBeenCalledWith("worktree_create_agent", {
      repoPath: "/repos/demo",
      agent: "claude",
      prompt: "do work",
    });
    expect(res).toEqual(handoff);
  });

  it("worktreeCreateFleet and fleetSpawn invoke worktree_create_fleet and normalize response", async () => {
    const rawSlots: FleetSlotResult[] = [
      { index: 0, ok: true, record: null, session_id: "s0", error: null },
      { index: 1, ok: false, record: null, session_id: null, error: "failed" },
    ];
    invokeMock.mockResolvedValue(rawSlots);
    const res1 = await worktreeCreateFleet({
      repoPath: "/repo",
      slots: [{ name: null, agent: "claude", command: null, prompt: null }],
    });
    expect(invokeMock).toHaveBeenCalledWith("worktree_create_fleet", {
      repoPath: "/repo",
      slots: [{ name: null, agent: "claude", command: null, prompt: null }],
    });
    expect(res1).toEqual({ results: rawSlots });

    invokeMock.mockResolvedValue({ results: rawSlots });
    const res2 = await fleetSpawn({
      repoPath: "/repo",
      slots: [{ name: null, agent: "claude", command: null, prompt: null }],
    });
    expect(res2).toEqual({ results: rawSlots });
  });

  it("worktreeList invokes worktree_list and returns entries", async () => {
    const entries = [{ record: { id: "wt-1" } as WorktreeRecord, missing_on_disk: false }];
    invokeMock.mockResolvedValue(entries);
    await expect(worktreeList()).resolves.toEqual(entries);
    expect(invokeMock).toHaveBeenCalledWith("worktree_list");
  });

  it("worktreeShow invokes worktree_show with id", async () => {
    const record = { id: "wt-show" } as WorktreeRecord;
    invokeMock.mockResolvedValue(record);
    await expect(worktreeShow("wt-show")).resolves.toEqual(record);
    expect(invokeMock).toHaveBeenCalledWith("worktree_show", { id: "wt-show" });
  });

  it("worktreeCurrent invokes worktree_current with cwd", async () => {
    const record = { id: "wt-curr" } as WorktreeRecord;
    invokeMock.mockResolvedValue(record);
    await expect(worktreeCurrent("/work/path")).resolves.toEqual(record);
    expect(invokeMock).toHaveBeenCalledWith("worktree_current", { cwd: "/work/path" });
  });

  it("worktreeSet invokes worktree_set with proper setParent flag", async () => {
    invokeMock.mockResolvedValue(null);
    await worktreeSet("wt-1", { workspaceStatus: "completed", displayName: "My WT" });
    expect(invokeMock).toHaveBeenCalledWith("worktree_set", {
      id: "wt-1",
      setParent: false,
      workspaceStatus: "completed",
      displayName: "My WT",
    });

    invokeMock.mockClear();
    await worktreeSet("wt-2", { parentWorktreeId: null });
    expect(invokeMock).toHaveBeenCalledWith("worktree_set", {
      id: "wt-2",
      setParent: true,
      parentWorktreeId: null,
    });
  });

  it("worktreeRemove invokes worktree_remove with force and deleteBranch", async () => {
    invokeMock.mockResolvedValue(undefined);
    await worktreeRemove("wt-1", true, false);
    expect(invokeMock).toHaveBeenCalledWith("worktree_remove", {
      id: "wt-1",
      force: true,
      deleteBranch: false,
    });
  });

  it("worktreePurge invokes worktree_purge with id", async () => {
    invokeMock.mockResolvedValue(undefined);
    await worktreePurge("wt-1");
    expect(invokeMock).toHaveBeenCalledWith("worktree_purge", { id: "wt-1" });
  });

  it("worktreePs invokes worktree_ps", async () => {
    const entries = [{ record: { id: "wt-1" } as WorktreeRecord, live_sessions: 2 }];
    invokeMock.mockResolvedValue(entries);
    await expect(worktreePs()).resolves.toEqual(entries);
    expect(invokeMock).toHaveBeenCalledWith("worktree_ps");
  });

  it("worktreeLineage invokes worktree_lineage with id", async () => {
    const lineage = [{ id: "wt-root" }, { id: "wt-child" }] as WorktreeRecord[];
    invokeMock.mockResolvedValue(lineage);
    await expect(worktreeLineage("wt-child")).resolves.toEqual(lineage);
    expect(invokeMock).toHaveBeenCalledWith("worktree_lineage", { id: "wt-child" });
  });

  it("repoAdd and repoList invoke repo_add and repo_list", async () => {
    const repos = [{ repo_id: "demo", path: "/repos/demo", default_base_ref: "main", worktree_base_path: null }];
    invokeMock.mockResolvedValue(repos);
    await expect(repoAdd("/repos/demo")).resolves.toEqual(repos);
    expect(invokeMock).toHaveBeenCalledWith("repo_add", { path: "/repos/demo" });

    await expect(repoList()).resolves.toEqual(repos);
    expect(invokeMock).toHaveBeenCalledWith("repo_list");
  });

  it("onWorktreeChanged listens to worktree-changed and forwards payload", async () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValue(unlisten);
    const cb = vi.fn();
    const result = await onWorktreeChanged(cb);
    expect(listenMock).toHaveBeenCalledWith("worktree-changed", expect.any(Function));
    const handler = listenMock.mock.calls[0][1] as (e: {
      payload: { id: string | null };
    }) => void;
    handler({ payload: { id: "wt-1" } });
    handler({ payload: { id: null } });
    expect(cb).toHaveBeenNthCalledWith(1, { id: "wt-1" });
    expect(cb).toHaveBeenNthCalledWith(2, { id: null });
    expect(result).toBe(unlisten);
  });
});
