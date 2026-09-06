import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTerminalStore, markScrollbackDirty, selectProjectTree } from "./terminalStore";
import * as ptyTransport from "../lib/pty/transport";
import * as worktreeTransport from "../lib/worktree/transport";
import * as gitTransport from "../lib/git/transport";
import * as layoutTransport from "../lib/layout/transport";
import * as workspaceTransport from "../lib/workspace/transport";
import * as fsTransport from "../lib/fs/transport";
import * as settingsTransport from "../lib/settings/transport";
import * as windowTransport from "../lib/window/transport";
import { DEFAULT_APP_SETTINGS, DEFAULT_APPEARANCE_SETTINGS } from "../lib/settings/types";

vi.mock("../lib/pty/transport", () => ({
  ptySpawn: vi.fn(),
  ptyKill: vi.fn(),
  ptyResize: vi.fn().mockResolvedValue(undefined),
  ptyAck: vi.fn().mockResolvedValue(undefined),
  ptyWrite: vi.fn().mockResolvedValue(undefined),
  ptyList: vi.fn().mockResolvedValue([]),
  ptySetTitle: vi.fn().mockResolvedValue(undefined),
  ptyResetTitle: vi.fn().mockResolvedValue(undefined),
  onTitleChanged: vi.fn().mockResolvedValue(() => {}),
  onFocusRequested: vi.fn().mockResolvedValue(() => {}),
  onSessionWorking: vi.fn().mockResolvedValue(() => {}),
  onAgentStatus: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("../lib/worktree/transport", () => ({
  worktreeList: vi.fn().mockResolvedValue([]),
  worktreePs: vi.fn().mockResolvedValue([]),
  worktreeCreate: vi.fn(),
  worktreeSet: vi.fn().mockResolvedValue(null),
  worktreeRemove: vi.fn().mockResolvedValue(undefined),
  worktreePurge: vi.fn().mockResolvedValue(undefined),
  repoAdd: vi.fn().mockResolvedValue([]),
  repoList: vi.fn().mockResolvedValue([]),
  agentProfiles: vi.fn().mockResolvedValue([]),
  worktreeCreateAgent: vi.fn(),
  worktreeCreateFleet: vi.fn(),
  onWorktreeChanged: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("../lib/git/transport", () => ({
  scStatus: vi.fn().mockResolvedValue({
    entries: [],
    conflict_state: "none",
    branch: "main",
    upstream: { has_upstream: false, ahead: 0, behind: 0, remote_branch: null },
    did_hit_limit: false,
    status_length: 0,
  }),
  scStage: vi.fn().mockResolvedValue(undefined),
  scUnstage: vi.fn().mockResolvedValue(undefined),
  scDiscard: vi.fn().mockResolvedValue(undefined),
  scCommit: vi.fn().mockResolvedValue("abc1234"),
  scLocalBranches: vi.fn().mockResolvedValue({ branches: ["main"], current: "main" }),
  scCheckout: vi.fn().mockResolvedValue(undefined),
  scBranchCompare: vi.fn().mockResolvedValue({
    base_ref: "main",
    ahead: 0,
    behind: 0,
    changed_files: [],
  }),
  scFetch: vi.fn().mockResolvedValue(undefined),
  scHistory: vi.fn().mockResolvedValue({ items: [], has_more: false }),
  scFileDiff: vi.fn().mockResolvedValue({
    kind: "text",
    original_content: "",
    modified_content: "",
    truncated: false,
  }),
  scPull: vi.fn().mockResolvedValue({ status: "up-to-date", new_head: null }),
  scFastForward: vi.fn().mockResolvedValue({ status: "up-to-date", new_head: null }),
  scPush: vi.fn().mockResolvedValue({ pushed_to: "origin/main", was_publish: false }),
  onGitChanged: vi.fn().mockResolvedValue(() => {}),
  onPrChanged: vi.fn().mockResolvedValue(() => {}),
  requestReviewEligibility: vi.fn().mockResolvedValue({ eligible: true, blocked_reason: null, base_ref: 'main', owner_repo: 'owner/repo', existing_pr_url: null }),
  requestCreateReview: vi.fn().mockResolvedValue({ pr_url: 'https://example.com/pr/1', pr_number: 1, base_ref: 'main', owner_repo: 'owner/repo' }),
  requestReviewStatus: vi.fn().mockResolvedValue({ number: 1, title: 't', url: 'https://example.com/pr/1', state: 'open', draft: false, mergeable: 'unknown', base_ref_name: 'main', head_ref_name: 'feat', checks: [], fetched_at_ms: 0 }),
}));

vi.mock("../lib/layout/transport", () => ({
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

vi.mock("../lib/window/transport", () => ({
  getSavedWindowState: vi.fn().mockResolvedValue(null),
  applyWindowState: vi.fn().mockResolvedValue(undefined),
}));

const ptySpawnMock = vi.mocked(ptyTransport.ptySpawn);
const ptyKillMock = vi.mocked(ptyTransport.ptyKill);
const ptyWriteMock = vi.mocked(ptyTransport.ptyWrite);
const saveLayoutMock = vi.mocked(layoutTransport.saveLayout);
const loadLayoutMock = vi.mocked(layoutTransport.loadLayout);
const saveScrollbackMock = vi.mocked(layoutTransport.saveScrollback);
const loadScrollbackMock = vi.mocked(layoutTransport.loadScrollback);
const deleteScrollbackMock = vi.mocked(layoutTransport.deleteScrollback);
const cleanupStaleScrollbacksMock = vi.mocked(layoutTransport.cleanupStaleScrollbacks);
const saveRecentsMock = vi.mocked(workspaceTransport.saveRecents);
const loadRecentsMock = vi.mocked(workspaceTransport.loadRecents);
const savePresetsMock = vi.mocked(workspaceTransport.savePresets);
const loadPresetsMock = vi.mocked(workspaceTransport.loadPresets);
const readFileMock = vi.mocked(fsTransport.readFile);
const writeFileMock = vi.mocked(fsTransport.writeFile);
const saveSettingsMock = vi.mocked(settingsTransport.saveSettings);
const loadSettingsMock = vi.mocked(settingsTransport.loadSettings);
const getSavedWindowStateMock = vi.mocked(windowTransport.getSavedWindowState);
const applyWindowStateMock = vi.mocked(windowTransport.applyWindowState);
const worktreeListMock = vi.mocked(worktreeTransport.worktreeList);
const worktreePsMock = vi.mocked(worktreeTransport.worktreePs);
const worktreeCreateMock = vi.mocked(worktreeTransport.worktreeCreate);
const worktreeSetMock = vi.mocked(worktreeTransport.worktreeSet);
const worktreeRemoveMock = vi.mocked(worktreeTransport.worktreeRemove);
const worktreePurgeMock = vi.mocked(worktreeTransport.worktreePurge);
const repoAddMock = vi.mocked(worktreeTransport.repoAdd);
const repoListMock = vi.mocked(worktreeTransport.repoList);
const ptyListMock = vi.mocked(ptyTransport.ptyList);
const worktreeCreateAgentMock = vi.mocked(worktreeTransport.worktreeCreateAgent);
const worktreeCreateFleetMock = vi.mocked(worktreeTransport.worktreeCreateFleet);

function worktreeRecord(overrides: Partial<worktreeTransport.WorktreeRecord> = {}): worktreeTransport.WorktreeRecord {
  return {
    id: "demo::C:/ws/feat-a",
    repo_id: "demo",
    name: "feat-a",
    display_name: null,
    branch: "feat-a",
    path: "C:/ws/feat-a",
    base_ref: "main",
    parent_worktree_id: null,
    child_worktree_ids: [],
    workspace_status: "todo",
    retired: false,
    created_at_ms: 1723900000000,
    linked_pr_url: null,
    ...overrides,
  };
}

function spawnRes(id: string, is_new = true, snapshot?: string | null): ptyTransport.PtySpawnResult {
  return { id, is_new, snapshot, pid: 1234, cols: 80, rows: 24 };
}

// Leaf ids in DFS order for asserting rebuilt grid layouts.
function leafIdList(node: unknown): string[] {
  if (!node || typeof node !== "object") return [];
  const n = node as { type?: string; id?: string; a?: unknown; b?: unknown };
  if (n.type === "leaf") return [n.id ?? ""];
  return [...leafIdList(n.a), ...leafIdList(n.b)];
}

// Module-init subscriptions register during import; capture before clearAllMocks runs.
const titleChangedHandler = vi.mocked(ptyTransport.onTitleChanged).mock.calls[0]?.[0];
const focusRequestedHandler = vi.mocked(ptyTransport.onFocusRequested).mock.calls[0]?.[0];

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

  it("spawnSession stores resumeKind when the daemon returns a resume plan", async () => {
    ptySpawnMock.mockResolvedValue({
      ...spawnRes("agent-1"),
      is_warm: false,
      resume: { command_line: "claude --resume abc123", kind: "agent-resume" },
    });
    await useTerminalStore.getState().spawnSession();
    const session = useTerminalStore.getState().sessions["agent-1"];
    expect(session.resumeKind).toBe("agent-resume");
    expect(session.isRestored).toBeUndefined();
  });

  it("spawnSession uses the daemon birth title when provided", async () => {
    ptySpawnMock.mockResolvedValue({ ...spawnRes("s-1-1"), title: "fox" });
    const id = await useTerminalStore.getState().spawnSession();
    expect(useTerminalStore.getState().sessions[id].title).toBe("fox");
  });

  it("spawnSession falls back to a friendly name when the daemon omits the title", async () => {
    ptySpawnMock.mockResolvedValue(spawnRes("s-1786150000000-9"));
    const id = await useTerminalStore.getState().spawnSession();
    const title = useTerminalStore.getState().sessions[id].title;
    expect(title).not.toBe(id);
    expect(title.startsWith("s-")).toBe(false);
  });

  it("spawnSession replaces a synthetic existing title on reattach", async () => {
    useTerminalStore.setState({
      sessions: {
        "s-keep": {
          id: "s-keep",
          title: "s-keep",
          status: "sleeping",
          cols: 80,
          rows: 24,
        },
      },
    });
    ptySpawnMock.mockResolvedValue({ ...spawnRes("s-keep"), is_new: false, title: "heron" });
    const id = await useTerminalStore.getState().spawnSession(undefined, undefined, "s-keep");
    expect(useTerminalStore.getState().sessions[id].title).toBe("heron");
  });

  it("spawnSession keeps a user title across reattach", async () => {
    useTerminalStore.setState({
      sessions: {
        "s-mine": {
          id: "s-mine",
          title: "Build Output",
          status: "sleeping",
          cols: 80,
          rows: 24,
        },
      },
    });
    ptySpawnMock.mockResolvedValue({ ...spawnRes("s-mine"), is_new: false, title: "fox" });
    const id = await useTerminalStore.getState().spawnSession(undefined, undefined, "s-mine");
    expect(useTerminalStore.getState().sessions[id].title).toBe("Build Output");
  });

  it("spawnSession sends resumeAgents:false when auto-resume setting is disabled", async () => {
    useTerminalStore.setState({
      settings: {
        ...DEFAULT_APP_SETTINGS,
        general: { ...DEFAULT_APP_SETTINGS.general, autoResumeAgents: false },
      },
    });
    ptySpawnMock.mockResolvedValue(spawnRes("no-resume"));
    await useTerminalStore.getState().spawnSession();
    expect(ptySpawnMock).toHaveBeenCalledWith({ resumeAgents: false });
    const session = useTerminalStore.getState().sessions["no-resume"];
    expect(session.resumeKind).toBeUndefined();
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

  it("spawnSession forwards geometry (cols and rows) in options when provided", async () => {
    ptySpawnMock.mockResolvedValue({
      id: "session-geom",
      is_new: true,
      pid: 1234,
      cols: 120,
      rows: 40,
      cwd: "C:\\custom",
    });
    const id = await useTerminalStore.getState().spawnSession(
      "C:\\custom",
      "pwsh",
      "session-geom",
      { cols: 120, rows: 40 },
    );
    expect(ptySpawnMock).toHaveBeenCalledWith({
      id: "session-geom",
      cwd: "C:\\custom",
      shell: "pwsh",
      cols: 120,
      rows: 40,
    });
    expect(id).toBe("session-geom");
    const session = useTerminalStore.getState().sessions["session-geom"];
    expect(session).toBeDefined();
    expect(session.cols).toBe(120);
    expect(session.rows).toBe(40);
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

  it("ackSession forwards the byte count to the transport", () => {
    const ptyAckMock = vi.mocked(ptyTransport.ptyAck);
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

  it("splitPaneWithCommand delivers the launch command at spawn, never via timed write", async () => {
    ptySpawnMock.mockResolvedValue(spawnRes("s-agent"));
    useTerminalStore.setState({
      sessions: {
        root: { id: "root", title: "root", status: "running", cwd: "D:\\oppa\\project", cols: 80, rows: 24 },
      },
      layout: { type: "leaf", id: "root" },
      focusedPath: [],
    });
    await useTerminalStore.getState().splitPaneWithCommand("h", [], "opencode", "OpenCode");
    // The daemon injects this on shell-readiness: no wall-clock write race.
    expect(ptySpawnMock).toHaveBeenCalledWith({
      cwd: "D:\\oppa\\project",
      initialCommand: "opencode",
    });
    const state = useTerminalStore.getState();
    expect(state.layout).toEqual({
      type: "split",
      dir: "h",
      ratio: 0.5,
      a: { type: "leaf", id: "root" },
      b: { type: "leaf", id: "s-agent" },
    });
    expect(state.focusedPath).toEqual([1]);
    expect(state.sessions["s-agent"].title).toBe("OpenCode");
    expect(ptyWriteMock).not.toHaveBeenCalled();
  });

  it("splitPaneWithCommand omits initialCommand for blank commands", async () => {
    ptySpawnMock.mockResolvedValue(spawnRes("s-blank"));
    useTerminalStore.setState({
      sessions: {
        root: { id: "root", title: "root", status: "running", cwd: "D:\\oppa\\project", cols: 80, rows: 24 },
      },
      layout: { type: "leaf", id: "root" },
      focusedPath: [],
    });
    await useTerminalStore.getState().splitPaneWithCommand("h", [], "   ", undefined);
    expect(ptySpawnMock).toHaveBeenCalledWith({ cwd: "D:\\oppa\\project" });
    expect(ptyWriteMock).not.toHaveBeenCalled();
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
    // Structural changes persist through the shared 2s debounce so rapid
    // interactions (tab switching, drag, splits) never trigger one disk
    // write per action. The close handshake still saves immediately.
    beforeEach(() => {
      useTerminalStore.setState({ ready: true });
    });

    async function expectDebouncedSave(run: () => void | Promise<unknown>) {
      vi.useFakeTimers();
      try {
        saveLayoutMock.mockClear();
        await run();
        expect(saveLayoutMock).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2000);
        expect(saveLayoutMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    }

    it("createTab persists the new tab layout after the debounce window", async () => {
      ptySpawnMock.mockResolvedValue(spawnRes("s2"));
      await expectDebouncedSave(() => useTerminalStore.getState().createTab());
    });

    it("selectTab does not persist synchronously on tab switch", async () => {
      useTerminalStore.setState({
        tabs: [
          { id: "t1", layout: { type: "leaf", id: "s1" }, focusedPath: [] },
          { id: "t2", layout: { type: "leaf", id: "s2" }, focusedPath: [] },
        ],
        activeTabId: "t1",
        ready: true,
      });
      await expectDebouncedSave(() => useTerminalStore.getState().selectTab("t2"));
    });

    it("closeTab persists the layout after closing a tab (debounced)", async () => {
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
      await expectDebouncedSave(() => useTerminalStore.getState().closeTab("t2"));
    });

    it("renameTab persists the tab title change (debounced)", async () => {
      useTerminalStore.setState({
        tabs: [{ id: "t1", title: "Old", layout: { type: "leaf", id: "s1" }, focusedPath: [] }],
        activeTabId: "t1",
        ready: true,
      });
      await expectDebouncedSave(() => useTerminalStore.getState().renameTab("t1", "New Title"));
    });

    it("splitPane persists the new arrangement (debounced)", async () => {
      ptySpawnMock.mockResolvedValue(spawnRes("s1"));
      await expectDebouncedSave(() => useTerminalStore.getState().splitPane("h"));
    });

    it("closePane persists the arrangement (debounced)", async () => {
      ptySpawnMock.mockResolvedValue(spawnRes("s1"));
      vi.useFakeTimers();
      try {
        await useTerminalStore.getState().splitPane("h");
        saveLayoutMock.mockClear();
        await useTerminalStore.getState().closePane();
        expect(saveLayoutMock).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2000);
        expect(saveLayoutMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
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

    it("saveLayout serializes scrollback only for sessions with new output since the last save", async () => {
      useTerminalStore.setState({
        ready: true,
        sessions: {
          s1: { id: "s1", title: "s1", status: "running", cols: 80, rows: 24 },
          s2: { id: "s2", title: "s2", status: "running", cols: 80, rows: 24 },
        },
        serializers: {
          s1: () => "buffer-one",
          s2: () => "buffer-two",
        },
      });
      saveScrollbackMock.mockClear();

      markScrollbackDirty("s1");
      await useTerminalStore.getState().saveLayout();
      let savedIds = saveScrollbackMock.mock.calls.map((c) => c[0]);
      expect(savedIds).toContain("s1");
      expect(savedIds).not.toContain("s2");

      // No new output since → nothing rewritten.
      saveScrollbackMock.mockClear();
      await useTerminalStore.getState().saveLayout();
      expect(saveScrollbackMock).not.toHaveBeenCalled();

      // Fresh output on the other session re-marks only it.
      markScrollbackDirty("s2");
      await useTerminalStore.getState().saveLayout();
      savedIds = saveScrollbackMock.mock.calls.map((c) => c[0]);
      expect(savedIds).toEqual(["s2"]);
    });

    it("cacheScrollback marks the session dirty for the next layout save", async () => {
      useTerminalStore.setState({
        ready: true,
        sessions: {
          s9: { id: "s9", title: "s9", status: "running", cols: 80, rows: 24 },
        },
        serializers: {},
        cachedScrollbacks: {},
      });
      saveScrollbackMock.mockClear();

      useTerminalStore.getState().cacheScrollback("s9", "cached-buffer");
      await useTerminalStore.getState().saveLayout();
      expect(saveScrollbackMock.mock.calls.map((c) => c[0])).toEqual(["s9"]);
    });

    it("updateSessionCwd debounces layout persistence by 2000ms", async () => {
      vi.useFakeTimers();
      useTerminalStore.setState({
        ready: true,
        sessions: {
          s1: { id: "s1", title: "s1", status: "running", cwd: "/old/dir", cols: 80, rows: 24 },
        },
      });
      saveLayoutMock.mockClear();
      useTerminalStore.getState().updateSessionCwd("s1", "/new/dir");
      expect(useTerminalStore.getState().sessions["s1"].cwd).toBe("/new/dir");
      expect(saveLayoutMock).not.toHaveBeenCalled();

      // Advancing 1000ms should still not call saveLayout
      await vi.advanceTimersByTimeAsync(1000);
      expect(saveLayoutMock).not.toHaveBeenCalled();

      // Advancing remaining 1000ms triggers saveLayout
      await vi.advanceTimersByTimeAsync(1000);
      expect(saveLayoutMock).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it("updateSessionCwd collapses rapid successive updates into a single debounced save", async () => {
      vi.useFakeTimers();
      useTerminalStore.setState({
        ready: true,
        sessions: {
          s1: { id: "s1", title: "s1", status: "running", cwd: "/old/dir", cols: 80, rows: 24 },
        },
      });
      saveLayoutMock.mockClear();
      useTerminalStore.getState().updateSessionCwd("s1", "/dir1");
      await vi.advanceTimersByTimeAsync(1000);
      useTerminalStore.getState().updateSessionCwd("s1", "/dir2");
      await vi.advanceTimersByTimeAsync(1000);
      expect(saveLayoutMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      expect(saveLayoutMock).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
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
      expect(parsed).toEqual(
        expect.objectContaining({
          version: 3,
          ui: expect.any(Object),
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
            { id: "a", title: "a", status: "running", cwd: "C:\\work", cols: 120, rows: 40, titlePinned: false },
            { id: "b", title: "b", status: "exited", cols: 80, rows: 24, titlePinned: false },
          ],
        }),
      );
    });

    it("saveLayout preserves sleeping sessions and prevents their scrollback cleanup", async () => {
      useTerminalStore.setState({
        tabs: [
          {
            id: "tab-1",
            title: "Active Tab",
            layout: { type: "leaf", id: "sess-1" },
            focusedPath: [],
            isSleeping: false,
          },
          {
            id: "tab-2",
            title: "Sleeping Tab",
            layout: { type: "leaf", id: "sess-2" },
            focusedPath: [],
            isSleeping: true,
          },
        ],
        sessions: {
          "sess-1": { id: "sess-1", title: "Active", status: "running", cols: 80, rows: 24, cwd: "C:/a" },
          "sess-2": { id: "sess-2", title: "Sleeping", status: "sleeping", cols: 80, rows: 24, cwd: "C:/b" },
        },
      });

      await useTerminalStore.getState().saveLayout();

      expect(saveLayoutMock).toHaveBeenCalledWith(
        expect.stringContaining('"id":"sess-2"'),
      );
      expect(cleanupStaleScrollbacksMock).toHaveBeenCalledWith(
        expect.arrayContaining(["sess-1", "sess-2"]),
      );
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
      markScrollbackDirty("a");
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
      markScrollbackDirty("active");
      markScrollbackDirty("bg");
      await useTerminalStore.getState().saveLayout();
      expect(saveScrollbackMock).toHaveBeenCalledWith("active", "active-buffer");
      expect(saveScrollbackMock).toHaveBeenCalledWith("bg", "bg-cached-buffer");
    });

    it("persists and restores UI sidebar, app mode, and maximized pane state", async () => {
      useTerminalStore.setState({
        ready: true,
        leftSidebarOpen: true,
        leftSidebarWidth: 310,
        rightSidebarOpen: true,
        rightSidebarWidth: 350,
        rightSidebarTab: "git",
        activeAppMode: "editor",
        maximizedSessionId: "sess-1",
        editorTabs: [
          {
            path: "/path/file.ts",
            name: "file.ts",
            content: "console.log('hi')",
            originalContent: "console.log('hi')",
            isDirty: false,
            language: "typescript",
            isMarkdown: false,
          },
        ],
        activeEditorPath: "/path/file.ts",
        editorViewMode: "markdown-preview",
        browserUrl: "http://localhost:3000",
        devicePreset: "iphone",
      });

      await useTerminalStore.getState().saveLayout();
      expect(saveLayoutMock).toHaveBeenCalled();
      const savedJson = JSON.parse(saveLayoutMock.mock.calls[0][0]);
      expect(savedJson.version).toBe(3);
      expect(savedJson.ui).toEqual(
        expect.objectContaining({
          leftSidebarOpen: true,
          leftSidebarWidth: 310,
          rightSidebarOpen: true,
          rightSidebarWidth: 350,
          rightSidebarTab: "git",
          activeAppMode: "editor",
          maximizedSessionId: "sess-1",
          editorTabs: [
            {
              path: "/path/file.ts",
              name: "file.ts",
              content: "console.log('hi')",
              originalContent: "console.log('hi')",
              isDirty: false,
              language: "typescript",
              isMarkdown: false,
            },
          ],
          activeEditorPath: "/path/file.ts",
          editorViewMode: "markdown-preview",
          browserUrl: "http://localhost:3000",
          devicePreset: "iphone",
        }),
      );
    });

    it("persists window state from getSavedWindowState and applies on loadLayout", async () => {
      getSavedWindowStateMock.mockResolvedValueOnce({
        width: 1440,
        height: 900,
        x: 120,
        y: 80,
        isMaximized: true,
      });

      useTerminalStore.setState({ ready: true });
      await useTerminalStore.getState().saveLayout();
      expect(saveLayoutMock).toHaveBeenCalled();
      const savedJson = JSON.parse(saveLayoutMock.mock.calls[0][0]);
      expect(savedJson.window).toEqual({
        width: 1440,
        height: 900,
        x: 120,
        y: 80,
        isMaximized: true,
      });

      loadLayoutMock.mockResolvedValueOnce(
        JSON.stringify({
          version: 2,
          window: {
            width: 1440,
            height: 900,
            x: 120,
            y: 80,
            isMaximized: true,
          },
          ui: {
            leftSidebarOpen: false,
            leftSidebarWidth: 320,
            rightSidebarOpen: true,
            rightSidebarWidth: 360,
            rightSidebarTab: "git",
            activeAppMode: "browser",
            maximizedSessionId: "sess-2",
            editorTabs: [],
            activeEditorPath: null,
            editorViewMode: "edit",
            browserUrl: "http://localhost:5173",
            devicePreset: "ipad",
          },
          tabs: [
            {
              id: "tab-1",
              layout: { type: "leaf", id: "sess-2" },
              focusedPath: [],
            },
          ],
          activeTabId: "tab-1",
          sessions: [
            { id: "sess-2", title: "s2", status: "running", cols: 80, rows: 24 },
          ],
        }),
      );
      ptySpawnMock.mockResolvedValueOnce(spawnRes("sess-2"));

      await useTerminalStore.getState().loadLayout();
      expect(applyWindowStateMock).toHaveBeenCalledWith({
        width: 1440,
        height: 900,
        x: 120,
        y: 80,
        isMaximized: true,
      });

      const state = useTerminalStore.getState();
      expect(state.leftSidebarOpen).toBe(false);
      expect(state.leftSidebarWidth).toBe(320);
      expect(state.rightSidebarOpen).toBe(true);
      expect(state.rightSidebarWidth).toBe(360);
      expect(state.rightSidebarTab).toBe("git");
      expect(state.activeAppMode).toBe("browser");
      expect(state.maximizedSessionId).toBe("sess-2");
      expect(state.browserUrl).toBe("http://localhost:5173");
      expect(state.devicePreset).toBe("ipad");
    });

    it("preserves store defaults when loading legacy layout.json without ui or window structures", async () => {
      loadLayoutMock.mockResolvedValueOnce(
        JSON.stringify({
          layout: { type: "leaf", id: "legacy-s1" },
          sessions: [
            { id: "legacy-s1", title: "s1", status: "running", cols: 80, rows: 24 },
          ],
        }),
      );
      ptySpawnMock.mockResolvedValueOnce(spawnRes("legacy-s1"));

      await useTerminalStore.getState().loadLayout();
      expect(applyWindowStateMock).not.toHaveBeenCalled();
      const state = useTerminalStore.getState();
      expect(state.leftSidebarOpen).toBe(true);
      expect(state.leftSidebarWidth).toBe(240);
      expect(state.rightSidebarOpen).toBe(false);
      expect(state.activeAppMode).toBe("terminal");
      expect(state.maximizedSessionId).toBe(null);
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
        { id: "old-left", cwd: "C:\\a", cols: 80, rows: 24 },
        { id: "old-top", cwd: "C:\\b", cols: 80, rows: 24 },
        { id: "old-right", cwd: "C:\\c", cols: 80, rows: 24 },
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
        { id: "daemon-s1", cwd: "/app/one", cols: 80, rows: 24 },
        { id: "daemon-s2", cwd: "/app/two", cols: 80, rows: 24 },
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

    it("loadLayout only spawns sessions for the active tab and marks inactive tabs as sleeping", async () => {
      const layoutData = {
        version: 2,
        activeTabId: "tab-1",
        tabs: [
          {
            id: "tab-1",
            title: "Project Active",
            layout: { type: "leaf", id: "sess-active-1" },
            focusedPath: [],
          },
          {
            id: "tab-2",
            title: "Project Dormant",
            layout: { type: "leaf", id: "sess-dormant-1" },
            focusedPath: [],
          },
        ],
        sessions: [
          {
            id: "sess-active-1",
            title: "Active Shell",
            status: "running",
            cwd: "C:/projects/active",
            cols: 80,
            rows: 24,
          },
          {
            id: "sess-dormant-1",
            title: "Dormant Shell",
            status: "running",
            cwd: "C:/projects/dormant",
            cols: 80,
            rows: 24,
          },
        ],
      };

      loadLayoutMock.mockResolvedValue(
        JSON.stringify(layoutData),
      );
      ptySpawnMock.mockResolvedValueOnce(spawnRes("sess-active-1"));

      await useTerminalStore.getState().loadLayout();

      const state = useTerminalStore.getState();
      expect(state.tabs).toHaveLength(2);
      expect(state.activeTabId).toBe("tab-1");

      const activeTab = state.tabs.find((t) => t.id === "tab-1");
      const dormantTab = state.tabs.find((t) => t.id === "tab-2");

      expect(activeTab?.isSleeping).toBeFalsy();
      expect(dormantTab?.isSleeping).toBe(true);

      expect(state.sessions["sess-active-1"]).toBeDefined();
      expect(state.sessions["sess-active-1"].status).toBe("running");

      expect(state.sessions["sess-dormant-1"]).toBeDefined();
      expect(state.sessions["sess-dormant-1"].status).toBe("sleeping");
      expect(state.sessions["sess-dormant-1"].cwd).toBe("C:/projects/dormant");

      // Verify spawnSession was only called for the active tab's session
      expect(ptySpawnMock).toHaveBeenCalledWith(
        expect.objectContaining({ id: "sess-active-1", cwd: "C:/projects/active" }),
      );
      expect(ptySpawnMock).not.toHaveBeenCalledWith(
        expect.objectContaining({ id: "sess-dormant-1" }),
      );
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

      it("selectTab on a sleeping tab wakes up its sessions on-demand", async () => {
        ptySpawnMock.mockResolvedValueOnce(spawnRes("sess-2"));
        loadScrollbackMock.mockResolvedValue("cached scrollback output for sess-2");

        useTerminalStore.setState({
          tabs: [
            {
              id: "tab-1",
              title: "Tab 1",
              layout: { type: "leaf", id: "sess-1" },
              focusedPath: [],
              isSleeping: false,
            },
            {
              id: "tab-2",
              title: "Tab 2",
              layout: { type: "leaf", id: "sess-2" },
              focusedPath: [],
              isSleeping: true,
            },
          ],
          activeTabId: "tab-1",
          sessions: {
            "sess-1": {
              id: "sess-1",
              title: "Shell 1",
              status: "running",
              cols: 80,
              rows: 24,
            },
            "sess-2": {
              id: "sess-2",
              title: "Shell 2",
              status: "sleeping",
              cwd: "C:/projects/proj2",
              cols: 80,
              rows: 24,
            },
          },
        });

        // Select sleeping tab
        useTerminalStore.getState().selectTab("tab-2");

        const stateImmediately = useTerminalStore.getState();
        expect(stateImmediately.activeTabId).toBe("tab-2");
        expect(stateImmediately.tabs.find((t) => t.id === "tab-2")?.isSleeping).toBe(false);

        // Await wakeTab completion
        await useTerminalStore.getState().wakeTab("tab-2");

        const stateAfterWake = useTerminalStore.getState();
        expect(stateAfterWake.sessions["sess-2"]?.status).toBe("running");
        expect(stateAfterWake.restoredScrollbacks["sess-2"]).toBe(
          "cached scrollback output for sess-2",
        );
        expect(ptySpawnMock).toHaveBeenCalledWith(
          expect.objectContaining({ id: "sess-2", cwd: "C:/projects/proj2" }),
        );
      });

      it("wakeTab handles split sleeping sessions and renames/scrollback restoration", async () => {
        ptySpawnMock
          .mockResolvedValueOnce(spawnRes("sess-split-1"))
          .mockResolvedValueOnce(spawnRes("sess-split-2"));
        loadScrollbackMock.mockImplementation(async (id) =>
          id === "sess-split-1" ? "output-1" : null,
        );

        useTerminalStore.setState({
          tabs: [
            {
              id: "tab-split",
              title: "Split Tab",
              layout: {
                type: "split",
                dir: "h",
                ratio: 0.5,
                a: { type: "leaf", id: "sess-split-1" },
                b: { type: "leaf", id: "sess-split-2" },
              },
              focusedPath: [],
              isSleeping: true,
            },
          ],
          activeTabId: "tab-split",
          sessions: {
            "sess-split-1": {
              id: "sess-split-1",
              title: "Custom Title 1",
              status: "sleeping",
              cwd: "C:/proj/app1",
              cols: 80,
              rows: 24,
            },
            "sess-split-2": {
              id: "sess-split-2",
              title: "Custom Title 2",
              status: "sleeping",
              cwd: "C:/proj/app2",
              cols: 80,
              rows: 24,
            },
          },
        });

        await useTerminalStore.getState().wakeTab("tab-split");

        const state = useTerminalStore.getState();
        expect(state.sessions["sess-split-1"]?.status).toBe("running");
        expect(state.sessions["sess-split-1"]?.title).toBe("Custom Title 1");
        expect(state.sessions["sess-split-1"]?.isRestored).toBe(true);
        expect(state.restoredScrollbacks["sess-split-1"]).toBe("output-1");

        expect(state.sessions["sess-split-2"]?.status).toBe("running");
        expect(state.sessions["sess-split-2"]?.title).toBe("Custom Title 2");
        expect(state.tabs.find((t) => t.id === "tab-split")?.isSleeping).toBe(false);
      });

      it("wakeTab no-ops for wizard tabs or tabs without sleeping sessions", async () => {
        ptySpawnMock.mockClear();
        useTerminalStore.setState({
          tabs: [
            {
              id: "tab-wiz",
              title: "Setup Wizard",
              isWizard: true,
              layout: { type: "leaf", id: "" },
              focusedPath: [],
            },
            {
              id: "tab-running",
              title: "Running Tab",
              layout: { type: "leaf", id: "sess-run" },
              focusedPath: [],
            },
          ],
          sessions: {
            "sess-run": {
              id: "sess-run",
              title: "Run",
              status: "running",
              cols: 80,
              rows: 24,
            },
          },
        });

        await useTerminalStore.getState().wakeTab("tab-wiz");
        await useTerminalStore.getState().wakeTab("tab-running");
        expect(ptySpawnMock).not.toHaveBeenCalled();
      });

      it("wakeTab passes saved session geometry to ptySpawn", async () => {
        useTerminalStore.setState({
          tabs: [
            {
              id: "tab-sleeping",
              title: "Sleeping Tab",
              layout: { type: "leaf", id: "sess-sleep" },
              focusedPath: [],
              isSleeping: true,
            },
          ],
          sessions: {
            "sess-sleep": {
              id: "sess-sleep",
              title: "Sleeping Shell",
              status: "sleeping",
              cwd: "C:/projects/saved",
              cols: 140,
              rows: 50,
            },
          },
        });
        ptySpawnMock.mockResolvedValueOnce({
          id: "sess-sleep",
          is_new: true,
          cols: 140,
          rows: 50,
          cwd: "C:/projects/saved",
        });

        await useTerminalStore.getState().wakeTab("tab-sleeping");
        expect(ptySpawnMock).toHaveBeenCalledWith(
          expect.objectContaining({
            id: "sess-sleep",
            cwd: "C:/projects/saved",
            cols: 140,
            rows: 50,
          }),
        );
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

      it("closeTab on a sleeping tab cleans up sessions without calling ptyKill", async () => {
        useTerminalStore.setState({
          tabs: [
            {
              id: "tab-1",
              title: "Tab 1",
              layout: { type: "leaf", id: "sess-1" },
              focusedPath: [],
              isSleeping: false,
            },
            {
              id: "tab-2",
              title: "Tab 2",
              layout: { type: "leaf", id: "sess-2" },
              focusedPath: [],
              isSleeping: true,
            },
          ],
          activeTabId: "tab-1",
          sessions: {
            "sess-1": { id: "sess-1", title: "Active", status: "running", cols: 80, rows: 24 },
            "sess-2": { id: "sess-2", title: "Sleeping", status: "sleeping", cols: 80, rows: 24 },
          },
        });

        ptyKillMock.mockClear();

        await useTerminalStore.getState().closeTab("tab-2");

        expect(ptyKillMock).not.toHaveBeenCalledWith("sess-2");
        expect(deleteScrollbackMock).toHaveBeenCalledWith("sess-2");
        expect(useTerminalStore.getState().sessions["sess-2"]).toBeUndefined();
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

      it("closePane on a sleeping session cleans up session without calling ptyKill", async () => {
        useTerminalStore.setState({
          tabs: [
            {
              id: "tab-1",
              title: "Tab 1",
              layout: {
                type: "split",
                dir: "h",
                ratio: 0.5,
                a: { type: "leaf", id: "sess-1" },
                b: { type: "leaf", id: "sess-2" },
              },
              focusedPath: [1],
            },
          ],
          activeTabId: "tab-1",
          layout: {
            type: "split",
            dir: "h",
            ratio: 0.5,
            a: { type: "leaf", id: "sess-1" },
            b: { type: "leaf", id: "sess-2" },
          },
          focusedPath: [1],
          sessions: {
            "sess-1": { id: "sess-1", title: "Active", status: "running", cols: 80, rows: 24 },
            "sess-2": { id: "sess-2", title: "Sleeping", status: "sleeping", cols: 80, rows: 24 },
          },
        });

        ptyKillMock.mockClear();

        await useTerminalStore.getState().closePane([1]);

        expect(ptyKillMock).not.toHaveBeenCalledWith("sess-2");
        expect(deleteScrollbackMock).toHaveBeenCalledWith("sess-2");
        expect(useTerminalStore.getState().sessions["sess-2"]).toBeUndefined();
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

      it("loadLayout restores multiple tabs, remapping active tab and leaving inactive tabs sleeping", async () => {
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
        ptySpawnMock.mockResolvedValueOnce(spawnRes("new-2"));

        await useTerminalStore.getState().loadLayout();
        const state = useTerminalStore.getState();
        expect(state.tabs).toHaveLength(2);
        expect(state.tabs[0].id).toBe("t1");
        expect(state.tabs[0].title).toBe("Tab One");
        expect(state.tabs[0].layout).toEqual({ type: "leaf", id: "old-1" });
        expect(state.tabs[0].isSleeping).toBe(true);
        expect(state.tabs[1].id).toBe("t2");
        expect(state.tabs[1].title).toBe("Tab Two");
        expect(state.tabs[1].layout).toEqual({ type: "leaf", id: "new-2" });
        expect(state.tabs[1].isSleeping).toBeFalsy();
        expect(state.activeTabId).toBe("t2");
        expect(state.layout).toEqual({ type: "leaf", id: "new-2" });
        expect(state.sessions["old-1"]?.status).toBe("sleeping");
        expect(state.sessions["new-2"]?.status).toBe("running");
        expect(ptySpawnMock).toHaveBeenCalledTimes(1);
        expect(ptySpawnMock).toHaveBeenCalledWith(
          expect.objectContaining({ id: "old-2", cwd: "C:\\b" }),
        );
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

      it("loadLayout passes saved session geometry to ptySpawn", async () => {
        loadLayoutMock.mockResolvedValue(
          JSON.stringify({
            tabs: [
              { id: "t1", title: "Tab One", layout: { type: "leaf", id: "old-1" }, focusedPath: [] },
            ],
            activeTabId: "t1",
            sessions: [
              { id: "old-1", title: "s1", status: "running", cwd: "C:\\a", cols: 132, rows: 43 },
            ],
          }),
        );
        ptySpawnMock.mockResolvedValueOnce({
          id: "new-1",
          is_new: true,
          cols: 132,
          rows: 43,
          cwd: "C:\\a",
        });

        await useTerminalStore.getState().loadLayout();
        expect(ptySpawnMock).toHaveBeenCalledWith(
          expect.objectContaining({
            id: "old-1",
            cwd: "C:\\a",
            cols: 132,
            rows: 43,
          }),
        );
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

    it("renameSession debounces layout persistence by 2000ms", async () => {
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

      await vi.advanceTimersByTimeAsync(1000);
      expect(saveLayoutMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      expect(saveLayoutMock).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it("renameSession collapses rapid successive renames into a single debounced save", async () => {
      vi.useFakeTimers();
      useTerminalStore.setState({
        ready: true,
        sessions: {
          s1: { id: "s1", title: "s1", status: "running", cols: 80, rows: 24 },
        },
      });
      saveLayoutMock.mockClear();
      useTerminalStore.getState().renameSession("s1", "Server 1");
      await vi.advanceTimersByTimeAsync(1000);
      useTerminalStore.getState().renameSession("s1", "Server 2");
      await vi.advanceTimersByTimeAsync(1000);
      expect(saveLayoutMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      expect(saveLayoutMock).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
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

    it("createWizardTab appends a new tab with isWizard=true and activates it", async () => {
      vi.useFakeTimers();
      try {
      useTerminalStore.setState({
        tabs: [{ id: "tab-1", title: "Shell", layout: { type: "leaf", id: "s-1" }, focusedPath: [] }],
        activeTabId: "tab-1",
        ready: true,
      });

      const wizardTabId = useTerminalStore.getState().createWizardTab();
      await Promise.resolve();
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
      await vi.advanceTimersByTimeAsync(2000);
      expect(saveLayoutMock).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
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
      vi.useFakeTimers();
      try {
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
      await vi.advanceTimersByTimeAsync(2000);
      expect(saveLayoutMock).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
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

  describe("view-only diff slice", () => {
    const scFileDiffMock = vi.mocked(gitTransport.scFileDiff);

    beforeEach(() => {
      vi.clearAllMocks();
      useTerminalStore.setState({
        sessions: {
          s1: {
            id: "s1",
            title: "s1",
            status: "running",
            cwd: "/mock/repo",
            cols: 80,
            rows: 24,
          },
        },
        tabs: [{ id: "tab-1", layout: { type: "leaf", id: "s1" }, focusedPath: [] }],
        activeTabId: "tab-1",
        layout: { type: "leaf", id: "s1" },
        focusedPath: [],
        viewOnlyDiff: null,
        pendingAiDiff: null,
      });
    });

    it("openDiffView stores the pair, focuses the editor, and never arms the AI banner", () => {
      useTerminalStore.getState().stageAiDiff("stale.ts", "a", "b");
      useTerminalStore.getState().openDiffView("src/a.rs", "old", "new");

      const state = useTerminalStore.getState();
      expect(state.viewOnlyDiff).toEqual({ path: "src/a.rs", original: "old", modified: "new" });
      expect(state.pendingAiDiff).toBeNull();
      expect(state.activeAppMode).toBe("editor");
    });

    it("clearViewOnlyDiff resets the review and restores edit mode", () => {
      useTerminalStore.getState().openDiffView("src/a.rs", "old", "new");
      useTerminalStore.getState().clearViewOnlyDiff();

      expect(useTerminalStore.getState().viewOnlyDiff).toBeNull();
      expect(useTerminalStore.getState().editorViewMode).toBe("edit");
    });

    it("openGitDiff unstaged compares worktree against index", async () => {
      scFileDiffMock.mockResolvedValue({
        kind: "text",
        original_content: "a",
        modified_content: "b",
        truncated: false,
      });

      await useTerminalStore.getState().openGitDiff("f.rs", "unstaged");

      expect(scFileDiffMock).toHaveBeenCalledWith("/mock/repo", "f.rs", false, false);
      expect(useTerminalStore.getState().viewOnlyDiff).toEqual({
        path: "f.rs",
        original: "a",
        modified: "b",
      });
    });

    it("openGitDiff staged compares index against HEAD", async () => {
      scFileDiffMock.mockResolvedValue({
        kind: "text",
        original_content: "a",
        modified_content: "b",
        truncated: false,
      });

      await useTerminalStore.getState().openGitDiff("f.rs", "staged");

      expect(scFileDiffMock).toHaveBeenCalledWith("/mock/repo", "f.rs", true, false);
    });

    it("openGitDiff untracked compares worktree against empty HEAD so additions show", async () => {
      scFileDiffMock.mockResolvedValue({
        kind: "text",
        original_content: "",
        modified_content: "brand new",
        truncated: false,
      });

      await useTerminalStore.getState().openGitDiff("new.ts", "untracked");

      expect(scFileDiffMock).toHaveBeenCalledWith("/mock/repo", "new.ts", false, true);
      expect(useTerminalStore.getState().viewOnlyDiff?.modified).toBe("brand new");
    });

    it("openGitDiff binary diffs show a placeholder in the modified pane", async () => {
      scFileDiffMock.mockResolvedValue({
        kind: "binary",
        original_content: "",
        modified_content: "",
        truncated: false,
      });

      await useTerminalStore.getState().openGitDiff("img.png", "unstaged");

      expect(useTerminalStore.getState().viewOnlyDiff?.modified).toBe("<binary file>");
    });

    it("openGitDiff truncated diffs show a truncation notice in the modified pane", async () => {
      scFileDiffMock.mockResolvedValue({
        kind: "text",
        original_content: "partial",
        modified_content: "partial",
        truncated: true,
      });

      await useTerminalStore.getState().openGitDiff("big.log", "unstaged");

      expect(useTerminalStore.getState().viewOnlyDiff?.modified).toBe(
        "<diff too large — truncated>",
      );
    });
  });

  describe("swapPanes", () => {
    beforeEach(() => {
      useTerminalStore.setState({ ready: true });
    });

    it("swaps two leaf positions in single-tab layout and updates focusedPath to follow focused session", async () => {
      vi.useFakeTimers();
      try {
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
      await Promise.resolve();

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
      await vi.advanceTimersByTimeAsync(2000);
      expect(saveLayoutMock).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("swaps leaves in the active tab of multi-tab state", async () => {
      vi.useFakeTimers();
      try {
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
      await Promise.resolve();

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
      await vi.advanceTimersByTimeAsync(2000);
      expect(saveLayoutMock).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
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

    it("moves source pane relative to target pane and updates focusedPath to sourceId", async () => {
      vi.useFakeTimers();
      try {
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
      await Promise.resolve();

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
      await vi.advanceTimersByTimeAsync(2000);
      expect(saveLayoutMock).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("updates multi-tab active tab layout and focusedPath on movePane", async () => {
      vi.useFakeTimers();
      try {
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
      await Promise.resolve();

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
      await vi.advanceTimersByTimeAsync(2000);
      expect(saveLayoutMock).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
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
      expect(settings.appearance.sidebarOnLaunch).toBe("remember_last");
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

    it("flushSettings immediately persists pending theme changes (close-path)", async () => {
      useTerminalStore.getState().updateAppearanceSettings({
        themeName: "dracula",
      });
      expect(saveSettingsMock).not.toHaveBeenCalled();

      await useTerminalStore.getState().flushSettings();

      expect(saveSettingsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          appearance: expect.objectContaining({
            themeName: "dracula",
          }),
        }),
      );
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

  describe("worktree slice", () => {
    it("loadWorktrees merges list entries with live session counts from ps", async () => {
      worktreeListMock.mockResolvedValue([
        { record: worktreeRecord(), missing_on_disk: false },
      ]);
      worktreePsMock.mockResolvedValue([
        { record: worktreeRecord(), live_sessions: 2 },
      ]);

      await useTerminalStore.getState().loadWorktrees();

      const state = useTerminalStore.getState();
      expect(state.worktrees).toHaveLength(1);
      expect(state.worktrees[0].record.id).toBe("demo::C:/ws/feat-a");
      expect(state.worktreeLiveSessions["demo::C:/ws/feat-a"]).toBe(2);
    });

    it("createWorktree calls transport and refreshes the worktree list", async () => {
      worktreeCreateMock.mockResolvedValue(worktreeRecord());
      worktreeListMock.mockResolvedValue([
        { record: worktreeRecord(), missing_on_disk: false },
      ]);
      repoListMock.mockResolvedValue([]);

      const created = await useTerminalStore.getState().createWorktree({
        repoPath: "C:/repos/demo",
        name: "feat-a",
        baseRef: "main",
      });

      expect(created?.id).toBe("demo::C:/ws/feat-a");
      expect(worktreeCreateMock).toHaveBeenCalledWith({
        repoPath: "C:/repos/demo",
        name: "feat-a",
        baseRef: "main",
      });
      await vi.waitFor(() => {
        expect(useTerminalStore.getState().worktrees).toHaveLength(1);
      });
    });

    it("createWorktreeWithAgent opens a tab bound to the daemon's agent session", async () => {
      const record = worktreeRecord();
      worktreeCreateAgentMock.mockResolvedValue({ record, session_id: "agent-1" });
      ptyListMock.mockResolvedValue(["agent-1"]);
      ptySpawnMock.mockResolvedValue(spawnRes("agent-1", false, "screen"));
      worktreeListMock.mockResolvedValue([]);
      repoListMock.mockResolvedValue([]);

      const handoff = await useTerminalStore.getState().createWorktreeWithAgent({
        repoPath: "C:/repos/demo",
        name: "feat-a",
        agent: "claude",
        prompt: "fix it",
      });

      expect(handoff.session_id).toBe("agent-1");
      expect(worktreeCreateAgentMock).toHaveBeenCalledWith({
        repoPath: "C:/repos/demo",
        name: "feat-a",
        agent: "claude",
        prompt: "fix it",
      });
      await vi.waitFor(() => {
        const state = useTerminalStore.getState();
        const tab = state.tabs[state.tabs.length - 1];
        expect(tab?.layout).toEqual({ type: "leaf", id: "agent-1" });
        expect(state.activeTabId).toBe(tab?.id);
      });
      // Attach must reuse the daemon session id, not spawn a fresh shell
      const spawnArgs = ptySpawnMock.mock.calls[0][0];
      expect(spawnArgs?.id).toBe("agent-1");
      expect(spawnArgs?.cwd).toBe(record.path);
      expect(spawnArgs?.worktreeId).toBe(record.id);
    });

    it("createWorktreeWithAgent skips the attach when ListSessions lacks the session", async () => {
      worktreeCreateAgentMock.mockResolvedValue({
        record: worktreeRecord(),
        session_id: "agent-missing",
      });
      ptyListMock.mockResolvedValue([]);
      worktreeListMock.mockResolvedValue([]);
      repoListMock.mockResolvedValue([]);

      const handoff = await useTerminalStore.getState().createWorktreeWithAgent({
        repoPath: "C:/repos/demo",
        name: "feat-a",
        agent: "codex",
      });

      expect(handoff.record.id).toBe("demo::C:/ws/feat-a");
      expect(ptySpawnMock).not.toHaveBeenCalled();
      expect(useTerminalStore.getState().tabs).toHaveLength(0);
    });

    it("setWorktreeStatus forwards the status and refreshes", async () => {
      worktreeSetMock.mockResolvedValue(
        worktreeRecord({ workspace_status: "completed" }),
      );
      worktreeListMock.mockResolvedValue([]);
      worktreePsMock.mockResolvedValue([]);

      await useTerminalStore
        .getState()
        .setWorktreeStatus("demo::C:/ws/feat-a", "completed");

      expect(worktreeSetMock).toHaveBeenCalledWith("demo::C:/ws/feat-a", {
        workspaceStatus: "completed",
      });
      expect(worktreeListMock).toHaveBeenCalled();
    });

    it("removeWorktree surfaces the teardown-refusal reason on failure", async () => {
      worktreeRemoveMock.mockRejectedValue(
        "cannot remove worktree demo::C:/ws/feat-a: live sessions present: s-1 (cwd inside worktree)",
      );

      await expect(
        useTerminalStore.getState().removeWorktree("demo::C:/ws/feat-a"),
      ).rejects.toThrow(/live sessions present/);
      // A refused removal must not wipe the visible card.
      expect(worktreeListMock).not.toHaveBeenCalled();
    });

    it("removeWorktree refreshes the list after a successful removal", async () => {
      worktreeRemoveMock.mockResolvedValue(undefined);
      worktreeListMock.mockResolvedValue([]);

      await useTerminalStore.getState().removeWorktree("demo::C:/ws/feat-a");

      expect(worktreeRemoveMock).toHaveBeenCalledWith(
        "demo::C:/ws/feat-a",
        false,
        false,
      );
      expect(worktreeListMock).toHaveBeenCalled();
    });

    it("removeWorktree with force=true kills bound GUI sessions and passes force flag", async () => {
      worktreeRemoveMock.mockResolvedValue(undefined);
      worktreeListMock.mockResolvedValue([]);
      const killSessionSpy = vi.spyOn(useTerminalStore.getState(), "killSession").mockResolvedValue(undefined);

      useTerminalStore.setState({
        sessions: {
          s1: { id: "s1", status: "running", worktreeId: "demo::C:/ws/feat-a" } as any,
          s2: { id: "s2", status: "running", worktreeId: "demo::C:/ws/other" } as any,
        },
      });

      await useTerminalStore.getState().removeWorktree("demo::C:/ws/feat-a", true);

      expect(killSessionSpy).toHaveBeenCalledWith("s1");
      expect(killSessionSpy).not.toHaveBeenCalledWith("s2");
      expect(worktreeRemoveMock).toHaveBeenCalledWith(
        "demo::C:/ws/feat-a",
        true,
        false,
      );
      expect(worktreeListMock).toHaveBeenCalled();
    });

    it("purgeWorktree drops a tombstone and refreshes", async () => {
      worktreePurgeMock.mockResolvedValue(undefined);
      worktreeListMock.mockResolvedValue([]);

      await useTerminalStore.getState().purgeWorktree("demo::C:/ws/feat-a");

      expect(worktreePurgeMock).toHaveBeenCalledWith("demo::C:/ws/feat-a");
      expect(worktreeListMock).toHaveBeenCalled();
    });

    it("loadRepopulates repos via repo_list", async () => {
      repoListMock.mockResolvedValue([
        { repo_id: "demo", path: "C:/repos/demo", default_base_ref: null, worktree_base_path: null },
      ]);

      await useTerminalStore.getState().loadRepos();

      expect(useTerminalStore.getState().repos[0].repo_id).toBe("demo");
    });

    it("addRepo registers a repo and refreshes the repo list", async () => {
      repoAddMock.mockResolvedValue([
        { repo_id: "fresh", path: "C:/repos/fresh", default_base_ref: null, worktree_base_path: null },
      ]);
      repoListMock.mockResolvedValue([
        { repo_id: "fresh", path: "C:/repos/fresh", default_base_ref: null, worktree_base_path: null },
      ]);

      const added = await useTerminalStore.getState().addRepo("C:/repos/fresh");

      expect(added.repo_id).toBe("fresh");
      await vi.waitFor(() => {
        expect(useTerminalStore.getState().repos).toHaveLength(1);
      });
    });
  });

  describe("daemon session-title sync events", () => {
    it("title change updates the matching session and its tab title", () => {
      useTerminalStore.setState({
        sessions: {
          s1: { id: "s1", title: "s1", status: "running", cols: 80, rows: 24 },
        },
        tabs: [
          { id: "tab-1", layout: { type: "leaf", id: "s1" }, focusedPath: [] },
        ],
        activeTabId: "tab-1",
        layout: { type: "leaf", id: "s1" },
        focusedPath: [],
      });

      titleChangedHandler?.({ id: "s1", title: "build" });

      expect(useTerminalStore.getState().sessions["s1"].title).toBe("build");
      expect(useTerminalStore.getState().tabs[0].title).toBe("build");
    });

    it("title change for an unknown session is ignored silently", () => {
      expect(() => titleChangedHandler?.({ id: "ghost", title: "x" })).not.toThrow();
      expect(Object.keys(useTerminalStore.getState().sessions)).not.toContain("ghost");
    });

    it("auto title events never overwrite a locally pinned rename", () => {
      useTerminalStore.setState({
        sessions: {
          s1: { id: "s1", title: "Build Output", titlePinned: true, status: "running", cols: 80, rows: 24 },
        },
        tabs: [
          { id: "tab-1", layout: { type: "leaf", id: "s1" }, focusedPath: [] },
        ],
        activeTabId: "tab-1",
        layout: { type: "leaf", id: "s1" },
        focusedPath: [],
      });

      titleChangedHandler?.({ id: "s1", title: "npm run dev", pinned: false });

      expect(useTerminalStore.getState().sessions["s1"].title).toBe("Build Output");
    });

    it("manual title events apply and pin the session", () => {
      useTerminalStore.setState({
        sessions: {
          s1: { id: "s1", title: "fox", status: "running", cols: 80, rows: 24 },
        },
        tabs: [
          { id: "tab-1", layout: { type: "leaf", id: "s1" }, focusedPath: [] },
        ],
        activeTabId: "tab-1",
        layout: { type: "leaf", id: "s1" },
        focusedPath: [],
      });

      titleChangedHandler?.({ id: "s1", title: "Release", pinned: true });

      const session = useTerminalStore.getState().sessions["s1"];
      expect(session.title).toBe("Release");
      expect(session.titlePinned).toBe(true);
    });

    it("auto titles follow only the focused pane's tab title", () => {
      useTerminalStore.setState({
        sessions: {
          s1: { id: "s1", title: "fox", status: "running", cols: 80, rows: 24 },
          s2: { id: "s2", title: "heron", status: "running", cols: 80, rows: 24 },
        },
        tabs: [
          {
            id: "tab-1",
            title: "fox",
            layout: {
              type: "split",
              dir: "h",
              ratio: 0.5,
              a: { type: "leaf", id: "s1" },
              b: { type: "leaf", id: "s2" },
            },
            focusedPath: [0],
          },
        ],
        activeTabId: "tab-1",
        layout: {
          type: "split",
          dir: "h",
          ratio: 0.5,
          a: { type: "leaf", id: "s1" },
          b: { type: "leaf", id: "s2" },
        },
        focusedPath: [0],
      });

      // Background pane auto title updates its session but not the shared tab.
      titleChangedHandler?.({ id: "s2", title: "npm run dev", pinned: false });
      expect(useTerminalStore.getState().sessions["s2"].title).toBe("npm run dev");
      expect(useTerminalStore.getState().tabs[0].title).toBe("fox");

      // Focused pane auto title follows.
      titleChangedHandler?.({ id: "s1", title: "opencode", pinned: false });
      expect(useTerminalStore.getState().tabs[0].title).toBe("opencode");
    });

    it("resetSessionTitle unpins locally and asks the daemon to revert", async () => {
      const resetMock = vi.mocked(ptyTransport.ptyResetTitle);
      useTerminalStore.setState({
        sessions: {
          s1: { id: "s1", title: "Build Output", titlePinned: true, status: "running", cols: 80, rows: 24 },
        },
      });

      await useTerminalStore.getState().resetSessionTitle("s1");

      expect(useTerminalStore.getState().sessions["s1"].titlePinned).toBe(false);
      expect(resetMock).toHaveBeenCalledWith("s1");
    });

    it("focus request selects the owning tab and focuses that pane", () => {
      useTerminalStore.setState({
        sessions: {
          s1: { id: "s1", title: "s1", status: "running", cols: 80, rows: 24 },
          s9: { id: "s9", title: "s9", status: "running", cols: 80, rows: 24 },
        },
        tabs: [
          { id: "tab-1", layout: { type: "leaf", id: "s1" }, focusedPath: [] },
          {
            id: "tab-2",
            layout: {
              type: "split",
              dir: "h",
              ratio: 0.5,
              a: { type: "leaf", id: "s1" },
              b: { type: "leaf", id: "s9" },
            },
            focusedPath: [0],
          },
        ],
        activeTabId: "tab-1",
        layout: { type: "leaf", id: "s1" },
        focusedPath: [],
      });

      focusRequestedHandler?.({ id: "s9" });

      expect(useTerminalStore.getState().activeTabId).toBe("tab-2");
      expect(useTerminalStore.getState().focusedPath).toEqual([1]);
    });

    it("focus request for a session with no tab is ignored", () => {
      useTerminalStore.setState({
        tabs: [{ id: "tab-1", layout: { type: "leaf", id: "s1" }, focusedPath: [] }],
        activeTabId: "tab-1",
        layout: { type: "leaf", id: "s1" },
        focusedPath: [],
      });
      focusRequestedHandler?.({ id: "ghost" });
      expect(useTerminalStore.getState().activeTabId).toBe("tab-1");
    });
  });

  describe("selectProjectTree selector", () => {
    it("returns empty array when there are no repos and no worktrees", () => {
      useTerminalStore.setState({
        repos: [],
        worktrees: [],
        sessions: {},
        workingBySessionId: {},
      });
      const tree = selectProjectTree(useTerminalStore.getState());
      expect(tree).toEqual([]);
    });

    it("groups branches under repos and extracts repoName from repo path", () => {
      useTerminalStore.setState({
        repos: [
          { repo_id: "repo-1", path: "C:/projects/my-app", default_base_ref: "main", worktree_base_path: null },
          { repo_id: "repo-2", path: "/home/user/backend", default_base_ref: "main", worktree_base_path: null },
        ],
        worktrees: [
          {
            record: worktreeRecord({
              id: "wt-1",
              repo_id: "repo-1",
              name: "feat-auth",
              display_name: null,
              branch: "feat-auth",
              path: "C:/projects/my-app/wt-1",
              workspace_status: "in-progress",
            }),
            missing_on_disk: false,
          },
          {
            record: worktreeRecord({
              id: "wt-2",
              repo_id: "repo-1",
              name: "fix-bug",
              display_name: "Fix Login Bug",
              branch: "fix-bug",
              path: "C:/projects/my-app/wt-2",
              workspace_status: "completed",
            }),
            missing_on_disk: false,
          },
          {
            record: worktreeRecord({
              id: "wt-3",
              repo_id: "repo-2",
              name: "api-v2",
              display_name: null,
              branch: "api-v2",
              path: "/home/user/backend/wt-3",
              workspace_status: "todo",
            }),
            missing_on_disk: true,
          },
        ],
        sessions: {},
        workingBySessionId: {},
      });

      const tree = selectProjectTree(useTerminalStore.getState());
      expect(tree).toHaveLength(2);

      // Project 1
      expect(tree[0].repoId).toBe("repo-1");
      expect(tree[0].repoName).toBe("my-app");
      expect(tree[0].repoPath).toBe("C:/projects/my-app");
      expect(tree[0].branches).toHaveLength(2);

      expect(tree[0].branches[0]).toEqual({
        worktreeId: "wt-1",
        name: "feat-auth",
        branch: "feat-auth",
        path: "C:/projects/my-app/wt-1",
        status: "in-progress",
        sessionIds: [],
        prUrl: null,
        missingOnDisk: false,
        retired: false,
      });

      expect(tree[0].branches[1]).toEqual({
        worktreeId: "wt-2",
        name: "Fix Login Bug",
        branch: "fix-bug",
        path: "C:/projects/my-app/wt-2",
        status: "completed",
        sessionIds: [],
        prUrl: null,
        missingOnDisk: false,
        retired: false,
      });

      // Project 2
      expect(tree[1].repoId).toBe("repo-2");
      expect(tree[1].repoName).toBe("backend");
      expect(tree[1].repoPath).toBe("/home/user/backend");
      expect(tree[1].branches).toHaveLength(1);
      expect(tree[1].branches[0].missingOnDisk).toBe(true);
      expect(tree[1].branches[0].status).toBe("sleeping");
    });

    it("handles trailing slashes and windows backslashes in repo paths", () => {
      useTerminalStore.setState({
        repos: [
          { repo_id: "r1", path: "D:\\repos\\oppa\\", default_base_ref: null, worktree_base_path: null },
          { repo_id: "r2", path: "", default_base_ref: null, worktree_base_path: null },
        ],
        worktrees: [],
        sessions: {},
        workingBySessionId: {},
      });

      const tree = selectProjectTree(useTerminalStore.getState());
      expect(tree).toHaveLength(2);
      expect(tree[0].repoName).toBe("oppa");
      expect(tree[1].repoName).toBe("r2");
    });

    it("maps linked session IDs and computes totalLiveSessions excluding exited ones", () => {
      useTerminalStore.setState({
        repos: [
          { repo_id: "r1", path: "C:/repos/app", default_base_ref: null, worktree_base_path: null },
        ],
        worktrees: [
          {
            record: worktreeRecord({
              id: "wt-a",
              repo_id: "r1",
              name: "a",
              branch: "a",
              path: "C:/repos/app/a",
            }),
            missing_on_disk: false,
          },
          {
            record: worktreeRecord({
              id: "wt-b",
              repo_id: "r1",
              name: "b",
              branch: "b",
              path: "C:/repos/app/b",
            }),
            missing_on_disk: false,
          },
        ],
        sessions: {
          s1: { id: "s1", status: "running", worktreeId: "wt-a" } as any,
          s2: { id: "s2", status: "exited", worktreeId: "wt-a" } as any,
          s3: { id: "s3", status: "running", worktreeId: "wt-b" } as any,
          s4: { id: "s4", status: "running", worktreeId: "wt-other" } as any,
        },
        workingBySessionId: {},
      });

      const tree = selectProjectTree(useTerminalStore.getState());
      expect(tree).toHaveLength(1);
      const proj = tree[0];
      expect(proj.totalLiveSessions).toBe(2); // s1 and s3
      expect(proj.branches[0].sessionIds).toEqual(["s1", "s2"]);
      expect(proj.branches[1].sessionIds).toEqual(["s3"]);
    });

    it("computes status 'working' if any live session is actively working", () => {
      useTerminalStore.setState({
        repos: [
          { repo_id: "r1", path: "C:/repos/app", default_base_ref: null, worktree_base_path: null },
        ],
        worktrees: [
          {
            record: worktreeRecord({
              id: "wt-a",
              repo_id: "r1",
              name: "a",
              branch: "a",
              path: "C:/repos/app/a",
              workspace_status: "in-progress",
            }),
            missing_on_disk: false,
          },
        ],
        sessions: {
          s1: { id: "s1", status: "running", worktreeId: "wt-a" } as any,
          s2: { id: "s2", status: "running", worktreeId: "wt-a" } as any,
        },
        workingBySessionId: {
          s1: false,
          s2: true,
        },
      });

      const tree = selectProjectTree(useTerminalStore.getState());
      expect(tree[0].branches[0].status).toBe("working");
    });

    it("computes status 'idle' if live sessions exist and none are working", () => {
      useTerminalStore.setState({
        repos: [
          { repo_id: "r1", path: "C:/repos/app", default_base_ref: null, worktree_base_path: null },
        ],
        worktrees: [
          {
            record: worktreeRecord({
              id: "wt-a",
              repo_id: "r1",
              name: "a",
              branch: "a",
              path: "C:/repos/app/a",
              workspace_status: "todo",
            }),
            missing_on_disk: false,
          },
        ],
        sessions: {
          s1: { id: "s1", status: "running", worktreeId: "wt-a" } as any,
        },
        workingBySessionId: {
          s1: false,
        },
      });

      const tree = selectProjectTree(useTerminalStore.getState());
      expect(tree[0].branches[0].status).toBe("idle");
    });

    it("computes status 'sleeping' when branch is retired or has no live sessions (todo)", () => {
      useTerminalStore.setState({
        repos: [
          { repo_id: "r1", path: "C:/repos/app", default_base_ref: null, worktree_base_path: null },
        ],
        worktrees: [
          {
            record: worktreeRecord({
              id: "wt-a",
              repo_id: "r1",
              name: "a",
              branch: "a",
              path: "C:/repos/app/a",
              workspace_status: "todo",
              retired: false,
            }),
            missing_on_disk: false,
          },
          {
            record: worktreeRecord({
              id: "wt-b",
              repo_id: "r1",
              name: "b",
              branch: "b",
              path: "C:/repos/app/b",
              workspace_status: "in-progress",
              retired: true,
            }),
            missing_on_disk: false,
          },
        ],
        sessions: {},
        workingBySessionId: {},
      });

      const tree = selectProjectTree(useTerminalStore.getState());
      expect(tree[0].branches[0].status).toBe("sleeping");
      expect(tree[0].branches[1].status).toBe("sleeping");
    });

    it("computes status 'in-review' and maps prUrl when linked_pr_url is set", () => {
      useTerminalStore.setState({
        repos: [
          { repo_id: "r1", path: "C:/repos/app", default_base_ref: null, worktree_base_path: null },
        ],
        worktrees: [
          {
            record: worktreeRecord({
              id: "wt-a",
              repo_id: "r1",
              name: "a",
              branch: "a",
              path: "C:/repos/app/a",
              workspace_status: "in-review",
              linked_pr_url: "https://github.com/org/repo/pull/42",
            }),
            missing_on_disk: false,
          },
        ],
        sessions: {},
        workingBySessionId: {},
      });

      const tree = selectProjectTree(useTerminalStore.getState());
      expect(tree[0].branches[0].status).toBe("in-review");
      expect(tree[0].branches[0].prUrl).toBe("https://github.com/org/repo/pull/42");
    });

    it("creates fallback project groups for orphaned worktrees not matching state.repos", () => {
      useTerminalStore.setState({
        repos: [
          { repo_id: "r1", path: "C:/repos/app", default_base_ref: null, worktree_base_path: null },
        ],
        worktrees: [
          {
            record: worktreeRecord({
              id: "wt-a",
              repo_id: "r1",
              name: "a",
              branch: "a",
              path: "C:/repos/app/a",
            }),
            missing_on_disk: false,
          },
          {
            record: worktreeRecord({
              id: "wt-orphan-1",
              repo_id: "external-repo",
              name: "ext",
              branch: "ext",
              path: "D:/external/worktree",
            }),
            missing_on_disk: false,
          },
        ],
        sessions: {
          s1: { id: "s1", status: "running", worktreeId: "wt-orphan-1" } as any,
        },
        workingBySessionId: {},
      });

      const tree = selectProjectTree(useTerminalStore.getState());
      expect(tree).toHaveLength(2);
      expect(tree[0].repoId).toBe("r1");
      expect(tree[1].repoId).toBe("external-repo");
      expect(tree[1].repoName).toBe("external-repo");
      expect(tree[1].branches).toHaveLength(1);
      expect(tree[1].branches[0].worktreeId).toBe("wt-orphan-1");
      expect(tree[1].totalLiveSessions).toBe(1);
    });
  });

  describe("tileProjectBranches and focusBranchPane actions", () => {
    it("tileProjectBranches builds a 3-branch grid layout and creates/selects a grid tab", async () => {
      let spawnCount = 0;
      ptySpawnMock.mockImplementation(async () => {
        spawnCount++;
        return { id: `s-spawned-${spawnCount}`, is_new: true, is_warm: false, cols: 80, rows: 24, cwd: "" };
      });

      useTerminalStore.setState({
        repos: [{ repo_id: "repo-oppa", path: "C:/projects/oppa", default_base_ref: "main", worktree_base_path: null }],
        worktrees: [
          {
            record: worktreeRecord({
              id: "wt-1",
              repo_id: "repo-oppa",
              name: "feat-a",
              branch: "feat-a",
              path: "C:/projects/oppa/wt-1",
            }),
            missing_on_disk: false,
          },
          {
            record: worktreeRecord({
              id: "wt-2",
              repo_id: "repo-oppa",
              name: "feat-b",
              branch: "feat-b",
              path: "C:/projects/oppa/wt-2",
            }),
            missing_on_disk: false,
          },
          {
            record: worktreeRecord({
              id: "wt-3",
              repo_id: "repo-oppa",
              name: "feat-c",
              branch: "feat-c",
              path: "C:/projects/oppa/wt-3",
            }),
            missing_on_disk: false,
          },
        ],
        sessions: {},
        tabs: [],
        activeTabId: "",
      });

      const tabId = await useTerminalStore.getState().tileProjectBranches("repo-oppa");
      const state = useTerminalStore.getState();

      expect(tabId).toBeDefined();
      expect(state.activeTabId).toBe(tabId);
      const tab = state.tabs.find((t) => t.id === tabId);
      expect(tab).toBeDefined();
      expect(tab?.title).toBe("oppa (Grid)");

      // 3 branches layout: top row 2 (dir v) + bottom row 1 wide (dir h outer)
      expect(tab?.layout).toEqual({
        type: "split",
        dir: "h",
        ratio: 0.5,
        a: {
          type: "split",
          dir: "v",
          ratio: 0.5,
          a: { type: "leaf", id: "s-spawned-1" },
          b: { type: "leaf", id: "s-spawned-2" },
        },
        b: { type: "leaf", id: "s-spawned-3" },
      });
    });

    it("tileProjectBranches reuses live sessions for worktrees and filters by worktreeIds", async () => {
      ptySpawnMock.mockImplementation(async () => ({ id: "s-new", is_new: true, is_warm: false, cols: 80, rows: 24, cwd: "" }));

      useTerminalStore.setState({
        repos: [{ repo_id: "repo-oppa", path: "C:/projects/oppa", default_base_ref: "main", worktree_base_path: null }],
        worktrees: [
          {
            record: worktreeRecord({
              id: "wt-1",
              repo_id: "repo-oppa",
              name: "feat-a",
              branch: "feat-a",
              path: "C:/projects/oppa/wt-1",
            }),
            missing_on_disk: false,
          },
          {
            record: worktreeRecord({
              id: "wt-2",
              repo_id: "repo-oppa",
              name: "feat-b",
              branch: "feat-b",
              path: "C:/projects/oppa/wt-2",
            }),
            missing_on_disk: false,
          },
        ],
        sessions: {
          "s-live-1": {
            id: "s-live-1",
            title: "Live",
            status: "running",
            worktreeId: "wt-1",
            cwd: "C:/projects/oppa/wt-1",
            cols: 80,
            rows: 24,
          },
        },
        tabs: [],
        activeTabId: "",
      });

      const tabId = await useTerminalStore.getState().tileProjectBranches("repo-oppa", ["wt-1", "wt-2"]);
      const state = useTerminalStore.getState();

      const tab = state.tabs.find((t) => t.id === tabId);
      expect(tab?.layout).toEqual({
        type: "split",
        dir: "v",
        ratio: 0.5,
        a: { type: "leaf", id: "s-live-1" },
        b: { type: "leaf", id: "s-new" },
      });
    });

    it("focusBranchPane focuses existing tab and pane if worktree session is already open", async () => {
      useTerminalStore.setState({
        sessions: {
          "s-1": { id: "s-1", title: "s-1", status: "running", worktreeId: "wt-target", cwd: "/a", cols: 80, rows: 24 },
          "s-2": { id: "s-2", title: "s-2", status: "running", worktreeId: "wt-other", cwd: "/b", cols: 80, rows: 24 },
        },
        tabs: [
          {
            id: "tab-1",
            layout: {
              type: "split",
              dir: "h",
              ratio: 0.5,
              a: { type: "leaf", id: "s-2" },
              b: { type: "leaf", id: "s-1" },
            },
            focusedPath: [0],
          },
          {
            id: "tab-2",
            layout: { type: "leaf", id: "s-2" },
            focusedPath: [],
          },
        ],
        activeTabId: "tab-2",
      });

      await useTerminalStore.getState().focusBranchPane("wt-target");

      expect(useTerminalStore.getState().activeTabId).toBe("tab-1");
      expect(useTerminalStore.getState().focusedPath).toEqual([1]);
    });

    it("focusBranchPane spawns new tab with createTab when worktree session is not open", async () => {
      const createTabSpy = vi.spyOn(useTerminalStore.getState(), "createTab");

      useTerminalStore.setState({
        worktrees: [
          {
            record: worktreeRecord({
              id: "wt-unopened",
              name: "new-branch",
              path: "C:/projects/oppa/wt-new",
            }),
            missing_on_disk: false,
          },
        ],
        sessions: {},
        tabs: [],
        activeTabId: "",
      });

      await useTerminalStore.getState().focusBranchPane("wt-unopened");

      expect(createTabSpy).toHaveBeenCalledWith("C:/projects/oppa/wt-new", "wt-unopened");
    });
  });

  describe("workspace model (workspaceKey, mergeSessionsIntoWorkspace)", () => {
    it("saveLayout persists workspaceKey and worktreeId per tab/session (v3)", async () => {
      useTerminalStore.setState({
        ready: true,
        tabs: [
          {
            id: "tab-1",
            title: "oppa",
            workspaceKey: "C:/projects/oppa",
            layout: { type: "leaf", id: "sess-1" },
            focusedPath: [],
          },
        ],
        activeTabId: "tab-1",
        sessions: {
          "sess-1": {
            id: "sess-1",
            title: "feat-a",
            status: "running",
            cwd: "C:/projects/oppa/wt-1",
            worktreeId: "wt-1",
            cols: 80,
            rows: 24,
          },
        },
      });

      await useTerminalStore.getState().saveLayout();

      const parsed = JSON.parse(saveLayoutMock.mock.calls[0][0]);
      expect(parsed.version).toBe(3);
      expect(parsed.tabs[0].workspaceKey).toBe("C:/projects/oppa");
      expect(parsed.sessions[0].worktreeId).toBe("wt-1");
    });

    it("loadLayout restores workspaceKey and worktreeId from a v3 snapshot", async () => {
      loadLayoutMock.mockResolvedValue(
        JSON.stringify({
          version: 3,
          tabs: [
            {
              id: "tab-1",
              title: "oppa",
              workspaceKey: "C:/projects/oppa",
              layout: { type: "leaf", id: "old-1" },
              focusedPath: [],
            },
          ],
          activeTabId: "tab-1",
          sessions: [
            {
              id: "old-1",
              title: "feat-a",
              status: "running",
              cwd: "C:/projects/oppa/wt-1",
              worktreeId: "wt-1",
              cols: 80,
              rows: 24,
            },
          ],
        }),
      );
      ptySpawnMock.mockResolvedValue(spawnRes("new-1"));

      await useTerminalStore.getState().loadLayout();

      const state = useTerminalStore.getState();
      expect(state.tabs[0].workspaceKey).toBe("C:/projects/oppa");
      expect(state.sessions["new-1"].worktreeId).toBe("wt-1");
    });

    it("loadLayout migrates a v2 snapshot by deriving workspaceKey from the first session cwd", async () => {
      loadLayoutMock.mockResolvedValue(
        JSON.stringify({
          version: 2,
          tabs: [
            {
              id: "tab-1",
              title: "oppa",
              layout: { type: "leaf", id: "old-1" },
              focusedPath: [],
            },
          ],
          activeTabId: "tab-1",
          sessions: [
            { id: "old-1", title: "shell", status: "running", cwd: "C:/legacy/dir", cols: 80, rows: 24 },
          ],
        }),
      );
      ptySpawnMock.mockResolvedValue(spawnRes("new-1"));

      await useTerminalStore.getState().loadLayout();

      const state = useTerminalStore.getState();
      expect(state.tabs[0].workspaceKey).toBe("C:/legacy/dir");
    });

    it("mergeSessionsIntoWorkspace attaches warm sessions and rebuilds one grid", async () => {
      useTerminalStore.setState({
        tabs: [
          {
            id: "tab-1",
            title: "oppa",
            workspaceKey: "C:/projects/oppa",
            layout: { type: "leaf", id: "s-base" },
            focusedPath: [],
          },
        ],
        activeTabId: "tab-1",
        sessions: {
          "s-base": { id: "s-base", title: "base", status: "running", cwd: "C:/projects/oppa", cols: 80, rows: 24 },
        },
      });
      // Daemon already holds the fleet sessions; attaching passes existingId only.
      ptySpawnMock
        .mockResolvedValueOnce(spawnRes("s-agent-1", false))
        .mockResolvedValueOnce(spawnRes("s-agent-2", false));

      await useTerminalStore.getState().mergeSessionsIntoWorkspace("tab-1", ["s-agent-1", "s-agent-2"]);

      // Attach calls reuse the daemon session ids (no fresh shell spawns).
      expect(ptySpawnMock.mock.calls.map((c) => c[0])).toEqual([
        { id: "s-agent-1" },
        { id: "s-agent-2" },
      ]);
      const state = useTerminalStore.getState();
      const tab = state.tabs.find((t) => t.id === "tab-1");
      expect(leafIdList(tab?.layout)).toEqual(["s-base", "s-agent-1", "s-agent-2"]);
      expect(state.sessions["s-agent-1"].status).toBe("running");
    });

    it("mergeSessionsIntoWorkspace replaces an empty placeholder leaf instead of keeping it", async () => {
      useTerminalStore.setState({
        tabs: [
          {
            id: "tab-wizard",
            title: "New Workspace",
            isWizard: true,
            layout: { type: "leaf", id: "" },
            focusedPath: [],
          },
        ],
        activeTabId: "tab-wizard",
        sessions: {},
      });
      ptySpawnMock
        .mockResolvedValueOnce(spawnRes("s-a", false))
        .mockResolvedValueOnce(spawnRes("s-b", false));

      await useTerminalStore
        .getState()
        .mergeSessionsIntoWorkspace("tab-wizard", ["s-a", "s-b"], {
          workspaceKey: "C:/projects/oppa",
          title: "oppa agents",
          clearWizard: true,
        });

      const state = useTerminalStore.getState();
      const tab = state.tabs.find((t) => t.id === "tab-wizard");
      expect(tab?.isWizard).toBeFalsy();
      expect(tab?.title).toBe("oppa agents");
      expect(tab?.workspaceKey).toBe("C:/projects/oppa");
      expect(leafIdList(tab?.layout)).toEqual(["s-a", "s-b"]);
    });

    it("mergeSessionsIntoWorkspace keeps manual split changes racing the merge (snapshot-then-set)", async () => {
      useTerminalStore.setState({
        tabs: [
          {
            id: "tab-1",
            title: "oppa",
            workspaceKey: "C:/projects/oppa",
            layout: { type: "leaf", id: "s-base" },
            focusedPath: [],
          },
        ],
        activeTabId: "tab-1",
        sessions: {
          "s-base": { id: "s-base", title: "base", status: "running", cwd: "C:/projects/oppa", cols: 80, rows: 24 },
        },
      });
      ptySpawnMock.mockImplementation(async (opts) => {
        // User splits the pane while the attach is in flight: base gains a child.
        if (opts && typeof opts === "object" && "id" in opts) {
          useTerminalStore.setState((s) => ({
            tabs: s.tabs.map((t) =>
              t.id === "tab-1"
                ? {
                    ...t,
                    layout: {
                      type: "split",
                      dir: "h",
                      ratio: 0.5,
                      a: { type: "leaf", id: "s-base" },
                      b: { type: "leaf", id: "s-mid-race" },
                    },
                  }
                : t,
            ),
          }));
        }
        return spawnRes((opts as { id?: string })?.id ?? "s-x", false);
      });

      await useTerminalStore.getState().mergeSessionsIntoWorkspace("tab-1", ["s-agent-1"]);

      const tab = useTerminalStore.getState().tabs.find((t) => t.id === "tab-1");
      const ids = leafIdList(tab?.layout);
      expect(ids).toContain("s-base");
      expect(ids).toContain("s-mid-race");
      expect(ids).toContain("s-agent-1");
      expect(ids).not.toContain("");
    });
  });

  describe("launchParallelWorkspace", () => {
    const fleetInput = (overrides: Record<string, unknown> = {}) =>
      ({
        repoPath: "C:/projects/demo",
        slots: [
          { agent: "claude", command: null, prompt: "fix login", name: null },
          { agent: null, command: "my-agent --yolo", prompt: null, name: null },
        ],
        ...overrides,
      }) as unknown as import("../lib/worktree/transport").FleetSpawnOptions;

    it("spawns fleet slots and merges them into one workspace tab", async () => {
      worktreeCreateFleetMock.mockResolvedValue({
        results: [
          {
            index: 0,
            ok: true,
            record: worktreeRecord({ id: "wt-a", branch: "feat-a", path: "C:/projects/demo/wt-a" }),
            session_id: "daemon-s-1",
            error: null,
          },
          {
            index: 1,
            ok: true,
            record: worktreeRecord({ id: "wt-b", branch: "feat-b", path: "C:/projects/demo/wt-b" }),
            session_id: "daemon-s-2",
            error: null,
          },
        ],
      });
      worktreeListMock.mockResolvedValue([]);
      ptySpawnMock.mockImplementation(async (opts) =>
        spawnRes((opts as { id?: string })?.id ?? "fresh", false),
      );

      useTerminalStore.setState({
        tabs: [
          { id: "tab-w", isWizard: true, title: "New Workspace", layout: { type: "leaf", id: "" }, focusedPath: [] },
        ],
        activeTabId: "tab-w",
        sessions: {},
      });

      const outcome = await useTerminalStore.getState().launchParallelWorkspace(
        "tab-w",
        fleetInput(),
      );

      expect(outcome.ok).toBe(true);
      const state = useTerminalStore.getState();
      const tab = state.tabs.find((t) => t.id === "tab-w");
      expect(tab?.isWizard).toBeFalsy();
      // Fleet sessions warm-attached into the one tab
      expect(ptySpawnMock.mock.calls.map((c) => c[0])).toEqual([
        { id: "daemon-s-1", worktreeId: "wt-a" },
        { id: "daemon-s-2", worktreeId: "wt-b" },
      ]);
      const ids = leafIdList(tab?.layout);
      expect(ids).toEqual(["daemon-s-1", "daemon-s-2"]);
      expect(state.sessions["daemon-s-1"].worktreeId).toBe("wt-a");
    });

    it("returns per-slot failure outcomes without failing the whole launch", async () => {
      worktreeCreateFleetMock.mockResolvedValue({
        results: [
          {
            index: 0,
            ok: false,
            record: null,
            session_id: null,
            error: "repo not registered",
          },
          {
            index: 1,
            ok: true,
            record: worktreeRecord({ id: "wt-b" }),
            session_id: "daemon-s-2",
            error: null,
          },
        ],
      });
      worktreeListMock.mockResolvedValue([]);
      ptySpawnMock.mockImplementation(async (opts) =>
        spawnRes((opts as { id?: string })?.id ?? "fresh", false),
      );

      useTerminalStore.setState({
        tabs: [
          { id: "tab-w", isWizard: true, layout: { type: "leaf", id: "" }, focusedPath: [] },
        ],
        activeTabId: "tab-w",
        sessions: {},
      });

      const outcome = await useTerminalStore.getState().launchParallelWorkspace("tab-w", fleetInput());

      expect(outcome.ok).toBe(false);
      expect(outcome.errors).toEqual(["Slot 1: repo not registered"]);
      // The one success still merged
      const tab = useTerminalStore.getState().tabs.find((t) => t.id === "tab-w");
      expect(leafIdList(tab?.layout)).toEqual(["daemon-s-2"]);
    });
  });
});
