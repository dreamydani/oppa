import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen, act } from "@testing-library/react";
import { useTerminalStore } from "../store/terminalStore";
import * as transport from "../lib/pty/transport";
import { TerminalPaneHeader, resolveRepoForCwd } from "./TerminalPaneHeader";

vi.mock("../lib/pty/transport", () => ({
  ptySpawn: vi.fn().mockResolvedValue("s2"),
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
onGitChanged: vi.fn().mockResolvedValue(() => {}),
  onPrChanged: vi.fn().mockResolvedValue(() => {}),
  requestReviewEligibility: vi.fn().mockResolvedValue({ eligible: true, blocked_reason: null, base_ref: 'main', owner_repo: 'owner/repo', existing_pr_url: null }),
  requestCreateReview: vi.fn().mockResolvedValue({ pr_url: 'https://example.com/pr/1', pr_number: 1, base_ref: 'main', owner_repo: 'owner/repo' }),
  requestReviewStatus: vi.fn().mockResolvedValue({ number: 1, title: 't', url: 'https://example.com/pr/1', state: 'open', draft: false, mergeable: 'unknown', base_ref_name: 'main', head_ref_name: 'feat', checks: [], fetched_at_ms: 0 }),
  onTitleChanged: vi.fn().mockResolvedValue(() => {}),
  onFocusRequested: vi.fn().mockResolvedValue(() => {}),
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
  onSessionWorking: vi.fn().mockResolvedValue(() => {}),
  onPtyData: vi.fn(),
  onPtyExit: vi.fn(),
}));

// Module-init subscriptions register during import; capture before clearAllMocks runs.
const sessionWorkingHandler = vi.mocked(transport.onSessionWorking).mock.calls[0]?.[0];

function worktreeRecord(overrides: Partial<transport.WorktreeRecord> = {}): transport.WorktreeRecord {
  return {
    id: "wt-1",
    repo_id: "demo",
    name: "fix-login-flow",
    display_name: null,
    branch: "fix-login-flow",
    path: "C:/ws/fix-login-flow",
    base_ref: "main",
    parent_worktree_id: null,
    child_worktree_ids: [],
    workspace_status: "in-progress",
    retired: false,
    created_at_ms: 1723900000000,
    linked_pr_url: null,
    ...overrides,
  };
}

