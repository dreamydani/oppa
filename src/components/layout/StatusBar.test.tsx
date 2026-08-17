import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useTerminalStore } from "../../store/terminalStore";
import { StatusBar } from "./StatusBar";
import * as gitTransport from "../../lib/git/transport";

vi.mock("../../lib/git/transport", () => ({
  getGitStatus: vi.fn(),
}));

const mockGetGitStatus = vi.mocked(gitTransport.getGitStatus);

describe("StatusBar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTerminalStore.setState({
      sessions: {
        s1: {
          id: "s1",
          title: "s1",
          status: "running",
          cwd: "/home/user/project",
          cols: 120,
          rows: 30,
        },
      },
      tabs: [
        {
          id: "tab-1",
          layout: { type: "leaf", id: "s1" },
          focusedPath: [],
        },
      ],
      activeTabId: "tab-1",
      layout: { type: "leaf", id: "s1" },
      focusedPath: [],
    });
  });

  it("renders status bar container", () => {
    mockGetGitStatus.mockResolvedValue({
      is_git: false,
      branch: "",
      files: [],
      ahead: 0,
      behind: 0,
    });

    const { container } = render(<StatusBar />);
    const statusBar = container.querySelector(".status-bar");
    expect(statusBar).toBeTruthy();
  });

  it("renders git branch and ahead/behind counts when in git repository", async () => {
    mockGetGitStatus.mockResolvedValue({
      is_git: true,
      branch: "feature/ui-refresh",
      files: [{ path: "file.ts", status: "M" }],
      ahead: 2,
      behind: 1,
    });

    render(<StatusBar />);

    await waitFor(() => {
      expect(screen.getByText("feature/ui-refresh")).toBeTruthy();
    });

    expect(screen.getByText(/↑2/)).toBeTruthy();
    expect(screen.getByText(/↓1/)).toBeTruthy();
  });

  it("renders fallback git indicator when not in a git repo", async () => {
    mockGetGitStatus.mockResolvedValue({
      is_git: false,
      branch: "",
      files: [],
      ahead: 0,
      behind: 0,
    });

    render(<StatusBar />);

    await waitFor(() => {
      expect(screen.getByText(/no git|not a git/i)).toBeTruthy();
    });
  });

  it("renders active working directory badge", () => {
    mockGetGitStatus.mockResolvedValue({
      is_git: false,
      branch: "",
      files: [],
      ahead: 0,
      behind: 0,
    });

    render(<StatusBar />);
    expect(screen.getByText(/project/)).toBeTruthy();
  });

  it("renders terminal dimensions and status indicator", () => {
    mockGetGitStatus.mockResolvedValue({
      is_git: false,
      branch: "",
      files: [],
      ahead: 0,
      behind: 0,
    });

    render(<StatusBar />);
    expect(screen.getByText("120x30")).toBeTruthy();
    expect(screen.getByText(/Ready|Running/i)).toBeTruthy();
  });
});
