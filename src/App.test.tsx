import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import App from "./App";
import { useTerminalStore } from "./store/terminalStore";
import * as transport from "./lib/pty/transport";

vi.mock("./lib/pty/transport", () => ({
  confirmSaveComplete: vi.fn().mockResolvedValue(undefined),
  onPtyCwd: vi.fn(),
  ptySpawn: vi.fn().mockResolvedValue("s1"),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  ptyResize: vi.fn().mockResolvedValue(undefined),
  ptyAck: vi.fn().mockResolvedValue(undefined),
  ptyWrite: vi.fn(),
  onPtyData: vi.fn().mockResolvedValue(vi.fn()),
  onPtyExit: vi.fn().mockResolvedValue(vi.fn()),
  saveLayout: vi.fn().mockResolvedValue(undefined),
  loadLayout: vi.fn().mockResolvedValue(null),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(vi.fn()),
}));

describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTerminalStore.setState({
      sessions: {
        s1: { id: "s1", title: "s1", status: "running", cols: 80, rows: 24 },
      },
      layout: { type: "leaf", id: "s1" },
      focusedPath: [],
      ready: true,
    });
  });

  it("subscribes to onPtyCwd on mount and updates session cwd", async () => {
    let cwdHandler: ((p: { id: string; cwd: string }) => void) | undefined;
    const unlisten = vi.fn();
    vi.mocked(transport.onPtyCwd).mockImplementation(async (cb) => {
      cwdHandler = cb;
      return unlisten;
    });

    const { unmount } = render(<App />);

    expect(transport.onPtyCwd).toHaveBeenCalledTimes(1);
    expect(cwdHandler).toBeDefined();

    cwdHandler?.({ id: "s1", cwd: "/test/dir" });
    expect(useTerminalStore.getState().sessions["s1"].cwd).toBe("/test/dir");

    unmount();
    await vi.waitFor(() => {
      expect(unlisten).toHaveBeenCalled();
    });
  });
});
