import React, { useState } from "react";
import { Folder, ArrowRight } from "lucide-react";
import { useTerminalStore } from "../../store/terminalStore";
import type {
  RecentWorkspace,
  WorkspacePreset,
} from "../../lib/workspace/transport";
import "./WorkspaceSetupWizard.css";

export interface WizardStepLayoutProps {
  cwd: string;
  setCwd: (cwd: string) => void;
  terminalCount: number;
  setTerminalCount: (n: number) => void;
  onSelectRecent: (recent: RecentWorkspace) => void;
  onSelectPreset: (preset: WorkspacePreset) => void;
  onOpenNewPresetModal?: () => void;
  recentWorkspaces?: RecentWorkspace[];
  workspacePresets?: WorkspacePreset[];
}

export const GRID_OPTIONS = [1, 2, 4, 6, 8, 10, 12] as const;

export function getGridLayoutLabel(count: number): string {
  const terminalText = count === 1 ? "1 terminal" : `${count} terminals`;
  let gridSpec = "1x1 grid";
  if (count === 2) gridSpec = "1x2 grid";
  else if (count === 4) gridSpec = "2x2 grid";
  else if (count === 6) gridSpec = "2x3 grid";
  else if (count === 8) gridSpec = "2x4 grid";
  else if (count === 10) gridSpec = "2x5 grid";
  else if (count === 12) gridSpec = "3x4 grid";
  return `${terminalText}   ${gridSpec}`;
}

export function resolveCdPath(currentCwd: string, input: string): string {
  let target = input.trim();
  if (!target) return currentCwd;

  if (target.startsWith("cd ")) {
    target = target.slice(3).trim();
  }
  if (!target) return currentCwd;

  // Absolute path checks
  const isUnixAbs = target.startsWith("/") || target.startsWith("~");
  const isWinDrive = /^[a-zA-Z]:[/\\]/.test(target);
  const isWinUnc = target.startsWith("\\\\");

  if (isUnixAbs || isWinDrive || isWinUnc || !currentCwd) {
    return target;
  }

  const isBackslash =
    currentCwd.includes("\\") && !currentCwd.includes("/");
  const sep = isBackslash ? "\\" : "/";

  const rawParts = currentCwd.split(/[/\\]+/).filter(Boolean);
  const isDrive = /^[a-zA-Z]:$/.test(rawParts[0] || "");
  const isAbsUnix = currentCwd.startsWith("/");

  if (target === "..") {
    if (rawParts.length > (isDrive ? 1 : 0)) {
      rawParts.pop();
    }
    if (rawParts.length === 0) {
      return isAbsUnix ? "/" : isDrive ? `${rawParts[0]}\\` : "";
    }
    if (isDrive && rawParts.length === 1) {
      return `${rawParts[0]}${sep}`;
    }
    const prefix = isAbsUnix ? "/" : "";
    return prefix + rawParts.join(sep);
  }

  if (target.startsWith("../") || target.startsWith("..\\")) {
    const remainder = target.slice(3);
    if (rawParts.length > (isDrive ? 1 : 0)) {
      rawParts.pop();
    }
    let parentPath: string;
    if (isDrive && rawParts.length === 1) {
      parentPath = `${rawParts[0]}${sep}`;
    } else {
      const prefix = isAbsUnix ? "/" : "";
      parentPath = prefix + rawParts.join(sep);
    }
    return resolveCdPath(parentPath, remainder);
  }

  const baseCwd = currentCwd.replace(/[/\\]+$/, "");
  return `${baseCwd}${sep}${target}`;
}

