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
} from "./transport";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

describe("pty transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ptySpawn invokes pty_spawn with options and resolves the session id", async () => {
    invokeMock.mockResolvedValue("abc");
    const id = await ptySpawn({ shell: "pwsh", cwd: "/tmp", cols: 100, rows: 30 });
    expect(invokeMock).toHaveBeenCalledWith("pty_spawn", {
      shell: "pwsh",
      cwd: "/tmp",
      cols: 100,
      rows: 30,
    });
    expect(id).toBe("abc");
  });

  it("ptySpawn with no options invokes pty_spawn with empty args", async () => {
    invokeMock.mockResolvedValue("xyz");
    await ptySpawn();
    expect(invokeMock).toHaveBeenCalledWith("pty_spawn", {});
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
      payload: { id: string; data: string; seq: number };
    }) => void;
    handler({ payload: { id: "abc", data: "hi", seq: 3 } });
    expect(cb).toHaveBeenCalledWith({ id: "abc", data: "hi", seq: 3 });
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
});
