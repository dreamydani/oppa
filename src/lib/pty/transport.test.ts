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
  onPtyData,
  onPtyExit,
  onPtyCwd,
  onTitleChanged,
  onFocusRequested,
  onSessionWorking,
  onAgentStatus,
} from "./transport";
import type { PtySpawnResult, AgentStatusEntry } from "./transport";

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

  it("onSessionWorking listens to session-working and forwards payload", async () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValue(unlisten);
    const cb = vi.fn();
    const result = await onSessionWorking(cb);
    expect(listenMock).toHaveBeenCalledWith("session-working", expect.any(Function));
    const handler = listenMock.mock.calls[0][1] as (e: {
      payload: { sessionId: string; working: boolean };
    }) => void;
    handler({ payload: { sessionId: "s1", working: true } });
    expect(cb).toHaveBeenCalledWith({ sessionId: "s1", working: true });
    expect(result).toBe(unlisten);
  });

  it("onAgentStatus listens to agent-status and normalizes snake_case to camelCase", async () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValue(unlisten);
    const cb = vi.fn();
    const result = await onAgentStatus(cb);
    expect(listenMock).toHaveBeenCalledWith("agent-status", expect.any(Function));
    const handler = listenMock.mock.calls[0][1] as (e: {
      payload: { pane_key?: string; paneKey?: string; entry: AgentStatusEntry };
    }) => void;
    const entry: AgentStatusEntry = {
      state: "working",
      state_started_at_ms: 100,
      updated_at_ms: 200,
      origin: "hook",
    };
    handler({ payload: { pane_key: "s1", entry } });
    expect(cb).toHaveBeenCalledWith({ paneKey: "s1", entry });
    expect(result).toBe(unlisten);
  });
});

