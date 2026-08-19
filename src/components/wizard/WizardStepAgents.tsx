import React from "react";
import { Bot, Terminal, Code2, CheckCircle2, Zap, Sparkles } from "lucide-react";
import "./WorkspaceSetupWizard.css";

export interface PersonaOption {
  id: string;
  name: string;
  desc: string;
  badge?: string;
}

export const PERSONA_OPTIONS: PersonaOption[] = [
  {
    id: "none",
    name: "None / Standalone Terminal",
    desc: "Standard terminal shells without AI overlay",
  },
  {
    id: "copilot",
    name: "Shell Copilot",
    desc: "Context-aware terminal commands & shell assistant",
    badge: "Popular",
  },
  {
    id: "code-assistant",
    name: "Code Assistant",
    desc: "Autonomous coding & refactoring agent",
    badge: "Smart",
  },
  {
    id: "reviewer",
    name: "Code Reviewer",
    desc: "Automated PR / diff reviewer & linter",
  },
  {
    id: "grok",
    name: "Grok",
    desc: "Fast real-time reasoning & dev assistance",
  },
  {
    id: "gpt-5",
    name: "GPT 5.5",
    desc: "Deep multi-step planning & architectural assistant",
  },
];

function getPersonaIcon(id: string): React.ReactElement {
  switch (id) {
    case "copilot":
      return <Sparkles size={16} className="text-amber-400" />;
    case "code-assistant":
      return <Code2 size={16} className="text-orange-400" />;
    case "reviewer":
      return <CheckCircle2 size={16} className="text-emerald-400" />;
    case "grok":
      return <Zap size={16} className="text-blue-400" />;
    case "gpt-5":
      return <Bot size={16} className="text-purple-400" />;
    case "none":
    default:
      return <Terminal size={16} className="text-muted-foreground" />;
  }
}

export interface WizardStepAgentsProps {
  agentPersona: string;
  setAgentPersona: (persona: string) => void;
  terminalCount: number;
  commands: string[];
  setCommands: (cmds: string[]) => void;
  saveAsPreset: boolean;
  setSaveAsPreset: (save: boolean) => void;
  presetName: string;
  setPresetName: (name: string) => void;
}

export function WizardStepAgents({
  agentPersona,
  setAgentPersona,
  terminalCount,
  commands,
  setCommands,
  saveAsPreset,
  setSaveAsPreset,
  presetName,
  setPresetName,
}: WizardStepAgentsProps): React.ReactElement {
  const count = Math.max(1, terminalCount);

  const handleCommandChange = (index: number, value: string) => {
    const updated = [...commands];
    while (updated.length <= index) {
      updated.push("");
    }
    updated[index] = value;
    setCommands(updated);
  };

  const getPlaceholder = (i: number): string => {
    if (i === 0) return "e.g. pnpm dev";
    if (i === 1) return "e.g. cargo watch -x run";
    if (i === 2) return "e.g. git status";
    return "e.g. npm run test";
  };

  return (
    <div className="wizard-step-container">
      <div className="wizard-step-header">
        <h2 className="wizard-step-title">Agents & Startup Commands</h2>
        <p className="wizard-step-subtitle">
          Configure AI assistant persona and initial commands to execute upon startup
        </p>
      </div>

      {/* AI Persona Selector */}
      <div className="wizard-section">
        <div className="wizard-section-title-row">
          <span className="wizard-section-heading">AI AGENT PERSONA</span>
        </div>

        <div className="wizard-personas-grid">
          {PERSONA_OPTIONS.map((persona) => {
            const isSelected = agentPersona === persona.id;
            return (
              <button
                key={persona.id}
                type="button"
                data-testid={`persona-${persona.id}`}
                className={`wizard-persona-card ${isSelected ? "active" : ""}`}
                onClick={() => setAgentPersona(persona.id)}
              >
                <div className="wizard-persona-card-header">
                  <div className="wizard-persona-icon-box">
                    {getPersonaIcon(persona.id)}
                  </div>
                  {persona.badge && (
                    <span className="wizard-persona-badge">{persona.badge}</span>
                  )}
                </div>
                <div className="wizard-persona-name">{persona.name}</div>
                <div className="wizard-persona-desc">{persona.desc}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Startup Commands Section */}
      <div className="wizard-section">
        <div className="wizard-section-title-row">
          <span className="wizard-section-heading">
            STARTUP COMMANDS ({count} {count === 1 ? "PANE" : "PANES"})
          </span>
        </div>

        <div className="wizard-commands-list">
          {Array.from({ length: count }).map((_, i) => {
            const val = commands[i] ?? "";
            const fieldId = `wizard-cmd-input-${i}`;
            return (
              <div key={i} className="wizard-command-row">
                <label htmlFor={fieldId} className="wizard-command-label">
                  <span className="wizard-command-badge">P{i + 1}</span>
                  <span className="sr-only">Terminal {i + 1} Command</span>
                </label>
                <div className="wizard-input-wrapper">
                  <input
                    id={fieldId}
                    aria-label={`Terminal ${i + 1} Command`}
                    type="text"
                    className="wizard-text-input wizard-command-input"
                    value={val}
                    onChange={(e) => handleCommandChange(i, e.target.value)}
                    placeholder={getPlaceholder(i)}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Save as Preset Section */}
      <div className="wizard-section wizard-preset-save-section">
        <label htmlFor="wizard-save-preset-checkbox" className="wizard-checkbox-row">
          <input
            id="wizard-save-preset-checkbox"
            type="checkbox"
            className="wizard-checkbox"
            checked={saveAsPreset}
            onChange={(e) => setSaveAsPreset(e.target.checked)}
          />
          <span className="wizard-checkbox-label">
            Save this configuration as a custom preset
          </span>
        </label>

        {saveAsPreset && (
          <div className="wizard-preset-name-wrapper">
            <label htmlFor="wizard-preset-name-input" className="wizard-label">
              Preset Name
            </label>
            <div className="wizard-input-wrapper">
              <input
                id="wizard-preset-name-input"
                type="text"
                className="wizard-text-input"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                placeholder="e.g. Fullstack Dev"
                autoFocus
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
