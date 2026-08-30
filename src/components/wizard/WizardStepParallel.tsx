import React, { useEffect, useState } from "react";
import { Check, ChevronDown, Loader2, X } from "lucide-react";
import { useTerminalStore } from "../../store/terminalStore";
import { agentProfiles } from "../../lib/worktree/transport";
import type { AgentProfile } from "../../lib/worktree/transport";
import "./WorkspaceSetupWizard.css";

// Catalog id of the raw-command pseudo profile (same convention as the old
// fleet sheet / WorktreeCreateModal).
const GENERIC_AGENT_ID = "generic";

const MIN_SLOTS = 1;
const MAX_SLOTS = 8;

export interface ParallelSlotDraft {
  agentId: string;
  command: string;
  prompt: string;
  showPrompt: boolean;
}

export function emptyParallelSlot(): ParallelSlotDraft {
  return { agentId: "", command: "", prompt: "", showPrompt: false };
}

export function parallelDraftsValid(
  slots: ParallelSlotDraft[],
  sharedPrompt: string,
): string | null {
  for (let i = 0; i < slots.length; i += 1) {
    const slot = slots[i];
    const label = `Slot ${i + 1}`;
    if (slot.agentId === GENERIC_AGENT_ID && !slot.command.trim()) {
      return `${label}: enter a command for the custom launch.`;
    }
    const hasLauncher = !!slot.agentId && slot.agentId !== GENERIC_AGENT_ID;
    const hasPrompt = !!slot.prompt.trim() || !!sharedPrompt.trim();
    if (!hasLauncher && !hasPrompt) {
      return `${label}: pick an agent or add a prompt.`;
    }
  }
  return null;
}

/** Confirm-summary grouping: slots sharing one launcher collapse into one line. */
export function groupParallelSummary(
  slots: ParallelSlotDraft[],
  profiles: AgentProfile[],
): Array<{ label: string; count: number; prompt: string | null }> {
  const agentLabel = (agentId: string): string =>
    profiles.find((p) => p.id === agentId)?.displayName ??
    (agentId === GENERIC_AGENT_ID ? "custom command" : "no agent");
  const groups = new Map<string, { label: string; count: number; prompt: string | null }>();
  for (const slot of slots) {
    const key = slot.agentId === GENERIC_AGENT_ID
      ? `${slot.agentId}:${slot.command.trim()}`
      : slot.agentId;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (existing.prompt !== null && existing.prompt !== slot.prompt.trim()) {
        existing.prompt = "";
      }
    } else {
      groups.set(key, { label: agentLabel(slot.agentId), count: 1, prompt: slot.prompt.trim() });
    }
  }
  return [...groups.values()];
}

export interface WizardStepParallelProps {
  repoPath: string;
  setRepoPath: (path: string) => void;
  baseRef: string;
  setBaseRef: (ref: string) => void;
  sharedPrompt: string;
  setSharedPrompt: (prompt: string) => void;
  slots: ParallelSlotDraft[];
  setSlots: (slots: ParallelSlotDraft[]) => void;
  // Step-3 confirm phase renders the summary read-only instead of the editor.
  phase: "edit" | "confirm";
  launchError?: string | null;
}

