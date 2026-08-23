import { describe, it, expect, vi, beforeEach } from "vitest";
import { StrictMode } from "react";
import { render, waitFor, within } from "@testing-library/react";
import { useTerminalStore } from "../store/terminalStore";
import { SessionLeaf } from "./SessionLeaf";
import * as transport from "../lib/pty/transport";

vi.mock("./TerminalPane", () => ({
  TerminalPane: ({ id, path }: { id: string; path?: number[] }) => (
    <div className="terminal-pane" data-testid={id} data-path={path?.join(".")} />
  ),
}));

vi.mock("../lib/pty/transport", () => ({
  ptySpawn: vi.fn(),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  ptyResize: vi.fn().mockResolvedValue(undefined),
  ptyAck: vi.fn().mockResolvedValue(undefined),
  ptyWrite: vi.fn(),
  saveLayout: vi.fn().mockResolvedValue(undefined),
  loadLayout: vi.fn().mockResolvedValue(null),
  saveScrollback: vi.fn().mockResolvedValue(undefined),
  loadScrollback: vi.fn().mockResolvedValue(null),
  deleteScrollback: vi.fn().mockResolvedValue(undefined),
  cleanupStaleScrollbacks: vi.fn().mockResolvedValue(undefined),
  onPtyCwd: vi.fn(),
  onWorktreeChanged: vi.fn().mockResolvedValue(() => {}),
  worktreeList: vi.fn().mockResolvedValue([]),
  worktreePs: vi.fn().mockResolvedValue([]),
  worktreeCreate: vi.fn(),
  worktreeSet: vi.fn().mockResolvedValue(null),
  worktreeShow: vi.fn().mockResolvedValue(null),
  worktreeCurrent: vi.fn().mockResolvedValue(null),
  worktreeRemove: vi.fn().mockResolvedValue(undefined),
  worktreePurge: vi.fn().mockResolvedValue(undefined),
  worktreeLineage: vi.fn().mockResolvedValue([]),
  repoAdd: vi.fn().mockResolvedValue([]),
  repoList: vi.fn().mockResolvedValue([]),
  onPtyData: vi.fn(),
  onPtyExit: vi.fn(),
}));

const ptySpawnMock = vi.mocked(transport.ptySpawn);

function running(id: string) {
  return { id, title: id, status: "running" as const, cols: 80, rows: 24 };
}

// Mirrors how PaneSplit feeds SessionLeaf: every leaf id in the layout tree
// gets a SessionLeaf, so a spawn-swap re-renders the leaf with the real
// session id and a placeholder stays mounted even when a split wraps it.
function LeafHarness() {
  const layout = useTerminalStore((s) => s.layout);
  const renderNode = (node: ReturnType<typeof useTerminalStore.getState>["layout"], path: number[]): React.ReactNode => {
    if (node.type === "leaf") {
      return <SessionLeaf key={path.join(".")} id={node.id} />;
    }
    return (
      <div key={path.join(".")}>
        {renderNode(node.a, [...path, 0])}
        {renderNode(node.b, [...path, 1])}
      </div>
    );
  };
  return <div>{renderNode(layout, [])}</div>;
}

