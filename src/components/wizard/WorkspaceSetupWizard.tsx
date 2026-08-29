import React, { useState, useEffect, useCallback } from "react";
import { X, ArrowLeft, ArrowRight, Zap, Play, Terminal, Bot } from "lucide-react";
import { useTerminalStore } from "../../store/terminalStore";
import { WizardStepStart } from "./WizardStepStart";
import { WizardStepLayout } from "./WizardStepLayout";
import { WizardStepAgents } from "./WizardStepAgents";
import {
  WizardStepParallel,
  emptyParallelSlot,
  parallelDraftsValid,
} from "./WizardStepParallel";
import type { ParallelSlotDraft } from "./WizardStepParallel";
import type {
  RecentWorkspace,
  WorkspacePreset,
} from "../../lib/workspace/transport";
import "./WorkspaceSetupWizard.css";

const STEPS = [
  { step: 1, title: "Start" },
  { step: 2, title: "Layout" },
  { step: 3, title: "Agents" },
] as const;

export type WizardMode = "standard" | "parallel";

export interface WorkspaceSetupWizardProps {
  tabId?: string;
}

export function WorkspaceSetupWizard({
  tabId,
}: WorkspaceSetupWizardProps = {}): React.ReactElement | null {
  const isSetupWizardOpen = useTerminalStore((s) => s.isSetupWizardOpen);
  const storeStep = useTerminalStore((s) => s.wizardStep);
  const setStoreStep = useTerminalStore((s) => s.setWizardStep);
  const closeSetupWizard = useTerminalStore((s) => s.closeSetupWizard);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const loadWizardData = useTerminalStore((s) => s.loadWizardData);
  const launchCustomWorkspace = useTerminalStore((s) => s.launchCustomWorkspace);
  const launchWorkspaceForTab = useTerminalStore((s) => s.launchWorkspaceForTab);
  const launchParallelWorkspace = useTerminalStore((s) => s.launchParallelWorkspace);
  const saveWorkspacePreset = useTerminalStore((s) => s.saveWorkspacePreset);
  const recentWorkspaces = useTerminalStore((s) => s.recentWorkspaces);
  const workspacePresets = useTerminalStore((s) => s.workspacePresets);
  const getActiveCwd = useTerminalStore((s) => s.getActiveCwd);

  const [step, setStepState] = useState<1 | 2 | 3>(storeStep || 1);
  const [name, setName] = useState("");
  const [shell, setShell] = useState("");
  const [cwd, setCwd] = useState("");
  const [terminalCount, setTerminalCount] = useState(1);
  const [agentPersona, setAgentPersona] = useState("none");
  const [commands, setCommands] = useState<string[]>([]);
  const [saveAsPreset, setSaveAsPreset] = useState(false);
  const [presetName, setPresetName] = useState("");
  // Parallel mode state (replaces the fleet spawn sheet)
  const [mode, setMode] = useState<WizardMode>("standard");
  const [repoPath, setRepoPath] = useState("");
  const [baseRef, setBaseRef] = useState("");
  const [sharedPrompt, setSharedPrompt] = useState("");
  const [slots, setSlots] = useState<ParallelSlotDraft[]>([emptyParallelSlot(), emptyParallelSlot()]);
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);

  const setStep = (newStep: 1 | 2 | 3) => {
    setStepState(newStep);
    setStoreStep(newStep);
  };

  // Reset to step 1 whenever tabId changes (new workspace tab)
  useEffect(() => {
    if (tabId) {
      setStep(1);
    }
  }, [tabId]);

  // Sync with storeStep if changed externally
  useEffect(() => {
    if (storeStep && storeStep !== step) {
      setStepState(storeStep);
    }
  }, [storeStep]);

  // Load wizard data and initial active CWD on mount
  useEffect(() => {
    if (recentWorkspaces.length === 0 && workspacePresets.length === 0) {
      void loadWizardData();
    }
    const activeCwd = getActiveCwd();
    if (activeCwd) {
      setCwd(activeCwd);
    }
  }, []);

  const handleClose = useCallback(() => {
    if (tabId) {
      closeTab(tabId);
    }
    closeSetupWizard();
  }, [tabId, closeTab, closeSetupWizard]);

  // Keyboard shortcut listener for Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleClose]);

  if (!tabId && !isSetupWizardOpen) {
    return null;
  }

  const handleSelectRecent = (recent: RecentWorkspace) => {
    if (recent.path) setCwd(recent.path);
    if (recent.name) setName(recent.name);
    if (recent.terminal_count) setTerminalCount(recent.terminal_count);
  };

  const handleSelectPreset = (preset: WorkspacePreset) => {
    if (preset.name) setName(preset.name);
    if (preset.terminal_count) setTerminalCount(preset.terminal_count);
    if (preset.shell) setShell(preset.shell);
    if (preset.agent_persona) setAgentPersona(preset.agent_persona);
    if (preset.commands) setCommands(preset.commands);
  };

  const handleQuickSpawn = async () => {
    const config = {
      name: name.trim() || undefined,
      cwd: cwd.trim() || undefined,
      shell: shell.trim() || undefined,
      terminalCount: 1,
    };
    if (tabId) {
      await launchWorkspaceForTab(tabId, config);
    } else {
      await launchCustomWorkspace(config);
      closeSetupWizard();
    }
  };

  // Parallel launch: fleet IPC in the daemon, then one workspace tab gridding
  // every successful slot (the old fleet sheet's per-slot tabs are gone).
  const handleParallelLaunch = async () => {
    const problem = parallelDraftsValid(slots, sharedPrompt);
    if (problem) {
      setLaunchError(problem);
      return;
    }
    if (!repoPath) {
      setLaunchError("Pick a repository.");
      return;
    }
    setLaunchError(null);
    setLaunching(true);
    try {
      const outcome = await launchParallelWorkspace(
        tabId ?? useTerminalStore.getState().createWizardTab(),
        {
          repoPath,
          baseRef: baseRef.trim() || undefined,
          sharedPrompt: sharedPrompt.trim() || undefined,
          slots: slots.map((slot) => ({
            name: null,
            agent: slot.agentId && slot.agentId !== "generic" ? slot.agentId : null,
            command: slot.agentId === "generic" ? slot.command.trim() : null,
            prompt: slot.prompt.trim() || null,
          })),
        },
        { title: name.trim() || undefined },
      );
      if (!outcome.ok) {
        setLaunchError(outcome.errors.join(" · "));
        return;
      }
      if (!tabId) closeSetupWizard();
    } catch (e) {
      setLaunchError(e instanceof Error ? e.message : String(e));
    } finally {
      setLaunching(false);
    }
  };

  const handleLaunch = async () => {
    if (mode === "parallel") {
      return handleParallelLaunch();
    }
    if (saveAsPreset) {
      const finalPresetName =
        presetName.trim() || name.trim() || "Custom Preset";
      await saveWorkspacePreset({
        id: `preset-${Date.now()}`,
        name: finalPresetName,
        terminal_count: terminalCount,
        shell: shell.trim() || undefined,
        commands: commands.slice(0, terminalCount),
        agent_persona: agentPersona !== "none" ? agentPersona : undefined,
      });
    }

    const config = {
      name: name.trim() || undefined,
      cwd: cwd.trim() || undefined,
      shell: shell.trim() || undefined,
      terminalCount,
      commands: commands.slice(0, terminalCount),
      agentPersona: agentPersona !== "none" ? agentPersona : undefined,
    };

    if (tabId) {
      await launchWorkspaceForTab(tabId, config);
    } else {
      await launchCustomWorkspace(config);
      closeSetupWizard();
    }
  };

  return (
    <div
      className="wizard-workbench-page"
      role="region"
      aria-label="Workspace Setup Wizard"
    >
      <div className="wizard-content-container">
        {/* Wizard Top Header */}
        <div className="wizard-page-header">
          <div className="wizard-dialog-title-group">
            <img src="/logo.png" alt="OPPA" className="wizard-logo-img" />
            <span className="wizard-logo-tag wizard-logo-badge sr-only">OPPA</span>
            <span className="wizard-dialog-heading">Workspace Setup</span>
          </div>

          <button
            type="button"
            className="wizard-close-btn"
            onClick={handleClose}
            aria-label="Close wizard"
            title="Close wizard (Esc)"
          >
            <X size={16} />
          </button>
        </div>

        {/* Top Step Progress Bar */}
        <div className="wizard-progress-nav">
          {STEPS.map((s, idx) => {
            const isActive = step === s.step;
            const isPassed = step > s.step;

            return (
              <React.Fragment key={s.step}>
                <button
                  type="button"
                  data-testid={`wizard-progress-step-${s.step}`}
                  className={`wizard-step-pill wizard-progress-step ${isActive ? "active" : ""} ${
                    isPassed ? "completed" : ""
                  }`}
                  onClick={() => setStep(s.step)}
                  aria-label={`Go to Step ${s.step}: ${s.title}`}
                >
                  <span className="wizard-step-num">{s.step}</span>
                  <span className="wizard-step-name">{s.title}</span>
                </button>
                {idx < STEPS.length - 1 && (
                  <div
                    className={`wizard-progress-divider wizard-step-divider ${
                      step > s.step ? "active" : ""
                    }`}
                  />
                )}
              </React.Fragment>
            );
          })}
        </div>

        {/* Wizard Main Step Content */}
        <div className="wizard-step-body">
          {step === 1 && (
            <>
              <div className="wizard-mode-toggle" role="radiogroup" aria-label="Workspace mode">
                <button
                  type="button"
                  role="radio"
                  aria-checked={mode === "standard"}
                  data-testid="wizard-mode-standard"
                  className={`wizard-mode-btn ${mode === "standard" ? "active" : ""}`}
                  onClick={() => setMode("standard")}
                >
                  <Terminal size={14} />
                  <span>Standard terminals</span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={mode === "parallel"}
                  data-testid="wizard-mode-parallel"
                  className={`wizard-mode-btn ${mode === "parallel" ? "active" : ""}`}
                  onClick={() => setMode("parallel")}
                >
                  <Bot size={14} />
                  <span>Parallel agents</span>
                </button>
              </div>
              <WizardStepStart
                name={name}
                setName={setName}
                shell={shell}
                setShell={setShell}
              />
            </>
          )}

          {step === 2 && mode === "standard" && (
            <WizardStepLayout
              cwd={cwd}
              setCwd={setCwd}
              terminalCount={terminalCount}
              setTerminalCount={setTerminalCount}
              onSelectRecent={handleSelectRecent}
              onSelectPreset={handleSelectPreset}
              onOpenNewPresetModal={() => {
                setSaveAsPreset(true);
                setStep(3);
              }}
              recentWorkspaces={recentWorkspaces}
              workspacePresets={workspacePresets}
            />
          )}

          {step === 2 && mode === "parallel" && (
            <WizardStepParallel
              repoPath={repoPath}
              setRepoPath={setRepoPath}
              baseRef={baseRef}
              setBaseRef={setBaseRef}
              sharedPrompt={sharedPrompt}
              setSharedPrompt={setSharedPrompt}
              slots={slots}
              setSlots={setSlots}
              phase="edit"
              launchError={launchError}
            />
          )}

          {step === 3 && mode === "standard" && (
            <WizardStepAgents
              agentPersona={agentPersona}
              setAgentPersona={setAgentPersona}
              terminalCount={terminalCount}
              commands={commands}
              setCommands={setCommands}
              saveAsPreset={saveAsPreset}
              setSaveAsPreset={setSaveAsPreset}
              presetName={presetName}
              setPresetName={setPresetName}
            />
          )}

          {step === 3 && mode === "parallel" && (
            <WizardStepParallel
              repoPath={repoPath}
              setRepoPath={setRepoPath}
              baseRef={baseRef}
              setBaseRef={setBaseRef}
              sharedPrompt={sharedPrompt}
              setSharedPrompt={setSharedPrompt}
              slots={slots}
              setSlots={setSlots}
              phase="confirm"
              launchError={launchError}
            />
          )}
        </div>

        {/* Wizard Bottom Navigation Bar */}
        <div className="wizard-action-footer">
          <div className="wizard-footer-left">
            <button
              type="button"
              className="wizard-nav-btn wizard-btn-back"
              onClick={() => setStep((step - 1) as 1 | 2 | 3)}
              disabled={step === 1}
              aria-label="Back"
            >
              <ArrowLeft size={15} />
              <span>Back</span>
            </button>
          </div>

          <div className="wizard-footer-center">
            <button
              type="button"
              className="wizard-nav-btn wizard-btn-quick"
              onClick={handleQuickSpawn}
              aria-label="Quick Spawn"
              title="Spawn single 1x1 terminal immediately in folder"
            >
              <Zap size={14} />
              <span>Quick Spawn</span>
            </button>
          </div>

          <div className="wizard-footer-right">
            {step < 3 ? (
              <button
                type="button"
                className="wizard-nav-btn wizard-btn-next"
                onClick={() => setStep((step + 1) as 1 | 2 | 3)}
                aria-label="Next step"
              >
                <span>
                  Next:{" "}
                  {mode === "parallel"
                    ? step === 1
                      ? "Agents"
                      : "Review"
                    : step === 1
                      ? "Layout"
                      : "Agents"}
                </span>
                <ArrowRight size={15} />
              </button>
            ) : (
              <button
                type="button"
                className="wizard-nav-btn wizard-btn-launch"
                onClick={handleLaunch}
                disabled={launching}
                aria-label={mode === "parallel" ? "Launch Parallel Workspace" : "Launch Workspace"}
              >
                <Play size={15} />
                <span>
                  {launching
                    ? "Launching…"
                    : mode === "parallel"
                      ? "Launch Parallel Workspace"
                      : "Launch Workspace"}
                </span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
