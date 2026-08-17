import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { AppShell } from "./AppShell";
import { useTerminalStore } from "../../store/terminalStore";

vi.mock("../../lib/pty/transport", () => ({
  ptySpawn: vi.fn().mockResolvedValue("s1"),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  ptyResize: vi.fn().mockResolvedValue(undefined),
  ptyAck: vi.fn().mockResolvedValue(undefined),
  ptyWrite: vi.fn(),
  onPtyData: vi.fn().mockResolvedValue(vi.fn()),
  onPtyExit: vi.fn().mockResolvedValue(vi.fn()),
  saveLayout: vi.fn().mockResolvedValue(undefined),
  loadLayout: vi.fn().mockResolvedValue(null),
  saveScrollback: vi.fn().mockResolvedValue(undefined),
  loadScrollback: vi.fn().mockResolvedValue(null),
  deleteScrollback: vi.fn().mockResolvedValue(undefined),
  cleanupStaleScrollbacks: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/fs/transport", () => ({
  readDir: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../lib/git/transport", () => ({
  getGitStatus: vi.fn().mockResolvedValue({
    is_git: false,
    branch: "",
    files: [],
    ahead: 0,
    behind: 0,
  }),
}));

vi.mock("../TerminalPane", () => ({
  TerminalPane: ({ id }: { id: string }) => (
    <div className="terminal-pane" data-session-id={id} />
  ),
}));

describe("AppShell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTerminalStore.setState({
      sessions: {
        s1: { id: "s1", title: "s1", status: "running", cols: 80, rows: 24 },
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
      ready: true,
      leftSidebarOpen: true,
      leftSidebarWidth: 240,
      rightSidebarOpen: true,
      rightSidebarWidth: 280,
      isSetupWizardOpen: false,
    });
  });

  it("renders Titlebar, LeftSidebar, main area with TabBar, Toolbar, PaneSplit, RightSidebar, and StatusBar when active tab is terminal", () => {
    const { container } = render(<AppShell />);

    expect(container.querySelector(".app-shell")).toBeTruthy();
    expect(container.querySelector(".titlebar")).toBeTruthy();
    expect(container.querySelector(".left-sidebar")).toBeTruthy();
    expect(container.querySelector(".app-main")).toBeTruthy();
    expect(container.querySelector(".tab-bar")).toBeTruthy();
    expect(container.querySelector(".toolbar")).toBeTruthy();
    expect(container.querySelector(".terminal-workbench")).toBeTruthy();
    expect(container.querySelector(".right-sidebar")).toBeTruthy();
    expect(container.querySelector(".status-bar")).toBeTruthy();
  });

  it("renders WorkspaceSetupWizard inline in .terminal-workbench and hides Toolbar when active tab is a wizard tab", () => {
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
    });
    const { container, getByRole } = render(<AppShell />);

    expect(container.querySelector(".toolbar")).toBeNull();
    expect(getByRole("region", { name: /workspace setup wizard/i })).toBeTruthy();
    expect(container.querySelector(".left-sidebar")).toBeTruthy();
    expect(container.querySelector(".right-sidebar")).toBeTruthy();
  });
});
