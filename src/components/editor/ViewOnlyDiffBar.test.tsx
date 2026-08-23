import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ViewOnlyDiffBar } from "./ViewOnlyDiffBar";
import { useTerminalStore } from "../../store/terminalStore";
import * as ptyTransport from "../../lib/pty/transport";
import * as bridge from "./diffSelectionBridge";
import type { WorktreeListEntry } from "../../lib/pty/transport";

vi.mock("../../lib/pty/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/pty/transport")>()),
  diffCommentsList: vi.fn().mockResolvedValue([]),
  diffCommentAdd: vi.fn(),
}));

vi.mock("./diffSelectionBridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./diffSelectionBridge")>()),
  readDiffSelection: vi.fn(),
}));

const diffCommentAddMock = vi.mocked(ptyTransport.diffCommentAdd);
const readDiffSelectionMock = vi.mocked(bridge.readDiffSelection);

function makeWorktreeEntry(id: string, path: string): WorktreeListEntry {
  return {
    record: {
      id,
      repo_id: "r",
      name: "wt",
      display_name: null,
      branch: "b",
      path,
      base_ref: "main",
      parent_worktree_id: null,
      child_worktree_ids: [],
      workspace_status: "in-progress" as const,
      retired: false,
      created_at_ms: 0,
      linked_pr_url: null,
    },
    missing_on_disk: false,
  };
}

function seedStore(worktrees: WorktreeListEntry[] = []) {
  useTerminalStore.setState({
    viewOnlyDiff: { path: "src/lib/mod.rs", original: "old", modified: "new" },
    pendingAiDiff: null,
    worktrees,
    tabs: [{ id: "tab-1", layout: { type: "leaf", id: "s1" }, focusedPath: [] }],
    activeTabId: "tab-1",
    layout: { type: "leaf", id: "s1" },
    focusedPath: [],
    sessions: {
      s1: { id: "s1", title: "s1", status: "running", cwd: "/repo/wt-1", cols: 80, rows: 24 },
    },
  });
}

describe("ViewOnlyDiffBar note affordance", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedStore([makeWorktreeEntry("wt-1", "/repo/wt-1")]);
    diffCommentAddMock.mockImplementation(async () => ({
      id: "c-new",
      worktree_id: "wt-1",
      file_path: "src/lib/mod.rs",
      source: "diff",
      selected_text: null,
      start_line: null,
      line_number: 1,
      body: "b",
      scope: "unstaged",
      old_path: null,
      created_at_ms: 1,
      updated_at_ms: null,
      sent_at: null,
    }));
  });

  it("opens the note form prefilled from the editor selection snapshot", async () => {
    readDiffSelectionMock.mockReturnValue({
      selectedText: "let x = 1;",
      lineNumber: 7,
      rangeStartLine: null,
    });
    render(<ViewOnlyDiffBar />);

    fireEvent.click(screen.getByTestId("add-diff-note"));

    const lineInput = screen.getByTestId("diff-note-line") as HTMLInputElement;
    expect(lineInput.value).toBe("7");
    expect((screen.getByTestId("diff-note-body") as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByTestId("diff-note-scope")).toHaveValue("unstaged");
  });

  it("falls back to the cursor line when there is no selection", () => {
    readDiffSelectionMock.mockReturnValue({
      selectedText: "",
      lineNumber: 12,
      rangeStartLine: null,
    });
    render(<ViewOnlyDiffBar />);

    fireEvent.click(screen.getByTestId("add-diff-note"));

    expect((screen.getByTestId("diff-note-line") as HTMLInputElement).value).toBe("12");
  });

  it("saves a single-line note without start_line or selected text", async () => {
    readDiffSelectionMock.mockReturnValue({
      selectedText: "",
      lineNumber: 4,
      rangeStartLine: null,
    });
    render(<ViewOnlyDiffBar />);

    fireEvent.click(screen.getByTestId("add-diff-note"));
    fireEvent.change(screen.getByTestId("diff-note-body"), { target: { value: "rename this" } });
    fireEvent.click(screen.getByTestId("diff-note-save"));

    await waitFor(() =>
      expect(diffCommentAddMock).toHaveBeenCalledWith({
        worktree_id: "wt-1",
        file_path: "src/lib/mod.rs",
        source: "diff",
        selected_text: null,
        start_line: null,
        line_number: 4,
        body: "rename this",
        scope: "unstaged",
      }),
    );
    await waitFor(() =>
      expect(useTerminalStore.getState().diffComments["wt-1"]).toHaveLength(1),
    );
    expect(screen.queryByTestId("diff-note-form")).toBeNull();
  });

  it("keeps selection text and range when a multi-line selection was captured", async () => {
    readDiffSelectionMock.mockReturnValue({
      selectedText: "a\nb",
      lineNumber: 9,
      rangeStartLine: 8,
    });
    render(<ViewOnlyDiffBar />);

    fireEvent.click(screen.getByTestId("add-diff-note"));
    fireEvent.change(screen.getByTestId("diff-note-body"), { target: { value: "tighten" } });
    fireEvent.click(screen.getByTestId("diff-note-save"));

    await waitFor(() =>
      expect(diffCommentAddMock).toHaveBeenCalledWith(
        expect.objectContaining({ selected_text: "a\nb", start_line: 8, line_number: 9 }),
      ),
    );
  });

  it("saves with an edited scope and line number", async () => {
    readDiffSelectionMock.mockReturnValue({
      selectedText: "",
      lineNumber: 4,
      rangeStartLine: null,
    });
    render(<ViewOnlyDiffBar />);

    fireEvent.click(screen.getByTestId("add-diff-note"));
    fireEvent.change(screen.getByTestId("diff-note-body"), { target: { value: "check" } });
    fireEvent.change(screen.getByTestId("diff-note-line"), { target: { value: "6" } });
    fireEvent.change(screen.getByTestId("diff-note-scope"), { target: { value: "staged" } });
    fireEvent.click(screen.getByTestId("diff-note-save"));

    await waitFor(() =>
      expect(diffCommentAddMock).toHaveBeenCalledWith(
        expect.objectContaining({ line_number: 6, scope: "staged" }),
      ),
    );
  });

  it("disables note capture while the tab is not bound to a worktree", () => {
    seedStore([]);
    render(<ViewOnlyDiffBar />);

    const btn = screen.getByTestId("add-diff-note");
    expect(btn).toBeDisabled();
    expect(btn.getAttribute("title")).toMatch(/bind a terminal to a worktree/i);
  });

  it("closes the form on cancel", () => {
    readDiffSelectionMock.mockReturnValue({
      selectedText: "",
      lineNumber: 1,
      rangeStartLine: null,
    });
    render(<ViewOnlyDiffBar />);

    fireEvent.click(screen.getByTestId("add-diff-note"));
    fireEvent.click(screen.getByTestId("diff-note-cancel"));

    expect(screen.queryByTestId("diff-note-form")).toBeNull();
  });
});
