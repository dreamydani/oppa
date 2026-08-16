import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useTerminalStore } from "../store/terminalStore";
import { Toolbar } from "./Toolbar";
import * as transport from "../lib/pty/transport";

vi.mock("../lib/pty/transport", () => ({
  ptySpawn: vi.fn(),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  ptyResize: vi.fn().mockResolvedValue(undefined),
  ptyAck: vi.fn().mockResolvedValue(undefined),
  ptyWrite: vi.fn(),
  onPtyData: vi.fn(),
  onPtyExit: vi.fn(),
}));

const ptySpawnMock = vi.mocked(transport.ptySpawn);

describe("Toolbar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ptySpawnMock.mockResolvedValue("s1");
    useTerminalStore.setState({
      sessions: {},
      layout: { type: "leaf", id: "" },
      focusedPath: [],
    });
  });

  it("renders the three action buttons", () => {
    const { getByTitle } = render(<Toolbar />);
    expect(getByTitle("Split horizontal (Ctrl+Shift+D)")).toBeTruthy();
    expect(getByTitle("Split vertical (Ctrl+Shift+E)")).toBeTruthy();
    expect(getByTitle("Close pane (Ctrl+W)")).toBeTruthy();
  });

  it("splits horizontally when the first split button is clicked", async () => {
    const { getByTitle } = render(<Toolbar />);
    fireEvent.click(getByTitle("Split horizontal (Ctrl+Shift+D)"));
    await vi.waitFor(() => {
      const layout = useTerminalStore.getState().layout;
      if (layout.type !== "split") throw new Error("expected split layout");
      expect(layout.dir).toBe("h");
    });
  });

  it("splits vertically when the second split button is clicked", async () => {
    const { getByTitle } = render(<Toolbar />);
    fireEvent.click(getByTitle("Split vertical (Ctrl+Shift+E)"));
    await vi.waitFor(() => {
      const layout = useTerminalStore.getState().layout;
      if (layout.type !== "split") throw new Error("expected split layout");
      expect(layout.dir).toBe("v");
    });
  });

  it("closes the focused pane when the close button is clicked", async () => {
    // Two sessions in a split, focus on the second leaf.
    useTerminalStore.setState({
      sessions: {
        a: { id: "a", title: "a", status: "running", cols: 80, rows: 24 },
        b: { id: "b", title: "b", status: "running", cols: 80, rows: 24 },
      },
      layout: {
        type: "split",
        dir: "h",
        ratio: 0.5,
        a: { type: "leaf", id: "a" },
        b: { type: "leaf", id: "b" },
      },
      focusedPath: [1],
    });

    const { getByTitle } = render(<Toolbar />);
    fireEvent.click(getByTitle("Close pane (Ctrl+W)"));
    // closePane is async; let it settle.
    await vi.waitFor(() => {
      const state = useTerminalStore.getState();
      expect(state.layout.type).toBe("leaf");
      expect(state.sessions["b"]).toBeUndefined(); // killed + removed
    });
  });
});
