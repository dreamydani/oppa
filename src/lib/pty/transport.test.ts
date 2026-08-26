import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  ptySpawn,
  ptyWrite,
  ptyResize,
  ptyKill,
  ptyAck,
  ptyList,
  saveLayout,
  loadLayout,
  saveScrollback,
  loadScrollback,
  deleteScrollback,
  cleanupStaleScrollbacks,
  onPtyData,
  onPtyExit,
  onPtyCwd,
  worktreeCreate,
  worktreeList,
  worktreeSet,
  worktreeRemove,
  worktreePurge,
  worktreePs,
  repoAdd,
  repoList,
  onWorktreeChanged,
  onTitleChanged,
  onFocusRequested,
  worktreeCreateFleet,
} from "./transport";
import type { PtySpawnResult, FleetSlotResult } from "./transport";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

describe("pty transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ptySpawn invokes pty_spawn with options including id and resolves PtySpawnResult", async () => {
    const mockResult: PtySpawnResult = {
      id: "abc",
      is_new: false,
      snapshot: "previous snapshot",
      pid: 1234,
      cols: 100,
      rows: 30,
      cwd: "/tmp",
    };
    invokeMock.mockResolvedValue(mockResult);
    const result = await ptySpawn({ id: "abc", shell: "pwsh", cwd: "/tmp", cols: 100, rows: 30 });
    expect(invokeMock).toHaveBeenCalledWith("pty_spawn", {
      id: "abc",
      shell: "pwsh",
      cwd: "/tmp",
      cols: 100,
      rows: 30,
    });
    expect(result).toEqual(mockResult);
  });

  it("ptySpawn with no options invokes pty_spawn with empty args", async () => {
    const mockResult: PtySpawnResult = {
      id: "xyz",
      is_new: true,
      pid: 5678,
      cols: 80,
      rows: 24,
    };
    invokeMock.mockResolvedValue(mockResult);
    const result = await ptySpawn();
    expect(invokeMock).toHaveBeenCalledWith("pty_spawn", {});
    expect(result).toEqual(mockResult);
  });

  it("ptyWrite invokes pty_write with id and data", () => {
    ptyWrite("abc", "ls\r");
    expect(invokeMock).toHaveBeenCalledWith("pty_write", { id: "abc", data: "ls\r" });
  });

  it("ptyResize invokes pty_resize with id, cols, rows", () => {
    ptyResize("abc", 120, 40);
    expect(invokeMock).toHaveBeenCalledWith("pty_resize", {
      id: "abc",
      cols: 120,
      rows: 40,
    });
  });

  it("ptyKill invokes pty_kill with id", () => {
    ptyKill("abc");
    expect(invokeMock).toHaveBeenCalledWith("pty_kill", { id: "abc" });
  });

  it("ptyAck invokes pty_ack with a numeric char count", () => {
    ptyAck("abc", 42);
    expect(invokeMock).toHaveBeenCalledWith("pty_ack", { id: "abc", chars: 42 });
  });

  it("ptyList invokes pty_list and resolves session ids", async () => {
    invokeMock.mockResolvedValue(["abc", "def"]);
    await expect(ptyList()).resolves.toEqual(["abc", "def"]);
    expect(invokeMock).toHaveBeenCalledWith("pty_list");
  });

  it("saveLayout invokes save_layout with the serialized JSON under layoutJson", async () => {
    invokeMock.mockResolvedValue(undefined);
    const json = '{"layout":{"type":"leaf","id":"a"},"sessions":[]}';
    await saveLayout(json);
    expect(invokeMock).toHaveBeenCalledWith("save_layout", { layoutJson: json });
  });

  it("loadLayout invokes load_layout and resolves the saved JSON (or null)", async () => {
    invokeMock.mockResolvedValue('{"layout":{"type":"leaf","id":"a"}}');
    await expect(loadLayout()).resolves.toBe('{"layout":{"type":"leaf","id":"a"}}');
    expect(invokeMock).toHaveBeenCalledWith("load_layout");

    invokeMock.mockResolvedValue(null);
    await expect(loadLayout()).resolves.toBeNull();
  });

  it("onPtyData subscribes to pty:data and forwards the payload", async () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValue(unlisten);
    const cb = vi.fn();
    const result = await onPtyData(cb);
    expect(listenMock).toHaveBeenCalledWith("pty:data", expect.any(Function));
    const handler = listenMock.mock.calls[0][1] as (e: {
      payload: { id: string; data: string; bytes: number; seq: number };
    }) => void;
    handler({ payload: { id: "abc", data: "hi", bytes: 2, seq: 3 } });
    expect(cb).toHaveBeenCalledWith({ id: "abc", data: "hi", bytes: 2, seq: 3 });
    expect(result).toBe(unlisten);
  });

  it("onPtyExit subscribes to pty:exit and forwards the payload", async () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValue(unlisten);
    const cb = vi.fn();
    await onPtyExit(cb);
    expect(listenMock).toHaveBeenCalledWith("pty:exit", expect.any(Function));
    const handler = listenMock.mock.calls[0][1] as (e: {
      payload: { id: string; code: number | null };
    }) => void;
    handler({ payload: { id: "abc", code: 0 } });
    expect(cb).toHaveBeenCalledWith({ id: "abc", code: 0 });
  });

  it("onPtyCwd subscribes to pty:cwd and forwards the payload", async () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValue(unlisten);
    const cb = vi.fn();
    const result = await onPtyCwd(cb);
    expect(listenMock).toHaveBeenCalledWith("pty:cwd", expect.any(Function));
    const handler = listenMock.mock.calls[0][1] as (e: {
      payload: { id: string; cwd: string };
    }) => void;
    handler({ payload: { id: "abc", cwd: "C:\\work" } });
    expect(cb).toHaveBeenCalledWith({ id: "abc", cwd: "C:\\work" });
    expect(result).toBe(unlisten);
  });

  it("saveScrollback invokes save_scrollback with id and data", async () => {
    invokeMock.mockResolvedValue(undefined);
    await saveScrollback("term-1", "serialized data");
    expect(invokeMock).toHaveBeenCalledWith("save_scrollback", {
      id: "term-1",
      data: "serialized data",
    });
  });

  it("loadScrollback invokes load_scrollback with id and returns data or null", async () => {
    invokeMock.mockResolvedValue("persisted scrollback");
    await expect(loadScrollback("term-1")).resolves.toBe("persisted scrollback");
    expect(invokeMock).toHaveBeenCalledWith("load_scrollback", { id: "term-1" });

    invokeMock.mockResolvedValue(null);
    await expect(loadScrollback("term-2")).resolves.toBeNull();
  });

  it("deleteScrollback invokes delete_scrollback with id", async () => {
    invokeMock.mockResolvedValue(undefined);
    await deleteScrollback("term-1");
    expect(invokeMock).toHaveBeenCalledWith("delete_scrollback", { id: "term-1" });
  });

  it("cleanupStaleScrollbacks invokes cleanup_stale_scrollbacks with activeIds", async () => {
    invokeMock.mockResolvedValue(undefined);
    await cleanupStaleScrollbacks(["term-1", "term-2"]);
    expect(invokeMock).toHaveBeenCalledWith("cleanup_stale_scrollbacks", {
      activeIds: ["term-1", "term-2"],
    });
  });

  it("ptySpawn handles is_warm and cold_scrollback fields in PtySpawnResult", async () => {
    const mockResult: PtySpawnResult = {
      id: "cold-1",
      is_new: true,
      is_warm: false,
      cold_scrollback: "persisted terminal scrollback\n",
      pid: 4567,
      cols: 80,
      rows: 24,
      cwd: "/workspace",
    };
    invokeMock.mockResolvedValue(mockResult);
    const result = await ptySpawn({ id: "cold-1" });
    expect(invokeMock).toHaveBeenCalledWith("pty_spawn", { id: "cold-1" });
    expect(result).toEqual(mockResult);
    expect(result.is_warm).toBe(false);
    expect(result.cold_scrollback).toBe("persisted terminal scrollback\n");
  });

  it("worktreeCreate invokes worktree_create with camelCase args mapped from options", async () => {
    invokeMock.mockResolvedValue(null);
    await worktreeCreate({ repoPath: "/repos/demo", name: "feat-a", baseRef: "main" });
    expect(invokeMock).toHaveBeenCalledWith("worktree_create", {
      repoPath: "/repos/demo",
      name: "feat-a",
      baseRef: "main",
    });
  });

  it("worktreeList invokes worktree_list and resolves entries", async () => {
    const entries = [{ record: { id: "wt-1" }, missing_on_disk: false }];
    invokeMock.mockResolvedValue(entries);
    await expect(worktreeList()).resolves.toEqual(entries);
    expect(invokeMock).toHaveBeenCalledWith("worktree_list");
  });

  it("worktreeSet invokes worktree_set including setParent for clear-vs-untouched", async () => {
    invokeMock.mockResolvedValue(null);
    await worktreeSet("wt-1", { workspaceStatus: "completed" });
    expect(invokeMock).toHaveBeenCalledWith("worktree_set", {
      id: "wt-1",
      setParent: false,
      workspaceStatus: "completed",
    });

    invokeMock.mockClear();
    await worktreeSet("wt-2", { parentWorktreeId: null });
    expect(invokeMock).toHaveBeenCalledWith("worktree_set", {
      id: "wt-2",
      setParent: true,
      parentWorktreeId: null,
    });
  });

  it("worktreeRemove and worktreePurge forward flags to their commands", async () => {
    invokeMock.mockResolvedValue(undefined);
    await worktreeRemove("wt-1", true, false);
    expect(invokeMock).toHaveBeenCalledWith("worktree_remove", {
      id: "wt-1",
      force: true,
      deleteBranch: false,
    });

    await worktreePurge("wt-1");
    expect(invokeMock).toHaveBeenCalledWith("worktree_purge", { id: "wt-1" });
  });

  it("worktreePs resolves live session counts per record", async () => {
    const entries = [{ record: { id: "wt-1" }, live_sessions: 2 }];
    invokeMock.mockResolvedValue(entries);
    await expect(worktreePs()).resolves.toEqual(entries);
    expect(invokeMock).toHaveBeenCalledWith("worktree_ps");
  });

  it("repoAdd and repoList resolve registry repo records", async () => {
    const repos = [{ repo_id: "demo", path: "/repos/demo" }];
    invokeMock.mockResolvedValue(repos);
    await expect(repoAdd("/repos/demo")).resolves.toEqual(repos);
    expect(invokeMock).toHaveBeenCalledWith("repo_add", { path: "/repos/demo" });

    await expect(repoList()).resolves.toEqual(repos);
    expect(invokeMock).toHaveBeenCalledWith("repo_list");
  });

  it("onWorktreeChanged subscribes to worktree-changed and forwards the payload", async () => {
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

  it("onTitleChanged subscribes to session-title-changed and forwards the payload", async () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValue(unlisten);
    const cb = vi.fn();
    const result = await onTitleChanged(cb);
    expect(listenMock).toHaveBeenCalledWith("session-title-changed", expect.any(Function));
    const handler = listenMock.mock.calls[0][1] as (e: {
      payload: { id: string; title: string };
    }) => void;
    handler({ payload: { id: "s1", title: "build" } });
    expect(cb).toHaveBeenCalledWith({ id: "s1", title: "build" });
    expect(result).toBe(unlisten);
  });

  it("onFocusRequested subscribes to session-focus-requested and forwards the payload", async () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValue(unlisten);
    const cb = vi.fn();
    const result = await onFocusRequested(cb);
    expect(listenMock).toHaveBeenCalledWith("session-focus-requested", expect.any(Function));
    const handler = listenMock.mock.calls[0][1] as (e: {
      payload: { id: string };
    }) => void;
    handler({ payload: { id: "s9" } });
    expect(cb).toHaveBeenCalledWith({ id: "s9" });
    expect(result).toBe(unlisten);
  });

  it("worktreeCreateFleet normalizes raw array response from backend into { results }", async () => {
    const rawSlots: FleetSlotResult[] = [
      { index: 0, ok: true, record: null, session_id: "s0", error: null },
      { index: 1, ok: false, record: null, session_id: null, error: "failed" },
    ];
    invokeMock.mockResolvedValue(rawSlots);
    const result = await worktreeCreateFleet({
      repoPath: "/repo",
      slots: [{ name: null, agent: "claude", command: null, prompt: null }],
    });
    expect(invokeMock).toHaveBeenCalledWith("worktree_create_fleet", {
      repoPath: "/repo",
      slots: [{ name: null, agent: "claude", command: null, prompt: null }],
    });
    expect(result).toEqual({ results: rawSlots });
  });
});

