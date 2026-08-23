import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { WizardStepAgents } from "./WizardStepAgents";
import { WorkspaceSetupWizard } from "./WorkspaceSetupWizard";
import { useTerminalStore } from "../../store/terminalStore";
import type { RecentWorkspace, WorkspacePreset } from "../../lib/workspace/transport";

// Mock the transport modules
vi.mock("../../lib/pty/transport", () => ({
  ptySpawn: vi.fn().mockResolvedValue("session-1"),
  ptyKill: vi.fn().mockResolvedValue(undefined),
  ptyResize: vi.fn(),
  ptyAck: vi.fn().mockResolvedValue(undefined),
  ptyWrite: vi.fn().mockResolvedValue(undefined),
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
  ptyList: vi.fn().mockResolvedValue([]),
  agentProfiles: vi.fn().mockResolvedValue([]),
  worktreeCreateAgent: vi.fn(),
}));

vi.mock("../../lib/workspace/transport", () => ({
  saveRecents: vi.fn().mockResolvedValue(undefined),
  loadRecents: vi.fn().mockResolvedValue([]),
  savePresets: vi.fn().mockResolvedValue(undefined),
  loadPresets: vi.fn().mockResolvedValue([]),
}));

describe("WizardStepAgents", () => {
  const mockSetAgentPersona = vi.fn();
  const mockSetCommands = vi.fn();
  const mockSetSaveAsPreset = vi.fn();
  const mockSetPresetName = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders header and subtitle", () => {
    render(
      <WizardStepAgents
        agentPersona="none"
        setAgentPersona={mockSetAgentPersona}
        terminalCount={2}
        commands={["", ""]}
        setCommands={mockSetCommands}
        saveAsPreset={false}
        setSaveAsPreset={mockSetSaveAsPreset}
        presetName=""
        setPresetName={mockSetPresetName}
      />,
    );

    expect(screen.getByText("Agents & Startup Commands")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Configure AI assistant persona and initial commands to execute upon startup",
      ),
    ).toBeInTheDocument();
  });

  it("renders persona options and handles selection", () => {
    render(
      <WizardStepAgents
        agentPersona="none"
        setAgentPersona={mockSetAgentPersona}
        terminalCount={1}
        commands={[""]}
        setCommands={mockSetCommands}
        saveAsPreset={false}
        setSaveAsPreset={mockSetSaveAsPreset}
        presetName=""
        setPresetName={mockSetPresetName}
      />,
    );

    expect(screen.getByText("Shell Copilot")).toBeInTheDocument();
    expect(screen.getByText("Code Assistant")).toBeInTheDocument();
    expect(screen.getByText("Code Reviewer")).toBeInTheDocument();
    expect(screen.getByText("Grok")).toBeInTheDocument();
    expect(screen.getByText("GPT 5.5")).toBeInTheDocument();

    // Check badges
    expect(screen.getByText("Popular")).toBeInTheDocument();
    expect(screen.getByText("Smart")).toBeInTheDocument();

    const copilotCard = screen.getByTestId("persona-copilot");
    fireEvent.click(copilotCard);
    expect(mockSetAgentPersona).toHaveBeenCalledWith("copilot");
  });

  it("applies active class to selected persona card", () => {
    const { rerender } = render(
      <WizardStepAgents
        agentPersona="copilot"
        setAgentPersona={mockSetAgentPersona}
        terminalCount={1}
        commands={[""]}
        setCommands={mockSetCommands}
        saveAsPreset={false}
        setSaveAsPreset={mockSetSaveAsPreset}
        presetName=""
        setPresetName={mockSetPresetName}
      />,
    );

    const copilotCard = screen.getByTestId("persona-copilot");
    expect(copilotCard.className).toContain("active");

    const noneCard = screen.getByTestId("persona-none");
    expect(noneCard.className).not.toContain("active");

    rerender(
      <WizardStepAgents
        agentPersona="grok"
        setAgentPersona={mockSetAgentPersona}
        terminalCount={1}
        commands={[""]}
        setCommands={mockSetCommands}
        saveAsPreset={false}
        setSaveAsPreset={mockSetSaveAsPreset}
        presetName=""
        setPresetName={mockSetPresetName}
      />,
    );

    expect(screen.getByTestId("persona-grok").className).toContain("active");
    expect(copilotCard.className).not.toContain("active");
  });

  it("renders physical clay tags (P1, P2, ...) and command inputs", () => {
    render(
      <WizardStepAgents
        agentPersona="none"
        setAgentPersona={mockSetAgentPersona}
        terminalCount={3}
        commands={["pnpm dev", "", ""]}
        setCommands={mockSetCommands}
        saveAsPreset={false}
        setSaveAsPreset={mockSetSaveAsPreset}
        presetName=""
        setPresetName={mockSetPresetName}
      />,
    );

    expect(screen.getByText("P1")).toHaveClass("wizard-command-badge");
    expect(screen.getByText("P2")).toHaveClass("wizard-command-badge");
    expect(screen.getByText("P3")).toHaveClass("wizard-command-badge");

    expect(screen.getByLabelText("Terminal 1 Command")).toHaveValue("pnpm dev");
    expect(screen.getByLabelText("Terminal 2 Command")).toHaveValue("");
    expect(screen.getByLabelText("Terminal 3 Command")).toHaveValue("");

    const input2 = screen.getByLabelText("Terminal 2 Command");
    fireEvent.change(input2, { target: { value: "cargo watch -x run" } });

    expect(mockSetCommands).toHaveBeenCalledWith([
      "pnpm dev",
      "cargo watch -x run",
      "",
    ]);
  });

  it("toggles save as preset and shows preset name input", () => {
    const { rerender } = render(
      <WizardStepAgents
        agentPersona="none"
        setAgentPersona={mockSetAgentPersona}
        terminalCount={1}
        commands={[""]}
        setCommands={mockSetCommands}
        saveAsPreset={false}
        setSaveAsPreset={mockSetSaveAsPreset}
        presetName=""
        setPresetName={mockSetPresetName}
      />,
    );

    const checkbox = screen.getByLabelText(
      "Save this configuration as a custom preset",
    );
    expect(checkbox).not.toBeChecked();
    expect(screen.queryByPlaceholderText("e.g. Fullstack Dev")).not.toBeInTheDocument();

    fireEvent.click(checkbox);
    expect(mockSetSaveAsPreset).toHaveBeenCalledWith(true);

    rerender(
      <WizardStepAgents
        agentPersona="none"
        setAgentPersona={mockSetAgentPersona}
        terminalCount={1}
        commands={[""]}
        setCommands={mockSetCommands}
        saveAsPreset={true}
        setSaveAsPreset={mockSetSaveAsPreset}
        presetName="My Preset"
        setPresetName={mockSetPresetName}
      />,
    );

    const presetNameInput = screen.getByPlaceholderText("e.g. Fullstack Dev");
    expect(presetNameInput).toBeInTheDocument();
    expect(presetNameInput).toHaveValue("My Preset");

    fireEvent.change(presetNameInput, { target: { value: "Updated Preset" } });
    expect(mockSetPresetName).toHaveBeenCalledWith("Updated Preset");
  });
});