describe("TerminalPaneHeader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTerminalStore.setState({
      sessions: {
        s1: {
          id: "s1",
          title: "Terminal 1",
          status: "running",
          cols: 80,
          rows: 24,
          cwd: "/home/user/project",
        },
      },
      tabs: [],
      activeTabId: "",
      layout: { type: "leaf", id: "s1" },
      focusedPath: [],
      maximizedSessionId: null,
    });
  });

  it("renders session title and all action buttons", () => {
    render(<TerminalPaneHeader id="s1" path={[]} />);

    expect(screen.getByText("Terminal 1")).toBeTruthy();
    expect(screen.getByTitle("More Options")).toBeTruthy();
    expect(screen.getByTitle("Open in Browser")).toBeTruthy();
    expect(screen.getByTitle("Maximize Pane")).toBeTruthy();
    expect(screen.getByTitle("Split Right")).toBeTruthy();
    expect(screen.getByTitle("Split Down")).toBeTruthy();
    expect(screen.getByTitle("Close Pane")).toBeTruthy();
  });

  it("allows inline renaming via click and Enter key", () => {
    render(<TerminalPaneHeader id="s1" path={[]} />);

    const titleEl = screen.getByText("Terminal 1");
    fireEvent.click(titleEl);

    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("Terminal 1");

    fireEvent.change(input, { target: { value: "Build Output" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(useTerminalStore.getState().sessions["s1"].title).toBe("Build Output");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("Build Output")).toBeTruthy();
  });

  it("saves inline renaming on blur", () => {
    render(<TerminalPaneHeader id="s1" path={[]} />);

    const titleEl = screen.getByText("Terminal 1");
    fireEvent.click(titleEl);

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Server Logs" } });
    fireEvent.blur(input);

    expect(useTerminalStore.getState().sessions["s1"].title).toBe("Server Logs");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("Server Logs")).toBeTruthy();
  });

  it("cancels inline renaming on Escape key without updating title", () => {
    render(<TerminalPaneHeader id="s1" path={[]} />);

    const titleEl = screen.getByText("Terminal 1");
    fireEvent.click(titleEl);

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Discarded Change" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(useTerminalStore.getState().sessions["s1"].title).toBe("Terminal 1");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText("Terminal 1")).toBeTruthy();
  });

  it("toggles maximize and restore pane state", () => {
    const { rerender } = render(<TerminalPaneHeader id="s1" path={[]} />);

    const maxBtn = screen.getByTitle("Maximize Pane");
    fireEvent.click(maxBtn);

    expect(useTerminalStore.getState().maximizedSessionId).toBe("s1");

    rerender(<TerminalPaneHeader id="s1" path={[]} />);
    const restoreBtn = screen.getByTitle("Restore Pane");
    expect(restoreBtn).toBeTruthy();

    fireEvent.click(restoreBtn);
    expect(useTerminalStore.getState().maximizedSessionId).toBeNull();
  });

  it("splits pane horizontally when Split Right is clicked", async () => {
    render(<TerminalPaneHeader id="s1" path={[]} />);

    const splitRightBtn = screen.getByTitle("Split Right");
    fireEvent.click(splitRightBtn);

    await vi.waitFor(() => {
      const layout = useTerminalStore.getState().layout;
      expect(layout.type).toBe("split");
      if (layout.type === "split") {
        expect(layout.dir).toBe("h");
      }
    });
  });

  it("splits pane vertically when Split Down is clicked", async () => {
    render(<TerminalPaneHeader id="s1" path={[]} />);

    const splitDownBtn = screen.getByTitle("Split Down");
    fireEvent.click(splitDownBtn);

    await vi.waitFor(() => {
      const layout = useTerminalStore.getState().layout;
      expect(layout.type).toBe("split");
      if (layout.type === "split") {
        expect(layout.dir).toBe("v");
      }
    });
  });

  it("closes pane when Close button is clicked", async () => {
    useTerminalStore.setState({
      sessions: {
        s1: { id: "s1", title: "s1", status: "running", cols: 80, rows: 24 },
        s2: { id: "s2", title: "s2", status: "running", cols: 80, rows: 24 },
      },
      layout: {
        type: "split",
        dir: "h",
        ratio: 0.5,
        a: { type: "leaf", id: "s1" },
        b: { type: "leaf", id: "s2" },
      },
      focusedPath: [0],
    });

    render(<TerminalPaneHeader id="s1" path={[0]} />);

    const closeBtn = screen.getByTitle("Close Pane");
    fireEvent.click(closeBtn);

    await vi.waitFor(() => {
      const state = useTerminalStore.getState();
      expect(state.sessions["s1"]).toBeUndefined();
    });
  });

  it("opens More menu and calls onClear on Clear Scrollback click", () => {
    const onClear = vi.fn();
    render(<TerminalPaneHeader id="s1" path={[]} onClear={onClear} />);

    const moreBtn = screen.getByTitle("More Options");
    fireEvent.click(moreBtn);

    expect(screen.getByText("Clear Scrollback")).toBeTruthy();
    expect(screen.getByText("Rename Pane")).toBeTruthy();
    expect(screen.getByText("Split Right")).toBeTruthy();
    expect(screen.getByText("Split Down")).toBeTruthy();

    fireEvent.click(screen.getByText("Clear Scrollback"));
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Clear Scrollback")).toBeNull();
  });

  it("opens rename input from More menu", () => {
    render(<TerminalPaneHeader id="s1" path={[]} />);

    fireEvent.click(screen.getByTitle("More Options"));
    fireEvent.click(screen.getByText("Rename Pane"));

    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("closes More menu on outside click", () => {
    render(
      <div>
        <div data-testid="outside">Outside</div>
        <TerminalPaneHeader id="s1" path={[]} />
      </div>
    );

    fireEvent.click(screen.getByTitle("More Options"));
    expect(screen.getByText("Clear Scrollback")).toBeTruthy();

    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.queryByText("Clear Scrollback")).toBeNull();
  });

  it("switches to browser mode when Open in Browser button is clicked without detected ports", () => {
    useTerminalStore.setState({ activeAppMode: "terminal", detectedPorts: [] });
    render(<TerminalPaneHeader id="s1" path={[]} />);

    const openBrowserBtn = screen.getByTitle("Open in Browser");
    fireEvent.click(openBrowserBtn);

    expect(useTerminalStore.getState().activeAppMode).toBe("browser");
  });

  it("navigates to detected port URL and switches to browser mode when Open in Browser button is clicked", () => {
    useTerminalStore.setState({
      activeAppMode: "terminal",
      detectedPorts: [
        { port: 5173, url: "http://localhost:5173", title: "Localhost :5173", timestamp: Date.now() },
      ],
    });
    render(<TerminalPaneHeader id="s1" path={[]} />);

    const openBrowserBtn = screen.getByTitle("Open in Browser");
    fireEvent.click(openBrowserBtn);

    expect(useTerminalStore.getState().activeAppMode).toBe("browser");
    expect(useTerminalStore.getState().browserUrl).toBe("http://localhost:5173");
  });

  it("switches to browser mode when Open in Browser is clicked from More menu", () => {
    useTerminalStore.setState({ activeAppMode: "terminal" });
    render(<TerminalPaneHeader id="s1" path={[]} />);

    const moreBtn = screen.getByTitle("More Options");
    fireEvent.click(moreBtn);

    const menuOpenBrowser = screen.getByText("Open in Browser");
    expect(menuOpenBrowser).toBeTruthy();
    fireEvent.click(menuOpenBrowser);

    expect(useTerminalStore.getState().activeAppMode).toBe("browser");
    expect(screen.queryByText("Clear Scrollback")).toBeNull();
  });

  it("renders draggable header region with title constraint class", () => {
    const { container } = render(<TerminalPaneHeader id="s1" path={[]} />);

    const dragZone = container.querySelector(".pane-header-drag-zone");
    expect(dragZone).not.toBeNull();

    const titleEl = container.querySelector(".terminal-pane-title");
    expect(titleEl).not.toBeNull();
    expect(titleEl?.textContent).toBe("Terminal 1");
  });

  it("clicking drag region with movement < 5px focuses pane without initiating drag", () => {
    useTerminalStore.setState({
      focusedPath: [1],
    });

    const { container } = render(<TerminalPaneHeader id="s1" path={[0]} />);
    const dragZone = container.querySelector(".pane-header-drag-zone")!;
    expect(dragZone).not.toBeNull();

    // Movement of 3px (below 5px threshold)
    fireEvent.pointerDown(dragZone, { pointerId: 1, clientX: 10, clientY: 10, button: 0 });
    fireEvent.pointerMove(window, { pointerId: 1, clientX: 13, clientY: 10 });
    fireEvent.pointerUp(window, { pointerId: 1, clientX: 13, clientY: 10 });

    expect(useTerminalStore.getState().focusedPath).toEqual([0]);
  });

  it("dragging drag region >= 5px captures pointer and activates drag state", () => {
    const { container } = render(<TerminalPaneHeader id="s1" path={[0]} />);
    const dragZone = container.querySelector(".pane-header-drag-zone")!;

    const captureSpy = vi.spyOn(dragZone, "setPointerCapture");
    const releaseSpy = vi.spyOn(dragZone, "releasePointerCapture");

    // Movement of 10px (exceeds 5px threshold)
    fireEvent.pointerDown(dragZone, { pointerId: 1, clientX: 10, clientY: 10, button: 0 });
    expect(captureSpy).toHaveBeenCalledWith(1);

    fireEvent.pointerMove(window, { pointerId: 1, clientX: 20, clientY: 20 });
    expect(dragZone.className).toContain("dragging");

    fireEvent.pointerUp(window, { pointerId: 1, clientX: 20, clientY: 20 });
    expect(releaseSpy).toHaveBeenCalledWith(1);
    expect(dragZone.className).not.toContain("dragging");
  });

  it("action buttons and rename elements stop pointerdown propagation", () => {
    const { container } = render(<TerminalPaneHeader id="s1" path={[]} />);

    const buttons = container.querySelectorAll(".terminal-pane-header-btn");
    expect(buttons.length).toBeGreaterThan(0);

    for (const btn of buttons) {
      const event = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
      const stopSpy = vi.spyOn(event, "stopPropagation");
      btn.dispatchEvent(event);
      expect(stopSpy).toHaveBeenCalled();
    }

    const titleEl = container.querySelector(".terminal-pane-title")!;
    const titleEvent = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });
    const titleStopSpy = vi.spyOn(titleEvent, "stopPropagation");
    titleEl.dispatchEvent(titleEvent);
    expect(titleStopSpy).toHaveBeenCalled();
  });

  describe("Session Restored Banner", () => {
    it("renders Session restored badge when session isRestored is true", () => {
      useTerminalStore.setState({
        sessions: {
          s1: {
            id: "s1",
            title: "Terminal 1",
            status: "running",
            cols: 80,
            rows: 24,
            isRestored: true,
          },
        },
      });

      render(<TerminalPaneHeader id="s1" path={[]} />);

      const badge = screen.getByRole("status", { name: /session restored/i });
      expect(badge).toBeTruthy();
      expect(badge.className).toContain("terminal-restored-badge");
      expect(badge.textContent).toContain("Session restored");
    });

    it("does not render Session restored badge when isRestored is false or undefined", () => {
      useTerminalStore.setState({
        sessions: {
          s1: {
            id: "s1",
            title: "Terminal 1",
            status: "running",
            cols: 80,
            rows: 24,
            isRestored: false,
          },
        },
      });

      render(<TerminalPaneHeader id="s1" path={[]} />);
      expect(screen.queryByRole("status", { name: /session restored/i })).toBeNull();
    });

    it("shows Agent resumed text and green variant for agent-resume kind", () => {
      useTerminalStore.setState({
        sessions: {
          s1: {
            id: "s1",
            title: "Terminal 1",
            status: "running",
            cols: 80,
            rows: 24,
            isRestored: true,
            resumeKind: "agent-resume",
          },
        },
      });

      render(<TerminalPaneHeader id="s1" path={[]} />);

      const badge = screen.getByRole("status", { name: /session restored/i });
      expect(badge.className).toContain("terminal-restored-badge--resumed");
      expect(badge.textContent).toContain("Agent resumed");
    });

    it("shows Command relaunched text for command-relaunch kind", () => {
      useTerminalStore.setState({
        sessions: {
          s1: {
            id: "s1",
            title: "Terminal 1",
            status: "running",
            cols: 80,
            rows: 24,
            isRestored: true,
            resumeKind: "command-relaunch",
          },
        },
      });

      render(<TerminalPaneHeader id="s1" path={[]} />);

      const badge = screen.getByRole("status", { name: /session restored/i });
      expect(badge.className).not.toContain("terminal-restored-badge--resumed");
      expect(badge.textContent).toContain("Command relaunched");
    });

    it("clicking dismiss button calls dismissSessionRestoredBanner", () => {
      useTerminalStore.setState({
        sessions: {
          s1: {
            id: "s1",
            title: "Terminal 1",
            status: "running",
            cols: 80,
            rows: 24,
            isRestored: true,
          },
        },
      });

      render(<TerminalPaneHeader id="s1" path={[]} />);

      const dismissBtn = screen.getByRole("button", { name: /dismiss restored banner/i });
      fireEvent.click(dismissBtn);

      expect(useTerminalStore.getState().sessions["s1"].isRestored).toBe(false);
      expect(screen.queryByRole("status", { name: /session restored/i })).toBeNull();
    });

    it("clicking restored badge pill calls dismissSessionRestoredBanner", () => {
      useTerminalStore.setState({
        sessions: {
          s1: {
            id: "s1",
            title: "Terminal 1",
            status: "running",
            cols: 80,
            rows: 24,
            isRestored: true,
          },
        },
      });

      render(<TerminalPaneHeader id="s1" path={[]} />);

      const badge = screen.getByRole("status", { name: /session restored/i });
      fireEvent.click(badge);

      expect(useTerminalStore.getState().sessions["s1"].isRestored).toBe(false);
      expect(screen.queryByRole("status", { name: /session restored/i })).toBeNull();
    });
  });

  describe("Terminal Switcher Dropdown", () => {
    beforeEach(() => {
      useTerminalStore.setState({
        sessions: {
          s1: {
            id: "s1",
            title: "fix login flow",
            status: "running",
            cols: 80,
            rows: 24,
            cwd: "C:/ws/main",
            worktreeId: "wt-1",
          },
          s2: {
            id: "s2",
            title: "api server",
            status: "running",
            cols: 80,
            rows: 24,
            cwd: "C:/ws/main",
          },
        },
        tabs: [
          { id: "tab-1", layout: { type: "leaf", id: "s1" }, focusedPath: [] },
          { id: "tab-2", layout: { type: "leaf", id: "s2" }, focusedPath: [] },
        ],
        activeTabId: "tab-1",
        worktrees: [{ record: worktreeRecord(), missing_on_disk: false }],
        workingBySessionId: {},
      });
    });

    it("lists every tab's session title with a branch chip only on the worktree-bound row", () => {
      const { container } = render(<TerminalPaneHeader id="s1" path={[]} />);
      fireEvent.click(screen.getByTitle("Switch Terminal"));

      const panel = container.querySelector(".terminal-pane-header-switcher-panel")!;
      expect(panel.textContent).toContain("fix login flow");
      expect(panel.textContent).toContain("api server");

      const chips = panel.querySelectorAll(".terminal-pane-header-switcher-branch");
      expect(chips.length).toBe(1);
      expect(chips[0].textContent).toBe("fix-login-flow");
    });

    it("renders the working/idle dot from workingBySessionId and updates live from events", () => {
      useTerminalStore.setState({ workingBySessionId: { s1: true } });
      const { container } = render(<TerminalPaneHeader id="s1" path={[]} />);
      fireEvent.click(screen.getByTitle("Switch Terminal"));

      let dots = container.querySelectorAll(".terminal-pane-header-working-dot");
      expect(dots.length).toBe(2);
      expect(dots[0].classList.contains("working")).toBe(true);
      expect(dots[1].classList.contains("working")).toBe(false);

      act(() => sessionWorkingHandler?.({ sessionId: "s2", working: true }));
      dots = container.querySelectorAll(".terminal-pane-header-working-dot");
      expect(dots[0].classList.contains("working")).toBe(true);
      expect(dots[1].classList.contains("working")).toBe(true);

      act(() => sessionWorkingHandler?.({ sessionId: "s1", working: false }));
      dots = container.querySelectorAll(".terminal-pane-header-working-dot");
      expect(dots[0].classList.contains("working")).toBe(false);
      expect(dots[1].classList.contains("working")).toBe(true);
    });

    it("highlights the active tab row", () => {
      const { container } = render(<TerminalPaneHeader id="s1" path={[]} />);
      fireEvent.click(screen.getByTitle("Switch Terminal"));

      const rows = container.querySelectorAll(".terminal-pane-header-switcher-row");
      expect(rows.length).toBe(2);
      expect(rows[0].className).toContain("active");
      expect(rows[1].className).not.toContain("active");
    });

    it("selects the clicked tab and closes the dropdown", () => {
      const { container } = render(<TerminalPaneHeader id="s1" path={[]} />);
      fireEvent.click(screen.getByTitle("Switch Terminal"));
      expect(container.querySelector(".terminal-pane-header-switcher-panel")).not.toBeNull();

      fireEvent.click(screen.getByText("api server").closest("button")!);

      expect(useTerminalStore.getState().activeTabId).toBe("tab-2");
      expect(container.querySelector(".terminal-pane-header-switcher-panel")).toBeNull();
    });

    it("closes the dropdown on Escape", () => {
      const { container } = render(<TerminalPaneHeader id="s1" path={[]} />);
      fireEvent.click(screen.getByTitle("Switch Terminal"));
      expect(container.querySelector(".terminal-pane-header-switcher-panel")).not.toBeNull();

      fireEvent.keyDown(document, { key: "Escape" });
      expect(container.querySelector(".terminal-pane-header-switcher-panel")).toBeNull();
    });

    it("closes the dropdown on outside click", () => {
      const { container } = render(
        <div>
          <div data-testid="outside">Outside</div>
          <TerminalPaneHeader id="s1" path={[]} />
        </div>,
      );
      fireEvent.click(screen.getByTitle("Switch Terminal"));
      expect(container.querySelector(".terminal-pane-header-switcher-panel")).not.toBeNull();

      fireEvent.mouseDown(screen.getByTestId("outside"));
      expect(container.querySelector(".terminal-pane-header-switcher-panel")).toBeNull();
    });
  });

  describe("Split Chooser Popover", () => {
    beforeEach(() => {
      useTerminalStore.setState({ repos: [] });
    });

    function repoRecord(overrides: Partial<transport.RepoRecord> = {}): transport.RepoRecord {
      return {
        repo_id: "demo",
        path: "/home/user/project",
        default_base_ref: null,
        worktree_base_path: null,
        ...overrides,
      };
    }

    it("resolveRepoForCwd picks the longest repo path that prefixes the cwd", () => {
      const repos = [
        repoRecord({ repo_id: "mono", path: "D:/repos" }),
        repoRecord({ repo_id: "backend", path: "D:/repos/backend" }),
      ];

      expect(resolveRepoForCwd("D:\\repos\\backend\\sub\\app", repos)?.repo_id).toBe("backend");
      expect(resolveRepoForCwd("D:/repos/other", repos)?.repo_id).toBe("mono");
      expect(resolveRepoForCwd("D:/elsewhere", repos)).toBeNull();
      expect(resolveRepoForCwd(undefined, repos)).toBeNull();
    });

    it("opens the chooser from the split caret while main split buttons stay instant", () => {
      render(<TerminalPaneHeader id="s1" path={[]} />);

      expect(screen.queryByText("Same directory")).toBeNull();

      fireEvent.click(screen.getByTitle("Split Right Options"));
      expect(screen.getByText("Same directory")).toBeTruthy();
      expect(screen.getByText("New branch…")).toBeTruthy();

      // Main button still executes its split immediately (no popover needed).
      fireEvent.click(screen.getByTitle("Split Down"));
      void vi.waitFor(() => {
        expect(useTerminalStore.getState().layout.type).toBe("split");
      });
    });

    it("choosing Same directory invokes splitPane once with the expected args and closes", async () => {
      const splitSpy = vi
        .spyOn(useTerminalStore.getState(), "splitPane")
        .mockResolvedValue(undefined);
      const openSheetSpy = vi.spyOn(useTerminalStore.getState(), "openFleetSheet");
      render(<TerminalPaneHeader id="s1" path={[0]} />);

      fireEvent.click(screen.getByTitle("Split Down Options"));
      fireEvent.click(screen.getByText("Same directory"));

      expect(splitSpy).toHaveBeenCalledTimes(1);
      expect(splitSpy).toHaveBeenCalledWith("v", [0]);
      expect(openSheetSpy).not.toHaveBeenCalled();
      expect(screen.queryByText("Same directory")).toBeNull();
    });

    it("choosing New branch… opens the fleet sheet prefilled with the resolved repo and count=1 without splitting", async () => {
      useTerminalStore.setState({
        sessions: {
          s1: {
            id: "s1",
            title: "Terminal 1",
            status: "running",
            cols: 80,
            rows: 24,
            cwd: "D:\\repos\\backend\\sub\\app",
          },
        },
        repos: [
          repoRecord({ repo_id: "mono", path: "D:/repos" }),
          repoRecord({ repo_id: "backend", path: "D:/repos/backend", default_base_ref: "main" }),
        ],
      });
      const splitSpy = vi
        .spyOn(useTerminalStore.getState(), "splitPane")
        .mockResolvedValue(undefined);
      const openSheetSpy = vi.spyOn(useTerminalStore.getState(), "openFleetSheet");
      render(<TerminalPaneHeader id="s1" path={[]} />);

      fireEvent.click(screen.getByTitle("Split Right Options"));
      fireEvent.click(screen.getByText("New branch…"));

      expect(openSheetSpy).toHaveBeenCalledTimes(1);
      expect(openSheetSpy).toHaveBeenCalledWith({ repoPath: "D:/repos/backend", count: 1 });
      expect(splitSpy).not.toHaveBeenCalled();
      expect(screen.queryByText("New branch…")).toBeNull();
    });

    it("choosing New branch… without a resolvable repo opens the sheet unprefilled", () => {
      useTerminalStore.setState({
        sessions: {
          s1: {
            id: "s1",
            title: "Terminal 1",
            status: "running",
            cols: 80,
            rows: 24,
            cwd: "/home/nowhere",
          },
        },
        repos: [repoRecord()],
      });
      const openSheetSpy = vi.spyOn(useTerminalStore.getState(), "openFleetSheet");
      render(<TerminalPaneHeader id="s1" path={[]} />);

      fireEvent.click(screen.getByTitle("Split Right Options"));
      fireEvent.click(screen.getByText("New branch…"));

      expect(openSheetSpy).toHaveBeenCalledTimes(1);
      expect(openSheetSpy).toHaveBeenCalledWith();
    });

    it("closes the chooser on Escape without side effects", () => {
      const splitSpy = vi
        .spyOn(useTerminalStore.getState(), "splitPane")
        .mockResolvedValue(undefined);
      const openSheetSpy = vi.spyOn(useTerminalStore.getState(), "openFleetSheet");
      render(<TerminalPaneHeader id="s1" path={[]} />);

      fireEvent.click(screen.getByTitle("Split Right Options"));
      expect(screen.getByText("Same directory")).toBeTruthy();

      fireEvent.keyDown(document, { key: "Escape" });

      expect(screen.queryByText("Same directory")).toBeNull();
      expect(splitSpy).not.toHaveBeenCalled();
      expect(openSheetSpy).not.toHaveBeenCalled();
    });

    it("closes the chooser on outside click", () => {
      render(
        <div>
          <div data-testid="outside">Outside</div>
          <TerminalPaneHeader id="s1" path={[]} />
        </div>,
      );

      fireEvent.click(screen.getByTitle("Split Right Options"));
      expect(screen.getByText("Same directory")).toBeTruthy();

      fireEvent.mouseDown(screen.getByTestId("outside"));
      expect(screen.queryByText("Same directory")).toBeNull();
    });
  });
});

