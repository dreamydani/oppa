import React, { useState, useEffect } from "react";
import { X, ArrowLeft, ArrowRight, Zap, Play } from "lucide-react";
import { useTerminalStore } from "../../store/terminalStore";
import { WizardStepStart } from "./WizardStepStart";
import { WizardStepLayout } from "./WizardStepLayout";
import { WizardStepAgents } from "./WizardStepAgents";
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

export function WorkspaceSetupWizard(): React.ReactElement | null {
  const isSetupWizardOpen = useTerminalStore((s) => s.isSetupWizardOpen);
  const storeStep = useTerminalStore((s) => s.wizardStep);
  const setStoreStep = useTerminalStore((s) => s.setWizardStep);
  const closeSetupWizard = useTerminalStore((s) => s.closeSetupWizard);
  const loadWizardData = useTerminalStore((s) => s.loadWizardData);
  const launchCustomWorkspace = useTerminalStore((s) => s.launchCustomWorkspace);
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

  const setStep = (newStep: 1 | 2 | 3) => {
    setStepState(newStep);
    setStoreStep(newStep);
  };

  // Sync with storeStep if changed externally
  useEffect(() => {
    if (storeStep && storeStep !== step) {
      setStepState(storeStep);
    }
  }, [storeStep]);

  // Load wizard data and initial active CWD on mount
  useEffect(() => {
    void loadWizardData();
    const activeCwd = getActiveCwd();
    if (activeCwd) {
      setCwd(activeCwd);
    }
  }, []);

  // Keyboard shortcut listener for Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeSetupWizard();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeSetupWizard]);

  if (!isSetupWizardOpen) {
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
    await launchCustomWorkspace({
      name: name.trim() || undefined,
      cwd: cwd.trim() || undefined,
      shell: shell.trim() || undefined,
      terminalCount: 1,
    });
    closeSetupWizard();
  };

  const handleLaunch = async () => {
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

    await launchCustomWorkspace({
      name: name.trim() || undefined,
      cwd: cwd.trim() || undefined,
      shell: shell.trim() || undefined,
      terminalCount,
      commands: commands.slice(0, terminalCount),
      agentPersona: agentPersona !== "none" ? agentPersona : undefined,
    });

    closeSetupWizard();
  };

  return (
    <div
      className="wizard-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Workspace Setup Wizard"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeSetupWizard();
      }}
    >
      <div className="wizard-modal-dialog">
        {/* Wizard Header */}
        <div className="wizard-dialog-header">
          <div className="wizard-dialog-title-group">
            <span className="wizard-logo-tag">OPPA</span>
            <span className="wizard-dialog-heading">Workspace Wizard</span>
          </div>

          <button
            type="button"
            className="wizard-close-btn"
            onClick={closeSetupWizard}
            aria-label="Close wizard"
            title="Close wizard (Esc)"
          >
            <X size={18} />
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
                  className={`wizard-step-pill ${isActive ? "active" : ""} ${
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
                    className={`wizard-progress-divider ${
                      step > s.step ? "active" : ""
                    }`}
                  />
                )}
              </React.Fragment>
            );
          })}
        </div>

        {/* Wizard Main Step Content */}
        <div className="wizard-dialog-body">
          {step === 1 && (
            <WizardStepStart
              name={name}
              setName={setName}
              shell={shell}
              setShell={setShell}
            />
          )}

          {step === 2 && (
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

          {step === 3 && (
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
        </div>

        {/* Wizard Bottom Navigation Bar */}
        <div className="wizard-dialog-footer">
          <div className="wizard-footer-left">
            <button
              type="button"
              className="wizard-nav-btn wizard-btn-back"
              onClick={() => setStep((step - 1) as 1 | 2 | 3)}
              disabled={step === 1}
              aria-label="Back"
            >
              <ArrowLeft size={16} />
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
              <Zap size={14} className="text-amber-400" />
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
                  Next: {step === 1 ? "Layout" : "Agents"}
                </span>
                <ArrowRight size={16} />
              </button>
            ) : (
              <button
                type="button"
                className="wizard-nav-btn wizard-btn-launch"
                onClick={handleLaunch}
                aria-label="Launch Workspace"
              >
                <Play size={16} className="fill-current" />
                <span>Launch Workspace</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
