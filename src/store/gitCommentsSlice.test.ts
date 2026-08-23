import { describe, it, expect, vi, beforeEach } from "vitest";
import { useTerminalStore } from "./terminalStore";
import * as transport from "../lib/pty/transport";
import type { DiffComment } from "../lib/pty/transport";

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
  onWorktreeChanged: vi.fn().mockResolvedValue(() => {}),
  onTitleChanged: vi.fn().mockResolvedValue(() => {}),
  onFocusRequested: vi.fn().mockResolvedValue(() => {}),
  onGitChanged: vi.fn().mockResolvedValue(() => {}),
  worktreeList: vi.fn().mockResolvedValue([]),
  worktreePs: vi.fn().mockResolvedValue([]),
  worktreeCreate: vi.fn(),
  worktreeSet: vi.fn().mockResolvedValue(null),
  worktreeRemove: vi.fn().mockResolvedValue(undefined),
  worktreePurge: vi.fn().mockResolvedValue(undefined),
  repoAdd: vi.fn().mockResolvedValue([]),
  repoList: vi.fn().mockResolvedValue([]),
  ptyList: vi.fn().mockResolvedValue([]),
  agentProfiles: vi.fn().mockResolvedValue([]),
  worktreeCreateAgent: vi.fn(),
  diffCommentsList: vi.fn().mockResolvedValue([]),
  diffCommentAdd: vi.fn(),
  diffCommentUpdate: vi.fn(),
  diffCommentDelete: vi.fn().mockResolvedValue(undefined),
  diffCommentsMarkSent: vi.fn(),
}));

const diffCommentsListMock = vi.mocked(transport.diffCommentsList);
const diffCommentAddMock = vi.mocked(transport.diffCommentAdd);
const diffCommentUpdateMock = vi.mocked(transport.diffCommentUpdate);
const diffCommentDeleteMock = vi.mocked(transport.diffCommentDelete);
const diffCommentsMarkSentMock = vi.mocked(transport.diffCommentsMarkSent);
const ptyWriteMock = vi.mocked(transport.ptyWrite);

function makeComment(overrides: Partial<DiffComment> = {}): DiffComment {
  return {
    id: "c-1",
    worktree_id: "wt-1",
    file_path: "src/lib/mod.rs",
    source: "diff",
    selected_text: null,
    start_line: null,
    line_number: 3,
    body: "fix this",
    scope: "unstaged",
    old_path: null,
    created_at_ms: 1,
    updated_at_ms: null,
    sent_at: null,
    ...overrides,
  };
}

