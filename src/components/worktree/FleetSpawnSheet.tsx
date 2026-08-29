import React, { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Layers, Loader2, X } from "lucide-react";
import { useTerminalStore } from "../../store/terminalStore";
import { agentProfiles } from "../../lib/pty/transport";
import type {
  AgentProfile,
  FleetSlotInput,
  WorktreeRecord,
} from "../../lib/pty/transport";
import "./worktree.css";
import "./FleetSpawnSheet.css";

// Catalog id of the raw-command pseudo profile (same convention as WorktreeCreateModal)
const GENERIC_AGENT_ID = "generic";

const MIN_SLOTS = 1;
const MAX_SLOTS = 8;
const DEFAULT_SLOTS = 2;

interface SlotDraft {
  agentId: string;
  command: string;
  prompt: string;
  showPrompt: boolean;
}

// Per-row outcome; the single fleet IPC finalizes every row at once, so v1
// shows a shared "spawning" phase rather than true per-row streaming.
interface RowOutcome {
  status: "spawning" | "ok" | "error";
  branch?: string;
  error?: string;
  record?: WorktreeRecord;
  sessionId?: string | null;
}

type SheetPhase = "edit" | "confirm" | "launching" | "done";

function emptySlot(): SlotDraft {
  return { agentId: "", command: "", prompt: "", showPrompt: false };
}

function excerpt(text: string, max = 42): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

