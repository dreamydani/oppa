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
  saveScrollback: vi.fn().mockResolvedValue(undefined),
  loadScrollback: vi.fn().mockResolvedValue(null),
  deleteScrollback: vi.fn().mockResolvedValue(undefined),
  cleanupStaleScrollbacks: vi.fn().mockResolvedValue(undefined),
}));

const ptySpawnMock = vi.mocked(transport.ptySpawn);
const ptyKillMock = vi.mocked(transport.ptyKill);
const saveLayoutMock = vi.mocked(transport.saveLayout);
const loadLayoutMock = vi.mocked(transport.loadLayout);
const saveScrollbackMock = vi.mocked(transport.saveScrollback);
const loadScrollbackMock = vi.mocked(transport.loadScrollback);
const deleteScrollbackMock = vi.mocked(transport.deleteScrollback);
const cleanupStaleScrollbacksMock = vi.mocked(transport.cleanupStaleScrollbacks);

describe("terminalStore", () => {
  beforeEach(() => {
    saveLayoutMock.mockResolvedValue(undefined);
    loadLayoutMock.mockResolvedValue(null);
    useTerminalStore.setState({
      sessions: {},
      tabs: [{ id: "tab-1", layout: { type: "leaf", id: "" }, focusedPath: [] }],
      activeTabId: "tab-1",
      layout: { type: "leaf", id: "" },
      focusedPath: [],
      serializers: {},
      cachedScrollbacks: {},
      restoredScrollbacks: {},
      ready: false,
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
    // The underlying error message is surfaced on the session so the pane can
    // render something real instead of a hardcoded string.
    expect(failed.error).toBe("shell not found");
  });

  it("spawnSession records a string error when the failure is not an Error", async () => {
    ptySpawnMock.mockRejectedValue("boom");
    await useTerminalStore.getState().spawnSession();
    const sessions = useTerminalStore.getState().sessions;
    const failed = Object.values(sessions)[0];
    expect(failed?.status).toBe("error");
    expect(failed?.error).toBe("boom");
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

  it("updateSessionCwd updates a session's live cwd", () => {
    useTerminalStore.setState({
      sessions: {
        abc: { id: "abc", title: "abc", status: "running", cwd: "C:\\old", cols: 80, rows: 24 },
      },
    });
    useTerminalStore.getState().updateSessionCwd("abc", "C:\\new");
    expect(useTerminalStore.getState().sessions["abc"].cwd).toBe("C:\\new");
  });

  it("updateSessionCwd does nothing if the session does not exist", () => {
    useTerminalStore.setState({
      sessions: {},
    });
    useTerminalStore.getState().updateSessionCwd("nonexistent", "C:\\new");
    expect(useTerminalStore.getState().sessions["nonexistent"]).toBeUndefined();
  });

  it("registerSerializer and unregisterSerializer manage active serializers", () => {
    const fn = () => "test-buffer";
    useTerminalStore.getState().registerSerializer("abc", fn);
    expect(useTerminalStore.getState().serializers["abc"]).toBe(fn);
    useTerminalStore.getState().unregisterSerializer("abc");
    expect(useTerminalStore.getState().serializers["abc"]).toBeUndefined();
  });

  it("cacheScrollback stores buffer in cachedScrollbacks", () => {
    useTerminalStore.getState().cacheScrollback("abc", "cached-buffer-content");
    expect(useTerminalStore.getState().cachedScrollbacks["abc"]).toBe("cached-buffer-content");
  });

  it("setRestoredScrollback and clearRestoredScrollback manage restored scrollback state", () => {
    useTerminalStore.getState().setRestoredScrollback("abc", "restored content");
    expect(useTerminalStore.getState().restoredScrollbacks["abc"]).toBe("restored content");
    useTerminalStore.getState().clearRestoredScrollback("abc");
    expect(useTerminalStore.getState().restoredScrollbacks["abc"]).toBeUndefined();
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

  it("splitPane inherits live cwd from the focused session", async () => {
    ptySpawnMock.mockResolvedValue("s2");
    useTerminalStore.setState({
      sessions: {
        root: { id: "root", title: "root", status: "running", cwd: "D:\\oppa\\project", cols: 80, rows: 24 },
      },
      layout: { type: "leaf", id: "root" },
      focusedPath: [],
    });
    await useTerminalStore.getState().splitPane("v");
    expect(ptySpawnMock).toHaveBeenCalledWith({ cwd: "D:\\oppa\\project" });
    const { layout, focusedPath } = useTerminalStore.getState();
    expect(layout).toEqual({
      type: "split",
      dir: "v",
      ratio: 0.5,
      a: { type: "leaf", id: "root" },
      b: { type: "leaf", id: "s2" },
    });
    expect(focusedPath).toEqual([1]);
  });

  it("splitPane splits at an explicit path and inherits that leaf's cwd", async () => {
    ptySpawnMock.mockResolvedValue("s2");
    useTerminalStore.setState({
      sessions: {
        x: { id: "x", title: "x", status: "running", cwd: "C:\\path\\x", cols: 80, rows: 24 },
        y: { id: "y", title: "y", status: "running", cwd: "C:\\path\\y", cols: 80, rows: 24 },
      },
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
    expect(ptySpawnMock).toHaveBeenCalledWith({ cwd: "C:\\path\\x" });
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

  it("closePane prunes scrollback from disk via deleteScrollback", async () => {
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
    expect(deleteScrollbackMock).toHaveBeenCalledWith("a");
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

  describe("save-on-mutation", () => {
    // The store persists the layout on every structural change so the saved
    // file is always current even if the app is killed without the close
    // handshake running.
    beforeEach(() => {
      useTerminalStore.setState({ ready: true });
    });

    it("createTab persists the new tab layout", async () => {
      ptySpawnMock.mockResolvedValue("s2");
      await useTerminalStore.getState().createTab();
      expect(saveLayoutMock).toHaveBeenCalled();
    });

    it("closeTab persists the layout after closing a tab", async () => {
      useTerminalStore.setState({
        tabs: [
          { id: "t1", layout: { type: "leaf", id: "s1" }, focusedPath: [] },
          { id: "t2", layout: { type: "leaf", id: "s2" }, focusedPath: [] },
        ],
        activeTabId: "t1",
        sessions: {
          s1: { id: "s1", title: "s1", status: "running", cols: 80, rows: 24 },
          s2: { id: "s2", title: "s2", status: "running", cols: 80, rows: 24 },
        },
      });
      saveLayoutMock.mockClear();
      await useTerminalStore.getState().closeTab("t2");
      expect(saveLayoutMock).toHaveBeenCalled();
    });

    it("selectTab persists the new active tab", () => {
      useTerminalStore.setState({
        tabs: [
          { id: "t1", layout: { type: "leaf", id: "s1" }, focusedPath: [] },
          { id: "t2", layout: { type: "leaf", id: "s2" }, focusedPath: [] },
        ],
        activeTabId: "t1",
      });
      saveLayoutMock.mockClear();
      useTerminalStore.getState().selectTab("t2");
      expect(saveLayoutMock).toHaveBeenCalled();
    });

    it("renameTab persists the tab title change", () => {
      useTerminalStore.setState({
        tabs: [{ id: "t1", layout: { type: "leaf", id: "s1" }, focusedPath: [] }],
        activeTabId: "t1",
      });
      saveLayoutMock.mockClear();
      useTerminalStore.getState().renameTab("t1", "New Title");
      expect(saveLayoutMock).toHaveBeenCalled();
    });

    it("splitPane persists the new arrangement", async () => {
      ptySpawnMock.mockResolvedValue("s1");
      await useTerminalStore.getState().splitPane("h");
      expect(saveLayoutMock).toHaveBeenCalled();
    });

    it("closePane persists the arrangement", async () => {
      ptySpawnMock.mockResolvedValue("s1");
      await useTerminalStore.getState().splitPane("h");
      saveLayoutMock.mockClear();
      await useTerminalStore.getState().closePane();
      expect(saveLayoutMock).toHaveBeenCalled();
    });

    it("setRatio persists the new ratio", () => {
      useTerminalStore.setState({
        layout: {
          type: "split",
          dir: "h",
          ratio: 0.5,
          a: { type: "leaf", id: "a" },
          b: { type: "leaf", id: "b" },
        },
      });
      saveLayoutMock.mockClear();
      useTerminalStore.getState().setRatio([], 0.75);
      expect(saveLayoutMock).toHaveBeenCalled();
    });

    it("updateSessionCwd persists the updated cwd", () => {
      useTerminalStore.setState({
        sessions: {
          s1: { id: "s1", title: "s1", status: "running", cwd: "/old/dir", cols: 80, rows: 24 },
        },
      });
      saveLayoutMock.mockClear();
      useTerminalStore.getState().updateSessionCwd("s1", "/new/dir");
      expect(saveLayoutMock).toHaveBeenCalled();
    });

    it("updateSessionCwd does not persist if cwd is unchanged or session is missing", () => {
      useTerminalStore.setState({
        sessions: {
          s1: { id: "s1", title: "s1", status: "running", cwd: "/same/dir", cols: 80, rows: 24 },
        },
      });
      saveLayoutMock.mockClear();
      useTerminalStore.getState().updateSessionCwd("s1", "/same/dir");
      useTerminalStore.getState().updateSessionCwd("nonexistent", "/any/dir");
      expect(saveLayoutMock).not.toHaveBeenCalled();
    });
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
    beforeEach(() => {
      // Ready = startup restore has settled; a real save happens then.
      useTerminalStore.setState({ ready: true });
    });

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
        tabs: [
          {
            id: "tab-1",
            layout: {
              type: "split",
              dir: "h",
              ratio: 0.4,
              a: { type: "leaf", id: "a" },
              b: { type: "leaf", id: "b" },
            },
            focusedPath: [],
          },
        ],
        activeTabId: "tab-1",
        sessions: [
          { id: "a", title: "a", status: "running", cwd: "C:\\work", cols: 120, rows: 40 },
          { id: "b", title: "b", status: "exited", cols: 80, rows: 24 },
        ],
      });
    });

    it("captures active serializer buffers and cleans up stale scrollbacks", async () => {
      useTerminalStore.setState({
        sessions: {
          a: { id: "a", title: "a", status: "running", cols: 80, rows: 24 },
          b: { id: "b", title: "b", status: "running", cols: 80, rows: 24 },
          c: { id: "c", title: "c", status: "exited", cols: 80, rows: 24 },
        },
        serializers: {
          a: () => "buffer-a-content",
          b: () => "",
        },
        layout: {
          type: "split",
          dir: "h",
          ratio: 0.5,
          a: { type: "leaf", id: "a" },
          b: { type: "leaf", id: "b" },
        },
      });
      await useTerminalStore.getState().saveLayout();
      expect(saveScrollbackMock).toHaveBeenCalledWith("a", "buffer-a-content");
      expect(saveScrollbackMock).not.toHaveBeenCalledWith("b", expect.anything());
      expect(cleanupStaleScrollbacksMock).toHaveBeenCalledWith(
        expect.arrayContaining(["a", "b", "c"]),
      );
    });

    it("saves scrollback from cachedScrollbacks when session has no active serializer (background tabs)", async () => {
      useTerminalStore.setState({
        sessions: {
          active: { id: "active", title: "active", status: "running", cols: 80, rows: 24 },
          bg: { id: "bg", title: "bg", status: "running", cols: 80, rows: 24 },
        },
        serializers: {
          active: () => "active-buffer",
        },
        cachedScrollbacks: {
          bg: "bg-cached-buffer",
        },
        layout: {
          type: "leaf",
          id: "active",
        },
      });
      await useTerminalStore.getState().saveLayout();
      expect(saveScrollbackMock).toHaveBeenCalledWith("active", "active-buffer");
      expect(saveScrollbackMock).toHaveBeenCalledWith("bg", "bg-cached-buffer");
    });

    it("propagates transport failures instead of swallowing them", async () => {
      saveLayoutMock.mockRejectedValue(new Error("disk full"));
      await expect(useTerminalStore.getState().saveLayout()).rejects.toThrow(
        "disk full",
      );
    });

    it("skips the save while the store is not ready (mid-restore)", async () => {
      // Not ready: a beforeunload during the startup restore must not
      // overwrite the last good save with a near-empty snapshot.
      useTerminalStore.setState({
        ready: false,
        sessions: {
          a: { id: "a", title: "a", status: "running", cols: 80, rows: 24 },
        },
        layout: { type: "leaf", id: "a" },
      });
      await useTerminalStore.getState().saveLayout();
      expect(saveLayoutMock).not.toHaveBeenCalled();
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

    it("restores saved scrollbacks, sets restored state, and migrates snapshot on disk", async () => {
      loadLayoutMock.mockResolvedValue(
        JSON.stringify({
          layout: {
            type: "split",
            dir: "h",
            ratio: 0.5,
            a: { type: "leaf", id: "old-1" },
            b: { type: "leaf", id: "old-2" },
          },
          sessions: [
            { id: "old-1", title: "s1", status: "running", cwd: "C:\\a", cols: 80, rows: 24 },
            { id: "old-2", title: "s2", status: "running", cwd: "C:\\b", cols: 80, rows: 24 },
          ],
        }),
      );
      ptySpawnMock
        .mockResolvedValueOnce("new-1")
        .mockResolvedValueOnce("new-2");
      loadScrollbackMock.mockImplementation(async (id) => {
        if (id === "old-1") return "scrollback-1";
        return null;
      });

      await useTerminalStore.getState().loadLayout();

      expect(loadScrollbackMock).toHaveBeenCalledWith("old-1");
      expect(loadScrollbackMock).toHaveBeenCalledWith("old-2");
      expect(useTerminalStore.getState().restoredScrollbacks["new-1"]).toBe("scrollback-1");
      expect(useTerminalStore.getState().restoredScrollbacks["new-2"]).toBeUndefined();
      expect(saveScrollbackMock).toHaveBeenCalledWith("new-1", "scrollback-1");
      expect(deleteScrollbackMock).toHaveBeenCalledWith("old-1");
      expect(deleteScrollbackMock).not.toHaveBeenCalledWith("old-2");
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

  describe("multi-tab management", () => {
    beforeEach(() => {
      ptySpawnMock.mockResolvedValue("s1");
    });

    describe("createTab", () => {
      it("creates a new tab with a fresh session, sets it active, and appends to tabs", async () => {
        ptySpawnMock.mockResolvedValueOnce("s-new");
        const tabId = await useTerminalStore.getState().createTab();
        expect(tabId).toBeDefined();
        const state = useTerminalStore.getState();
        expect(state.activeTabId).toBe(tabId);
        const createdTab = state.tabs.find((t) => t.id === tabId);
        expect(createdTab).toBeDefined();
        expect(createdTab?.layout).toEqual({ type: "leaf", id: "s-new" });
        expect(createdTab?.focusedPath).toEqual([]);
        expect(state.layout).toEqual({ type: "leaf", id: "s-new" });
        expect(state.sessions["s-new"]).toBeDefined();
      });

      it("forwards cwd when creating a tab", async () => {
        ptySpawnMock.mockResolvedValueOnce("s-cwd");
        await useTerminalStore.getState().createTab("D:\\my-project");
        expect(ptySpawnMock).toHaveBeenCalledWith({ cwd: "D:\\my-project" });
        expect(useTerminalStore.getState().sessions["s-cwd"]?.cwd).toBe("D:\\my-project");
      });

      it("preserves existing tabs when creating a new tab", async () => {
        useTerminalStore.setState({
          tabs: [
            { id: "tab-1", layout: { type: "leaf", id: "s1" }, focusedPath: [] },
          ],
          activeTabId: "tab-1",
          sessions: {
            s1: { id: "s1", title: "s1", status: "running", cols: 80, rows: 24 },
          },
        });
        ptySpawnMock.mockResolvedValueOnce("s2");
        const tab2Id = await useTerminalStore.getState().createTab();
        const { tabs, activeTabId } = useTerminalStore.getState();
        expect(tabs).toHaveLength(2);
        expect(tabs[0].id).toBe("tab-1");
        expect(tabs[1].id).toBe(tab2Id);
        expect(activeTabId).toBe(tab2Id);
      });
    });

    describe("selectTab", () => {
      it("switches active tab and updates top-level layout and focusedPath", () => {
        const tab1 = { id: "t1", layout: { type: "leaf", id: "s1" } as const, focusedPath: [] };
        const tab2 = {
          id: "t2",
          layout: {
            type: "split",
            dir: "h",
            ratio: 0.5,
            a: { type: "leaf", id: "s2" },
            b: { type: "leaf", id: "s3" },
          } as const,
          focusedPath: [1],
        };
        useTerminalStore.setState({
          tabs: [tab1, tab2],
          activeTabId: "t1",
          layout: tab1.layout,
          focusedPath: tab1.focusedPath,
        });

        useTerminalStore.getState().selectTab("t2");
        const state = useTerminalStore.getState();
        expect(state.activeTabId).toBe("t2");
        expect(state.layout).toEqual(tab2.layout);
        expect(state.focusedPath).toEqual([1]);
      });

      it("no-ops if tabId does not exist", () => {
        const tab1 = { id: "t1", layout: { type: "leaf", id: "s1" } as const, focusedPath: [] };
        useTerminalStore.setState({
          tabs: [tab1],
          activeTabId: "t1",
          layout: tab1.layout,
          focusedPath: tab1.focusedPath,
        });
        useTerminalStore.getState().selectTab("non-existent");
        expect(useTerminalStore.getState().activeTabId).toBe("t1");
      });
    });

    describe("renameTab", () => {
      it("updates the title of the target tab", () => {
        useTerminalStore.setState({
          tabs: [
            { id: "t1", layout: { type: "leaf", id: "s1" }, focusedPath: [] },
          ],
          activeTabId: "t1",
        });
        useTerminalStore.getState().renameTab("t1", "Backend Server");
        expect(useTerminalStore.getState().tabs[0].title).toBe("Backend Server");
      });
    });

    describe("closeTab", () => {
      it("closes active tab, terminates sessions, deletes scrollbacks, and activates adjacent tab", async () => {
        ptyKillMock.mockResolvedValue(undefined);
        const tab1 = { id: "t1", layout: { type: "leaf", id: "s1" } as const, focusedPath: [] };
        const tab2 = { id: "t2", layout: { type: "leaf", id: "s2" } as const, focusedPath: [] };
        const tab3 = { id: "t3", layout: { type: "leaf", id: "s3" } as const, focusedPath: [] };
        useTerminalStore.setState({
          tabs: [tab1, tab2, tab3],
          activeTabId: "t2",
          layout: tab2.layout,
          focusedPath: tab2.focusedPath,
          sessions: {
            s1: { id: "s1", title: "s1", status: "running", cols: 80, rows: 24 },
            s2: { id: "s2", title: "s2", status: "running", cols: 80, rows: 24 },
            s3: { id: "s3", title: "s3", status: "running", cols: 80, rows: 24 },
          },
        });

        await useTerminalStore.getState().closeTab("t2");
        expect(ptyKillMock).toHaveBeenCalledWith("s2");
        expect(deleteScrollbackMock).toHaveBeenCalledWith("s2");

        const state = useTerminalStore.getState();
        expect(state.tabs.map((t) => t.id)).toEqual(["t1", "t3"]);
        expect(state.activeTabId).toBe("t3");
        expect(state.sessions["s2"]).toBeUndefined();
        expect(state.sessions["s1"]).toBeDefined();
        expect(state.sessions["s3"]).toBeDefined();
      });

      it("closes background tab without switching active tab", async () => {
        ptyKillMock.mockResolvedValue(undefined);
        const tab1 = { id: "t1", layout: { type: "leaf", id: "s1" } as const, focusedPath: [] };
        const tab2 = { id: "t2", layout: { type: "leaf", id: "s2" } as const, focusedPath: [] };
        useTerminalStore.setState({
          tabs: [tab1, tab2],
          activeTabId: "t1",
          layout: tab1.layout,
          focusedPath: tab1.focusedPath,
          sessions: {
            s1: { id: "s1", title: "s1", status: "running", cols: 80, rows: 24 },
            s2: { id: "s2", title: "s2", status: "running", cols: 80, rows: 24 },
          },
        });

        await useTerminalStore.getState().closeTab("t2");
        expect(ptyKillMock).toHaveBeenCalledWith("s2");
        const state = useTerminalStore.getState();
        expect(state.tabs.map((t) => t.id)).toEqual(["t1"]);
        expect(state.activeTabId).toBe("t1");
      });

      it("resets to a fresh empty tab when the last tab is closed", async () => {
        ptyKillMock.mockResolvedValue(undefined);
        const tab1 = { id: "t1", layout: { type: "leaf", id: "s1" } as const, focusedPath: [] };
        useTerminalStore.setState({
          tabs: [tab1],
          activeTabId: "t1",
          layout: tab1.layout,
          focusedPath: tab1.focusedPath,
          sessions: {
            s1: { id: "s1", title: "s1", status: "running", cols: 80, rows: 24 },
          },
        });

        await useTerminalStore.getState().closeTab("t1");
        expect(ptyKillMock).toHaveBeenCalledWith("s1");
        const state = useTerminalStore.getState();
        expect(state.tabs).toHaveLength(1);
        expect(state.tabs[0].layout).toEqual({ type: "leaf", id: "" });
        expect(state.sessions).toEqual({});
      });
    });

    describe("split isolation across tabs", () => {
      it("splitPane modifies only the active tab layout", async () => {
        ptySpawnMock.mockResolvedValue("s-split");
        const tab1 = { id: "t1", layout: { type: "leaf", id: "s1" } as const, focusedPath: [] };
        const tab2 = { id: "t2", layout: { type: "leaf", id: "s2" } as const, focusedPath: [] };
        useTerminalStore.setState({
          tabs: [tab1, tab2],
          activeTabId: "t1",
          layout: tab1.layout,
          focusedPath: tab1.focusedPath,
          sessions: {
            s1: { id: "s1", title: "s1", status: "running", cols: 80, rows: 24 },
            s2: { id: "s2", title: "s2", status: "running", cols: 80, rows: 24 },
          },
        });

        await useTerminalStore.getState().splitPane("h");
        const state = useTerminalStore.getState();
        expect(state.tabs[0].layout).toEqual({
          type: "split",
          dir: "h",
          ratio: 0.5,
          a: { type: "leaf", id: "s1" },
          b: { type: "leaf", id: "s-split" },
        });
        // Tab 2 must be untouched
        expect(state.tabs[1].layout).toEqual({ type: "leaf", id: "s2" });
      });

      it("closePane in active tab leaves background tab panes intact", async () => {
        ptyKillMock.mockResolvedValue(undefined);
        const tab1 = {
          id: "t1",
          layout: {
            type: "split",
            dir: "h",
            ratio: 0.5,
            a: { type: "leaf", id: "s1" },
            b: { type: "leaf", id: "s2" },
          } as const,
          focusedPath: [1],
        };
        const tab2 = { id: "t2", layout: { type: "leaf", id: "s3" } as const, focusedPath: [] };
        useTerminalStore.setState({
          tabs: [tab1, tab2],
          activeTabId: "t1",
          layout: tab1.layout,
          focusedPath: tab1.focusedPath,
          sessions: {
            s1: { id: "s1", title: "s1", status: "running", cols: 80, rows: 24 },
            s2: { id: "s2", title: "s2", status: "running", cols: 80, rows: 24 },
            s3: { id: "s3", title: "s3", status: "running", cols: 80, rows: 24 },
          },
        });

        await useTerminalStore.getState().closePane();
        expect(ptyKillMock).toHaveBeenCalledWith("s2");
        const state = useTerminalStore.getState();
        expect(state.tabs[0].layout).toEqual({ type: "leaf", id: "s1" });
        expect(state.tabs[1].layout).toEqual({ type: "leaf", id: "s3" });
        expect(state.sessions["s3"]).toBeDefined();
        expect(state.sessions["s2"]).toBeUndefined();
      });
    });

    describe("multi-tab persistence", () => {
      beforeEach(() => {
        useTerminalStore.setState({ ready: true });
      });

      it("saveLayout serializes all tabs, activeTabId, and sessions", async () => {
        const tab1 = { id: "t1", title: "Tab 1", layout: { type: "leaf", id: "s1" } as const, focusedPath: [] };
        const tab2 = { id: "t2", title: "Tab 2", layout: { type: "leaf", id: "s2" } as const, focusedPath: [] };
        useTerminalStore.setState({
          tabs: [tab1, tab2],
          activeTabId: "t2",
          layout: tab2.layout,
          focusedPath: tab2.focusedPath,
          sessions: {
            s1: { id: "s1", title: "s1", status: "running", cwd: "C:\\a", cols: 80, rows: 24 },
            s2: { id: "s2", title: "s2", status: "running", cwd: "C:\\b", cols: 80, rows: 24 },
          },
        });

        await useTerminalStore.getState().saveLayout();
        expect(saveLayoutMock).toHaveBeenCalledTimes(1);
        const parsed = JSON.parse(saveLayoutMock.mock.calls[0][0]);
        expect(parsed.activeTabId).toBe("t2");
        expect(parsed.tabs).toHaveLength(2);
        expect(parsed.tabs[0].title).toBe("Tab 1");
        expect(parsed.tabs[1].title).toBe("Tab 2");
        expect(parsed.sessions).toHaveLength(2);
      });

      it("loadLayout restores multiple tabs, remapping session IDs across all tabs", async () => {
        loadLayoutMock.mockResolvedValue(
          JSON.stringify({
            tabs: [
              { id: "t1", title: "Tab One", layout: { type: "leaf", id: "old-1" }, focusedPath: [] },
              { id: "t2", title: "Tab Two", layout: { type: "leaf", id: "old-2" }, focusedPath: [] },
            ],
            activeTabId: "t2",
            sessions: [
              { id: "old-1", title: "s1", status: "running", cwd: "C:\\a", cols: 80, rows: 24 },
              { id: "old-2", title: "s2", status: "running", cwd: "C:\\b", cols: 80, rows: 24 },
            ],
          }),
        );
        ptySpawnMock
          .mockResolvedValueOnce("new-1")
          .mockResolvedValueOnce("new-2");

        await useTerminalStore.getState().loadLayout();
        const state = useTerminalStore.getState();
        expect(state.tabs).toHaveLength(2);
        expect(state.tabs[0].id).toBe("t1");
        expect(state.tabs[0].title).toBe("Tab One");
        expect(state.tabs[0].layout).toEqual({ type: "leaf", id: "new-1" });
        expect(state.tabs[1].id).toBe("t2");
        expect(state.tabs[1].title).toBe("Tab Two");
        expect(state.tabs[1].layout).toEqual({ type: "leaf", id: "new-2" });
        expect(state.activeTabId).toBe("t2");
        expect(state.layout).toEqual({ type: "leaf", id: "new-2" });
      });

      it("loadLayout promotes legacy single-layout snapshot into tabs[0]", async () => {
        loadLayoutMock.mockResolvedValue(
          JSON.stringify({
            layout: { type: "leaf", id: "legacy-1" },
            sessions: [
              { id: "legacy-1", title: "legacy", status: "running", cwd: "C:\\legacy", cols: 80, rows: 24 },
            ],
          }),
        );
        ptySpawnMock.mockResolvedValueOnce("new-legacy");

        await useTerminalStore.getState().loadLayout();
        const state = useTerminalStore.getState();
        expect(state.tabs).toHaveLength(1);
        expect(state.tabs[0].layout).toEqual({ type: "leaf", id: "new-legacy" });
        expect(state.activeTabId).toBe(state.tabs[0].id);
        expect(state.layout).toEqual({ type: "leaf", id: "new-legacy" });
      });
    });
  });
});
