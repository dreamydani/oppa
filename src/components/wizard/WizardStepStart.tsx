import React from "react";
import { ChevronDown } from "lucide-react";
import "./WorkspaceSetupWizard.css";

export interface WizardStepStartProps {
  name: string;
  setName: (name: string) => void;
  shell: string;
  setShell: (shell: string) => void;
}

export function WizardStepStart({
  name,
  setName,
  shell,
  setShell,
}: WizardStepStartProps): React.ReactElement {
  return (
    <div className="wizard-step-container">
      <div className="wizard-step-header">
        <h2 className="wizard-step-title">Start a workspace</h2>
        <p className="wizard-step-subtitle">
          Configure initial workspace name and preferred shell
        </p>
      </div>

      <div className="wizard-section">
        <div className="wizard-form-group">
          <label htmlFor="wizard-workspace-name" className="wizard-label">
            Workspace Name
          </label>
          <div className="wizard-input-wrapper">
            <input
              id="wizard-workspace-name"
              type="text"
              className="wizard-text-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Project"
              autoFocus
            />
          </div>
        </div>

        <div className="wizard-form-group">
          <label htmlFor="wizard-shell-select" className="wizard-label">
            Preferred Shell
          </label>
          <div className="wizard-input-wrapper with-select-chevron">
            <select
              id="wizard-shell-select"
              className="wizard-select-input"
              value={shell}
              onChange={(e) => setShell(e.target.value)}
            >
              <option value="">Default Shell</option>
              <option value="powershell.exe">PowerShell</option>
              <option value="cmd.exe">Command Prompt</option>
              <option value="bash.exe">Git Bash</option>
              <option value="wsl.exe">WSL</option>
              <option value="/bin/bash">Bash</option>
              <option value="/bin/zsh">Zsh</option>
            </select>
            <ChevronDown size={14} className="wizard-select-chevron" />
          </div>
        </div>
      </div>
    </div>
  );
}