describe("SessionLeaf", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTerminalStore.setState({ sessions: {}, layout: { type: "leaf", id: "" } });
  });

  it("spawns a session for a leaf id that has none, then renders the terminal", async () => {
    ptySpawnMock.mockResolvedValue({ id: "s1", is_new: true, pid: 100 });
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

  it("spawns a session with geometry computed from container dimensions when available", async () => {
    ptySpawnMock.mockResolvedValue({ id: "s1", is_new: true, pid: 100 });

    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = vi.fn().mockReturnValue({
      width: 900,
      height: 720,
      top: 0,
      left: 0,
      bottom: 720,
      right: 900,
    });

    try {
      render(<LeafHarness />);

      await waitFor(() => expect(ptySpawnMock).toHaveBeenCalledTimes(1));
      // Default appearance (fontSize 14, lineHeight 1.2) estimates an
      // 8x17 cell: 900/8 = 112 cols, 720/17 = 42 rows.
      expect(ptySpawnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          cols: 112,
          rows: 42,
        }),
      );
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    }
  });

  it("renders the terminal immediately when the session already exists", () => {
    ptySpawnMock.mockResolvedValue({ id: "unused", is_new: true, pid: 100 });
    useTerminalStore.setState({
      sessions: { s1: running("s1") },
      layout: { type: "leaf", id: "s1" },
    });

    const { container } = render(<SessionLeaf id="s1" />);
    expect(ptySpawnMock).not.toHaveBeenCalled();
    expect(within(container).queryByTestId("s1")).not.toBeNull();
  });

  it("does not double-spawn under StrictMode", async () => {
    ptySpawnMock.mockResolvedValue({ id: "s1", is_new: true, pid: 100 });
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
    ptySpawnMock.mockResolvedValue({ id: "unused", is_new: true, pid: 100 });
    useTerminalStore.setState({
      sessions: { s1: running("s1") },
      layout: { type: "leaf", id: "s1" },
    });

    const { rerender } = render(<SessionLeaf id="s1" />);
    rerender(<SessionLeaf id="s1" />);
    expect(ptySpawnMock).not.toHaveBeenCalled();
  });

  it("shows a loading placeholder while the spawn is in flight", async () => {
    let resolveSpawn!: (res: transport.PtySpawnResult) => void;
    ptySpawnMock.mockReturnValue(
      new Promise<transport.PtySpawnResult>((resolve) => {
        resolveSpawn = resolve;
      }),
    );

    const { container } = render(<LeafHarness />);
    expect(ptySpawnMock).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(container.querySelector(".session-leaf-loading")).not.toBeNull(),
    );

    resolveSpawn({ id: "s1", is_new: true, pid: 100 });
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
    let resolveSpawn!: (res: transport.PtySpawnResult) => void;
    ptySpawnMock.mockReturnValue(
      new Promise<transport.PtySpawnResult>((resolve) => {
        resolveSpawn = resolve;
      }),
    );

    const { unmount } = render(<LeafHarness />);
    expect(ptySpawnMock).toHaveBeenCalledTimes(1);
    unmount();

    // Real unmount detaches the node, so the late resolution must not swap
    // the layout (the leaf is gone). The orphan session itself stays in the
    // store — killing it is the session owner's job, not the view's.
    resolveSpawn({ id: "late", is_new: true, pid: 100 });
    await waitFor(() =>
      expect(useTerminalStore.getState().sessions["late"]).toBeDefined(),
    );
    expect(useTerminalStore.getState().layout).toEqual({ type: "leaf", id: "" });
  });

  it("substitutes the placeholder id everywhere when the user splits before the spawn resolves", async () => {
    let resolveSpawn!: (res: transport.PtySpawnResult) => void;
    ptySpawnMock.mockReturnValue(
      new Promise<transport.PtySpawnResult>((resolve) => {
        resolveSpawn = resolve;
      }),
    );

    // Root placeholder leaf (fresh start) begins spawning.
    useTerminalStore.setState({ layout: { type: "leaf", id: "" } });
    const { container } = render(<LeafHarness />);
    expect(ptySpawnMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".session-leaf-loading")).not.toBeNull();

    // The user splits before the spawn resolves: splitPane spawns a real
    // session for the new leaf and wraps the placeholder as a child.
    ptySpawnMock.mockResolvedValueOnce({ id: "other", is_new: true, pid: 100 });
    await useTerminalStore.getState().splitPane("h");
    expect(useTerminalStore.getState().layout).toEqual({
      type: "split",
      dir: "h",
      ratio: 0.5,
      a: { type: "leaf", id: "" },
      b: { type: "leaf", id: "other" },
    });

    // The original spawn now resolves: the placeholder id must be replaced
    // wherever it still occurs in the tree — no placeholder may remain and
    // the real session must be referenced by the tree.
    resolveSpawn({ id: "s1", is_new: true, pid: 100 });
    await waitFor(() =>
      expect(useTerminalStore.getState().layout).toEqual({
        type: "split",
        dir: "h",
        ratio: 0.5,
        a: { type: "leaf", id: "s1" },
        b: { type: "leaf", id: "other" },
      }),
    );
    const layout = useTerminalStore.getState().layout;
    expect(JSON.stringify(layout)).not.toContain('"id":""');
    expect(useTerminalStore.getState().sessions["s1"]).toBeDefined();
    expect(useTerminalStore.getState().sessions["other"]).toBeDefined();
  });

  it("passes path prop through to TerminalPane", () => {
    useTerminalStore.setState({
      sessions: { s1: running("s1") },
      layout: { type: "leaf", id: "s1" },
    });

    const { container } = render(<SessionLeaf id="s1" path={[0, 1]} />);
    const pane = container.querySelector(".terminal-pane");
    expect(pane?.getAttribute("data-path")).toBe("0.1");
  });

  it("displays loading shimmer when session has status sleeping", () => {
    useTerminalStore.setState({
      sessions: {
        s1: {
          id: "s1",
          title: "Sleeping Session",
          status: "sleeping",
          cwd: "/home/user/proj",
          cols: 80,
          rows: 24,
        },
      },
      layout: { type: "leaf", id: "s1" },
    });

    const { container } = render(<SessionLeaf id="s1" />);
    expect(ptySpawnMock).not.toHaveBeenCalled();
    const skeleton = container.querySelector(".session-leaf-loading.terminal-loading-skeleton");
    expect(skeleton).not.toBeNull();
    expect(container.querySelector(".terminal-loading-shimmer")).not.toBeNull();
    expect(container.querySelector(".terminal-pane")).toBeNull();
  });

  it("displays loading shimmer when session has status restoring", () => {
    useTerminalStore.setState({
      sessions: {
        s1: {
          id: "s1",
          title: "Restoring Session",
          status: "restoring",
          cwd: "/home/user/proj",
          cols: 80,
          rows: 24,
        },
      },
      layout: { type: "leaf", id: "s1" },
    });

    const { container } = render(<SessionLeaf id="s1" />);
    expect(ptySpawnMock).not.toHaveBeenCalled();
    const skeleton = container.querySelector(".session-leaf-loading.terminal-loading-skeleton");
    expect(skeleton).not.toBeNull();
    expect(container.querySelector(".terminal-loading-shimmer")).not.toBeNull();
    expect(container.querySelector(".terminal-pane")).toBeNull();
  });
});