describe("WorkspaceSetupWizard full assembly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTerminalStore.setState({
      isSetupWizardOpen: true,
      wizardStep: 1,
      recentWorkspaces: [],
      workspacePresets: [],
      sessions: {},
      tabs: [{ id: "tab-1", layout: { type: "leaf", id: "" }, focusedPath: [] }],
      activeTabId: "tab-1",
    });
  });

  it("renders 3-step progress bar and initial Step 1", () => {
    render(<WorkspaceSetupWizard />);

    expect(screen.getByText("Start")).toBeInTheDocument();
    expect(screen.getByText("Layout")).toBeInTheDocument();
    expect(screen.getByText("Agents")).toBeInTheDocument();

    // Step 1 content is visible
    expect(screen.getByText("Start a workspace")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("My Project")).toBeInTheDocument();
  });

  it("navigates forward and backward with Next and Back buttons", async () => {
    render(<WorkspaceSetupWizard />);

    const backBtn = screen.getByRole("button", { name: /back/i });
    expect(backBtn).toBeDisabled();

    // Move to Step 2
    const nextBtn = screen.getByRole("button", { name: /next/i });
    fireEvent.click(nextBtn);

    expect(screen.getByText("Set up your workspace")).toBeInTheDocument();
    expect(backBtn).not.toBeDisabled();

    // Move to Step 3
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByText("Agents & Startup Commands")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /launch workspace/i })).toBeInTheDocument();

    // Move back to Step 2
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(screen.getByText("Set up your workspace")).toBeInTheDocument();

    // Move back to Step 1
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(screen.getByText("Start a workspace")).toBeInTheDocument();
  });

  it("allows direct navigation by clicking step pills in the progress bar", () => {
    render(<WorkspaceSetupWizard />);

    const step3Pill = screen.getByTestId("wizard-progress-step-3");
    fireEvent.click(step3Pill);

    expect(screen.getByText("Agents & Startup Commands")).toBeInTheDocument();

    const step2Pill = screen.getByTestId("wizard-progress-step-2");
    fireEvent.click(step2Pill);

    expect(screen.getByText("Set up your workspace")).toBeInTheDocument();

    const step1Pill = screen.getByTestId("wizard-progress-step-1");
    fireEvent.click(step1Pill);

    expect(screen.getByText("Start a workspace")).toBeInTheDocument();
  });

  it("handles Quick Spawn bypass button", async () => {
    const launchSpy = vi.spyOn(useTerminalStore.getState(), "launchCustomWorkspace");
    render(<WorkspaceSetupWizard />);

    const quickSpawnBtn = screen.getByRole("button", { name: /quick spawn/i });
    fireEvent.click(quickSpawnBtn);

    await waitFor(() => {
      expect(launchSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          terminalCount: 1,
        }),
      );
    });
  });

  it("pre-fills wizard state when selecting a recent workspace in Step 2", () => {
    const mockRecents: RecentWorkspace[] = [
      {
        name: "My App",
        path: "/workspace/my-app",
        terminal_count: 4,
        last_opened: Date.now(),
      },
    ];
    useTerminalStore.setState({ recentWorkspaces: mockRecents });

    render(<WorkspaceSetupWizard />);

    // Go to Step 2
    fireEvent.click(screen.getByTestId("wizard-progress-step-2"));

    expect(screen.getByText("My App")).toBeInTheDocument();
    fireEvent.click(screen.getByText("My App"));

    // Check folder input is filled
    expect(screen.getByDisplayValue("/workspace/my-app")).toBeInTheDocument();

    // Check Step 3 reflects 4 terminal command inputs
    fireEvent.click(screen.getByTestId("wizard-progress-step-3"));
    expect(screen.getByLabelText("Terminal 4 Command")).toBeInTheDocument();
  });

  it("pre-fills wizard state when selecting a preset in Step 2", () => {
    const mockPresets: WorkspacePreset[] = [
      {
        id: "full-stack",
        name: "Fullstack App",
        terminal_count: 3,
        shell: "powershell.exe",
        commands: ["pnpm dev", "cargo watch", "docker compose up"],
        agent_persona: "copilot",
      },
    ];
    useTerminalStore.setState({ workspacePresets: mockPresets });

    render(<WorkspaceSetupWizard />);

    // Go to Step 2
    fireEvent.click(screen.getByTestId("wizard-progress-step-2"));
    fireEvent.click(screen.getByText("Fullstack App"));

    // Check Step 3 reflects commands and persona
    fireEvent.click(screen.getByTestId("wizard-progress-step-3"));
    expect(screen.getByLabelText("Terminal 1 Command")).toHaveValue("pnpm dev");
    expect(screen.getByLabelText("Terminal 2 Command")).toHaveValue("cargo watch");
    expect(screen.getByLabelText("Terminal 3 Command")).toHaveValue("docker compose up");
  });

  it("launches custom workspace and closes wizard when clicking Launch Workspace", async () => {
    const launchSpy = vi.spyOn(useTerminalStore.getState(), "launchCustomWorkspace");
    const savePresetSpy = vi.spyOn(useTerminalStore.getState(), "saveWorkspacePreset");

    render(<WorkspaceSetupWizard />);

    // Step 1: Fill name and shell
    fireEvent.change(screen.getByPlaceholderText("My Project"), {
      target: { value: "Super App" },
    });
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "powershell.exe" },
    });

    // Step 2: Set folder & terminal count
    fireEvent.click(screen.getByTestId("wizard-progress-step-2"));
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. \/home\/project/i), {
      target: { value: "D:/dev/super-app" },
    });
    fireEvent.click(screen.getByRole("button", { name: "4 terminals layout" }));

    // Step 3: Set persona, commands, and save as preset
    fireEvent.click(screen.getByTestId("wizard-progress-step-3"));
    fireEvent.click(screen.getByTestId("persona-copilot"));

    fireEvent.change(screen.getByLabelText("Terminal 1 Command"), {
      target: { value: "pnpm dev" },
    });
    fireEvent.change(screen.getByLabelText("Terminal 2 Command"), {
      target: { value: "pnpm test" },
    });

    fireEvent.click(
      screen.getByLabelText("Save this configuration as a custom preset"),
    );
    fireEvent.change(screen.getByPlaceholderText("e.g. Fullstack Dev"), {
      target: { value: "Super Stack" },
    });

    // Launch
    const launchBtn = screen.getByRole("button", { name: /launch workspace/i });
    fireEvent.click(launchBtn);

    await waitFor(() => {
      expect(savePresetSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Super Stack",
          terminal_count: 4,
          shell: "powershell.exe",
          agent_persona: "copilot",
        }),
      );

      expect(launchSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Super App",
          cwd: "D:/dev/super-app",
          shell: "powershell.exe",
          terminalCount: 4,
          agentPersona: "copilot",
          commands: expect.arrayContaining(["pnpm dev", "pnpm test"]),
        }),
      );
    });
  });

  it("closes wizard when clicking close button or pressing Escape", () => {
    const closeSpy = vi.spyOn(useTerminalStore.getState(), "closeSetupWizard");
    render(<WorkspaceSetupWizard />);

    const closeBtn = screen.getByRole("button", { name: /close wizard/i });
    fireEvent.click(closeBtn);
    expect(closeSpy).toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    expect(closeSpy).toHaveBeenCalledTimes(2);
  });

  it("renders wizard workbench page with container and minimalist clay styling", () => {
    render(<WorkspaceSetupWizard tabId="tab-test" />);
    const page = screen.getByRole("region", { name: /workspace setup wizard/i });
    expect(page.className).toContain("wizard-workbench-page");
    expect(page.querySelector(".wizard-content-container")).not.toBeNull();
  });

  it("renders full-page workbench container without modal overlay", () => {
    const { container } = render(<WorkspaceSetupWizard tabId="tab-wizard-1" />);
    expect(container.querySelector(".wizard-workbench-page")).toBeInTheDocument();
    expect(container.querySelector(".wizard-content-container")).toBeInTheDocument();
    expect(container.querySelector(".wizard-modal-overlay")).not.toBeInTheDocument();
    expect(container.querySelector(".wizard-modal-dialog")).not.toBeInTheDocument();
  });

  it("launches workspace into tab when tabId prop is provided", async () => {
    const launchTabSpy = vi.spyOn(useTerminalStore.getState(), "launchWorkspaceForTab");
    render(<WorkspaceSetupWizard tabId="tab-wizard-1" />);

    // Fill Step 1
    fireEvent.change(screen.getByPlaceholderText("My Project"), {
      target: { value: "Tab Workspace" },
    });

    // Step 2
    fireEvent.click(screen.getByTestId("wizard-progress-step-2"));
    fireEvent.change(screen.getByPlaceholderText(/e\.g\. \/home\/project/i), {
      target: { value: "D:/dev/tab-project" },
    });
    fireEvent.click(screen.getByRole("button", { name: "2 terminals layout" }));

    // Step 3
    fireEvent.click(screen.getByTestId("wizard-progress-step-3"));
    const launchBtn = screen.getByRole("button", { name: /launch workspace/i });
    fireEvent.click(launchBtn);

    await waitFor(() => {
      expect(launchTabSpy).toHaveBeenCalledWith(
        "tab-wizard-1",
        expect.objectContaining({
          name: "Tab Workspace",
          cwd: "D:/dev/tab-project",
          terminalCount: 2,
        }),
      );
    });
  });

  it("handles Quick Spawn with tabId prop", async () => {
    const launchTabSpy = vi.spyOn(useTerminalStore.getState(), "launchWorkspaceForTab");
    render(<WorkspaceSetupWizard tabId="tab-wizard-1" />);

    const quickSpawnBtn = screen.getByRole("button", { name: /quick spawn/i });
    fireEvent.click(quickSpawnBtn);

    await waitFor(() => {
      expect(launchTabSpy).toHaveBeenCalledWith(
        "tab-wizard-1",
        expect.objectContaining({
          terminalCount: 1,
        }),
      );
    });
  });

  it("closes tab when tabId prop is provided and close button is clicked", () => {
    const closeTabSpy = vi.spyOn(useTerminalStore.getState(), "closeTab");
    render(<WorkspaceSetupWizard tabId="tab-wizard-1" />);

    const closeBtn = screen.getByRole("button", { name: /close wizard/i });
    fireEvent.click(closeBtn);

    expect(closeTabSpy).toHaveBeenCalledWith("tab-wizard-1");
  });

  it("renders pebble stepper with active clay glow and step numbers", () => {
    render(<WorkspaceSetupWizard tabId="tab-test" />);
    const step1 = screen.getByTestId("wizard-progress-step-1");
    expect(step1.className).toContain("active");
    expect(step1.querySelector(".wizard-step-num")?.textContent).toBe("1");
    expect(step1.querySelector(".wizard-step-name")?.textContent).toBe("Start");

    const step2 = screen.getByTestId("wizard-progress-step-2");
    expect(step2.className).not.toContain("active");
    expect(step2.querySelector(".wizard-step-num")?.textContent).toBe("2");
    expect(step2.querySelector(".wizard-step-name")?.textContent).toBe("Layout");

    const step3 = screen.getByTestId("wizard-progress-step-3");
    expect(step3.className).not.toContain("active");
    expect(step3.querySelector(".wizard-step-num")?.textContent).toBe("3");
    expect(step3.querySelector(".wizard-step-name")?.textContent).toBe("Agents");
  });

  it("renders header topbar with logo badge and close button", () => {
    render(<WorkspaceSetupWizard tabId="tab-test" />);
    expect(screen.getByText("OPPA")).toHaveClass("wizard-logo-badge");
    expect(screen.getByText("Workspace Setup")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /close wizard/i })).toHaveClass("wizard-close-btn");
  });

  it("renders 3D tactile action footer with back, quick spawn, and next/launch buttons", () => {
    render(<WorkspaceSetupWizard tabId="tab-test" />);

    const backBtn = screen.getByRole("button", { name: /back/i });
    expect(backBtn).toHaveClass("wizard-btn-back");
    expect(backBtn).toBeDisabled();

    const quickBtn = screen.getByRole("button", { name: /quick spawn/i });
    expect(quickBtn).toHaveClass("wizard-btn-quick");

    const nextBtn = screen.getByRole("button", { name: /next/i });
    expect(nextBtn).toHaveClass("wizard-btn-next");

    // Go to step 3
    fireEvent.click(screen.getByTestId("wizard-progress-step-3"));
    expect(backBtn).not.toBeDisabled();

    const launchBtn = screen.getByRole("button", { name: /launch workspace/i });
    expect(launchBtn).toHaveClass("wizard-btn-launch");
  });

  it("always starts on step 1 when a wizard tab is mounted, even if previous store step was 3", () => {
    useTerminalStore.setState({ wizardStep: 3 });
    render(<WorkspaceSetupWizard tabId="tab-new-wizard" />);

    const step1 = screen.getByTestId("wizard-progress-step-1");
    expect(step1.className).toContain("active");
    expect(screen.getByText("Start a workspace")).toBeInTheDocument();
  });

  it("opens custom clay dropdown, renders shell options, and updates shell on option click", () => {
    render(<WorkspaceSetupWizard tabId="tab-test" />);

    const dropdownTrigger = screen.getByTestId("wizard-shell-dropdown-trigger");
    expect(dropdownTrigger).toHaveTextContent("Default Shell");

    // Click to open custom dropdown
    fireEvent.click(dropdownTrigger);
    expect(screen.getByRole("listbox", { name: "Preferred Shell Options" })).toBeInTheDocument();

    // Select PowerShell from custom clay dropdown
    const listbox = screen.getByRole("listbox", { name: "Preferred Shell Options" });
    const psOption = within(listbox).getByRole("option", { name: /PowerShell/i });
    fireEvent.click(psOption);

    expect(dropdownTrigger).toHaveTextContent("PowerShell");
    expect(screen.queryByRole("listbox", { name: "Preferred Shell Options" })).not.toBeInTheDocument();
  });

  it("toggles preset switch card and expands preset name input well", () => {
    render(<WorkspaceSetupWizard tabId="tab-test" />);

    // Navigate to step 3
    fireEvent.click(screen.getByTestId("wizard-progress-step-3"));

    const switchCheckbox = screen.getByRole("checkbox", {
      name: "Save this configuration as a custom preset",
    });
    expect(switchCheckbox).not.toBeChecked();
    expect(screen.queryByPlaceholderText("e.g. Fullstack Dev")).not.toBeInTheDocument();

    // Toggle ON
    fireEvent.click(switchCheckbox);
    expect(switchCheckbox).toBeChecked();
    expect(screen.getByPlaceholderText("e.g. Fullstack Dev")).toBeInTheDocument();
  });
});


