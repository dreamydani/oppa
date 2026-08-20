import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTerminalStore } from "./terminalStore";
import * as transport from "../lib/pty/transport";
import * as workspaceTransport from "../lib/workspace/transport";
import * as fsTransport from "../lib/fs/transport";
import * as settingsTransport from "../lib/settings/transport";
import { DEFAULT_APP_SETTINGS, DEFAULT_APPEARANCE_SETTINGS } from "../lib/settings/types";

vi.mock("../lib/pty/transport", () => ({
  ptySpawn: vi.fn(),
  ptyKill: vi.fn(),
  ptyResize: vi.fn().mockResolvedValue(undefined),
  ptyAck: vi.fn().mockResolvedValue(undefined),
  ptyWrite: vi.fn().mockResolvedValue(undefined),
  saveLayout: vi.fn(),
  loadLayout: vi.fn(),
  saveScrollback: vi.fn().mockResolvedValue(undefined),
  loadScrollback: vi.fn().mockResolvedValue(null),
  deleteScrollback: vi.fn().mockResolvedValue(undefined),
  cleanupStaleScrollbacks: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/workspace/transport", () => ({
  saveRecents: vi.fn().mockResolvedValue(undefined),
  loadRecents: vi.fn().mockResolvedValue([]),
  savePresets: vi.fn().mockResolvedValue(undefined),
  loadPresets: vi.fn().mockResolvedValue([]),
}));

vi.mock("../lib/fs/transport", () => ({
  readDir: vi.fn().mockResolvedValue([]),
  readFile: vi.fn().mockResolvedValue(""),
  writeFile: vi.fn().mockResolvedValue(undefined),
  createFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/settings/transport", () => ({
  saveSettings: vi.fn().mockResolvedValue(undefined),
  loadSettings: vi.fn().mockResolvedValue(null),
}));

const ptySpawnMock = vi.mocked(transport.ptySpawn);
const ptyKillMock = vi.mocked(transport.ptyKill);
const ptyWriteMock = vi.mocked(transport.ptyWrite);
const saveLayoutMock = vi.mocked(transport.saveLayout);
const loadLayoutMock = vi.mocked(transport.loadLayout);
const saveScrollbackMock = vi.mocked(transport.saveScrollback);
const loadScrollbackMock = vi.mocked(transport.loadScrollback);
const deleteScrollbackMock = vi.mocked(transport.deleteScrollback);
const cleanupStaleScrollbacksMock = vi.mocked(transport.cleanupStaleScrollbacks);
const saveRecentsMock = vi.mocked(workspaceTransport.saveRecents);
const loadRecentsMock = vi.mocked(workspaceTransport.loadRecents);
const savePresetsMock = vi.mocked(workspaceTransport.savePresets);
const loadPresetsMock = vi.mocked(workspaceTransport.loadPresets);
const readFileMock = vi.mocked(fsTransport.readFile);
const writeFileMock = vi.mocked(fsTransport.writeFile);
const saveSettingsMock = vi.mocked(settingsTransport.saveSettings);
const loadSettingsMock = vi.mocked(settingsTransport.loadSettings);

function spawnRes(id: string, is_new = true, snapshot?: string | null): transport.PtySpawnResult {
  return { id, is_new, snapshot, pid: 1234, cols: 80, rows: 24 };
}