export function WizardStepParallel({
  repoPath,
  setRepoPath,
  baseRef,
  setBaseRef,
  sharedPrompt,
  setSharedPrompt,
  slots,
  setSlots,
  phase,
  launchError,
}: WizardStepParallelProps): React.ReactElement {
  const repos = useTerminalStore((s) => s.repos);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);

  useEffect(() => {
    void useTerminalStore.getState().loadRepos().catch(() => {});
    void agentProfiles().then(setProfiles).catch(() => setProfiles([]));
  }, []);

  const updateSlot = (index: number, patch: Partial<ParallelSlotDraft>) => {
    setSlots(slots.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };

  const removeSlot = (index: number) => {
    if (slots.length <= MIN_SLOTS) return;
    setSlots(slots.filter((_, i) => i !== index));
  };

  if (phase === "confirm") {
    const groups = groupParallelSummary(slots, profiles);
    return (
      <div className="wizard-step-container">
        <div className="wizard-step-header">
          <h2 className="wizard-step-title">Review parallel launch</h2>
          <p className="wizard-step-subtitle">
            One workspace opens with every agent terminal gridded together.
          </p>
        </div>
        <div className="wizard-parallel-summary">
          <div className="wizard-parallel-summary-line muted">
            {repoPath}
            {baseRef.trim() ? ` · base ${baseRef.trim()}` : ""}
          </div>
          {groups.map((group, i) => (
            <div key={`${group.label}-${i}`} className="wizard-parallel-summary-line">
              <strong>
                {group.count} × {group.label}
              </strong>
              {group.prompt ? <span className="muted"> · prompt: {group.prompt}</span> : null}
            </div>
          ))}
          <div className="wizard-parallel-summary-line muted">{slots.length} slots total</div>
          {sharedPrompt.trim() ? (
            <div className="wizard-parallel-summary-line muted">
              Shared prompt: {sharedPrompt.trim()}
            </div>
          ) : null}
        </div>
        {launchError && (
          <p className="wizard-parallel-error" role="alert">
            {launchError}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="wizard-step-container">
      <div className="wizard-step-header">
        <h2 className="wizard-step-title">Parallel agents</h2>
        <p className="wizard-step-subtitle">
          One worktree + agent terminal per slot, all opening in a single workspace grid.
        </p>
      </div>

      <div className="wizard-section">
        <div className="wizard-form-group">
          <label htmlFor="wizard-parallel-repo" className="wizard-label">
            Repository
          </label>
          <select
            id="wizard-parallel-repo"
            className="wizard-parallel-select"
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            aria-label="Repository"
          >
            <option value="" disabled>
              Select repository…
            </option>
            {repos.map((repo) => (
              <option key={repo.repo_id} value={repo.path}>
                {repo.path}
              </option>
            ))}
          </select>
        </div>

        <div className="wizard-form-group">
          <label htmlFor="wizard-parallel-base" className="wizard-label">
            Base ref (optional)
          </label>
          <input
            id="wizard-parallel-base"
            type="text"
            className="wizard-text-input"
            value={baseRef}
            onChange={(e) => setBaseRef(e.target.value)}
            placeholder={repos.find((r) => r.path === repoPath)?.default_base_ref ?? "main"}
          />
        </div>

        <div className="wizard-form-group">
          <label htmlFor="wizard-parallel-shared" className="wizard-label">
            Shared prompt (optional)
          </label>
          <textarea
            id="wizard-parallel-shared"
            className="wizard-text-input wizard-parallel-textarea"
            rows={2}
            value={sharedPrompt}
            onChange={(e) => setSharedPrompt(e.target.value)}
            aria-label="Shared prompt"
          />
        </div>
      </div>

      <div className="wizard-section">
        <div className="wizard-section-title-row">
          <span className="wizard-section-heading">AGENT SLOTS</span>
        </div>
        <div className="wizard-parallel-slots">
          {slots.map((slot, i) => (
            <div key={i} className="wizard-parallel-slot" data-testid={`wizard-parallel-slot-${i}`}>
              <span className="wizard-parallel-slot-index">{i + 1}</span>
              <div className="wizard-parallel-slot-fields">
                <select
                  className="wizard-parallel-select"
                  value={slot.agentId}
                  onChange={(e) => updateSlot(i, { agentId: e.target.value })}
                  aria-label={`Slot ${i + 1} agent`}
                >
                  <option value="">No agent</option>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName}
                    </option>
                  ))}
                </select>
                {slot.agentId === GENERIC_AGENT_ID && (
                  <input
                    type="text"
                    className="wizard-text-input"
                    value={slot.command}
                    onChange={(e) => updateSlot(i, { command: e.target.value })}
                    placeholder="e.g. my-agent --yolo"
                    aria-label={`Slot ${i + 1} command`}
                  />
                )}
                {slot.showPrompt ? (
                  <textarea
                    className="wizard-text-input wizard-parallel-textarea"
                    rows={2}
                    value={slot.prompt}
                    onChange={(e) => updateSlot(i, { prompt: e.target.value })}
                    placeholder="Per-slot prompt overrides the shared one"
                    aria-label={`Slot ${i + 1} prompt`}
                  />
                ) : null}
              </div>
              <div className="wizard-parallel-slot-tools">
                {!slot.showPrompt && (
                  <button
                    type="button"
                    className="wizard-parallel-slot-tool"
                    title="Add a prompt for this slot"
                    aria-label={`Toggle prompt for slot ${i + 1}`}
                    onClick={() => updateSlot(i, { showPrompt: true })}
                  >
                    <ChevronDown size={12} />
                  </button>
                )}
                {slots.length > MIN_SLOTS && (
                  <button
                    type="button"
                    className="wizard-parallel-slot-tool danger"
                    title={`Remove slot ${i + 1}`}
                    aria-label={`Remove slot ${i + 1}`}
                    onClick={() => removeSlot(i)}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
        <button
          type="button"
          className="wizard-parallel-add-slot"
          disabled={slots.length >= MAX_SLOTS}
          onClick={() => setSlots([...slots, emptyParallelSlot()])}
        >
          + Add slot
        </button>
      </div>
    </div>
  );
}

// Re-exported so the wizard shell can render per-slot launch outcomes in the
// confirm phase after Launch (same visual as the old fleet sheet).
export function ParallelLaunchOutcomes({
  outcomes,
}: {
  outcomes: Array<{ status: "spawning" | "ok" | "error"; label?: string; error?: string }>;
}): React.ReactElement | null {
  if (outcomes.length === 0) return null;
  return (
    <div className="wizard-parallel-outcomes">
      {outcomes.map((outcome, i) => (
        <div key={i} className="wizard-parallel-outcome">
          {outcome.status === "spawning" && (
            <span className="wizard-parallel-outcome spawning">
              <Loader2 size={11} className="wizard-parallel-spin" /> spawning…
            </span>
          )}
          {outcome.status === "ok" && (
            <span className="wizard-parallel-outcome ok">
              <Check size={11} /> {outcome.label}
            </span>
          )}
          {outcome.status === "error" && (
            <span className="wizard-parallel-outcome failed">
              <X size={11} /> {outcome.error}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
