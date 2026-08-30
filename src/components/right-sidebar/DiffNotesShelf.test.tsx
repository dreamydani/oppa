import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DiffNotesShelf } from "./DiffNotesShelf";
import { useTerminalStore } from "../../store/terminalStore";
import * as ptyTransport from "../../lib/pty/transport";
import * as gitTransport from "../../lib/git/transport";
import type { DiffComment } from "../../lib/git/transport";
import type { WorktreeListEntry } from "../../lib/worktree/transport";

vi.mock("../../lib/pty/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/pty/transport")>()),
  ptyWrite: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/git/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/git/transport")>()),
  diffCommentsList: vi.fn().mockResolvedValue([]),
  diffCommentUpdate: vi.fn(),
  diffCommentDelete: vi.fn().mockResolvedValue(undefined),
  diffCommentsMarkSent: vi.fn(),
}));

const diffCommentUpdateMock = vi.mocked(gitTransport.diffCommentUpdate);
const diffCommentDeleteMock = vi.mocked(gitTransport.diffCommentDelete);
const diffCommentsMarkSentMock = vi.mocked(gitTransport.diffCommentsMarkSent);
const ptyWriteMock = vi.mocked(ptyTransport.ptyWrite);

function makeWorktreeEntry(id: string, name: string): WorktreeListEntry {
  return {
    record: {
      id,
      repo_id: "r",
      name,
      display_name: null,
      branch: "feature",
      path: `/repo/${id}`,
      base_ref: "main",
      parent_worktree_id: null,
      child_worktree_ids: [],
      workspace_status: "in-progress",
      retired: false,
      created_at_ms: 0,
      linked_pr_url: null,
    },
    missing_on_disk: false,
  };
}

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

function seedStore(opts: {
  worktreeId?: string;
  comments?: DiffComment[];
} = {}) {
  const bound = opts.worktreeId === undefined;
  const activeWorktreeId = bound || opts.worktreeId ? "wt-1" : "";
  useTerminalStore.setState({
    worktrees: [makeWorktreeEntry("wt-1", "feature-a")],
    diffComments: { [activeWorktreeId]: opts.comments ?? [] },
    tabs: [{ id: "tab-1", layout: { type: "leaf", id: "s1" }, focusedPath: [] }],
    activeTabId: "tab-1",
    layout: { type: "leaf", id: "s1" },
    focusedPath: [],
    sessions: {
      s1: {
        id: "s1",
        title: "s1",
        status: "running",
        cwd: bound ? "/repo/wt-1" : "/somewhere/unrelated",
        cols: 80,
        rows: 24,
        ...(bound ? { worktreeId: "wt-1" } : {}),
      },
      s2: {
        id: "s2",
        title: "agent two",
        status: "running",
        cwd: "/elsewhere",
        cols: 80,
        rows: 24,
      },
      dead: {
        id: "dead",
        title: "exited shell",
        status: "exited",
        cwd: "/repo/wt-1",
        cols: 80,
        rows: 24,
      },
    },
  });
  // The shelf reloads on mount; the daemon mock must agree with the seed.
  vi.mocked(gitTransport.diffCommentsList).mockResolvedValue(opts.comments ?? []);
}

