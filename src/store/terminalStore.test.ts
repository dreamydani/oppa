import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTerminalStore } from "./terminalStore";
import * as transport from "../lib/pty/transport";

vi.mock("../lib/pty/transport", () => ({
  ptySpawn: vi.fn(),
  ptyKill: vi.fn(),
  ptyResize: vi.fn().mockResolvedValue(undefined),
  ptyAck: vi.fn().mockResolvedValue(undefined),
  saveLayout: vi.fn(),
  loadLayout: vi.fn(),
}));

const ptySpawnMock = vi.mocked(transport.ptySpawn);
const ptyKillMock = vi.mocked(transport.ptyKill);
const saveLayoutMock = vi.mocked(transport.saveLayout);
const loadLayoutMock = vi.mocked(transport.loadLayout);

describe("terminalStore", () => {
  beforeEach(() => {
    useTerminalStore.setState({
      sessions: {},
      layout: { type: "leaf", id: "" },
    });
    vi.clearAllMocks();
  });

  it("spawnSession calls transport and tracks the new session as running", async () => {
    ptySpawnMock.mockResolvedValue("abc");
    await useTerminalStore.getState().spawnSession();
    expect(ptySpawnMock).toHaveBeenCalledWith(undefined); // transport maps undefined -> {} for invoke
    const session = useTerminalStore.getState().sessions["abc"];
    expect(session).toBeDefined();
    expect(session.id).toBe("abc");
    expect(session.status).toBe("running");
    expect(session.cols).toBe(80);
    expect(session.rows).toBe(24);
  });

  it("spawnSession forwards cwd and stores it on the session", async () => {
    ptySpawnMock.mockResolvedValue("def");
    await useTerminalStore.getState().spawnSession("C:\\work");
    expect(ptySpawnMock).toHaveBeenCalledWith({ cwd: "C:\\work" });
    expect(useTerminalStore.getState().sessions["def"].cwd).toBe("C:\\work");
  });

  it("spawnSession records an error status when spawn fails", async () => {
    ptySpawnMock.mockRejectedValue(new Error("shell not found"));
    await useTerminalStore.getState().spawnSession();
    const sessions = useTerminalStore.getState().sessions;
    const failed = Object.values(sessions)[0];
    expect(failed).toBeDefined();
    expect(failed.status).toBe("error");
  });

  it("killSession kills the pty and marks the session exited", async () => {
    useTerminalStore.setState({
      sessions: {
        abc: { id: "abc", title: "abc", status: "running", cols: 80, rows: 24 },
      },
    });
    ptyKillMock.mockResolvedValue(undefined);
    await useTerminalStore.getState().killSession("abc");
    expect(ptyKillMock).toHaveBeenCalledWith("abc");
    expect(useTerminalStore.getState().sessions["abc"].status).toBe("exited");
  });

  it("killSession marks the session exited even when the kill rejects", async () => {
    useTerminalStore.setState({
      sessions: {
        abc: { id: "abc", title: "abc", status: "running", cols: 80, rows: 24 },
      },
    });
    ptyKillMock.mockRejectedValue(new Error("no such session"));
    await expect(useTerminalStore.getState().killSession("abc")).resolves.toBeUndefined();
    expect(useTerminalStore.getState().sessions["abc"].status).toBe("exited");
  });

  it("resizeSession updates cols and rows", () => {
    useTerminalStore.setState({
      sessions: {
        abc: { id: "abc", title: "abc", status: "running", cols: 80, rows: 24 },
      },
    });
    useTerminalStore.getState().resizeSession("abc", 120, 40);
    const session = useTerminalStore.getState().sessions["abc"];
    expect(session.cols).toBe(120);
    expect(session.rows).toBe(40);
  });

  it("ackSession forwards the char count to the transport", () => {
    const ptyAckMock = vi.mocked(transport.ptyAck);
    useTerminalStore.getState().ackSession("abc", 128);
    expect(ptyAckMock).toHaveBeenCalledWith("abc", 128);
  });

  it("setSessionStatus updates a session's status", () => {
    useTerminalStore.setState({
      sessions: {
        abc: { id: "abc", title: "abc", status: "running", cols: 80, rows: 24 },
      },
    });
    useTerminalStore.getState().setSessionStatus("abc", "exited");
    expect(useTerminalStore.getState().sessions["abc"].status).toBe("exited");
  });

  it("setLayout replaces the layout tree", () => {
    const split = {
      type: "split",
      dir: "h",
      ratio: 0.5,
      a: { type: "leaf", id: "a" },
      b: { type: "leaf", id: "b" },
    } as const;
    useTerminalStore.getState().setLayout(split);
    expect(useTerminalStore.getState().layout).toEqual(split);
  });

  it("splitPane spawns a session, splits the layout, and focuses the new leaf", async () => {
    ptySpawnMock.mockResolvedValue("s1");
    useTerminalStore.setState({
      layout: { type: "leaf", id: "root" },
      focusedPath: [],
    });
    await useTerminalStore.getState().splitPane("h");
    expect(ptySpawnMock).toHaveBeenCalledTimes(1);
    const { layout, focusedPath, sessions } = useTerminalStore.getState();
    expect(layout).toEqual({
      type: "split",
      dir: "h",
      ratio: 0.5,
      a: { type: "leaf", id: "root" },
      b: { type: "leaf", id: "s1" },
    });
    expect(focusedPath).toEqual([1]);
    expect(sessions["s1"]).toBeDefined();
  });

  it("splitPane splits at an explicit path", async () => {
    ptySpawnMock.mockResolvedValue("s2");
    useTerminalStore.setState({
      layout: {
        type: "split",
        dir: "h",
        ratio: 0.5,
        a: { type: "leaf", id: "x" },
        b: { type: "leaf", id: "y" },
      },
      focusedPath: [1],
    });
    await useTerminalStore.getState().splitPane("v", [0]);
    const { layout, focusedPath } = useTerminalStore.getState();
    expect(layout).toEqual({
      type: "split",
      dir: "h",
      ratio: 0.5,
      a: {
        type: "split",
        dir: "v",
        ratio: 0.5,
        a: { type: "leaf", id: "x" },
        b: { type: "leaf", id: "s2" },
      },
      b: { type: "leaf", id: "y" },
    });
    expect(focusedPath).toEqual([0, 1]);
  });

  it("closePane removes the leaf, kills its session, and re-focuses a remaining leaf", async () => {
    ptyKillMock.mockResolvedValue(undefined);
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
      focusedPath: [0],
    });
    await useTerminalStore.getState().closePane();
    expect(ptyKillMock).toHaveBeenCalledWith("a");
    const { layout, focusedPath } = useTerminalStore.getState();
    expect(layout).toEqual({ type: "leaf", id: "b" });
    expect(focusedPath).toEqual([]);
  });

  it("closePane resets to a fresh empty leaf when the last pane is closed", async () => {
    ptyKillMock.mockResolvedValue(undefined);
    useTerminalStore.setState({
      sessions: {
        a: { id: "a", title: "a", status: "running", cols: 80, rows: 24 },
      },
      layout: { type: "leaf", id: "a" },
      focusedPath: [],
    });
    await useTerminalStore.getState().closePane();
    expect(ptyKillMock).toHaveBeenCalledWith("a");
    const { layout, focusedPath } = useTerminalStore.getState();
    expect(layout).toEqual({ type: "leaf", id: "" });
    expect(focusedPath).toEqual([]);
  });

  it("closePane kills no session when the removed leaf has none", async () => {
    ptyKillMock.mockResolvedValue(undefined);
    useTerminalStore.setState({
      sessions: {},
      layout: { type: "leaf", id: "orphan" },
      focusedPath: [],
    });
    await useTerminalStore.getState().closePane();
    expect(ptyKillMock).not.toHaveBeenCalled();
    expect(useTerminalStore.getState().layout).toEqual({ type: "leaf", id: "" });
  });

  it("closePane deletes the removed leaf's session from the store", async () => {
    ptyKillMock.mockResolvedValue(undefined);
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
      focusedPath: [0],
    });
    await useTerminalStore.getState().closePane();
    expect(ptyKillMock).toHaveBeenCalledWith("a");
    const sessions = useTerminalStore.getState().sessions;
    expect(sessions["a"]).toBeUndefined(); // pruned leaf id is gone from the tree
    expect(sessions["b"]).toBeDefined();
  });

  it("closePane deletes the last session when the final pane is closed", async () => {
    ptyKillMock.mockResolvedValue(undefined);
    useTerminalStore.setState({
      sessions: {
        a: { id: "a", title: "a", status: "running", cols: 80, rows: 24 },
      },
      layout: { type: "leaf", id: "a" },
      focusedPath: [],
    });
    await useTerminalStore.getState().closePane();
    expect(ptyKillMock).toHaveBeenCalledWith("a");
    expect(useTerminalStore.getState().sessions).toEqual({});
  });

  it("closePane re-focuses the depth-first leftmost remaining leaf via firstLeafPath", async () => {
    ptyKillMock.mockResolvedValue(undefined);
    useTerminalStore.setState({
      sessions: {
        a: { id: "a", title: "a", status: "running", cols: 80, rows: 24 },
        b: { id: "b", title: "b", status: "running", cols: 80, rows: 24 },
        c: { id: "c", title: "c", status: "running", cols: 80, rows: 24 },
        d: { id: "d", title: "d", status: "running", cols: 80, rows: 24 },
      },
      layout: {
        type: "split",
        dir: "h",
        ratio: 0.5,
        a: {
          type: "split",
          dir: "h",
          ratio: 0.5,
          a: { type: "leaf", id: "a" },
          b: { type: "leaf", id: "b" },
        },
        b: {
          type: "split",
          dir: "v",
          ratio: 0.5,
          a: { type: "leaf", id: "c" },
          b: { type: "leaf", id: "d" },
        },
      },
      focusedPath: [1, 1], // close the deep right-bottom leaf
    });
    await useTerminalStore.getState().closePane();
    expect(ptyKillMock).toHaveBeenCalledWith("d");
    const { layout, focusedPath } = useTerminalStore.getState();
    expect(layout).toEqual({
      type: "split",
      dir: "h",
      ratio: 0.5,
      a: {
        type: "split",
        dir: "h",
        ratio: 0.5,
        a: { type: "leaf", id: "a" },
        b: { type: "leaf", id: "b" },
      },
      b: { type: "leaf", id: "c" },
    });
    expect(focusedPath).toEqual([0, 0]); // leftmost leaf at depth, via firstLeafPath
  });

  it("focusPane sets the focused path", () => {
    useTerminalStore.getState().focusPane([0, 1]);
    expect(useTerminalStore.getState().focusedPath).toEqual([0, 1]);
  });

  it("moveFocus moves to a sibling in a matching split", () => {
    useTerminalStore.setState({
      layout: {
        type: "split",
        dir: "h",
        ratio: 0.5,
        a: { type: "leaf", id: "a" },
        b: { type: "leaf", id: "b" },
      },
      focusedPath: [0],
    });
    useTerminalStore.getState().moveFocus("right");
    expect(useTerminalStore.getState().focusedPath).toEqual([1]);
    useTerminalStore.getState().moveFocus("left");
    expect(useTerminalStore.getState().focusedPath).toEqual([0]);
  });

  it("moveFocus uses the nearest matching ancestor split", () => {
    useTerminalStore.setState({
      layout: {
        type: "split",
        dir: "h",
        ratio: 0.5,
        a: {
          type: "split",
          dir: "h",
          ratio: 0.5,
          a: { type: "leaf", id: "a" },
          b: { type: "leaf", id: "b" },
        },
        b: { type: "leaf", id: "c" },
      },
      focusedPath: [0, 0],
    });
    useTerminalStore.getState().moveFocus("right");
    expect(useTerminalStore.getState().focusedPath).toEqual([0, 1]);
  });

  it("moveFocus moves up/down through vertical splits", () => {
    useTerminalStore.setState({
      layout: {
        type: "split",
        dir: "v",
        ratio: 0.5,
        a: { type: "leaf", id: "top" },
        b: { type: "leaf", id: "bottom" },
      },
      focusedPath: [0],
    });
    useTerminalStore.getState().moveFocus("down");
    expect(useTerminalStore.getState().focusedPath).toEqual([1]);
  });

  it("moveFocus no-ops when the axis has no matching split", () => {
    useTerminalStore.setState({
      layout: {
        type: "split",
        dir: "h",
        ratio: 0.5,
        a: { type: "leaf", id: "a" },
        b: { type: "leaf", id: "b" },
      },
      focusedPath: [0],
    });
    useTerminalStore.getState().moveFocus("up"); // vertical axis, only horizontal splits
    expect(useTerminalStore.getState().focusedPath).toEqual([0]);
    useTerminalStore.getState().moveFocus("left"); // already at the left edge
    expect(useTerminalStore.getState().focusedPath).toEqual([0]);
  });

  it("moveFocus no-ops at a single-leaf root", () => {
    useTerminalStore.setState({
      layout: { type: "leaf", id: "a" },
      focusedPath: [],
    });
    useTerminalStore.getState().moveFocus("right");
    expect(useTerminalStore.getState().focusedPath).toEqual([]);
  });

  describe("setRatio", () => {
    it("updates the ratio of the split at the given path", () => {
      useTerminalStore.setState({
        layout: {
          type: "split",
          dir: "h",
          ratio: 0.5,
          a: { type: "leaf", id: "a" },
          b: { type: "leaf", id: "b" },
        },
      });
      useTerminalStore.getState().setRatio([], 0.75);
      const layout = useTerminalStore.getState().layout;
      expect(layout).toEqual({
        type: "split",
        dir: "h",
        ratio: 0.75,
        a: { type: "leaf", id: "a" },
        b: { type: "leaf", id: "b" },
      });
    });

    it("updates a nested split ratio without touching the others", () => {
      useTerminalStore.setState({
        layout: {
          type: "split",
          dir: "h",
          ratio: 0.5,
          a: {
            type: "split",
            dir: "v",
            ratio: 0.4,
            a: { type: "leaf", id: "a" },
            b: { type: "leaf", id: "b" },
          },
          b: { type: "leaf", id: "c" },
        },
      });
      useTerminalStore.getState().setRatio([0], 0.6);
      const { layout } = useTerminalStore.getState();
      if (layout.type !== "split") throw new Error("expected split root");
      expect(layout.ratio).toBe(0.5); // outer split untouched
      if (layout.a.type !== "split") throw new Error("expected nested split");
      expect(layout.a.ratio).toBe(0.6); // nested split updated
    });

    it("clamps the ratio to the valid range", () => {
      useTerminalStore.setState({
        layout: {
          type: "split",
          dir: "h",
          ratio: 0.5,
          a: { type: "leaf", id: "a" },
          b: { type: "leaf", id: "b" },
        },
      });
      useTerminalStore.getState().setRatio([], 1.5);
      const afterHigh = useTerminalStore.getState().layout;
      if (afterHigh.type !== "split") throw new Error("expected split root");
      expect(afterHigh.ratio).toBe(1);
      useTerminalStore.getState().setRatio([], -0.2);
      const afterLow = useTerminalStore.getState().layout;
      if (afterLow.type !== "split") throw new Error("expected split root");
      expect(afterLow.ratio).toBe(0);
    });

    it("no-ops when the path points at a leaf", () => {
      useTerminalStore.setState({
        layout: {
          type: "split",
          dir: "h",
          ratio: 0.5,
          a: { type: "leaf", id: "a" },
          b: { type: "leaf", id: "b" },
        },
      });
      // Leaf at [0] — no split to resize, tree must stay untouched.
      useTerminalStore.getState().setRatio([0], 0.9);
      const after = useTerminalStore.getState().layout;
      if (after.type !== "split") throw new Error("expected split root");
      expect(after.ratio).toBe(0.5);
    });
  });

  describe("saveLayout", () => {
    it("serializes the current layout + session state to the transport", async () => {
      useTerminalStore.setState({
        sessions: {
          a: { id: "a", title: "a", status: "running", cwd: "C:\\work", cols: 120, rows: 40 },
          b: { id: "b", title: "b", status: "exited", cols: 80, rows: 24 },
        },
        layout: {
          type: "split",
          dir: "h",
          ratio: 0.4,
          a: { type: "leaf", id: "a" },
          b: { type: "leaf", id: "b" },
        },
      });
      await useTerminalStore.getState().saveLayout();
      expect(saveLayoutMock).toHaveBeenCalledTimes(1);
      const json = saveLayoutMock.mock.calls[0][0];
      const parsed = JSON.parse(json);
      expect(parsed).toEqual({
        layout: {
          type: "split",
          dir: "h",
          ratio: 0.4,
          a: { type: "leaf", id: "a" },
          b: { type: "leaf", id: "b" },
        },
        sessions: [
          { id: "a", title: "a", status: "running", cwd: "C:\\work", cols: 120, rows: 40 },
          { id: "b", title: "b", status: "exited", cols: 80, rows: 24 },
        ],
      });
    });

    it("propagates transport failures instead of swallowing them", async () => {
      saveLayoutMock.mockRejectedValue(new Error("disk full"));
      await expect(useTerminalStore.getState().saveLayout()).rejects.toThrow(
        "disk full",
      );
    });
  });

  describe("loadLayout", () => {
    beforeEach(() => {
      // Default: no saved layout (fresh start).
      loadLayoutMock.mockResolvedValue(null);
      ptySpawnMock.mockResolvedValue("s1");
    });

    it("does nothing when no layout was saved", async () => {
      await useTerminalStore.getState().loadLayout();
      expect(ptySpawnMock).not.toHaveBeenCalled();
      expect(useTerminalStore.getState().layout).toEqual({ type: "leaf", id: "" });
    });

    it("spawns a fresh shell per saved leaf and maps saved ids to the new session ids", async () => {
      loadLayoutMock.mockResolvedValue(
        JSON.stringify({
          layout: {
            type: "split",
            dir: "h",
            ratio: 0.5,
            a: {
              type: "split",
              dir: "v",
              ratio: 0.3,
              a: { type: "leaf", id: "old-left" },
              b: { type: "leaf", id: "old-top" },
            },
            b: { type: "leaf", id: "old-right" },
          },
          sessions: [
            { id: "old-left", title: "left", status: "running", cwd: "C:\\a", cols: 80, rows: 24 },
            { id: "old-top", title: "top", status: "running", cwd: "C:\\b", cols: 80, rows: 24 },
            { id: "old-right", title: "right", status: "running", cwd: "C:\\c", cols: 80, rows: 24 },
          ],
        }),
      );
      // Deterministic DFS leaf order: old-left, old-top, old-right.
      ptySpawnMock
        .mockResolvedValueOnce("new-left")
        .mockResolvedValueOnce("new-top")
        .mockResolvedValueOnce("new-right");

      await useTerminalStore.getState().loadLayout();

      // Restored sessions are fresh shells: spawned with the saved cwd, and
      // their NEW ids (not the stale saved ones) back the tree + store.
      expect(ptySpawnMock.mock.calls.map((c) => c[0])).toEqual([
        { cwd: "C:\\a" },
        { cwd: "C:\\b" },
        { cwd: "C:\\c" },
      ]);
      const { layout, sessions } = useTerminalStore.getState();
      expect(layout).toEqual({
        type: "split",
        dir: "h",
        ratio: 0.5,
        a: {
          type: "split",
          dir: "v",
          ratio: 0.3,
          a: { type: "leaf", id: "new-left" },
          b: { type: "leaf", id: "new-top" },
        },
        b: { type: "leaf", id: "new-right" },
      });
      expect(Object.keys(sessions)).toEqual(["new-left", "new-top", "new-right"]);
      expect(sessions["new-left"].cwd).toBe("C:\\a");
      expect(JSON.stringify(layout)).not.toContain("old-");
    });

    it("keeps a leaf as an error session when its spawn fails", async () => {
      loadLayoutMock.mockResolvedValue(
        JSON.stringify({
          layout: { type: "leaf", id: "old-a" },
          sessions: [{ id: "old-a", title: "a", status: "running", cwd: "C:\\gone", cols: 80, rows: 24 }],
        }),
      );
      ptySpawnMock.mockRejectedValue(new Error("cwd not found"));

      await useTerminalStore.getState().loadLayout();

      const { layout, sessions } = useTerminalStore.getState();
      const restoredId = (layout as { type: "leaf"; id: string }).id;
      expect(restoredId).not.toBe("old-a");
      expect(sessions[restoredId]?.status).toBe("error");
      expect(sessions[restoredId]?.cwd).toBe("C:\\gone");
    });

    it("leaves the store untouched when the saved JSON is malformed", async () => {
      loadLayoutMock.mockResolvedValue("{not valid json");
      await expect(useTerminalStore.getState().loadLayout()).rejects.toThrow();
      expect(ptySpawnMock).not.toHaveBeenCalled();
      expect(useTerminalStore.getState().layout).toEqual({ type: "leaf", id: "" });
    });
  });
});
