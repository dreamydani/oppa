import { describe, it, expect, vi, beforeEach } from "vitest";
import { StrictMode } from "react";
import { render, waitFor, within } from "@testing-library/react";
import { useTerminalStore } from "../store/terminalStore";
import { SessionLeaf } from "./SessionLeaf";
import * as transport from "../lib/pty/transport";

vi.mock("./TerminalPane", () => ({
  TerminalPane: ({ id }: { id: string }) => (
    <div className="terminal-pane" data-testid={id} />
  ),
}));

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

function running(id: string) {
  return { id, title: id, status: "running" as const, cols: 80, rows: 24 };
}

// Mirrors how PaneSplit feeds SessionLeaf: the leaf id comes from the layout
// tree, so a spawn-swap re-renders the leaf with the real session id.
function LeafHarness() {
  const layout = useTerminalStore((s) => s.layout);
  if (layout.type !== "leaf") return null;
  return <SessionLeaf id={layout.id} />;
}

describe("SessionLeaf", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTerminalStore.setState({ sessions: {}, layout: { type: "leaf", id: "" } });
  });

  it("spawns a session for a leaf id that has none, then renders the terminal", async () => {
    ptySpawnMock.mockResolvedValue("s1");
    // The fresh-start layout has a root leaf with no session yet; SessionLeaf
    // must spawn one and swap the leaf id.
    const { container } = render(<LeafHarness />);

    await waitFor(() => expect(ptySpawnMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(useTerminalStore.getState().layout).toEqual({
        type: "leaf",
        id: "s1",
      }),
    );
    // The real session id replaces the placeholder leaf id in the tree.
    expect(useTerminalStore.getState().sessions["s1"]).toBeDefined();
    // And the pane for it is on screen.
    await waitFor(() =>
      expect(within(container).queryByTestId("s1")).not.toBeNull(),
    );
  });

  it("renders the terminal immediately when the session already exists", () => {
    ptySpawnMock.mockResolvedValue("unused");
    useTerminalStore.setState({
      sessions: { s1: running("s1") },
      layout: { type: "leaf", id: "s1" },
    });

    const { container } = render(<SessionLeaf id="s1" />);
    expect(ptySpawnMock).not.toHaveBeenCalled();
    expect(within(container).queryByTestId("s1")).not.toBeNull();
  });

  it("does not double-spawn under StrictMode", async () => {
    ptySpawnMock.mockResolvedValue("s1");
    render(
      <StrictMode>
        <LeafHarness />
      </StrictMode>,
    );

    await waitFor(() =>
      expect(useTerminalStore.getState().sessions["s1"]).toBeDefined(),
    );
    await waitFor(() => expect(ptySpawnMock).toHaveBeenCalledTimes(1));
  });

  it("does not spawn a second session when the id was already swapped in", async () => {
    // The store already has a session for the leaf id (id swap happened on a
    // previous render); SessionLeaf must reuse it, not spawn again.
    ptySpawnMock.mockResolvedValue("unused");
    useTerminalStore.setState({
      sessions: { s1: running("s1") },
      layout: { type: "leaf", id: "s1" },
    });

    const { rerender } = render(<SessionLeaf id="s1" />);
    rerender(<SessionLeaf id="s1" />);
    expect(ptySpawnMock).not.toHaveBeenCalled();
  });

  it("shows a loading placeholder while the spawn is in flight", async () => {
    let resolveSpawn!: (id: string) => void;
    ptySpawnMock.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveSpawn = resolve;
      }),
    );

    const { container } = render(<LeafHarness />);
    expect(ptySpawnMock).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(container.querySelector(".session-leaf-loading")).not.toBeNull(),
    );

    resolveSpawn("s1");
    await waitFor(() =>
      expect(within(container).queryByTestId("s1")).not.toBeNull(),
    );
  });

  it("renders the store's error session when the spawn fails", async () => {
    ptySpawnMock.mockRejectedValue(new Error("shell not found"));
    render(<LeafHarness />);

    // The store records an error session under a fresh id and swaps the leaf.
    await waitFor(() => {
      const { sessions, layout } = useTerminalStore.getState();
      if (layout.type !== "leaf") throw new Error("expected leaf root");
      expect(layout.id).not.toBe("");
      expect(sessions[layout.id]?.status).toBe("error");
    });
  });

  it("does not swap the layout when unmounted before the spawn resolves", async () => {
    let resolveSpawn!: (id: string) => void;
    ptySpawnMock.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveSpawn = resolve;
      }),
    );

    const { unmount } = render(<LeafHarness />);
    expect(ptySpawnMock).toHaveBeenCalledTimes(1);
    unmount();

    // Real unmount detaches the node, so the late resolution must not swap
    // the layout (the leaf is gone). The orphan session itself stays in the
    // store — killing it is the session owner's job, not the view's.
    resolveSpawn("late");
    await waitFor(() =>
      expect(useTerminalStore.getState().sessions["late"]).toBeDefined(),
    );
    expect(useTerminalStore.getState().layout).toEqual({ type: "leaf", id: "" });
  });
});
