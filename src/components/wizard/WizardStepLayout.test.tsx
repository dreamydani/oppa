import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WizardStepStart } from "./WizardStepStart";
import { WizardStepLayout, resolveCdPath } from "./WizardStepLayout";
import type { RecentWorkspace, WorkspacePreset } from "../../lib/workspace/transport";

describe("WizardStepStart", () => {
  it("renders heading and subtitle", () => {
    const setName = vi.fn();
    const setShell = vi.fn();
    render(<WizardStepStart name="" setName={setName} shell="" setShell={setShell} />);

    expect(screen.getByText("Start a workspace")).toBeInTheDocument();
    expect(
      screen.getByText("Configure initial workspace name and preferred shell"),
    ).toBeInTheDocument();
  });

  it("updates workspace name on input change", () => {
    const setName = vi.fn();
    const setShell = vi.fn();
    render(
      <WizardStepStart
        name="Old Project"
        setName={setName}
        shell=""
        setShell={setShell}
      />,
    );

    const input = screen.getByPlaceholderText("My Project");
    expect(input).toHaveValue("Old Project");

    fireEvent.change(input, { target: { value: "New Project" } });
    expect(setName).toHaveBeenCalledWith("New Project");
  });

  it("updates shell selection on change", () => {
    const setName = vi.fn();
    const setShell = vi.fn();
    render(
      <WizardStepStart
        name=""
        setName={setName}
        shell="powershell.exe"
        setShell={setShell}
      />,
    );

    const select = screen.getByRole("combobox");
    expect(select).toHaveValue("powershell.exe");

    fireEvent.change(select, { target: { value: "wsl.exe" } });
    expect(setShell).toHaveBeenCalledWith("wsl.exe");
  });

  it("renders shell select in sunken input wrapper with custom dropdown chevron", () => {
    const setName = vi.fn();
    const setShell = vi.fn();
    const { container } = render(
      <WizardStepStart
        name=""
        setName={setName}
        shell=""
        setShell={setShell}
      />,
    );

    const wrappers = container.querySelectorAll(".wizard-input-wrapper");
    expect(wrappers.length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector(".wizard-select-chevron")).toBeInTheDocument();
  });
});

describe("resolveCdPath helper", () => {
  it("returns absolute paths directly", () => {
    expect(resolveCdPath("D:/oppa", "C:/other/path")).toBe("C:/other/path");
    expect(resolveCdPath("/usr/local", "/var/log")).toBe("/var/log");
    expect(resolveCdPath("D:\\oppa", "E:\\data")).toBe("E:\\data");
  });

  it("joins relative subpaths with current cwd", () => {
    expect(resolveCdPath("D:/oppa/oppa", "src")).toBe("D:/oppa/oppa/src");
    expect(resolveCdPath("D:\\oppa\\oppa", "src")).toBe("D:\\oppa\\oppa\\src");
    expect(resolveCdPath("/home/user", "projects")).toBe("/home/user/projects");
  });

  it("handles parent directory navigation with ..", () => {
    expect(resolveCdPath("D:/oppa/oppa", "..")).toBe("D:/oppa");
    expect(resolveCdPath("/a/b/c", "..")).toBe("/a/b");
    expect(resolveCdPath("D:\\oppa\\oppa", "..")).toBe("D:\\oppa");
  });

  it("returns subpath directly if cwd is empty", () => {
    expect(resolveCdPath("", "my-folder")).toBe("my-folder");
  });
});

