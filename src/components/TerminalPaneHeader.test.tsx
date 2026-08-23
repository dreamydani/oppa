import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { useTerminalStore } from "../store/terminalStore";
import { TerminalPaneHeader } from "./TerminalPaneHeader";

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
  onTitleChanged: vi.fn().mockResolvedValue(() => {}),
  onFocusRequested: vi.fn().mockResolvedValue(() => {}),
  worktreeList: vi.fn().mockResolvedValue([]),
  worktreePs: vi.fn().mockResolvedValue([]),
  worktreeCreate: vi.fn(),
  worktreeSet: vi.fn().mockResolvedValue(null),
  worktreeShow: vi.fn().mockResolvedValue(null),
  worktreeCurrent: vi.fn().mockResolvedValue(null),
  worktreeRemove: vi.fn().mockResolvedValue(undefined),
  worktreePurge: vi.fn().mockResolvedValue(undefined),
  worktreeLineage: vi.fn().mockResolvedValue([]),
  repoAdd: vi.fn().mockResolvedValue([]),
  repoList: vi.fn().mockResolvedValue([]),
  onPtyData: vi.fn(),
  onPtyExit: vi.fn(),
}));

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
});

