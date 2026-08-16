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
});