describe("WizardStepLayout", () => {
  const mockSetCwd = vi.fn();
  const mockSetTerminalCount = vi.fn();
  const mockOnSelectRecent = vi.fn();
  const mockOnSelectPreset = vi.fn();
  const mockOnOpenNewPreset = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders heading and subtitle", () => {
    render(
      <WizardStepLayout
        cwd="/path/to/project"
        setCwd={mockSetCwd}
        terminalCount={4}
        setTerminalCount={mockSetTerminalCount}
        onSelectRecent={mockOnSelectRecent}
        onSelectPreset={mockOnSelectPreset}
        onOpenNewPresetModal={mockOnOpenNewPreset}
        recentWorkspaces={[]}
        workspacePresets={[]}
      />,
    );

    expect(screen.getByText("Set up your workspace")).toBeInTheDocument();
    expect(
      screen.getByText("Pick a folder to work in and choose how many terminals you want."),
    ).toBeInTheDocument();
  });

  it("updates cwd on working folder input change", () => {
    render(
      <WizardStepLayout
        cwd="/current/folder"
        setCwd={mockSetCwd}
        terminalCount={1}
        setTerminalCount={mockSetTerminalCount}
        onSelectRecent={mockOnSelectRecent}
        onSelectPreset={mockOnSelectPreset}
        recentWorkspaces={[]}
        workspacePresets={[]}
      />,
    );

    const folderInput = screen.getByDisplayValue("/current/folder");
    fireEvent.change(folderInput, { target: { value: "/new/folder" } });
    expect(mockSetCwd).toHaveBeenCalledWith("/new/folder");
  });

  it("resolves cd command jump input on Enter key", () => {
    render(
      <WizardStepLayout
        cwd="/home/user/oppa"
        setCwd={mockSetCwd}
        terminalCount={1}
        setTerminalCount={mockSetTerminalCount}
        onSelectRecent={mockOnSelectRecent}
        onSelectPreset={mockOnSelectPreset}
        recentWorkspaces={[]}
        workspacePresets={[]}
      />,
    );

    const cdInput = screen.getByPlaceholderText(/subpath or cd \.\./i);
    fireEvent.change(cdInput, { target: { value: "src" } });
    fireEvent.keyDown(cdInput, { key: "Enter", code: "Enter" });

    expect(mockSetCwd).toHaveBeenCalledWith("/home/user/oppa/src");
  });

  it("resolves cd command jump input on arrow button click", () => {
    render(
      <WizardStepLayout
        cwd="D:\\oppa\\oppa"
        setCwd={mockSetCwd}
        terminalCount={1}
        setTerminalCount={mockSetTerminalCount}
        onSelectRecent={mockOnSelectRecent}
        onSelectPreset={mockOnSelectPreset}
        recentWorkspaces={[]}
        workspacePresets={[]}
      />,
    );

    const cdInput = screen.getByPlaceholderText(/subpath or cd \.\./i);
    fireEvent.change(cdInput, { target: { value: ".." } });

    const submitBtn = screen.getByRole("button", { name: /jump/i });
    fireEvent.click(submitBtn);

    expect(mockSetCwd).toHaveBeenCalledWith("D:\\oppa");
  });

  it("renders visual grid tiles and preview badge", () => {
    render(
      <WizardStepLayout
        cwd="/path"
        setCwd={mockSetCwd}
        terminalCount={4}
        setTerminalCount={mockSetTerminalCount}
        onSelectRecent={mockOnSelectRecent}
        onSelectPreset={mockOnSelectPreset}
        recentWorkspaces={[]}
        workspacePresets={[]}
      />,
    );

    expect(screen.getByText(/4 terminals\s+2x2 grid/i)).toBeInTheDocument();

    const tile6 = screen.getByRole("button", { name: "6 terminals layout" });
    expect(tile6).toBeInTheDocument();

    fireEvent.click(tile6);
    expect(mockSetTerminalCount).toHaveBeenCalledWith(6);
  });

  it("renders tactile mechanical keycap tiles for grid options", () => {
    render(
      <WizardStepLayout
        cwd="D:\\oppa"
        setCwd={mockSetCwd}
        terminalCount={4}
        setTerminalCount={mockSetTerminalCount}
        onSelectRecent={mockOnSelectRecent}
        onSelectPreset={mockOnSelectPreset}
        recentWorkspaces={[]}
        workspacePresets={[]}
      />,
    );

    const tile4 = screen.getByRole("button", { name: "4 terminals layout" });
    expect(tile4.className).toContain("active");
    expect(tile4.querySelector(".tile-indicator-dot")).toBeInTheDocument();

    const tile8 = screen.getByRole("button", { name: "8 terminals layout" });
    expect(tile8.className).not.toContain("active");
    fireEvent.click(tile8);
    expect(mockSetTerminalCount).toHaveBeenCalledWith(8);
  });

  it("renders sunken quick jump cd well with kbd badge and submit button", () => {
    render(
      <WizardStepLayout
        cwd="/workspace"
        setCwd={mockSetCwd}
        terminalCount={1}
        setTerminalCount={mockSetTerminalCount}
        onSelectRecent={mockOnSelectRecent}
        onSelectPreset={mockOnSelectPreset}
        recentWorkspaces={[]}
        workspacePresets={[]}
      />,
    );

    expect(screen.getByText("> cd")).toBeInTheDocument();
    expect(screen.getByText("Enter ↵")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /jump/i })).toBeInTheDocument();
  });

  it("shows empty recents message when recentWorkspaces is empty", () => {
    render(
      <WizardStepLayout
        cwd="/path"
        setCwd={mockSetCwd}
        terminalCount={1}
        setTerminalCount={mockSetTerminalCount}
        onSelectRecent={mockOnSelectRecent}
        onSelectPreset={mockOnSelectPreset}
        recentWorkspaces={[]}
        workspacePresets={[]}
      />,
    );

    expect(
      screen.getByText("No recent workspaces yet — your opened workspaces will appear here"),
    ).toBeInTheDocument();
  });

  it("renders recent workspace cards and handles selection", () => {
    const mockRecents: RecentWorkspace[] = [
      {
        name: "oppa",
        path: "D:/oppa/oppa",
        terminal_count: 4,
        last_opened: Date.now(),
      },
      {
        name: "backend-core",
        path: "/dev/backend",
        terminal_count: 2,
        last_opened: Date.now() - 10000,
      },
    ];

    render(
      <WizardStepLayout
        cwd="/path"
        setCwd={mockSetCwd}
        terminalCount={1}
        setTerminalCount={mockSetTerminalCount}
        onSelectRecent={mockOnSelectRecent}
        onSelectPreset={mockOnSelectPreset}
        recentWorkspaces={mockRecents}
        workspacePresets={[]}
      />,
    );

    expect(screen.getByText("oppa")).toBeInTheDocument();
    expect(screen.getByText("D:/oppa/oppa")).toBeInTheDocument();
    expect(screen.getByText("backend-core")).toBeInTheDocument();

    fireEvent.click(screen.getByText("oppa"));
    expect(mockOnSelectRecent).toHaveBeenCalledWith(mockRecents[0]);
  });

  it("renders presets and handles preset selection & + NEW click", () => {
    const mockPresets: WorkspacePreset[] = [
      {
        id: "dev-stack",
        name: "Dev Stack",
        terminal_count: 4,
        commands: ["pnpm dev", "cargo watch", "git status"],
      },
      {
        id: "full-grid",
        name: "Full Grid",
        terminal_count: 6,
        commands: [],
      },
    ];

    render(
      <WizardStepLayout
        cwd="/path"
        setCwd={mockSetCwd}
        terminalCount={1}
        setTerminalCount={mockSetTerminalCount}
        onSelectRecent={mockOnSelectRecent}
        onSelectPreset={mockOnSelectPreset}
        onOpenNewPresetModal={mockOnOpenNewPreset}
        recentWorkspaces={[]}
        workspacePresets={mockPresets}
      />,
    );

    expect(screen.getByText("Dev Stack")).toBeInTheDocument();
    expect(screen.getByText("Full Grid")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Dev Stack"));
    expect(mockOnSelectPreset).toHaveBeenCalledWith(mockPresets[0]);

    const newBtn = screen.getByRole("button", { name: /\+ NEW/i });
    fireEvent.click(newBtn);
    expect(mockOnOpenNewPreset).toHaveBeenCalled();
  });
});