export function WizardStepLayout({
  cwd,
  setCwd,
  terminalCount,
  setTerminalCount,
  onSelectRecent,
  onSelectPreset,
  onOpenNewPresetModal,
  recentWorkspaces: propRecents,
  workspacePresets: propPresets,
}: WizardStepLayoutProps): React.ReactElement {
  const storeRecents = useTerminalStore((s) => s.recentWorkspaces);
  const storePresets = useTerminalStore((s) => s.workspacePresets);

  const recents = propRecents ?? storeRecents ?? [];
  const presets = propPresets ?? storePresets ?? [];

  const [cdInput, setCdInput] = useState("");

  const handleCdSubmit = () => {
    if (!cdInput.trim()) return;
    const resolved = resolveCdPath(cwd, cdInput);
    setCwd(resolved);
    setCdInput("");
  };

  const handleCdKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleCdSubmit();
    }
  };

  return (
    <div className="wizard-step-container">
      <div className="wizard-step-header">
        <h2 className="wizard-step-title">Set up your workspace</h2>
        <p className="wizard-step-subtitle">
          Pick a folder to work in and choose how many terminals you want.
        </p>
      </div>

      {/* Working folder section */}
      <div className="wizard-section">
        <label className="wizard-label" htmlFor="wizard-folder-input">
          Working folder
        </label>
        <div className="wizard-folder-input-row">
          <div className="wizard-input-wrapper with-icon">
            <Folder size={16} className="wizard-input-icon text-muted-foreground" />
            <input
              id="wizard-folder-input"
              type="text"
              className="wizard-text-input"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="e.g. /home/project or D:\dev\oppa"
            />
          </div>
        </div>

        {/* Quick jump line */}
        <div className="wizard-cd-row">
          <span className="wizard-cd-prefix">&gt; cd</span>
          <input
            type="text"
            className="wizard-cd-input"
            value={cdInput}
            onChange={(e) => setCdInput(e.target.value)}
            onKeyDown={handleCdKeyDown}
            placeholder="subpath or cd .. (e.g. src)"
          />
          <button
            type="button"
            className="wizard-cd-submit-btn"
            onClick={handleCdSubmit}
            aria-label="Jump to subpath"
            title="Jump to subpath"
          >
            <ArrowRight size={14} />
          </button>
        </div>
      </div>

      {/* Terminal grid layout selector */}
      <div className="wizard-section">
        <div className="wizard-section-header-row">
          <label className="wizard-label">How many terminals?</label>
          <span className="wizard-layout-pill">
            {getGridLayoutLabel(terminalCount)}
          </span>
        </div>

        <div className="wizard-grid-tiles-row">
          {GRID_OPTIONS.map((count) => {
            const isSelected = terminalCount === count;
            return (
              <button
                key={count}
                type="button"
                className={`wizard-grid-tile ${isSelected ? "active" : ""}`}
                onClick={() => setTerminalCount(count)}
                aria-label={`${count} terminals layout`}
              >
                <div className={`tile-preview-boxes tile-grid-${count}`}>
                  {Array.from({ length: Math.min(count, 12) }).map((_, i) => (
                    <span key={i} className="tile-box" />
                  ))}
                </div>
                <div className="tile-count-row">
                  <span className="tile-count">{count}</span>
                  {isSelected && <span className="tile-indicator-dot" />}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Recent workspaces section */}
      <div className="wizard-section">
        <div className="wizard-section-title-row">
          <span className="wizard-section-heading">RECENT</span>
          <span className="wizard-badge">{recents.length}</span>
        </div>

        {recents.length === 0 ? (
          <div className="wizard-recents-empty">
            No recent workspaces yet — your opened workspaces will appear here
          </div>
        ) : (
          <div className="wizard-recents-grid">
            {recents.map((recent) => (
              <button
                key={recent.path || recent.name}
                type="button"
                className="wizard-recent-card"
                onClick={() => onSelectRecent(recent)}
              >
                <div className="recent-card-icon-col">
                  <Folder size={18} className="text-muted-foreground" />
                </div>
                <div className="recent-card-info">
                  <div className="recent-card-name">{recent.name}</div>
                  <div className="recent-card-path">{recent.path}</div>
                </div>
                <span className="recent-card-terminals-badge">
                  {recent.terminal_count}{" "}
                  {recent.terminal_count === 1 ? "terminal" : "terminals"}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Presets section */}
      <div className="wizard-section">
        <div className="wizard-section-title-row">
          <span className="wizard-section-heading">PRESETS</span>
          <span className="wizard-badge">{presets.length}</span>
        </div>

        <div className="wizard-presets-chips-row">
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className="wizard-preset-chip"
              onClick={() => onSelectPreset(preset)}
            >
              {preset.name}
            </button>
          ))}
          <button
            type="button"
            className="wizard-preset-chip wizard-new-preset-chip"
            onClick={onOpenNewPresetModal}
          >
            + NEW
          </button>
        </div>
      </div>
    </div>
  );
}