export function FleetSpawnSheet(): React.ReactElement | null {
  const isOpen = useTerminalStore((s) => s.isFleetSheetOpen);
  const closeFleetSheet = useTerminalStore((s) => s.closeFleetSheet);
  const repos = useTerminalStore((s) => s.repos);
  const spawnFleet = useTerminalStore((s) => s.spawnFleet);
  const createTab = useTerminalStore((s) => s.createTab);
  const tileProjectBranches = useTerminalStore((s) => s.tileProjectBranches);

  const [phase, setPhase] = useState<SheetPhase>("edit");
  const [repoPath, setRepoPath] = useState("");
  const [baseRef, setBaseRef] = useState("");
  const [sharedPrompt, setSharedPrompt] = useState("");
  const [slots, setSlots] = useState<SlotDraft[]>([
    emptySlot(),
    emptySlot(),
  ]);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [gridError, setGridError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<RowOutcome[] | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    // Prefill is read once per open so re-opening always starts a fresh sheet.
    const prefill = useTerminalStore.getState().fleetSheetPrefill;
    setRepoPath(prefill?.repoPath ?? "");
    setBaseRef(prefill?.baseRef ?? "");
    setSharedPrompt("");
    const rowCount = Math.min(Math.max(prefill?.count ?? DEFAULT_SLOTS, MIN_SLOTS), MAX_SLOTS);
    setSlots(Array.from({ length: rowCount }, emptySlot));
    setPhase("edit");
    setValidationError(null);
    setLaunchError(null);
    setGridError(null);
    setOutcomes(null);
    setProfiles([]);
    void useTerminalStore.getState().loadRepos().catch(() => {});
    void agentProfiles()
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    // Launching must not be dismissible mid-flight: results would vanish.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && phase !== "launching") {
        e.preventDefault();
        closeFleetSheet();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, phase, closeFleetSheet]);

  const agentLabel = (agentId: string): string =>
    profiles.find((p) => p.id === agentId)?.displayName ??
    (agentId === GENERIC_AGENT_ID ? "custom command" : "no agent");

  // Confirm-summary grouping: slots sharing one launcher collapse into one
  // "N × label · prompt" line so the cost surface stays scannable.
  const summaryGroups = useMemo(() => {
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
  }, [slots, profiles]);

  const validateBeforeReview = (): string | null => {
    if (!repoPath) return "Pick a repository.";
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
  };

  const handleReview = () => {
    const problem = validateBeforeReview();
    setValidationError(problem);
    if (!problem) setPhase("confirm");
  };

  const toPayload = (slot: SlotDraft): FleetSlotInput => ({
    name: null,
    agent: slot.agentId && slot.agentId !== GENERIC_AGENT_ID ? slot.agentId : null,
    command: slot.agentId === GENERIC_AGENT_ID ? slot.command.trim() : null,
    prompt: slot.prompt.trim() || null,
  });

  const handleConfirmLaunch = async () => {
    setPhase("launching");
    setLaunchError(null);
    setOutcomes(slots.map(() => ({ status: "spawning" as const })));
    try {
      const result = await spawnFleet({
        repoPath,
        baseRef: baseRef.trim() || undefined,
        sharedPrompt: sharedPrompt.trim() || undefined,
        slots: slots.map(toPayload),
      });
      const rawResults = Array.isArray(result) ? result : (result?.results ?? []);
      const finalized: RowOutcome[] = rawResults.map((r) =>
        r.ok && r.record
          ? { status: "ok", branch: r.record.branch, record: r.record, sessionId: r.session_id }
          : { status: "error", error: r.error ?? "Unknown failure" },
      );
      setOutcomes(finalized);
      // One tab per successful slot; sessionId binds to the daemon's session.
      for (const outcome of finalized) {
        if (outcome.record) {
          void createTab(outcome.record.path, outcome.record.id, outcome.sessionId ?? undefined)
            .catch(() => {});
        }
      }
      setPhase("done");
    } catch (e) {
      setLaunchError(e instanceof Error ? e.message : String(e));
      setOutcomes(null);
      setPhase("edit");
    }
  };

  const updateSlot = (index: number, patch: Partial<SlotDraft>) => {
    setSlots((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };

  // Done-phase action: tile every successful slot into one grid tab. The
  // tiling action reuses live sessions, so no duplicate spawns occur.
  const okRecords = outcomes
    ? outcomes.flatMap((o) => (o.record ? [o.record] : []))
    : [];

  const handleOpenGrid = async () => {
    if (okRecords.length === 0) return;
    const repo = repos.find((r) => r.path === repoPath);
    setGridError(null);
    try {
      await tileProjectBranches(
        repo?.repo_id ?? okRecords[0].repo_id,
        okRecords.map((r) => r.id),
      );
      closeFleetSheet();
    } catch (e) {
      // The fleet already landed; keep the sheet open so the error is seen.
      setGridError(e instanceof Error ? e.message : String(e));
    }
  };

  const removeSlot = (index: number) => {
    setSlots((prev) => (prev.length <= MIN_SLOTS ? prev : prev.filter((_, i) => i !== index)));
  };

  if (!isOpen) return null;

  const busy = phase === "launching";

  return (
    <div
      className="wt-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) closeFleetSheet();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Spawn Fleet"
    >
      <div className="fleet-sheet-card">
        <div className="wt-create-header">
          <h3>
            <Layers size={13} /> Spawn Fleet
          </h3>
          <p>Creates one worktree + terminal per agent from a single launch.</p>
        </div>

        {(validationError || launchError || gridError) && (
          <p className="wt-error" role="alert">
            {validationError ?? launchError ?? gridError}
          </p>
        )}

        {phase === "confirm" ? (
          <div className="fleet-summary" role="region" aria-label="Fleet summary">
            <div className="fleet-summary-line muted">
              {repoPath}
              {baseRef.trim() ? ` · base ${baseRef.trim()}` : ""}
            </div>
            {summaryGroups.map((group, i) => (
              <div key={`${group.label}-${i}`} className="fleet-summary-line">
                <strong>
                  {group.count} × {group.label}
                </strong>
                {group.prompt ? (
                  <span className="muted"> · prompt: {excerpt(group.prompt)}</span>
                ) : null}
              </div>
            ))}
            <div className="fleet-summary-line muted">{slots.length} slots total</div>
            {sharedPrompt.trim() ? (
              <div className="fleet-summary-line muted">
                Shared prompt: {excerpt(sharedPrompt)}
              </div>
            ) : null}
            <div className="fleet-confirm-actions">
              <button
                type="button"
                className="wt-btn"
                onClick={() => setPhase("edit")}
              >
                Back
              </button>
              <button
                type="button"
                className="wt-btn primary"
                onClick={() => void handleConfirmLaunch()}
              >
                Confirm launch
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="wt-form-group">
              <label htmlFor="fleet-repo-select" className="wt-label">Repository</label>
              <select
                id="fleet-repo-select"
                className="wt-select"
                value={repoPath}
                disabled={busy}
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

            <div className="wt-form-group">
              <label htmlFor="fleet-base-input" className="wt-label">Base ref (optional)</label>
              <input
                id="fleet-base-input"
                type="text"
                className="wt-input"
                value={baseRef}
                disabled={busy}
                onChange={(e) => setBaseRef(e.target.value)}
                placeholder={repos.find((r) => r.path === repoPath)?.default_base_ref ?? "main"}
              />
            </div>

            <div className="wt-form-group">
              <label htmlFor="fleet-shared-prompt" className="wt-label">Shared prompt (optional)</label>
              <textarea
                id="fleet-shared-prompt"
                className="wt-input"
                rows={3}
                value={sharedPrompt}
                disabled={busy}
                onChange={(e) => setSharedPrompt(e.target.value)}
                aria-label="Shared prompt"
              />
            </div>

            <div className="fleet-slots">
              {slots.map((slot, i) => {
                const outcome = outcomes?.[i];
                return (
                  <div key={i} className="fleet-slot-row" data-testid={`fleet-slot-${i}`}>
                    <span className="fleet-slot-index">{i + 1}</span>
                    <div className="fleet-slot-fields">
                      <select
                        className="wt-select"
                        value={slot.agentId}
                        disabled={busy}
                        onChange={(e) =>
                          updateSlot(i, { agentId: e.target.value })
                        }
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
                          className="wt-input"
                          value={slot.command}
                          disabled={busy}
                          onChange={(e) => updateSlot(i, { command: e.target.value })}
                          placeholder="e.g. my-agent --yolo"
                          aria-label={`Slot ${i + 1} command`}
                        />
                      )}
                      {slot.showPrompt ? (
                        <textarea
                          className="wt-input"
                          rows={2}
                          value={slot.prompt}
                          disabled={busy}
                          onChange={(e) => updateSlot(i, { prompt: e.target.value })}
                          placeholder="Per-slot prompt overrides the shared one"
                          aria-label={`Slot ${i + 1} prompt`}
                        />
                      ) : null}
                      {outcome && (
                        <div className="fleet-slot-outcome">
                          {outcome.status === "spawning" && (
                            <span className="fleet-outcome spawning">
                              <Loader2 size={11} className="spin" /> spawning…
                            </span>
                          )}
                          {outcome.status === "ok" && outcome.record && (
                            <button
                              type="button"
                              className="fleet-outcome ok"
                              title="Open this terminal"
                              onClick={() =>
                                void createTab(
                                  outcome.record!.path,
                                  outcome.record!.id,
                                  outcome.sessionId ?? undefined,
                                ).catch(() => {})
                              }
                            >
                              <Check size={11} /> spawned: {outcome.branch}
                            </button>
                          )}
                          {outcome.status === "error" && (
                            <span className="fleet-outcome failed">
                              <X size={11} /> {outcome.error}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="fleet-slot-tools">
                      {!slot.showPrompt && !busy && (
                        <button
                          type="button"
                          className="fleet-slot-tool"
                          title="Add a prompt for this slot"
                          aria-label={`Toggle prompt for slot ${i + 1}`}
                          onClick={() => updateSlot(i, { showPrompt: true })}
                        >
                          <ChevronDown size={12} />
                        </button>
                      )}
                      {slots.length > MIN_SLOTS && !busy && (
                        <button
                          type="button"
                          className="fleet-slot-tool danger"
                          title={`Remove slot ${i + 1}`}
                          aria-label={`Remove slot ${i + 1}`}
                          onClick={() => removeSlot(i)}
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {phase !== "done" && (
              <button
                type="button"
                className="wt-btn fleet-add-slot"
                disabled={busy || slots.length >= MAX_SLOTS}
                onClick={() => setSlots((prev) => [...prev, emptySlot()])}
              >
                + Add slot
              </button>
            )}

            <div className="wt-create-actions">
            {phase === "done" ? (
              <>
                {okRecords.length > 0 && (
                  <button
                    type="button"
                    className="wt-btn"
                    onClick={() => void handleOpenGrid()}
                  >
                    Open grid
                  </button>
                )}
                <button
                  type="button"
                  className="wt-btn primary"
                  onClick={closeFleetSheet}
                >
                  Done
                </button>
              </>
            ) : (
                <button
                  type="button"
                  className="wt-btn primary"
                  disabled={busy}
                  onClick={handleReview}
                >
                  Review fleet…
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