describe("DiffNotesShelf", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    diffCommentsMarkSentMock.mockImplementation(async (ids: string[]) =>
      ids.map((id, i) => makeComment({ id, sent_at: 500 + i })),
    );
    // happy-dom exposes navigator.clipboard as getter-only
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
      configurable: true,
    });
  });

  it("shows the bind hint instead of the shelf when the tab is unbound", () => {
    seedStore({ worktreeId: "" });
    render(<DiffNotesShelf />);

    expect(screen.getByTestId("notes-unbound-hint")).toBeInTheDocument();
    expect(screen.queryByTestId("notes-shelf")).toBeNull();
  });

  it("groups unsent notes by file with counts and truncated bodies", () => {
    seedStore({
      comments: [
        makeComment({ body: "x".repeat(80) }),
        makeComment({ id: "c-2", line_number: 9, body: "short note" }),
        makeComment({
          id: "c-3",
          file_path: "README.md",
          line_number: 2,
          body: "docs",
        }),
      ],
    });
    render(<DiffNotesShelf />);

    expect(screen.getByText(/src[\\/]lib[\\/]mod\.rs \(2\)/)).toBeInTheDocument();
    expect(screen.getByText(/README\.md \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(`L3: ${"x".repeat(60)}…`)).toBeInTheDocument();
    expect(screen.getByText("L9: short note")).toBeInTheDocument();
    expect(screen.getByText("L2: docs")).toBeInTheDocument();
  });

  it("hides already-sent notes from the shelf", () => {
    seedStore({ comments: [makeComment({ sent_at: 100 })] });
    render(<DiffNotesShelf />);

    expect(screen.getByTestId("notes-shelf")).toBeInTheDocument();
    expect(screen.queryByText(/fix this/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Send .* notes/ })).toBeNull();
  });

  it("edits a note inline through the pencil affordance", async () => {
    diffCommentUpdateMock.mockResolvedValue(makeComment({ body: "edited body" }));
    seedStore({ comments: [makeComment()] });
    render(<DiffNotesShelf />);

    fireEvent.click(screen.getByTitle("Edit note"));
    fireEvent.change(screen.getByTestId("note-edit-input"), {
      target: { value: "edited body" },
    });
    fireEvent.click(screen.getByTestId("note-edit-save"));

    await waitFor(() =>
      expect(diffCommentUpdateMock).toHaveBeenCalledWith("c-1", "edited body"),
    );
  });

  it("deletes a note via the trash affordance", async () => {
    seedStore({ comments: [makeComment()] });
    render(<DiffNotesShelf />);

    fireEvent.click(screen.getByTitle("Delete note"));

    await waitFor(() => expect(diffCommentDeleteMock).toHaveBeenCalledWith("c-1"));
  });

  it("sends the formatted prompt to the picked session and marks notes sent", async () => {
    seedStore({
      comments: [
        makeComment(),
        makeComment({ id: "c-2", file_path: "README.md", line_number: 5, body: 'say "hi"' }),
      ],
    });
    render(<DiffNotesShelf />);

    fireEvent.click(screen.getByTestId("send-notes-btn"));
    fireEvent.click(screen.getByTestId("send-target-s2"));

    const expected =
      "Review notes for worktree feature-a:\n" +
      'File: src/lib/mod.rs\nLine: 3\nUser comment: "fix this"\n\n' +
      'File: README.md\nLine: 5\nUser comment: "say \\"hi\\""';
    await waitFor(() => expect(ptyWriteMock).toHaveBeenCalledWith("s2", `${expected}\r`));
    await waitFor(() =>
      expect(diffCommentsMarkSentMock).toHaveBeenCalledWith(["c-1", "c-2"]),
    );
    await waitFor(() =>
      expect(screen.getByTestId("notes-sent-line").textContent).toMatch(/Sent 2 notes/i),
    );
  });

  it("offers only live sessions as send targets", () => {
    seedStore({ comments: [makeComment()] });
    render(<DiffNotesShelf />);

    fireEvent.click(screen.getByTestId("send-notes-btn"));

    expect(screen.getByTestId("send-target-s1")).toBeInTheDocument();
    expect(screen.getByTestId("send-target-s2")).toBeInTheDocument();
    expect(screen.queryByTestId("send-target-dead")).toBeNull();
  });

  it("copies the exact prompt via the clipboard fallback", async () => {
    seedStore({ comments: [makeComment()] });
    render(<DiffNotesShelf />);

    fireEvent.click(screen.getByTestId("copy-prompt-btn"));

    await waitFor(() =>
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "Review notes for worktree feature-a:\n" +
          'File: src/lib/mod.rs\nLine: 3\nUser comment: "fix this"',
      ),
    );
  });

  it("collapses and expands the shelf", () => {
    seedStore({ comments: [makeComment()] });
    render(<DiffNotesShelf />);

    fireEvent.click(screen.getByTestId("notes-shelf-toggle"));
    expect(screen.queryByText(/mod\.rs \(1\)/)).toBeNull();

    fireEvent.click(screen.getByTestId("notes-shelf-toggle"));
    expect(screen.getByText(/mod\.rs \(1\)/)).toBeInTheDocument();
  });

  it("reloads comments when the bound worktree changes", async () => {
    seedStore({});
    render(<DiffNotesShelf />);

    await waitFor(() =>
      expect(vi.mocked(gitTransport.diffCommentsList)).toHaveBeenCalledWith("wt-1"),
    );
  });
});