describe("terminalStore", () => {
  beforeEach(() => {
    saveLayoutMock.mockResolvedValue(undefined);
    loadLayoutMock.mockResolvedValue(null);
    readFileMock.mockResolvedValue("");
    writeFileMock.mockResolvedValue(undefined);
    useTerminalStore.setState({
      sessions: {},
      tabs: [],
      activeTabId: "",
      layout: { type: "leaf", id: "" },
      focusedPath: [],
      serializers: {},
      cachedScrollbacks: {},
      restoredScrollbacks: {},
      ready: false,
      leftSidebarOpen: true,
      leftSidebarWidth: 240,
      rightSidebarOpen: false,
      rightSidebarWidth: 280,
      rightSidebarTab: "explorer",
      isWorkspaceLauncherOpen: false,
      maximizedSessionId: null,
      activeAppMode: "terminal",
      browserUrl: "",
      browserHistory: [],
      historyIndex: -1,
      devicePreset: "responsive",
      detectedPorts: [],
      editorTabs: [],
      activeEditorPath: null,
      editorViewMode: "edit",
      pendingAiDiff: null,
      settings: DEFAULT_APP_SETTINGS,
      isSettingsOpen: false,
      activeSettingsTab: "general",
      tabFocusHistory: [],
    });
    saveSettingsMock.mockClear();
    loadSettingsMock.mockClear();
    vi.clearAllMocks();
  });

  it("spawnSession calls transport and tracks the new session as running", async () => {
    ptySpawnMock.mockResolvedValue(spawnRes("abc"));
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
    ptySpawnMock.mockResolvedValue(spawnRes("def"));
    await useTerminalStore.getState().spawnSession("C:\\work");
    expect(ptySpawnMock).toHaveBeenCalledWith({ cwd: "C:\\work" });
    expect(useTerminalStore.getState().sessions["def"].cwd).toBe("C:\\work");
  });

  it("spawnSession forwards existingId and shell in options", async () => {
    ptySpawnMock.mockResolvedValue({
      id: "session-existing",
      is_new: false,
      pid: 1234,
      cols: 90,
      rows: 30,
      cwd: "C:\\custom",
    });
    const id = await useTerminalStore.getState().spawnSession("C:\\custom", "pwsh", "session-existing");
    expect(ptySpawnMock).toHaveBeenCalledWith({
      id: "session-existing",
      cwd: "C:\\custom",
      shell: "pwsh",
    });
    expect(id).toBe("session-existing");
    const session = useTerminalStore.getState().sessions["session-existing"];
    expect(session).toBeDefined();
    expect(session.cols).toBe(90);
    expect(session.rows).toBe(30);
    expect(session.cwd).toBe("C:\\custom");
  });


  it("spawnSession records restoredScrollbacks when is_new is false and snapshot is present", async () => {
    ptySpawnMock.mockResolvedValue({
      id: "s-warm",
      is_new: false,
      snapshot: "warm shell snapshot content",
      pid: 5678,
      cols: 80,
      rows: 24,
      cwd: "/home/user",
    });
    const id = await useTerminalStore.getState().spawnSession("/home/user", undefined, "s-warm");
    expect(id).toBe("s-warm");
    expect(useTerminalStore.getState().restoredScrollbacks["s-warm"]).toBe("warm shell snapshot content");
  });

  it("spawnSession handles cold restore payload, sets session.isRestored = true, and stores restoredScrollbacks", async () => {
    ptySpawnMock.mockResolvedValue({
      id: "s-cold",
      is_new: true,
      is_warm: false,
      cold_scrollback: "historical scrollback\n$ ",
      pid: 5679,
      cols: 80,
      rows: 24,
      cwd: "/home/user/project",
    });
    const id = await useTerminalStore.getState().spawnSession("/home/user/project", undefined, "s-cold");
    expect(id).toBe("s-cold");
    const session = useTerminalStore.getState().sessions["s-cold"];
    expect(session).toBeDefined();
    expect(session.isRestored).toBe(true);
    expect(useTerminalStore.getState().restoredScrollbacks["s-cold"]).toBe("historical scrollback\n$ ");
  });

  it("dismissSessionRestoredBanner clears session.isRestored", async () => {
    useTerminalStore.setState({
      sessions: {
        "s-cold": {
          id: "s-cold",
          title: "s-cold",
          status: "running",
          cols: 80,
          rows: 24,
          isRestored: true,
        },
      },
    });
    useTerminalStore.getState().dismissSessionRestoredBanner("s-cold");
    expect(useTerminalStore.getState().sessions["s-cold"].isRestored).toBe(false);
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
    ptySpawnMock.mockResolvedValue(spawnRes("s1"));
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
    ptySpawnMock.mockResolvedValue(spawnRes("s2"));
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
    ptySpawnMock.mockResolvedValue(spawnRes("s2"));
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
      ptySpawnMock.mockResolvedValue(spawnRes("s2"));
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
      ptySpawnMock.mockResolvedValue(spawnRes("s1"));
      await useTerminalStore.getState().splitPane("h");
      expect(saveLayoutMock).toHaveBeenCalled();
    });

    it("closePane persists the arrangement", async () => {
      ptySpawnMock.mockResolvedValue(spawnRes("s1"));
      await useTerminalStore.getState().splitPane("h");
      saveLayoutMock.mockClear();
      await useTerminalStore.getState().closePane();
      expect(saveLayoutMock).toHaveBeenCalled();
    });

    it("setRatio updates the ratio without persisting (saveLayout deferred to drag end)", () => {
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
      const layout = useTerminalStore.getState().layout;
      expect(layout.type === "split" && layout.ratio).toBe(0.75);
      // saveLayout is NOT called per-pixel; SplitDivider calls it once on drag end
      expect(saveLayoutMock).not.toHaveBeenCalled();
    });

    it("updateSessionCwd debounces layout persistence by 2000ms", () => {
      vi.useFakeTimers();
      useTerminalStore.setState({
        sessions: {
          s1: { id: "s1", title: "s1", status: "running", cwd: "/old/dir", cols: 80, rows: 24 },
        },
      });
      saveLayoutMock.mockClear();
      useTerminalStore.getState().updateSessionCwd("s1", "/new/dir");
      expect(useTerminalStore.getState().sessions["s1"].cwd).toBe("/new/dir");
      expect(saveLayoutMock).not.toHaveBeenCalled();

      // Advancing 1000ms should still not call saveLayout
      vi.advanceTimersByTime(1000);
      expect(saveLayoutMock).not.toHaveBeenCalled();

      // Advancing remaining 1000ms triggers saveLayout
      vi.advanceTimersByTime(1000);
      expect(saveLayoutMock).toHaveBeenCalledTimes(1);
    });

    it("updateSessionCwd collapses rapid successive updates into a single debounced save", () => {
      vi.useFakeTimers();
      useTerminalStore.setState({
        sessions: {
          s1: { id: "s1", title: "s1", status: "running", cwd: "/old/dir", cols: 80, rows: 24 },
        },
      });
      saveLayoutMock.mockClear();
      useTerminalStore.getState().updateSessionCwd("s1", "/dir1");
      vi.advanceTimersByTime(1000);
      useTerminalStore.getState().updateSessionCwd("s1", "/dir2");
      vi.advanceTimersByTime(1000);
      expect(saveLayoutMock).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1000);
      expect(saveLayoutMock).toHaveBeenCalledTimes(1);
    });

    it("updateSessionCwd does not persist if cwd is unchanged or session is missing", () => {
      vi.useFakeTimers();
      useTerminalStore.setState({
        sessions: {
          s1: { id: "s1", title: "s1", status: "running", cwd: "/same/dir", cols: 80, rows: 24 },
        },
      });
      saveLayoutMock.mockClear();
      useTerminalStore.getState().updateSessionCwd("s1", "/same/dir");
      useTerminalStore.getState().updateSessionCwd("nonexistent", "/any/dir");
      vi.advanceTimersByTime(2500);
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
      ptySpawnMock.mockResolvedValue(spawnRes("s1"));
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
        .mockResolvedValueOnce(spawnRes("new-left"))
        .mockResolvedValueOnce(spawnRes("new-top"))
        .mockResolvedValueOnce(spawnRes("new-right"));

      await useTerminalStore.getState().loadLayout();

      // Restored sessions pass oldId as existingId to enable warm reattachment.
      expect(ptySpawnMock.mock.calls.map((c) => c[0])).toEqual([
        { id: "old-left", cwd: "C:\\a" },
        { id: "old-top", cwd: "C:\\b" },
        { id: "old-right", cwd: "C:\\c" },
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

    it("warm-reattaches to existing daemon sessions without creating duplicate shells", async () => {
      loadLayoutMock.mockResolvedValue(
        JSON.stringify({
          layout: {
            type: "split",
            dir: "h",
            ratio: 0.5,
            a: { type: "leaf", id: "daemon-s1" },
            b: { type: "leaf", id: "daemon-s2" },
          },
          sessions: [
            { id: "daemon-s1", title: "s1", status: "running", cwd: "/app/one", cols: 80, rows: 24 },
            { id: "daemon-s2", title: "s2", status: "running", cwd: "/app/two", cols: 80, rows: 24 },
          ],
        }),
      );
      ptySpawnMock
        .mockResolvedValueOnce({
          id: "daemon-s1",
          is_new: false,
          snapshot: "daemon snapshot 1",
          pid: 101,
          cols: 80,
          rows: 24,
          cwd: "/app/one",
        })
        .mockResolvedValueOnce({
          id: "daemon-s2",
          is_new: false,
          snapshot: "daemon snapshot 2",
          pid: 102,
          cols: 80,
          rows: 24,
          cwd: "/app/two",
        });

      await useTerminalStore.getState().loadLayout();

      expect(ptySpawnMock.mock.calls.map((c) => c[0])).toEqual([
        { id: "daemon-s1", cwd: "/app/one" },
        { id: "daemon-s2", cwd: "/app/two" },
      ]);
      const state = useTerminalStore.getState();
      expect(state.restoredScrollbacks["daemon-s1"]).toBe("daemon snapshot 1");
      expect(state.restoredScrollbacks["daemon-s2"]).toBe("daemon snapshot 2");
      expect(state.layout).toEqual({
        type: "split",
        dir: "h",
        ratio: 0.5,
        a: { type: "leaf", id: "daemon-s1" },
        b: { type: "leaf", id: "daemon-s2" },
      });
      expect(Object.keys(state.sessions)).toEqual(["daemon-s1", "daemon-s2"]);
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
        .mockResolvedValueOnce(spawnRes("new-1"))
        .mockResolvedValueOnce(spawnRes("new-2"));
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

    it("preserves cold restored sessions, sets isRestored, and applies cold scrollback", async () => {
      loadLayoutMock.mockResolvedValue(
        JSON.stringify({
          layout: {
            type: "leaf",
            id: "cold-session-1",
          },
          sessions: [
            { id: "cold-session-1", title: "my-build", status: "running", cwd: "/project/app", cols: 80, rows: 24 },
          ],
        }),
      );
      ptySpawnMock.mockResolvedValueOnce({
        id: "cold-session-1",
        is_new: true,
        is_warm: false,
        cold_scrollback: "previous cold output",
        pid: 1234,
        cols: 80,
        rows: 24,
        cwd: "/project/app",
      });

      await useTerminalStore.getState().loadLayout();

      const state = useTerminalStore.getState();
      const session = state.sessions["cold-session-1"];
      expect(session).toBeDefined();
      expect(session.isRestored).toBe(true);
      expect(session.title).toBe("my-build");
      expect(state.restoredScrollbacks["cold-session-1"]).toBe("previous cold output");
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
      ptySpawnMock.mockResolvedValue(spawnRes("s1"));
    });

    describe("createTab", () => {
      it("creates a new tab with a fresh session, sets it active, and appends to tabs", async () => {
        ptySpawnMock.mockResolvedValueOnce(spawnRes("s-new"));
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
        ptySpawnMock.mockResolvedValueOnce(spawnRes("s-cwd"));
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
        ptySpawnMock.mockResolvedValueOnce(spawnRes("s2"));
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

      it("resets to empty tabs list when the last tab is closed", async () => {
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
        expect(state.tabs).toHaveLength(0);
        expect(state.activeTabId).toBe("");
        expect(state.sessions).toEqual({});
      });
    });

    describe("split isolation across tabs", () => {
      it("splitPane modifies only the active tab layout", async () => {
        ptySpawnMock.mockResolvedValue(spawnRes("s-split"));
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
          .mockResolvedValueOnce(spawnRes("new-1"))
          .mockResolvedValueOnce(spawnRes("new-2"));

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
        ptySpawnMock.mockResolvedValueOnce(spawnRes("new-legacy"));

        await useTerminalStore.getState().loadLayout();
        const state = useTerminalStore.getState();
        expect(state.tabs).toHaveLength(1);
        expect(state.tabs[0].layout).toEqual({ type: "leaf", id: "new-legacy" });
        expect(state.activeTabId).toBe(state.tabs[0].id);
        expect(state.layout).toEqual({ type: "leaf", id: "new-legacy" });
      });
    });
  });

  describe("UI state slice", () => {
    it("has expected initial store state", () => {
      const initialState = useTerminalStore.getInitialState();
      expect(initialState.leftSidebarOpen).toBe(true);
      expect(initialState.rightSidebarOpen).toBe(false);
    });

    it("initializes with default sidebar states and tab", () => {
      const state = useTerminalStore.getState();
      expect(state.leftSidebarOpen).toBe(true);
      expect(state.leftSidebarWidth).toBe(240);
      expect(state.rightSidebarOpen).toBe(false);
      expect(state.rightSidebarWidth).toBe(280);
      expect(state.rightSidebarTab).toBe("explorer");
    });

    it("toggles left sidebar visibility", () => {
      useTerminalStore.getState().toggleLeftSidebar();
      expect(useTerminalStore.getState().leftSidebarOpen).toBe(false);
      useTerminalStore.getState().toggleLeftSidebar();
      expect(useTerminalStore.getState().leftSidebarOpen).toBe(true);
    });

    it("sets left sidebar width", () => {
      useTerminalStore.getState().setLeftSidebarWidth(320);
      expect(useTerminalStore.getState().leftSidebarWidth).toBe(320);
    });

    it("toggles right sidebar visibility", () => {
      expect(useTerminalStore.getState().rightSidebarOpen).toBe(false);
      useTerminalStore.getState().toggleRightSidebar();
      expect(useTerminalStore.getState().rightSidebarOpen).toBe(true);
      useTerminalStore.getState().toggleRightSidebar();
      expect(useTerminalStore.getState().rightSidebarOpen).toBe(false);
    });

    it("sets right sidebar width", () => {
      useTerminalStore.getState().setRightSidebarWidth(360);
      expect(useTerminalStore.getState().rightSidebarWidth).toBe(360);
    });

    it("switches right sidebar tab between explorer and git", () => {
      useTerminalStore.getState().setRightSidebarTab("git");
      expect(useTerminalStore.getState().rightSidebarTab).toBe("git");
      useTerminalStore.getState().setRightSidebarTab("explorer");
      expect(useTerminalStore.getState().rightSidebarTab).toBe("explorer");
    });

    it("getActiveCwd returns the cwd of the currently active focused session", () => {
      useTerminalStore.setState({
        sessions: {
          s1: { id: "s1", title: "s1", status: "running", cwd: "D:\\projects\\oppa", cols: 80, rows: 24 },
          s2: { id: "s2", title: "s2", status: "running", cwd: "C:\\users\\test", cols: 80, rows: 24 },
        },
        tabs: [
          { id: "tab-1", layout: { type: "leaf", id: "s1" }, focusedPath: [] },
          { id: "tab-2", layout: { type: "leaf", id: "s2" }, focusedPath: [] },
        ],
        activeTabId: "tab-1",
        layout: { type: "leaf", id: "s1" },
        focusedPath: [],
      });

      expect(useTerminalStore.getState().getActiveCwd()).toBe("D:\\projects\\oppa");

      useTerminalStore.getState().selectTab("tab-2");
      expect(useTerminalStore.getState().getActiveCwd()).toBe("C:\\users\\test");
    });

    it("getActiveCwd returns undefined when focused session does not exist or has no cwd", () => {
      useTerminalStore.setState({
        sessions: {},
        tabs: [{ id: "tab-1", layout: { type: "leaf", id: "" }, focusedPath: [] }],
        activeTabId: "tab-1",
        layout: { type: "leaf", id: "" },
        focusedPath: [],
      });

      expect(useTerminalStore.getState().getActiveCwd()).toBeUndefined();
    });
  });

  describe("workspace launcher modal state", () => {
    it("defaults to isWorkspaceLauncherOpen = false", () => {
      expect(useTerminalStore.getState().isWorkspaceLauncherOpen).toBe(false);
    });

    it("opens, closes, and toggles workspace launcher modal", () => {
      useTerminalStore.getState().openWorkspaceLauncher();
      expect(useTerminalStore.getState().isWorkspaceLauncherOpen).toBe(true);

      useTerminalStore.getState().closeWorkspaceLauncher();
      expect(useTerminalStore.getState().isWorkspaceLauncherOpen).toBe(false);

      useTerminalStore.getState().toggleWorkspaceLauncher();
      expect(useTerminalStore.getState().isWorkspaceLauncherOpen).toBe(true);

      useTerminalStore.getState().toggleWorkspaceLauncher();
      expect(useTerminalStore.getState().isWorkspaceLauncherOpen).toBe(false);
    });
  });

  describe("pane maximization and session renaming", () => {
    it("initializes maximizedSessionId as null", () => {
      expect(useTerminalStore.getState().maximizedSessionId).toBeNull();
    });

    it("renameSession updates a session's title", () => {
      useTerminalStore.setState({
        sessions: {
          s1: { id: "s1", title: "s1", status: "running", cols: 80, rows: 24 },
        },
      });
      useTerminalStore.getState().renameSession("s1", "Build Terminal");
      expect(useTerminalStore.getState().sessions["s1"].title).toBe("Build Terminal");
    });

    it("renameSession does nothing if session does not exist", () => {
      useTerminalStore.setState({ sessions: {} });
      useTerminalStore.getState().renameSession("missing", "Title");
      expect(useTerminalStore.getState().sessions["missing"]).toBeUndefined();
    });

    it("renameSession debounces layout persistence by 2000ms", () => {
      vi.useFakeTimers();
      useTerminalStore.setState({
        ready: true,
        sessions: {
          s1: { id: "s1", title: "s1", status: "running", cols: 80, rows: 24 },
        },
      });
      saveLayoutMock.mockClear();
      useTerminalStore.getState().renameSession("s1", "Server");
      expect(useTerminalStore.getState().sessions["s1"].title).toBe("Server");
      expect(saveLayoutMock).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1000);
      expect(saveLayoutMock).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1000);
      expect(saveLayoutMock).toHaveBeenCalledTimes(1);
    });

    it("renameSession collapses rapid successive renames into a single debounced save", () => {
      vi.useFakeTimers();
      useTerminalStore.setState({
        ready: true,
        sessions: {
          s1: { id: "s1", title: "s1", status: "running", cols: 80, rows: 24 },
        },
      });
      saveLayoutMock.mockClear();
      useTerminalStore.getState().renameSession("s1", "Server 1");
      vi.advanceTimersByTime(1000);
      useTerminalStore.getState().renameSession("s1", "Server 2");
      vi.advanceTimersByTime(1000);
      expect(saveLayoutMock).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1000);
      expect(saveLayoutMock).toHaveBeenCalledTimes(1);
    });

    it("toggleMaximizePane sets maximizedSessionId when provided an id", () => {
      useTerminalStore.getState().toggleMaximizePane("s1");
      expect(useTerminalStore.getState().maximizedSessionId).toBe("s1");
    });

    it("toggleMaximizePane resets maximizedSessionId to null when called again with the same id", () => {
      useTerminalStore.setState({ maximizedSessionId: "s1" });
      useTerminalStore.getState().toggleMaximizePane("s1");
      expect(useTerminalStore.getState().maximizedSessionId).toBeNull();
    });

    it("toggleMaximizePane switches maximizedSessionId when called with a different id", () => {
      useTerminalStore.setState({ maximizedSessionId: "s1" });
      useTerminalStore.getState().toggleMaximizePane("s2");
      expect(useTerminalStore.getState().maximizedSessionId).toBe("s2");
    });

    it("toggleMaximizePane without arguments maximizes currently focused pane if none maximized", () => {
      const splitLayout = {
        type: "split" as const,
        dir: "h" as const,
        ratio: 0.5,
        a: { type: "leaf" as const, id: "s1" },
        b: { type: "leaf" as const, id: "s2" },
      };
      useTerminalStore.setState({
        maximizedSessionId: null,
        tabs: [
          {
            id: "tab-1",
            layout: splitLayout,
            focusedPath: [1],
          },
        ],
        activeTabId: "tab-1",
        layout: splitLayout,
        focusedPath: [1],
      });

      useTerminalStore.getState().toggleMaximizePane();
      expect(useTerminalStore.getState().maximizedSessionId).toBe("s2");
    });

    it("toggleMaximizePane without arguments restores to null if already maximized", () => {
      useTerminalStore.setState({ maximizedSessionId: "s2" });
      useTerminalStore.getState().toggleMaximizePane();
      expect(useTerminalStore.getState().maximizedSessionId).toBeNull();
    });
  });

  describe("workspace setup wizard state and actions", () => {
    it("initializes wizard state with default values", () => {
      const state = useTerminalStore.getState();
      expect(state.isSetupWizardOpen).toBe(false);
      expect(state.wizardStep).toBe(1);
      expect(state.recentWorkspaces).toEqual([]);
      expect(state.workspacePresets).toEqual([]);
    });

    it("opens, closes, and sets wizard step", () => {
      useTerminalStore.getState().openSetupWizard();
      expect(useTerminalStore.getState().isSetupWizardOpen).toBe(true);
      expect(useTerminalStore.getState().wizardStep).toBe(1);

      useTerminalStore.getState().setWizardStep(2);
      expect(useTerminalStore.getState().wizardStep).toBe(2);

      useTerminalStore.getState().setWizardStep(3);
      expect(useTerminalStore.getState().wizardStep).toBe(3);

      useTerminalStore.getState().closeSetupWizard();
      expect(useTerminalStore.getState().isSetupWizardOpen).toBe(false);
    });

    it("loadWizardData loads recents and presets from transport into state", async () => {
      const mockRecents = [
        { name: "Project A", path: "D:\\projA", terminal_count: 4, last_opened: 12345 },
      ];
      const mockPresets = [
        { id: "p1", name: "Dev Stack", terminal_count: 4, commands: ["npm run dev"] },
      ];
      loadRecentsMock.mockResolvedValueOnce(mockRecents);
      loadPresetsMock.mockResolvedValueOnce(mockPresets);

      await useTerminalStore.getState().loadWizardData();

      expect(loadRecentsMock).toHaveBeenCalled();
      expect(loadPresetsMock).toHaveBeenCalled();
      expect(useTerminalStore.getState().recentWorkspaces).toEqual(mockRecents);
      expect(useTerminalStore.getState().workspacePresets).toEqual(mockPresets);
    });

    it("addRecentWorkspace prepends, deduplicates by path, and persists", async () => {
      useTerminalStore.setState({
        recentWorkspaces: [
          { name: "Old Name", path: "D:\\repo", terminal_count: 2, last_opened: 100 },
          { name: "Other", path: "D:\\other", terminal_count: 1, last_opened: 90 },
        ],
      });

      const newRecent = {
        name: "New Name",
        path: "D:\\repo",
        terminal_count: 4,
        last_opened: 200,
      };

      await useTerminalStore.getState().addRecentWorkspace(newRecent);

      const updated = useTerminalStore.getState().recentWorkspaces;
      expect(updated).toHaveLength(2);
      expect(updated[0]).toEqual(newRecent);
      expect(updated[1].path).toBe("D:\\other");
      expect(saveRecentsMock).toHaveBeenCalledWith(updated);
    });

    it("saveWorkspacePreset adds or replaces a preset and persists", async () => {
      useTerminalStore.setState({
        workspacePresets: [
          { id: "preset-1", name: "Preset 1", terminal_count: 2, commands: [] },
        ],
      });

      const updatedPreset = {
        id: "preset-1",
        name: "Preset 1 Updated",
        terminal_count: 4,
        commands: ["cargo build"],
      };

      await useTerminalStore.getState().saveWorkspacePreset(updatedPreset);

      const presets = useTerminalStore.getState().workspacePresets;
      expect(presets).toHaveLength(1);
      expect(presets[0].name).toBe("Preset 1 Updated");
      expect(savePresetsMock).toHaveBeenCalledWith(presets);
    });

    it("launchCustomWorkspace spawns multiple sessions, executes startup commands, creates a grid tab, and closes the wizard", async () => {
      ptySpawnMock
        .mockResolvedValueOnce(spawnRes("s-1"))
        .mockResolvedValueOnce(spawnRes("s-2"))
        .mockResolvedValueOnce(spawnRes("s-3"))
        .mockResolvedValueOnce(spawnRes("s-4"));

      useTerminalStore.setState({
        isSetupWizardOpen: true,
        wizardStep: 3,
        ready: true,
      });

      const tabId = await useTerminalStore.getState().launchCustomWorkspace({
        name: "Full Stack Dev",
        cwd: "D:\\workspace\\project",
        terminalCount: 4,
        shell: "powershell.exe",
        commands: ["pnpm dev", "cargo watch", "", "git status"],
      });

      expect(ptySpawnMock).toHaveBeenCalledTimes(4);
      expect(ptySpawnMock).toHaveBeenCalledWith({
        cwd: "D:\\workspace\\project",
        shell: "powershell.exe",
      });

      expect(ptyWriteMock).toHaveBeenCalledWith("s-1", "pnpm dev\n");
      expect(ptyWriteMock).toHaveBeenCalledWith("s-2", "cargo watch\n");
      expect(ptyWriteMock).toHaveBeenCalledWith("s-4", "git status\n");

      const state = useTerminalStore.getState();
      expect(state.isSetupWizardOpen).toBe(false);
      expect(state.activeTabId).toBe(tabId);

      const activeTab = state.tabs.find((t) => t.id === tabId);
      expect(activeTab).toBeDefined();
      expect(activeTab?.title).toBe("Full Stack Dev");
      expect(activeTab?.layout).toEqual({
        type: "split",
        dir: "v",
        ratio: 0.5,
        a: {
          type: "split",
          dir: "h",
          ratio: 0.5,
          a: { type: "leaf", id: "s-1" },
          b: { type: "leaf", id: "s-2" },
        },
        b: {
          type: "split",
          dir: "h",
          ratio: 0.5,
          a: { type: "leaf", id: "s-3" },
          b: { type: "leaf", id: "s-4" },
        },
      });

      // Recent workspaces updated
      expect(state.recentWorkspaces[0]).toMatchObject({
        name: "Full Stack Dev",
        path: "D:\\workspace\\project",
        terminal_count: 4,
      });
      expect(saveRecentsMock).toHaveBeenCalled();
    });

    it("launchCustomWorkspace infers tab title from folder basename when name is omitted", async () => {
      ptySpawnMock.mockResolvedValueOnce(spawnRes("s-single"));

      const tabId = await useTerminalStore.getState().launchCustomWorkspace({
        cwd: "C:\\Users\\dev\\my-app",
        terminalCount: 1,
      });

      const state = useTerminalStore.getState();
      const activeTab = state.tabs.find((t) => t.id === tabId);
      expect(activeTab?.title).toBe("my-app");
    });

    it("createWizardTab appends a new tab with isWizard=true and activates it", () => {
      useTerminalStore.setState({
        tabs: [{ id: "tab-1", title: "Shell", layout: { type: "leaf", id: "s-1" }, focusedPath: [] }],
        activeTabId: "tab-1",
        ready: true,
      });

      const wizardTabId = useTerminalStore.getState().createWizardTab();
      const state = useTerminalStore.getState();

      expect(state.activeTabId).toBe(wizardTabId);
      expect(state.tabs).toHaveLength(2);

      const wizardTab = state.tabs.find((t) => t.id === wizardTabId);
      expect(wizardTab).toBeDefined();
      expect(wizardTab?.title).toBe("New Workspace");
      expect(wizardTab?.isWizard).toBe(true);
      expect(wizardTab?.layout).toEqual({ type: "leaf", id: "" });
      expect(wizardTab?.focusedPath).toEqual([]);
      expect(state.layout).toEqual({ type: "leaf", id: "" });
      expect(state.wizardStep).toBe(1);
      expect(saveLayoutMock).toHaveBeenCalled();
    });

    it("createWizardTab generates unique non-colliding ID when tab-1 and tab-2 already exist", () => {
      useTerminalStore.setState({
        tabs: [
          { id: "tab-1", title: "fixing", layout: { type: "leaf", id: "s-1" }, focusedPath: [] },
          { id: "tab-2", title: "taste-skills", layout: { type: "leaf", id: "s-2" }, focusedPath: [] },
        ],
        activeTabId: "tab-2",
        ready: true,
      });

      const wizardTabId = useTerminalStore.getState().createWizardTab();
      const state = useTerminalStore.getState();

      expect(wizardTabId).toBe("tab-3");
      expect(state.activeTabId).toBe("tab-3");
      expect(state.tabs).toHaveLength(3);
      expect(state.tabs[0].id).toBe("tab-1");
      expect(state.tabs[1].id).toBe("tab-2");
      expect(state.tabs[2].id).toBe("tab-3");
      expect(state.tabs[2].isWizard).toBe(true);
    });

    it("createTab generates unique non-colliding ID when multiple tabs exist", async () => {
      ptySpawnMock.mockResolvedValueOnce(spawnRes("s-new"));
      useTerminalStore.setState({
        tabs: [
          { id: "tab-1", title: "Shell 1", layout: { type: "leaf", id: "s-1" }, focusedPath: [] },
          { id: "tab-2", title: "Shell 2", layout: { type: "leaf", id: "s-2" }, focusedPath: [] },
        ],
        activeTabId: "tab-2",
        ready: true,
      });

      const newTabId = await useTerminalStore.getState().createTab();
      const state = useTerminalStore.getState();

      expect(newTabId).toBe("tab-3");
      expect(state.activeTabId).toBe("tab-3");
      expect(state.tabs).toHaveLength(3);
    });

    it("selectTab allows switching between terminal tabs and wizard tabs", () => {
      useTerminalStore.setState({
        tabs: [
          { id: "tab-1", title: "Terminal", layout: { type: "leaf", id: "s-1" }, focusedPath: [] },
          { id: "tab-2", title: "New Workspace", isWizard: true, layout: { type: "leaf", id: "" }, focusedPath: [] },
        ],
        activeTabId: "tab-1",
        layout: { type: "leaf", id: "s-1" },
        focusedPath: [],
      });

      useTerminalStore.getState().selectTab("tab-2");
      let state = useTerminalStore.getState();
      expect(state.activeTabId).toBe("tab-2");
      expect(state.layout).toEqual({ type: "leaf", id: "" });

      useTerminalStore.getState().selectTab("tab-1");
      state = useTerminalStore.getState();
      expect(state.activeTabId).toBe("tab-1");
      expect(state.layout).toEqual({ type: "leaf", id: "s-1" });
    });

    it("launchWorkspaceForTab spawns sessions, updates tab layout, title, recents, and sets isWizard=false", async () => {
      ptySpawnMock
        .mockResolvedValueOnce(spawnRes("w-1"))
        .mockResolvedValueOnce(spawnRes("w-2"));

      useTerminalStore.setState({
        tabs: [
          { id: "tab-1", title: "Shell", layout: { type: "leaf", id: "s-1" }, focusedPath: [] },
          { id: "tab-2", title: "New Workspace", isWizard: true, layout: { type: "leaf", id: "" }, focusedPath: [] },
        ],
        activeTabId: "tab-2",
        layout: { type: "leaf", id: "" },
        focusedPath: [],
        ready: true,
      });

      await useTerminalStore.getState().launchWorkspaceForTab("tab-2", {
        name: "Backend Service",
        cwd: "D:\\repos\\backend",
        terminalCount: 2,
        shell: "powershell.exe",
        commands: ["pnpm start", "pnpm test"],
      });

      expect(ptySpawnMock).toHaveBeenCalledTimes(2);
      expect(ptySpawnMock).toHaveBeenCalledWith({
        cwd: "D:\\repos\\backend",
        shell: "powershell.exe",
      });

      expect(ptyWriteMock).toHaveBeenCalledWith("w-1", "pnpm start\n");
      expect(ptyWriteMock).toHaveBeenCalledWith("w-2", "pnpm test\n");

      const state = useTerminalStore.getState();
      const launchedTab = state.tabs.find((t) => t.id === "tab-2");
      expect(launchedTab).toBeDefined();
      expect(launchedTab?.title).toBe("Backend Service");
      expect(launchedTab?.isWizard).toBe(false);
      expect(launchedTab?.layout).toEqual({
        type: "split",
        dir: "h",
        ratio: 0.5,
        a: { type: "leaf", id: "w-1" },
        b: { type: "leaf", id: "w-2" },
      });

      // Active tab layout should sync since tab-2 was active
      expect(state.layout).toEqual(launchedTab?.layout);
      expect(state.recentWorkspaces[0]).toMatchObject({
        name: "Backend Service",
        path: "D:\\repos\\backend",
        terminal_count: 2,
      });
      expect(saveRecentsMock).toHaveBeenCalled();
      expect(saveLayoutMock).toHaveBeenCalled();
    });

    it("launchWorkspaceForTab for a background tab updates that tab without disturbing active tab layout", async () => {
      ptySpawnMock.mockResolvedValueOnce(spawnRes("bg-1"));

      useTerminalStore.setState({
        tabs: [
          { id: "tab-1", title: "Active Tab", layout: { type: "leaf", id: "active-s" }, focusedPath: [] },
          { id: "tab-2", title: "New Workspace", isWizard: true, layout: { type: "leaf", id: "" }, focusedPath: [] },
        ],
        activeTabId: "tab-1",
        layout: { type: "leaf", id: "active-s" },
        focusedPath: [],
        ready: true,
      });

      await useTerminalStore.getState().launchWorkspaceForTab("tab-2", {
        cwd: "D:\\repos\\frontend",
        terminalCount: 1,
      });

      const state = useTerminalStore.getState();
      expect(state.activeTabId).toBe("tab-1");
      expect(state.layout).toEqual({ type: "leaf", id: "active-s" });

      const bgTab = state.tabs.find((t) => t.id === "tab-2");
      expect(bgTab?.title).toBe("frontend");
      expect(bgTab?.isWizard).toBe(false);
      expect(bgTab?.layout).toEqual({ type: "leaf", id: "bg-1" });
    });
  });

  describe("Browser store state and port detection", () => {
    it("initializes activeAppMode to terminal and provides browser navigation actions", () => {
      const { activeAppMode, setAppMode, navigateBrowser, browserUrl, browserGoBack, browserGoForward, browserReload } =
        useTerminalStore.getState();
      expect(activeAppMode).toBe("terminal");
      expect(browserUrl).toBe("");
      expect(useTerminalStore.getState().browserHistory).toEqual([]);
      expect(useTerminalStore.getState().historyIndex).toBe(-1);

      setAppMode("browser");
      expect(useTerminalStore.getState().activeAppMode).toBe("browser");

      navigateBrowser("http://localhost:5173");
      expect(useTerminalStore.getState().browserUrl).toBe("http://localhost:5173");
      expect(useTerminalStore.getState().browserHistory).toEqual(["http://localhost:5173"]);
      expect(useTerminalStore.getState().historyIndex).toBe(0);

      navigateBrowser("https://github.com");
      expect(useTerminalStore.getState().browserUrl).toBe("https://github.com");
      expect(useTerminalStore.getState().browserHistory).toEqual([
        "http://localhost:5173",
        "https://github.com",
      ]);
      expect(useTerminalStore.getState().historyIndex).toBe(1);

      browserGoBack();
      expect(useTerminalStore.getState().browserUrl).toBe("http://localhost:5173");
      expect(useTerminalStore.getState().historyIndex).toBe(0);

      // Going back at start of history does nothing
      browserGoBack();
      expect(useTerminalStore.getState().browserUrl).toBe("http://localhost:5173");
      expect(useTerminalStore.getState().historyIndex).toBe(0);

      browserGoForward();
      expect(useTerminalStore.getState().browserUrl).toBe("https://github.com");
      expect(useTerminalStore.getState().historyIndex).toBe(1);

      // Going forward at end of history does nothing
      browserGoForward();
      expect(useTerminalStore.getState().browserUrl).toBe("https://github.com");
      expect(useTerminalStore.getState().historyIndex).toBe(1);

      // Navigating after going back truncates forward history
      browserGoBack();
      navigateBrowser("https://developer.mozilla.org");
      expect(useTerminalStore.getState().browserUrl).toBe("https://developer.mozilla.org");
      expect(useTerminalStore.getState().browserHistory).toEqual([
        "http://localhost:5173",
        "https://developer.mozilla.org",
      ]);
      expect(useTerminalStore.getState().historyIndex).toBe(1);

      // Reload does not corrupt history
      browserReload();
      expect(useTerminalStore.getState().browserUrl).toBe("https://developer.mozilla.org");
      expect(useTerminalStore.getState().historyIndex).toBe(1);
    });

    it("handles device presets (responsive, iphone, ipad, desktop)", () => {
      const { setDevicePreset } = useTerminalStore.getState();
      expect(useTerminalStore.getState().devicePreset).toBe("responsive");

      setDevicePreset("iphone");
      expect(useTerminalStore.getState().devicePreset).toBe("iphone");

      setDevicePreset("ipad");
      expect(useTerminalStore.getState().devicePreset).toBe("ipad");

      setDevicePreset("desktop");
      expect(useTerminalStore.getState().devicePreset).toBe("desktop");

      setDevicePreset("responsive");
      expect(useTerminalStore.getState().devicePreset).toBe("responsive");
    });

    it("tracks detected localhost ports from addDetectedPort and clearDetectedPorts", () => {
      const { addDetectedPort, clearDetectedPorts } = useTerminalStore.getState();
      expect(useTerminalStore.getState().detectedPorts).toEqual([]);

      addDetectedPort({ port: 5173, url: "http://localhost:5173", title: "Vite Dev Server", timestamp: 1000 });
      expect(useTerminalStore.getState().detectedPorts).toEqual([
        { port: 5173, url: "http://localhost:5173", title: "Vite Dev Server", timestamp: 1000 },
      ]);

      // Adding existing port updates it rather than duplicating
      addDetectedPort({ port: 5173, url: "http://localhost:5173", title: "Vite App", timestamp: 2000 });
      expect(useTerminalStore.getState().detectedPorts).toEqual([
        { port: 5173, url: "http://localhost:5173", title: "Vite App", timestamp: 2000 },
      ]);

      addDetectedPort({ port: 3000, url: "http://localhost:3000" });
      expect(useTerminalStore.getState().detectedPorts.length).toBe(2);

      clearDetectedPorts();
      expect(useTerminalStore.getState().detectedPorts).toEqual([]);
    });

    it("scans output text and auto-registers localhost ports", () => {
      const { scanOutputForPorts } = useTerminalStore.getState();
      scanOutputForPorts("  VITE v5.4.1  ready in 240 ms\n\n  ➜  Local:   http://localhost:5173/\n  ➜  Network: http://192.168.1.5:5173/\n");

      const ports = useTerminalStore.getState().detectedPorts;
      expect(ports.some((p) => p.port === 5173)).toBe(true);

      scanOutputForPorts("Server listening on http://127.0.0.1:8080");
      const updatedPorts = useTerminalStore.getState().detectedPorts;
      expect(updatedPorts.some((p) => p.port === 8080)).toBe(true);
    });
  });

  describe("Editor store state and actions", () => {
    it("opens a file with provided content and sets active tab", async () => {
      await useTerminalStore.getState().openFileInEditor("D:/oppa/src/App.tsx", "const a = 1;");
      const state = useTerminalStore.getState();
      expect(state.editorTabs.length).toBe(1);
      expect(state.editorTabs[0]).toEqual({
        path: "D:/oppa/src/App.tsx",
        name: "App.tsx",
        content: "const a = 1;",
        originalContent: "const a = 1;",
        isDirty: false,
        language: "typescript",
        isMarkdown: false,
      });
      expect(state.activeEditorPath).toBe("D:/oppa/src/App.tsx");
      expect(state.editorViewMode).toBe("edit");
    });

    it("opens a file by reading from disk if content is omitted", async () => {
      readFileMock.mockResolvedValueOnce("fn main() { println!(\"hello\"); }");
      await useTerminalStore.getState().openFileInEditor("D:/oppa/src-tauri/src/main.rs");
      expect(readFileMock).toHaveBeenCalledWith("D:/oppa/src-tauri/src/main.rs");
      const state = useTerminalStore.getState();
      expect(state.editorTabs.length).toBe(1);
      expect(state.editorTabs[0].content).toBe("fn main() { println!(\"hello\"); }");
      expect(state.editorTabs[0].originalContent).toBe("fn main() { println!(\"hello\"); }");
      expect(state.editorTabs[0].language).toBe("rust");
      expect(state.editorTabs[0].isDirty).toBe(false);
      expect(state.activeEditorPath).toBe("D:/oppa/src-tauri/src/main.rs");
    });

    it("focuses existing tab when opening a file that is already open", async () => {
      await useTerminalStore.getState().openFileInEditor("D:/oppa/src/App.tsx", "const a = 1;");
      await useTerminalStore.getState().openFileInEditor("D:/oppa/src/index.ts", "const b = 2;");
      expect(useTerminalStore.getState().activeEditorPath).toBe("D:/oppa/src/index.ts");
      expect(useTerminalStore.getState().editorTabs.length).toBe(2);

      // Re-open first file
      await useTerminalStore.getState().openFileInEditor("D:/oppa/src/App.tsx");
      expect(useTerminalStore.getState().editorTabs.length).toBe(2);
      expect(useTerminalStore.getState().activeEditorPath).toBe("D:/oppa/src/App.tsx");
    });

    it("sets isMarkdown and editorViewMode to markdown-split for markdown files", async () => {
      await useTerminalStore.getState().openFileInEditor("D:/oppa/README.md", "# Title");
      const state = useTerminalStore.getState();
      expect(state.editorTabs[0].isMarkdown).toBe(true);
      expect(state.editorTabs[0].language).toBe("markdown");
      expect(state.editorViewMode).toBe("markdown-split");
    });

    it("detects programming languages accurately from file extensions", async () => {
      const { openFileInEditor } = useTerminalStore.getState();
      await openFileInEditor("file.py", "x = 1");
      await openFileInEditor("file.json", "{}");
      await openFileInEditor("file.html", "<div></div>");
      await openFileInEditor("file.css", "body {}");
      await openFileInEditor("file.toml", "[pkg]");
      await openFileInEditor("file.yaml", "key: val");
      await openFileInEditor("file.sh", "#!/bin/sh");
      await openFileInEditor("file.go", "package main");

      const tabs = useTerminalStore.getState().editorTabs;
      expect(tabs.find((t) => t.path === "file.py")?.language).toBe("python");
      expect(tabs.find((t) => t.path === "file.json")?.language).toBe("json");
      expect(tabs.find((t) => t.path === "file.html")?.language).toBe("html");
      expect(tabs.find((t) => t.path === "file.css")?.language).toBe("css");
      expect(tabs.find((t) => t.path === "file.toml")?.language).toBe("toml");
      expect(tabs.find((t) => t.path === "file.yaml")?.language).toBe("yaml");
      expect(tabs.find((t) => t.path === "file.sh")?.language).toBe("shell");
      expect(tabs.find((t) => t.path === "file.go")?.language).toBe("go");
    });

    it("updates tab content and tracks isDirty state", async () => {
      await useTerminalStore.getState().openFileInEditor("D:/oppa/src/App.tsx", "initial");
      expect(useTerminalStore.getState().editorTabs[0].isDirty).toBe(false);

      useTerminalStore.getState().updateEditorContent("D:/oppa/src/App.tsx", "modified");
      expect(useTerminalStore.getState().editorTabs[0].content).toBe("modified");
      expect(useTerminalStore.getState().editorTabs[0].isDirty).toBe(true);

      // Reverting back to original clears isDirty
      useTerminalStore.getState().updateEditorContent("D:/oppa/src/App.tsx", "initial");
      expect(useTerminalStore.getState().editorTabs[0].content).toBe("initial");
      expect(useTerminalStore.getState().editorTabs[0].isDirty).toBe(false);
    });

    it("saves active file via writeFile and clears isDirty flag", async () => {
      await useTerminalStore.getState().openFileInEditor("D:/oppa/src/App.tsx", "initial");
      useTerminalStore.getState().updateEditorContent("D:/oppa/src/App.tsx", "saved content");
      expect(useTerminalStore.getState().editorTabs[0].isDirty).toBe(true);

      await useTerminalStore.getState().saveActiveFile();
      expect(writeFileMock).toHaveBeenCalledWith("D:/oppa/src/App.tsx", "saved content");
      const tab = useTerminalStore.getState().editorTabs[0];
      expect(tab.isDirty).toBe(false);
      expect(tab.originalContent).toBe("saved content");
      expect(tab.content).toBe("saved content");
    });

    it("saveActiveFile does nothing if no active file", async () => {
      await useTerminalStore.getState().saveActiveFile();
      expect(writeFileMock).not.toHaveBeenCalled();
    });

    it("closes an active tab and selects adjacent tab", async () => {
      await useTerminalStore.getState().openFileInEditor("tab1.ts", "1");
      await useTerminalStore.getState().openFileInEditor("tab2.ts", "2");
      await useTerminalStore.getState().openFileInEditor("tab3.ts", "3");
      expect(useTerminalStore.getState().activeEditorPath).toBe("tab3.ts");

      useTerminalStore.getState().closeEditorTab("tab3.ts");
      expect(useTerminalStore.getState().editorTabs.length).toBe(2);
      expect(useTerminalStore.getState().activeEditorPath).toBe("tab2.ts");

      useTerminalStore.getState().closeEditorTab("tab1.ts");
      expect(useTerminalStore.getState().editorTabs.length).toBe(1);
      expect(useTerminalStore.getState().activeEditorPath).toBe("tab2.ts");

      useTerminalStore.getState().closeEditorTab("tab2.ts");
      expect(useTerminalStore.getState().editorTabs.length).toBe(0);
      expect(useTerminalStore.getState().activeEditorPath).toBeNull();
    });

    it("closing a non-active tab does not switch activeEditorPath", async () => {
      await useTerminalStore.getState().openFileInEditor("tab1.ts", "1");
      await useTerminalStore.getState().openFileInEditor("tab2.ts", "2");
      useTerminalStore.getState().setActiveEditorTab("tab2.ts");

      useTerminalStore.getState().closeEditorTab("tab1.ts");
      expect(useTerminalStore.getState().editorTabs.length).toBe(1);
      expect(useTerminalStore.getState().activeEditorPath).toBe("tab2.ts");
    });

    it("setActiveEditorTab sets activeEditorPath", async () => {
      await useTerminalStore.getState().openFileInEditor("tab1.ts", "1");
      await useTerminalStore.getState().openFileInEditor("tab2.ts", "2");
      useTerminalStore.getState().setActiveEditorTab("tab1.ts");
      expect(useTerminalStore.getState().activeEditorPath).toBe("tab1.ts");
    });

    it("stages AI diff, opens tab if needed, and switches to diff mode", () => {
      useTerminalStore.getState().stageAiDiff("D:/oppa/src/App.tsx", "const x = 1;", "const x = 2;", "Update x");
      const state = useTerminalStore.getState();
      expect(state.pendingAiDiff).toEqual({
        path: "D:/oppa/src/App.tsx",
        original: "const x = 1;",
        modified: "const x = 2;",
        summary: "Update x",
      });
      expect(state.editorViewMode).toBe("diff");
      expect(state.activeEditorPath).toBe("D:/oppa/src/App.tsx");
      expect(state.editorTabs.length).toBe(1);
      expect(state.editorTabs[0].content).toBe("const x = 1;");
    });

    it("accepts AI diff by saving modified content to disk and switching to edit mode", async () => {
      useTerminalStore.getState().stageAiDiff("D:/oppa/src/App.tsx", "const x = 1;", "const x = 2;", "Update x");
      await useTerminalStore.getState().acceptAiDiff();

      expect(writeFileMock).toHaveBeenCalledWith("D:/oppa/src/App.tsx", "const x = 2;");
      const state = useTerminalStore.getState();
      expect(state.pendingAiDiff).toBeNull();
      expect(state.editorViewMode).toBe("edit");
      expect(state.editorTabs[0].content).toBe("const x = 2;");
      expect(state.editorTabs[0].originalContent).toBe("const x = 2;");
      expect(state.editorTabs[0].isDirty).toBe(false);
    });

    it("rejects AI diff by clearing pendingAiDiff and restoring edit mode without modifying content", () => {
      useTerminalStore.getState().stageAiDiff("D:/oppa/src/App.tsx", "const x = 1;", "const x = 2;", "Update x");
      useTerminalStore.getState().rejectAiDiff();

      expect(writeFileMock).not.toHaveBeenCalled();
      const state = useTerminalStore.getState();
      expect(state.pendingAiDiff).toBeNull();
      expect(state.editorViewMode).toBe("edit");
      expect(state.editorTabs[0].content).toBe("const x = 1;");
    });

    it("setEditorViewMode updates editorViewMode", () => {
      useTerminalStore.getState().setEditorViewMode("markdown-preview");
      expect(useTerminalStore.getState().editorViewMode).toBe("markdown-preview");
      useTerminalStore.getState().setEditorViewMode("diff");
      expect(useTerminalStore.getState().editorViewMode).toBe("diff");
    });

    it("supports setting appMode to editor", () => {
      useTerminalStore.getState().setAppMode("editor");
      expect(useTerminalStore.getState().activeAppMode).toBe("editor");
    });
  });

  describe("swapPanes", () => {
    beforeEach(() => {
      useTerminalStore.setState({ ready: true });
    });

    it("swaps two leaf positions in single-tab layout and updates focusedPath to follow focused session", () => {
      useTerminalStore.setState({
        layout: {
          type: "split",
          dir: "h",
          ratio: 0.5,
          a: { type: "leaf", id: "p1" },
          b: { type: "leaf", id: "p2" },
        },
        focusedPath: [0],
        sessions: {
          p1: { id: "p1", title: "p1", status: "running", cols: 80, rows: 24 },
          p2: { id: "p2", title: "p2", status: "running", cols: 80, rows: 24 },
        },
      });
      saveLayoutMock.mockClear();

      useTerminalStore.getState().swapPanes("p1", "p2");

      const state = useTerminalStore.getState();
      expect(state.layout).toEqual({
        type: "split",
        dir: "h",
        ratio: 0.5,
        a: { type: "leaf", id: "p2" },
        b: { type: "leaf", id: "p1" },
      });
      // Focused session was p1 at [0]; after swap, p1 is at [1], so focusedPath becomes [1]
      expect(state.focusedPath).toEqual([1]);
      expect(saveLayoutMock).toHaveBeenCalled();
    });

    it("swaps leaves in the active tab of multi-tab state", () => {
      useTerminalStore.setState({
        tabs: [
          {
            id: "t1",
            layout: {
              type: "split",
              dir: "h",
              ratio: 0.5,
              a: { type: "leaf", id: "p1" },
              b: { type: "leaf", id: "p2" },
            },
            focusedPath: [1],
          },
          {
            id: "t2",
            layout: { type: "leaf", id: "p3" },
            focusedPath: [],
          },
        ],
        activeTabId: "t1",
        sessions: {
          p1: { id: "p1", title: "p1", status: "running", cols: 80, rows: 24 },
          p2: { id: "p2", title: "p2", status: "running", cols: 80, rows: 24 },
          p3: { id: "p3", title: "p3", status: "running", cols: 80, rows: 24 },
        },
      });
      saveLayoutMock.mockClear();

      useTerminalStore.getState().swapPanes("p1", "p2");

      const state = useTerminalStore.getState();
      const tab1 = state.tabs.find((t) => t.id === "t1");
      expect(tab1?.layout).toEqual({
        type: "split",
        dir: "h",
        ratio: 0.5,
        a: { type: "leaf", id: "p2" },
        b: { type: "leaf", id: "p1" },
      });
      // Focused session was p2 at [1]; after swap, p2 is at [0]
      expect(tab1?.focusedPath).toEqual([0]);
      expect(state.layout).toEqual(tab1?.layout);
      expect(state.focusedPath).toEqual([0]);
      expect(saveLayoutMock).toHaveBeenCalled();
    });

    it("does nothing when swapping identical IDs or missing IDs", () => {
      const tree = {
        type: "split" as const,
        dir: "h" as const,
        ratio: 0.5,
        a: { type: "leaf" as const, id: "p1" },
        b: { type: "leaf" as const, id: "p2" },
      };
      useTerminalStore.setState({
        layout: tree,
        focusedPath: [0],
      });
      saveLayoutMock.mockClear();

      useTerminalStore.getState().swapPanes("p1", "p1");
      useTerminalStore.getState().swapPanes("p1", "nonexistent");

      const state = useTerminalStore.getState();
      expect(state.layout).toBe(tree);
      expect(saveLayoutMock).not.toHaveBeenCalled();
    });
  });

  describe("movePane", () => {
    beforeEach(() => {
      useTerminalStore.setState({ ready: true });
    });

    it("moves source pane relative to target pane and updates focusedPath to sourceId", () => {
      useTerminalStore.setState({
        layout: {
          type: "split",
          dir: "h",
          ratio: 0.5,
          a: { type: "leaf", id: "p1" },
          b: { type: "leaf", id: "p2" },
        },
        focusedPath: [0],
        sessions: {
          p1: { id: "p1", title: "p1", status: "running", cols: 80, rows: 24 },
          p2: { id: "p2", title: "p2", status: "running", cols: 80, rows: 24 },
        },
      });
      saveLayoutMock.mockClear();

      useTerminalStore.getState().movePane("p1", "p2", "bottom");

      const state = useTerminalStore.getState();
      expect(state.layout).toEqual({
        type: "split",
        dir: "v",
        ratio: 0.5,
        a: { type: "leaf", id: "p2" },
        b: { type: "leaf", id: "p1" },
      });
      // sourceId p1 is now at [1]
      expect(state.focusedPath).toEqual([1]);
      expect(saveLayoutMock).toHaveBeenCalled();
    });

    it("updates multi-tab active tab layout and focusedPath on movePane", () => {
      useTerminalStore.setState({
        tabs: [
          {
            id: "t1",
            layout: {
              type: "split",
              dir: "h",
              ratio: 0.5,
              a: {
                type: "split",
                dir: "v",
                ratio: 0.5,
                a: { type: "leaf", id: "p1" },
                b: { type: "leaf", id: "p2" },
              },
              b: { type: "leaf", id: "p3" },
            },
            focusedPath: [0, 0],
          },
        ],
        activeTabId: "t1",
      });
      saveLayoutMock.mockClear();

      useTerminalStore.getState().movePane("p3", "p1", "top");

      const state = useTerminalStore.getState();
      const tab = state.tabs[0];
      expect(tab.layout).toEqual({
        type: "split",
        dir: "v",
        ratio: 0.5,
        a: {
          type: "split",
          dir: "v",
          ratio: 0.5,
          a: { type: "leaf", id: "p3" },
          b: { type: "leaf", id: "p1" },
        },
        b: { type: "leaf", id: "p2" },
      });
      // sourceId p3 is now at [0, 0]
      expect(tab.focusedPath).toEqual([0, 0]);
      expect(state.focusedPath).toEqual([0, 0]);
      expect(saveLayoutMock).toHaveBeenCalled();
    });

    it("does nothing when moving identical IDs or missing IDs", () => {
      const tree = {
        type: "split" as const,
        dir: "h" as const,
        ratio: 0.5,
        a: { type: "leaf" as const, id: "p1" },
        b: { type: "leaf" as const, id: "p2" },
      };
      useTerminalStore.setState({
        layout: tree,
        focusedPath: [0],
      });
      saveLayoutMock.mockClear();

      useTerminalStore.getState().movePane("p1", "p1", "left");
      useTerminalStore.getState().movePane("p1", "missing", "top");

      const state = useTerminalStore.getState();
      expect(state.layout).toBe(tree);
      expect(saveLayoutMock).not.toHaveBeenCalled();
    });
  });

  describe("swapFocusedPane", () => {
    beforeEach(() => {
      useTerminalStore.setState({ ready: true });
    });

    it("swaps focused pane with adjacent sibling to the right", () => {
      useTerminalStore.setState({
        layout: {
          type: "split",
          dir: "h",
          ratio: 0.5,
          a: { type: "leaf", id: "p1" },
          b: { type: "leaf", id: "p2" },
        },
        focusedPath: [0],
      });

      useTerminalStore.getState().swapFocusedPane("right");

      const state = useTerminalStore.getState();
      expect(state.layout).toEqual({
        type: "split",
        dir: "h",
        ratio: 0.5,
        a: { type: "leaf", id: "p2" },
        b: { type: "leaf", id: "p1" },
      });
      // Focus follows p1 to its new position at [1]
      expect(state.focusedPath).toEqual([1]);
    });

    it("swaps focused pane with adjacent sibling to the left", () => {
      useTerminalStore.setState({
        layout: {
          type: "split",
          dir: "h",
          ratio: 0.5,
          a: { type: "leaf", id: "p1" },
          b: { type: "leaf", id: "p2" },
        },
        focusedPath: [1],
      });

      useTerminalStore.getState().swapFocusedPane("left");

      const state = useTerminalStore.getState();
      expect(state.layout).toEqual({
        type: "split",
        dir: "h",
        ratio: 0.5,
        a: { type: "leaf", id: "p2" },
        b: { type: "leaf", id: "p1" },
      });
      // Focus follows p2 to its new position at [0]
      expect(state.focusedPath).toEqual([0]);
    });

    it("swaps focused pane with adjacent vertical sibling up and down", () => {
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

      useTerminalStore.getState().swapFocusedPane("down");

      let state = useTerminalStore.getState();
      expect(state.layout).toEqual({
        type: "split",
        dir: "v",
        ratio: 0.5,
        a: { type: "leaf", id: "bottom" },
        b: { type: "leaf", id: "top" },
      });
      expect(state.focusedPath).toEqual([1]); // top is now at [1]

      useTerminalStore.getState().swapFocusedPane("up");

      state = useTerminalStore.getState();
      expect(state.layout).toEqual({
        type: "split",
        dir: "v",
        ratio: 0.5,
        a: { type: "leaf", id: "top" },
        b: { type: "leaf", id: "bottom" },
      });
      expect(state.focusedPath).toEqual([0]); // top is back at [0]
    });

    it("swaps across nested splits", () => {
      useTerminalStore.setState({
        layout: {
          type: "split",
          dir: "h",
          ratio: 0.5,
          a: {
            type: "split",
            dir: "v",
            ratio: 0.5,
            a: { type: "leaf", id: "p1" },
            b: { type: "leaf", id: "p2" },
          },
          b: { type: "leaf", id: "p3" },
        },
        focusedPath: [0, 0], // p1
      });

      // Swapping right from p1 reaches p3
      useTerminalStore.getState().swapFocusedPane("right");

      const state = useTerminalStore.getState();
      expect(state.layout).toEqual({
        type: "split",
        dir: "h",
        ratio: 0.5,
        a: {
          type: "split",
          dir: "v",
          ratio: 0.5,
          a: { type: "leaf", id: "p3" },
          b: { type: "leaf", id: "p2" },
        },
        b: { type: "leaf", id: "p1" },
      });
      expect(state.focusedPath).toEqual([1]); // p1 moved to [1]
    });

    it("no-ops when there is no adjacent pane in the specified direction", () => {
      const tree = {
        type: "split" as const,
        dir: "h" as const,
        ratio: 0.5,
        a: { type: "leaf" as const, id: "p1" },
        b: { type: "leaf" as const, id: "p2" },
      };
      useTerminalStore.setState({
        layout: tree,
        focusedPath: [0],
      });
      saveLayoutMock.mockClear();

      useTerminalStore.getState().swapFocusedPane("left"); // already leftmost
      useTerminalStore.getState().swapFocusedPane("up"); // no vertical split

      const state = useTerminalStore.getState();
      expect(state.layout).toBe(tree);
      expect(state.focusedPath).toEqual([0]);
      expect(saveLayoutMock).not.toHaveBeenCalled();
    });

    it("no-ops on a single leaf root", () => {
      const tree = { type: "leaf" as const, id: "p1" };
      useTerminalStore.setState({
        layout: tree,
        focusedPath: [],
      });
      saveLayoutMock.mockClear();

      useTerminalStore.getState().swapFocusedPane("right");

      const state = useTerminalStore.getState();
      expect(state.layout).toBe(tree);
      expect(saveLayoutMock).not.toHaveBeenCalled();
    });
  });

  describe("settings slice and integrations", () => {
    it("initializes with default settings and updates settings", () => {
      const store = useTerminalStore.getState();
      expect(store.settings).toEqual(DEFAULT_APP_SETTINGS);
      expect(store.settings.general.defaultCwdMode).toBe("home");
      expect(store.isSettingsOpen).toBe(false);
      expect(store.activeSettingsTab).toBe("general");

      store.openSettings("shortcuts");
      expect(useTerminalStore.getState().isSettingsOpen).toBe(true);
      expect(useTerminalStore.getState().activeSettingsTab).toBe("shortcuts");

      store.openSettings();
      expect(useTerminalStore.getState().isSettingsOpen).toBe(true);
      expect(useTerminalStore.getState().activeSettingsTab).toBe("general");

      store.closeSettings();
      expect(useTerminalStore.getState().isSettingsOpen).toBe(false);

      store.updateSettings({
        general: {
          defaultCwdMode: "last_active",
        },
      });
      const updatedState = useTerminalStore.getState();
      expect(updatedState.settings.general.defaultCwdMode).toBe("last_active");
      // Other general settings remain intact
      expect(updatedState.settings.general.confirmCloseTabWithMultiplePanes).toBe(true);
    });

    it("debounces saveSettings on updateSettings", async () => {
      vi.useFakeTimers();
      try {
        const store = useTerminalStore.getState();
        store.updateSettings({
          general: {
            defaultCwdMode: "custom",
            customDefaultCwd: "C:\\Projects",
          },
        });

        expect(saveSettingsMock).not.toHaveBeenCalled();
        vi.advanceTimersByTime(200);
        expect(saveSettingsMock).toHaveBeenCalledWith(
          expect.objectContaining({
            general: expect.objectContaining({
              defaultCwdMode: "custom",
              customDefaultCwd: "C:\\Projects",
            }),
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("resolves default CWD correctly based on settings mode", () => {
      const store = useTerminalStore.getState();

      // Home mode -> undefined
      expect(store.resolveDefaultCwd()).toBeUndefined();

      // Custom mode with trimmed valid path
      store.updateSettings({
        general: {
          defaultCwdMode: "custom",
          customDefaultCwd: "  D:\\oppa\\custom-cwd  ",
        },
      });
      expect(useTerminalStore.getState().resolveDefaultCwd()).toBe("D:\\oppa\\custom-cwd");

      // Custom mode with empty/whitespace path -> fallback undefined
      store.updateSettings({
        general: {
          defaultCwdMode: "custom",
          customDefaultCwd: "    ",
        },
      });
      expect(useTerminalStore.getState().resolveDefaultCwd()).toBeUndefined();

      // Last active mode without active session -> undefined
      store.updateSettings({
        general: {
          defaultCwdMode: "last_active",
        },
      });
      expect(useTerminalStore.getState().resolveDefaultCwd()).toBeUndefined();

      // Last active mode with active session CWD
      useTerminalStore.setState({
        tabs: [{ id: "t1", layout: { type: "leaf", id: "s1" }, focusedPath: [] }],
        activeTabId: "t1",
        sessions: {
          s1: { id: "s1", title: "s1", status: "running", cwd: "D:\\active\\dir", cols: 80, rows: 24 },
        },
      });
      expect(useTerminalStore.getState().resolveDefaultCwd()).toBe("D:\\active\\dir");
    });

    it("createTab and spawnSession integrate CWD resolution", async () => {
      ptySpawnMock.mockResolvedValue(spawnRes("s-custom"));

      // Configure custom default CWD
      useTerminalStore.getState().updateSettings({
        general: {
          defaultCwdMode: "custom",
          customDefaultCwd: "D:\\default\\workspace",
        },
      });

      // createTab without explicit cwd uses resolved default CWD
      await useTerminalStore.getState().createTab();
      expect(ptySpawnMock).toHaveBeenCalledWith({ cwd: "D:\\default\\workspace" });

      ptySpawnMock.mockClear();

      // createTab with explicit cwd overrides resolved default CWD
      await useTerminalStore.getState().createTab("D:\\explicit\\path");
      expect(ptySpawnMock).toHaveBeenCalledWith({ cwd: "D:\\explicit\\path" });

      ptySpawnMock.mockClear();

      // spawnSession without cwd uses resolved default CWD
      await useTerminalStore.getState().spawnSession();
      expect(ptySpawnMock).toHaveBeenCalledWith({ cwd: "D:\\default\\workspace" });

      ptySpawnMock.mockClear();

      // spawnSession with explicit cwd overrides resolved default CWD
      await useTerminalStore.getState().spawnSession("D:\\explicit\\spawn");
      expect(ptySpawnMock).toHaveBeenCalledWith({ cwd: "D:\\explicit\\spawn" });
    });

    it("loadSettingsData loads and updates settings from transport", async () => {
      const customLoaded = {
        ...DEFAULT_APP_SETTINGS,
        general: {
          ...DEFAULT_APP_SETTINGS.general,
          defaultCwdMode: "last_active" as const,
          editorWordWrap: false,
        },
      };
      loadSettingsMock.mockResolvedValueOnce(customLoaded);

      await useTerminalStore.getState().loadSettingsData();

      expect(loadSettingsMock).toHaveBeenCalled();
      expect(useTerminalStore.getState().settings).toEqual(customLoaded);
    });

    it("loadLayout invokes loadSettingsData during bootstrap", async () => {
      const customLoaded = {
        ...DEFAULT_APP_SETTINGS,
        general: {
          ...DEFAULT_APP_SETTINGS.general,
          browserSearchEngine: "google" as const,
        },
      };
      loadSettingsMock.mockResolvedValueOnce(customLoaded);

      await useTerminalStore.getState().loadLayout();

      expect(loadSettingsMock).toHaveBeenCalled();
      expect(useTerminalStore.getState().settings.general.browserSearchEngine).toBe("google");
    });

    it("tracks tabFocusHistory across tab creation, selection, and closure", async () => {
      ptySpawnMock.mockResolvedValue(spawnRes("s1"));
      const t1 = await useTerminalStore.getState().createTab();

      ptySpawnMock.mockResolvedValue(spawnRes("s2"));
      const t2 = await useTerminalStore.getState().createTab();

      ptySpawnMock.mockResolvedValue(spawnRes("s3"));
      const t3 = await useTerminalStore.getState().createTab();

      expect(useTerminalStore.getState().tabFocusHistory).toEqual([t3, t2, t1]);

      // Focus t1 -> t1 moves to the front of history
      useTerminalStore.getState().selectTab(t1);
      expect(useTerminalStore.getState().tabFocusHistory).toEqual([t1, t3, t2]);

      // Focus t2 -> t2 moves to the front of history
      useTerminalStore.getState().selectTab(t2);
      expect(useTerminalStore.getState().tabFocusHistory).toEqual([t2, t1, t3]);

      // Close t1 -> t1 is removed from history
      await useTerminalStore.getState().closeTab(t1);
      expect(useTerminalStore.getState().tabFocusHistory).toEqual([t2, t3]);
    });

    it("debounces editor auto-save when editorAutoSaveDelay > 0", async () => {
      vi.useFakeTimers();
      try {
        useTerminalStore.setState({
          editorTabs: [
            {
              path: "/workspace/index.ts",
              name: "index.ts",
              content: "initial",
              originalContent: "initial",
              isDirty: false,
              language: "typescript",
              isMarkdown: false,
            },
          ],
          activeEditorPath: "/workspace/index.ts",
          settings: {
            ...DEFAULT_APP_SETTINGS,
            general: {
              ...DEFAULT_APP_SETTINGS.general,
              editorAutoSaveDelay: 500,
            },
          },
        });

        useTerminalStore.getState().updateEditorContent("/workspace/index.ts", "modified content");
        expect(writeFileMock).not.toHaveBeenCalled();

        vi.advanceTimersByTime(499);
        expect(writeFileMock).not.toHaveBeenCalled();

        vi.advanceTimersByTime(2);
        expect(writeFileMock).toHaveBeenCalledWith("/workspace/index.ts", "modified content");
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not auto-save editor content when editorAutoSaveDelay is 0", async () => {
      vi.useFakeTimers();
      try {
        useTerminalStore.setState({
          editorTabs: [
            {
              path: "/workspace/index.ts",
              name: "index.ts",
              content: "initial",
              originalContent: "initial",
              isDirty: false,
              language: "typescript",
              isMarkdown: false,
            },
          ],
          activeEditorPath: "/workspace/index.ts",
          settings: {
            ...DEFAULT_APP_SETTINGS,
            general: {
              ...DEFAULT_APP_SETTINGS.general,
              editorAutoSaveDelay: 0,
            },
          },
        });

        useTerminalStore.getState().updateEditorContent("/workspace/index.ts", "modified content");
        vi.advanceTimersByTime(2000);
        expect(writeFileMock).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("initializes appearance settings with DEFAULT_APPEARANCE_SETTINGS", () => {
      const { settings } = useTerminalStore.getState();
      expect(settings.appearance).toEqual(DEFAULT_APPEARANCE_SETTINGS);
      expect(settings.appearance.appTheme).toBe("dark");
      expect(settings.appearance.appFontFamily).toBe(
        "'Geist', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      );
      expect(settings.appearance.uiZoom).toBe(1.0);
      expect(settings.appearance.sidebarOnLaunch).toBe("open");
      expect(settings.appearance.showStatusBar).toBe(true);
      expect(settings.appearance.showTitlebarLogo).toBe(true);
      expect(settings.appearance.themeName).toBe("oppa_dark");
      expect(settings.appearance.fontSize).toBe(14);
      expect(settings.appearance.lineHeight).toBe(1.2);
      expect(settings.appearance.cursorStyle).toBe("block");
      expect(settings.appearance.cursorBlink).toBe(true);
      expect(settings.appearance.dimInactivePanes).toBe(true);
    });

    it("updateAppearanceSettings updates individual and multiple appearance keys", () => {
      // Single key update
      useTerminalStore.getState().updateAppearanceSettings({ fontSize: 18 });
      expect(useTerminalStore.getState().settings.appearance.fontSize).toBe(18);
      expect(useTerminalStore.getState().settings.appearance.themeName).toBe("oppa_dark");

      // App & UI appearance updates
      useTerminalStore.getState().updateAppearanceSettings({
        appTheme: "light",
        uiZoom: 1.25,
        sidebarOnLaunch: "collapsed",
        showStatusBar: false,
        showTitlebarLogo: false,
      });

      const appearanceAfter = useTerminalStore.getState().settings.appearance;
      expect(appearanceAfter.appTheme).toBe("light");
      expect(appearanceAfter.uiZoom).toBe(1.25);
      expect(appearanceAfter.sidebarOnLaunch).toBe("collapsed");
      expect(appearanceAfter.showStatusBar).toBe(false);
      expect(appearanceAfter.showTitlebarLogo).toBe(false);

      // Multiple keys update
      useTerminalStore.getState().updateAppearanceSettings({
        themeName: "tokyo_night",
        lineHeight: 1.5,
        cursorStyle: "bar",
        cursorBlink: false,
        dimInactivePanes: false,
      });

      const appearance = useTerminalStore.getState().settings.appearance;
      expect(appearance.themeName).toBe("tokyo_night");
      expect(appearance.fontSize).toBe(18);
      expect(appearance.lineHeight).toBe(1.5);
      expect(appearance.cursorStyle).toBe("bar");
      expect(appearance.cursorBlink).toBe(false);
      expect(appearance.dimInactivePanes).toBe(false);
      // General settings unchanged
      expect(useTerminalStore.getState().settings.general.defaultCwdMode).toBe("home");
    });

    it("updateAppearanceSettings triggers debounced persistence", async () => {
      vi.useFakeTimers();
      try {
        useTerminalStore.getState().updateAppearanceSettings({
          themeName: "dracula",
          fontSize: 16,
        });

        expect(saveSettingsMock).not.toHaveBeenCalled();
        vi.advanceTimersByTime(200);
        expect(saveSettingsMock).toHaveBeenCalledWith(
          expect.objectContaining({
            appearance: expect.objectContaining({
              themeName: "dracula",
              fontSize: 16,
            }),
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("updateSettings merges appearance slice and triggers debounced persistence", async () => {
      vi.useFakeTimers();
      try {
        useTerminalStore.getState().updateSettings({
          appearance: {
            themeName: "nord",
          },
        });

        expect(useTerminalStore.getState().settings.appearance.themeName).toBe("nord");
        expect(useTerminalStore.getState().settings.appearance.fontSize).toBe(14);
        expect(saveSettingsMock).not.toHaveBeenCalled();
        vi.advanceTimersByTime(200);
        expect(saveSettingsMock).toHaveBeenCalledWith(
          expect.objectContaining({
            appearance: expect.objectContaining({
              themeName: "nord",
            }),
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });
});


