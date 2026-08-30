import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  saveLayout,
  loadLayout,
  saveScrollback,
  loadScrollback,
  deleteScrollback,
  cleanupStaleScrollbacks,
  confirmSaveComplete,
} from "./transport";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

describe("layout transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("saveLayout invokes save_layout with serialized JSON under layoutJson", async () => {
    invokeMock.mockResolvedValue(undefined);
    const json = '{"layout":{"type":"leaf","id":"a"},"sessions":[]}';
    await saveLayout(json);
    expect(invokeMock).toHaveBeenCalledWith("save_layout", { layoutJson: json });
  });

  it("loadLayout invokes load_layout and returns JSON or null", async () => {
    invokeMock.mockResolvedValue('{"layout":{"type":"leaf","id":"a"}}');
    await expect(loadLayout()).resolves.toBe('{"layout":{"type":"leaf","id":"a"}}');
    expect(invokeMock).toHaveBeenCalledWith("load_layout");

    invokeMock.mockResolvedValue(null);
    await expect(loadLayout()).resolves.toBeNull();
  });

  it("saveScrollback invokes save_scrollback with id and data", async () => {
    invokeMock.mockResolvedValue(undefined);
    await saveScrollback("term-1", "serialized data");
    expect(invokeMock).toHaveBeenCalledWith("save_scrollback", {
      id: "term-1",
      data: "serialized data",
    });
  });

  it("loadScrollback invokes load_scrollback with id", async () => {
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

  it("confirmSaveComplete invokes confirm_save_complete", async () => {
    invokeMock.mockResolvedValue(undefined);
    await confirmSaveComplete();
    expect(invokeMock).toHaveBeenCalledWith("confirm_save_complete");
  });
});