describe("git comments slice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTerminalStore.setState({ diffComments: {}, sessions: {}, tabs: [], activeTabId: "" });
  });

  it("loads comments keyed by worktree id", async () => {
    const list = [makeComment(), makeComment({ id: "c-2", file_path: "README.md" })];
    diffCommentsListMock.mockResolvedValue(list);

    await useTerminalStore.getState().loadComments("wt-1");

    expect(diffCommentsListMock).toHaveBeenCalledWith("wt-1");
    expect(useTerminalStore.getState().diffComments["wt-1"]).toEqual(list);
  });

  it("keeps other worktrees' comments when loading", async () => {
    useTerminalStore.setState({
      diffComments: { "wt-9": [makeComment({ id: "c-9", worktree_id: "wt-9" })] },
    });
    diffCommentsListMock.mockResolvedValue([]);

    await useTerminalStore.getState().loadComments("wt-1");

    expect(useTerminalStore.getState().diffComments["wt-9"]).toHaveLength(1);
  });

  it("appends the stamped record after adding a comment", async () => {
    const added = makeComment();
    diffCommentAddMock.mockResolvedValue(added);

    await useTerminalStore.getState().addComment("wt-1", {
      worktree_id: "wt-1",
      file_path: "src/lib/mod.rs",
      source: "diff",
      line_number: 3,
      body: "fix this",
      scope: "unstaged",
    });

    expect(useTerminalStore.getState().diffComments["wt-1"]).toEqual([added]);
  });

  it("updates a comment body in place via its returned record", async () => {
    useTerminalStore.setState({ diffComments: { "wt-1": [makeComment()] } });
    diffCommentUpdateMock.mockResolvedValue(makeComment({ body: "edited" }));

    await useTerminalStore.getState().updateComment("c-1", "edited");

    expect(diffCommentUpdateMock).toHaveBeenCalledWith("c-1", "edited");
    expect(useTerminalStore.getState().diffComments["wt-1"][0].body).toBe("edited");
  });

  it("deletes a comment from its worktree bucket", async () => {
    useTerminalStore.setState({
      diffComments: {
        "wt-1": [makeComment(), makeComment({ id: "c-2" })],
        "wt-2": [makeComment({ id: "c-3", worktree_id: "wt-2" })],
      },
    });

    await useTerminalStore.getState().deleteComment("c-1");

    expect(diffCommentDeleteMock).toHaveBeenCalledWith("c-1");
    const buckets = useTerminalStore.getState().diffComments;
    expect(buckets["wt-1"].map((c) => c.id)).toEqual(["c-2"]);
    expect(buckets["wt-2"]).toHaveLength(1);
  });

  it("marks comments sent using the daemon-stamped records", async () => {
    useTerminalStore.setState({
      diffComments: {
        "wt-1": [
          makeComment(),
          makeComment({ id: "c-2", sent_at: 100 }),
          makeComment({ id: "c-3" }),
        ],
      },
    });
    diffCommentsMarkSentMock.mockResolvedValue([
      makeComment({ sent_at: 200 }),
      makeComment({ id: "c-3", sent_at: 201 }),
    ]);

    await useTerminalStore.getState().markCommentsSent(["c-1", "c-3"]);

    expect(diffCommentsMarkSentMock).toHaveBeenCalledWith(["c-1", "c-3"]);
    const stored = useTerminalStore.getState().diffComments["wt-1"];
    expect(stored.map((c) => c.sent_at)).toEqual([200, 100, 201]);
  });

  it("sends text to a live session through ptyWrite", async () => {
    await useTerminalStore.getState().sendToSession("s-7", "hello\r");
    expect(ptyWriteMock).toHaveBeenCalledWith("s-7", "hello\r");
  });

  it("resolves an empty worktree id when no tab is bound", () => {
    expect(useTerminalStore.getState().getActiveWorktreeId()).toBe("");
  });

  it("prefers the active session's worktree binding over cwd matching", () => {
    useTerminalStore.setState({
      worktrees: [
        {
          record: {
            id: "wt-cwd",
            repo_id: "r",
            name: "cwdmatch",
            display_name: null,
            branch: "b",
            path: "/repo/wt-cwd",
            base_ref: "main",
            parent_worktree_id: null,
            child_worktree_ids: [],
            workspace_status: "in-progress",
            retired: false,
            created_at_ms: 0,
            linked_pr_url: null,
          },
          missing_on_disk: false,
        },
        {
          record: {
            id: "wt-bound",
            repo_id: "r",
            name: "bound",
            display_name: null,
            branch: "b",
            path: "/elsewhere",
            base_ref: "main",
            parent_worktree_id: null,
            child_worktree_ids: [],
            workspace_status: "in-progress",
            retired: false,
            created_at_ms: 0,
            linked_pr_url: null,
          },
          missing_on_disk: false,
        },
      ],
      tabs: [{ id: "tab-1", layout: { type: "leaf", id: "s1" }, focusedPath: [] }],
      activeTabId: "tab-1",
      layout: { type: "leaf", id: "s1" },
      focusedPath: [],
      sessions: {
        s1: {
          id: "s1",
          title: "s1",
          status: "running",
          cwd: "/repo/wt-cwd/deeper",
          cols: 80,
          rows: 24,
          worktreeId: "wt-bound",
        },
      },
    });

    expect(useTerminalStore.getState().getActiveWorktreeId()).toBe("wt-bound");
  });

  it("derives the worktree id from the active session cwd as fallback", () => {
    useTerminalStore.setState({
      worktrees: [
        {
          record: {
            id: "wt-cwd",
            repo_id: "r",
            name: "cwdmatch",
            display_name: null,
            branch: "b",
            path: "C:\\repo\\wt-cwd",
            base_ref: "main",
            parent_worktree_id: null,
            child_worktree_ids: [],
            workspace_status: "in-progress",
            retired: false,
            created_at_ms: 0,
            linked_pr_url: null,
          },
          missing_on_disk: false,
        },
      ],
      tabs: [{ id: "tab-1", layout: { type: "leaf", id: "s1" }, focusedPath: [] }],
      activeTabId: "tab-1",
      layout: { type: "leaf", id: "s1" },
      focusedPath: [],
      sessions: {
        s1: {
          id: "s1",
          title: "s1",
          status: "running",
          cwd: "C:\\repo\\wt-cwd\\sub",
          cols: 80,
          rows: 24,
        },
      },
    });

    expect(useTerminalStore.getState().getActiveWorktreeId()).toBe("wt-cwd");
  });

  it("returns empty string for sessions outside every known worktree", () => {
    useTerminalStore.setState({
      worktrees: [],
      tabs: [{ id: "tab-1", layout: { type: "leaf", id: "s1" }, focusedPath: [] }],
      activeTabId: "tab-1",
      layout: { type: "leaf", id: "s1" },
      focusedPath: [],
      sessions: {
        s1: { id: "s1", title: "s1", status: "running", cwd: "/somewhere", cols: 80, rows: 24 },
      },
    });

    expect(useTerminalStore.getState().getActiveWorktreeId()).toBe("");
  });
});
