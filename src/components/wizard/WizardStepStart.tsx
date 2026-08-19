import React, { useState, useRef, useEffect } from "react";
import { ChevronDown, Check } from "lucide-react";
import "./WorkspaceSetupWizard.css";

export interface WizardStepStartProps {
  name: string;
  setName: (name: string) => void;
  shell: string;
  setShell: (shell: string) => void;
}

export const SHELL_OPTIONS = [
  { value: "", label: "Default Shell", desc: "Auto-detect platform default" },
  { value: "powershell.exe", label: "PowerShell", desc: "Windows PowerShell" },
  { value: "cmd.exe", label: "Command Prompt", desc: "Classic Windows CLI" },
  { value: "bash.exe", label: "Git Bash", desc: "MinGW / Git CLI" },
  { value: "wsl.exe", label: "WSL", desc: "Windows Subsystem for Linux" },
  { value: "/bin/bash", label: "Bash", desc: "GNU Bourne Again Shell" },
  { value: "/bin/zsh", label: "Zsh", desc: "Z Shell (macOS default)" },
];

export function WizardStepStart({
  name,
  setName,
  shell,
  setShell,
}: WizardStepStartProps): React.ReactElement {
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const selectedOption =
    SHELL_OPTIONS.find((opt) => opt.value === shell) ?? SHELL_OPTIONS[0];

  // Close dropdown on outside click
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setIsDropdownOpen(false);
      }
    };
    if (isDropdownOpen) {
      document.addEventListener("mousedown", handleOutsideClick);
    }
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
    };
  }, [isDropdownOpen]);

  const handleSelect = (val: string) => {
    setShell(val);
    setIsDropdownOpen(false);
  };

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
          <div
            ref={dropdownRef}
            className={`wizard-input-wrapper with-select-chevron wizard-custom-dropdown ${
              isDropdownOpen ? "open" : ""
            }`}
          >
            {/* Custom Clay Dropdown Trigger */}
            <button
              type="button"
              className="wizard-dropdown-trigger"
              onClick={() => setIsDropdownOpen(!isDropdownOpen)}
              aria-haspopup="listbox"
              aria-expanded={isDropdownOpen}
              data-testid="wizard-shell-dropdown-trigger"
            >
              <span className="wizard-dropdown-trigger-label">
                {selectedOption.label}
              </span>
              <ChevronDown
                size={14}
                className="wizard-select-chevron wizard-dropdown-chevron"
              />
            </button>

            {/* Custom Floating Clay Dropdown Menu */}
            {isDropdownOpen && (
              <div
                className="wizard-dropdown-menu"
                role="listbox"
                aria-label="Preferred Shell Options"
              >
                {SHELL_OPTIONS.map((opt) => {
                  const isSelected = opt.value === shell;
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      className={`wizard-dropdown-item ${
                        isSelected ? "active" : ""
                      }`}
                      onClick={() => handleSelect(opt.value)}
                    >
                      <div className="wizard-dropdown-item-info">
                        <span className="wizard-dropdown-item-label">
                          {opt.label}
                        </span>
                        <span className="wizard-dropdown-item-desc">
                          {opt.desc}
                        </span>
                      </div>
                      {isSelected && (
                        <Check size={14} className="wizard-dropdown-check" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Hidden native select for form accessibility & test compatibility */}
            <select
              id="wizard-shell-select"
              className="wizard-select-input sr-only"
              value={shell}
              onChange={(e) => setShell(e.target.value)}
              aria-label="Preferred Shell"
            >
              {SHELL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
    </div>
  );
}
