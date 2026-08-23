import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { GitSourceControl } from "./GitSourceControl";
import { useTerminalStore } from "../../store/terminalStore";
import type { PullOutcome, SourceControlStatus } from "../../lib/pty/transport";
import * as ptyTransport from "../../lib/pty/transport";

vi.mock("../../lib/pty/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/pty/transport")>()),
  scStatus: vi.fn(),
  scStage: vi.fn().mockResolvedValue(undefined),
  scUnstage: vi.fn().mockResolvedValue(undefined),
  scDiscard: vi.fn().mockResolvedValue(undefined),
  scCommit: vi.fn().mockResolvedValue("abc1234"),
  scLocalBranches: vi.fn().mockResolvedValue({ branches: ["main", "feature"], current: "main" }),
  scCheckout: vi.fn().mockResolvedValue(undefined),
  scFileDiff: vi.fn().mockResolvedValue({
    kind: "text",
    original_content: "old",
    modified_content: "new",
    truncated: false,
  }),
  scHistory: vi.fn().mockResolvedValue({ items: [], has_more: false }),
  scFetch: vi.fn().mockResolvedValue(undefined),
  scPull: vi.fn().mockResolvedValue({ status: "up-to-date", new_head: null }),
  scFastForward: vi.fn().mockResolvedValue({ status: "up-to-date", new_head: null }),
  scPush: vi.fn().mockResolvedValue({ pushed_to: "origin/main", was_publish: false }),
  generateCommitMessage: vi.fn().mockResolvedValue({ message: "" }),
}));

const scStatusMock = vi.mocked(ptyTransport.scStatus);
const scStageMock = vi.mocked(ptyTransport.scStage);
const scUnstageMock = vi.mocked(ptyTransport.scUnstage);
const scDiscardMock = vi.mocked(ptyTransport.scDiscard);
const scCommitMock = vi.mocked(ptyTransport.scCommit);
const scCheckoutMock = vi.mocked(ptyTransport.scCheckout);
const scFileDiffMock = vi.mocked(ptyTransport.scFileDiff);
const scPullMock = vi.mocked(ptyTransport.scPull);
const scPushMock = vi.mocked(ptyTransport.scPush);
const generateCommitMessageMock = vi.mocked(ptyTransport.generateCommitMessage);

function makeStatus(): SourceControlStatus {
  return {
    entries: [
      {
        path: "conflicted.txt",
        index_status: "U",
        worktree_status: "U",
        area: "conflict",
        old_path: null,
      },
      {
        path: "src/staged.ts",
        index_status: "M",
        worktree_status: " ",
        area: "staged",
        old_path: null,
      },
      {
        path: "renamed.ts",
        index_status: "R",
        worktree_status: " ",
        area: "staged",
        old_path: "old-name.ts",
      },
      {
        path: "src/lib/mod.rs",
        index_status: " ",
        worktree_status: "M",
        area: "unstaged",
        old_path: null,
      },
      {
        path: "notes.md",
        index_status: "?",
        worktree_status: "?",
        area: "untracked",
        old_path: null,
      },
    ],
    conflict_state: "none",
    branch: "main",
    upstream: { has_upstream: true, ahead: 2, behind: 1, remote_branch: "origin/main" },
    did_hit_limit: false,
    status_length: 5,
  };
}

async function seedStore(status: SourceControlStatus | null = makeStatus()) {
  useTerminalStore.setState({
    rightSidebarOpen: true,
    tabs: [{ id: "tab-1", layout: { type: "leaf", id: "s1" }, focusedPath: [] }],
    activeTabId: "tab-1",
    sessions: {
      s1: { id: "s1", title: "s1", status: "running", cwd: "/mock/repo", cols: 80, rows: 24 },
    },
    layout: { type: "leaf", id: "s1" },
    focusedPath: [],
    gitStatus: status,
    gitBranches: { branches: ["main", "feature"], current: "main" },
    gitHistory: null,
    viewOnlyDiff: null,
    pendingAiDiff: null,
  });
  scStatusMock.mockResolvedValue(
    status ?? {
      entries: [],
      conflict_state: "none",
      branch: "",
      upstream: { has_upstream: false, ahead: 0, behind: 0, remote_branch: null },
      did_hit_limit: false,
      status_length: 0,
    },
  );
}

describe("GitSourceControl", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.confirm = vi.fn().mockReturnValue(true);
  });

  it("groups entries into conflict-first sections with count badges and shows branch + upstream", async () => {
    await seedStore();
    render(<GitSourceControl />);

    expect(await screen.findByText("main")).toBeInTheDocument();
    const counts = Array.from(document.querySelectorAll(".git-count-badge")).map(
      (el) => el.textContent,
    );
    expect(counts).toEqual(["1", "2", "1", "1"]);

    const headers = Array.from(document.querySelectorAll(".git-section-label")).map(
      (el) => el.textContent,
    );
    expect(headers).toEqual(["Conflicts", "Staged", "Unstaged", "Untracked"]);

    expect(screen.getByText("↑2 ↓1")).toBeInTheDocument();
  });

  it("shows rename rows as old → new with dimmed dirname on paths", async () => {
    await seedStore();
    render(<GitSourceControl />);

    expect(screen.getByText("old-name.ts")).toBeInTheDocument();
    expect(screen.getByText("→")).toBeInTheDocument();

    const row = screen.getByText("mod.rs").closest(".git-file-item")!;
    expect(row.querySelector(".git-file-dirname")?.textContent).toBe("src/lib/");
    expect(row.querySelector(".git-file-basename")?.textContent).toBe("mod.rs");
  });

  it("stages unstaged files via the row hover action", async () => {
    await seedStore();
    render(<GitSourceControl />);

    const row = screen.getByText("mod.rs").closest(".git-file-item")!;
    fireEvent.click(within(row as HTMLElement).getByTitle("Stage"));

    await waitFor(() =>
      expect(scStageMock).toHaveBeenCalledWith("/mock/repo", ["src/lib/mod.rs"]),
    );
  });

  it("unstages staged files via the row hover action", async () => {
    await seedStore();
    render(<GitSourceControl />);

    const row = screen.getByText("staged.ts").closest(".git-file-item")!;
    fireEvent.click(within(row as HTMLElement).getByTitle("Unstage"));

    await waitFor(() =>
      expect(scUnstageMock).toHaveBeenCalledWith("/mock/repo", ["src/staged.ts"]),
    );
  });

  it("discards tracked files immediately from the staged section", async () => {
    await seedStore();
    render(<GitSourceControl />);

    const row = screen.getByText("staged.ts").closest(".git-file-item")!;
    fireEvent.click(within(row as HTMLElement).getByTitle("Discard"));

    await waitFor(() =>
      expect(scDiscardMock).toHaveBeenCalledWith("/mock/repo", ["src/staged.ts"], false),
    );
  });

  it("requires double-click confirmation on the untracked bulk discard", async () => {
    const status = makeStatus();
    status.entries = status.entries.filter((e) => e.area === "untracked");
    status.status_length = status.entries.length;
    await seedStore(status);
    render(<GitSourceControl />);

    const untrackedSection = document.querySelector(".git-section-untracked") as HTMLElement;
    const btn = within(untrackedSection).getByRole("button", { name: /Discard all/ });
    fireEvent.click(btn);
    expect(scDiscardMock).not.toHaveBeenCalled();
    expect(btn.getAttribute("title")).toMatch(/click again to confirm/i);

    fireEvent.click(btn);
    await waitFor(() =>
      expect(scDiscardMock).toHaveBeenCalledWith("/mock/repo", ["notes.md"], true),
    );
  });

  it("offers no staging action for conflicts but explains why", async () => {
    await seedStore();
    render(<GitSourceControl />);

    const row = screen.getByText("conflicted.txt").closest(".git-file-item")!;
    expect(within(row as HTMLElement).queryByTitle("Stage")).toBeNull();
    expect(row.getAttribute("title")).toMatch(/resolve/i);
  });

  it("bulk stage all / unstage all / discard all pass every path in the section", async () => {
    await seedStore();
    render(<GitSourceControl />);

    const unstagedSection = document.querySelector(".git-section-unstaged")!;
    fireEvent.click(
      within(unstagedSection as HTMLElement).getByRole("button", { name: /Stage all/ }),
    );
    await waitFor(() =>
      expect(scStageMock).toHaveBeenCalledWith("/mock/repo", ["src/lib/mod.rs"]),
    );

    const stagedSection = document.querySelector(".git-section-staged")!;
    fireEvent.click(
      within(stagedSection as HTMLElement).getByRole("button", { name: /Unstage all/ }),
    );
    await waitFor(() =>
      expect(scUnstageMock).toHaveBeenCalledWith("/mock/repo", [
        "src/staged.ts",
        "renamed.ts",
      ]),
    );

    // Untracked bulk discard follows the same double-click confirm rule
    const untrackedSection = document.querySelector(
      ".git-section-untracked",
    ) as HTMLElement;
    const discardAllBtn = within(untrackedSection).getByRole("button", {
      name: /Discard all/,
    });
    fireEvent.click(discardAllBtn);
    expect(scDiscardMock).not.toHaveBeenCalled();
    fireEvent.click(discardAllBtn);
    await waitFor(() =>
      expect(scDiscardMock).toHaveBeenCalledWith("/mock/repo", ["notes.md"], true),
    );
  });

  it("commit button stays disabled until a message is typed and staged files exist", async () => {
    await seedStore();
    render(<GitSourceControl />);

    const commitBtn = screen.getByRole("button", { name: "Commit" });
    expect(commitBtn).toBeDisabled();

    fireEvent.change(screen.getByPlaceholderText("Commit message…"), {
      target: { value: "feat: add thing" },
    });
    expect(commitBtn).toBeEnabled();

    fireEvent.click(commitBtn);
    await waitFor(() =>
      expect(scCommitMock).toHaveBeenCalledWith("/mock/repo", "feat: add thing"),
    );
    expect((screen.getByPlaceholderText("Commit message…") as HTMLTextAreaElement).value).toBe("");
  });

  it("hides the commit box when nothing is staged", async () => {
    const status = makeStatus();
    status.entries = status.entries.filter((e) => e.area !== "staged");
    status.status_length = status.entries.length;
    await seedStore(status);
    render(<GitSourceControl />);

    expect(screen.queryByPlaceholderText("Commit message…")).toBeNull();
  });

  it("AI message button fills the textarea with the agent reply", async () => {
    generateCommitMessageMock.mockResolvedValue({ message: "feat: generated subject" });
    await seedStore();
    render(<GitSourceControl />);

    const aiBtn = screen.getByRole("button", { name: /AI message/ });
    expect(aiBtn).toBeEnabled();

    fireEvent.click(aiBtn);
    expect(aiBtn).toBeDisabled();
    await waitFor(() =>
      expect(generateCommitMessageMock).toHaveBeenCalledWith("/mock/repo"),
    );
    await waitFor(() =>
      expect(
        (screen.getByPlaceholderText("Commit message…") as HTMLTextAreaElement).value,
      ).toBe("feat: generated subject"),
    );
  });

  it("AI message failure shows inline error and fills heuristic fallback", async () => {
    generateCommitMessageMock.mockRejectedValue(new Error("agent timed out"));
    await seedStore();
    render(<GitSourceControl />);

    fireEvent.click(screen.getByRole("button", { name: /AI message/ }));

    expect(await screen.findByText(/agent timed out/)).toBeInTheDocument();
    expect(
      (screen.getByPlaceholderText("Commit message…") as HTMLTextAreaElement).value,
    ).toMatch(/\(fallback\)$/);
  });

  it("AI message button is disabled while a commit sync is running", async () => {
    await seedStore();
    let releasePull: (v: PullOutcome) => void = () => {};
    scPullMock.mockReturnValue(
      new Promise<PullOutcome>((resolve) => {
        releasePull = resolve;
      }),
    );
    render(<GitSourceControl />);

    fireEvent.click(screen.getByRole("button", { name: "Pull" }));
    const aiBtn = screen.getByRole("button", { name: /AI message/ });
    expect(aiBtn).toBeDisabled();

    releasePull({ status: "up-to-date", new_head: null });
    await waitFor(() => expect(aiBtn).toBeEnabled());
  });

  it("shows the conflict banner when pull fails with a conflict error", async () => {
    await seedStore();
    scPullMock.mockRejectedValue(new Error("conflict: merge interrupted by local changes"));
    render(<GitSourceControl />);

    fireEvent.click(screen.getByRole("button", { name: "Pull" }));

    expect(await screen.findByText(/merge conflicts — resolve in editor then commit/i)).toBeInTheDocument();
  });

  it("surfaces push outcome inline after pushing", async () => {
    await seedStore();
    scPushMock.mockResolvedValue({ pushed_to: "origin/main", was_publish: false });
    render(<GitSourceControl />);

    fireEvent.click(screen.getByRole("button", { name: "Push" }));

    expect(await screen.findByText(/pushed to origin\/main/i)).toBeInTheDocument();
  });

  it("labels the push button Publish when there is no upstream and confirms once", async () => {
    const status = makeStatus();
    status.upstream = { has_upstream: false, ahead: 0, behind: 0, remote_branch: null };
    await seedStore(status);
    render(<GitSourceControl />);

    expect(screen.queryByRole("button", { name: "Push" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));

    expect(window.confirm).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(scPushMock).toHaveBeenCalledWith("/mock/repo", true, false),
    );
  });

  it("confirms before checking out another branch", async () => {
    await seedStore();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<GitSourceControl />);

    const select = screen.getByLabelText("Switch branch") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "feature" } });

    expect(confirmSpy).toHaveBeenCalled();
    expect(scCheckoutMock).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    fireEvent.change(select, { target: { value: "feature" } });
    await waitFor(() => expect(scCheckoutMock).toHaveBeenCalledWith("/mock/repo", "feature"));
  });

  it("opens diffs with area-specific flags when a file row is clicked", async () => {
    await seedStore();
    render(<GitSourceControl />);

    const unstagedRow = screen.getByText("mod.rs").closest(".git-file-item")!;
    fireEvent.click(unstagedRow);
    await waitFor(() =>
      expect(scFileDiffMock).toHaveBeenLastCalledWith("/mock/repo", "src/lib/mod.rs", false, false),
    );

    const stagedRow = screen.getByText("staged.ts").closest(".git-file-item")!;
    fireEvent.click(stagedRow);
    await waitFor(() =>
      expect(scFileDiffMock).toHaveBeenLastCalledWith("/mock/repo", "src/staged.ts", true, false),
    );

    const untrackedRow = screen.getByText("notes.md").closest(".git-file-item")!;
    fireEvent.click(untrackedRow);
    await waitFor(() =>
      expect(scFileDiffMock).toHaveBeenLastCalledWith("/mock/repo", "notes.md", false, true),
    );

    await waitFor(() => {
      const diff = useTerminalStore.getState().viewOnlyDiff;
      expect(diff?.path).toBe("notes.md");
      expect(diff?.original).toBe("old");
      expect(diff?.modified).toBe("new");
    });
  });

  it("expanding history loads 30 commits and renders short-sha subject stats rows", async () => {
    await seedStore();
    vi.mocked(ptyTransport.scHistory).mockResolvedValue({
      items: [
        {
          id: "0123456789abcdef",
          parent_ids: [],
          subject: "feat: add thing",
          message_body: "",
          author_name: "dev",
          author_email: "dev@oppa",
          timestamp_secs: 1,
          stats: { files: 3, insertions: 10, deletions: 2 },
        },
      ],
      has_more: false,
    });
    render(<GitSourceControl />);

    fireEvent.click(screen.getByRole("button", { name: /History/ }));
    await waitFor(() => expect(vi.mocked(ptyTransport.scHistory)).toHaveBeenCalledWith("/mock/repo", 30));

    expect(screen.getByText("0123456789".slice(0, 7))).toBeInTheDocument();
    expect(screen.getByText("feat: add thing")).toBeInTheDocument();
    expect(screen.getByText("+10 −2 files:3")).toBeInTheDocument();
  });
});
