import React, { useState, useEffect } from "react";
import { useTerminalStore } from "../../store/terminalStore";
import { agentProfiles } from "../../lib/worktree/transport";
import type {
  AgentProfile,
  RepoRecord,
  WorktreeListEntry,
} from "../../lib/worktree/transport";
import { useExitPresence } from "../../lib/motion/useExitPresence";
import "./worktree.css";

// Catalog id of the raw-command pseudo profile; it takes a --command, not a prompt
const GENERIC_AGENT_ID = "generic";

// Mirrors the [data-motion="modal"] exit duration in styles/motion.css.
const MODAL_EXIT_MS = 140;

export function WorktreeCreateModal(): React.ReactElement | null {
  const isOpen = useTerminalStore((s) => s.isWorktreeCreateOpen);
  const closeWorktreeCreate = useTerminalStore((s) => s.closeWorktreeCreate);
  const repos = useTerminalStore((s) => s.repos);
  const worktrees = useTerminalStore((s) => s.worktrees);
  const addRepo = useTerminalStore((s) => s.addRepo);
  const createWorktree = useTerminalStore((s) => s.createWorktree);
  const createWorktreeWithAgent = useTerminalStore((s) => s.createWorktreeWithAgent);
  const createTab = useTerminalStore((s) => s.createTab);

  const [repoPath, setRepoPath] = useState("");
  const [isAddingRepo, setIsAddingRepo] = useState(false);
  const [newRepoPath, setNewRepoPath] = useState("");
  const [name, setName] = useState("");
  const [baseRef, setBaseRef] = useState("");
  const [parentWorktreeId, setParentWorktreeId] = useState("");
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [agentId, setAgentId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [customCommand, setCustomCommand] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    // Prefill (workspace card "+"): preselect the owning repo when resolvable.
    const prefill = useTerminalStore.getState().worktreeCreatePrefill;
    setRepoPath(prefill?.repoPath ?? "");
    setIsAddingRepo(false);
    setNewRepoPath("");
    setName("");
    setBaseRef("");
    setParentWorktreeId("");
    setAgentId("");
    setPrompt("");
    setCustomCommand("");
    setError(null);
    setBusy(false);
    void useTerminalStore.getState().loadRepos().catch(() => {});
    void useTerminalStore.getState().loadWorktrees().catch(() => {});
    void agentProfiles()
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeWorktreeCreate();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, closeWorktreeCreate]);

  // Keeps the node mounted through its exit animation; without this the modal
  // scales in over 260ms and vanishes in 0ms. Must match the --dur-fast exit in
  // motion.css, otherwise the unmount cuts the departure short.
  const { present, state } = useExitPresence(isOpen, MODAL_EXIT_MS);

  if (!present) return null;

  const parentCandidates: WorktreeListEntry[] = worktrees.filter(
    (w) => !w.record.retired && w.record.repo_id === repoIdFromPath(repoPath, repos),
  );

  const handleRegisterRepo = async () => {
    const trimmed = newRepoPath.trim();
    if (!trimmed) return;
    setError(null);
    try {
      await addRepo(trimmed);
      setRepoPath(normalizeRepoPath(trimmed));
      setIsAddingRepo(false);
      setNewRepoPath("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleCreate = async () => {
    if (!repoPath || !name.trim()) {
      setError("Pick a repository and enter a worktree name.");
      return;
    }
    if (agentId === GENERIC_AGENT_ID && !customCommand.trim()) {
      setError("Enter a command for the custom agent launch.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const sharedInput = {
        repoPath,
        name: name.trim(),
        baseRef: baseRef.trim() || undefined,
        parentWorktreeId: parentWorktreeId || undefined,
      };
      if (agentId === GENERIC_AGENT_ID) {
        await createWorktreeWithAgent({
          ...sharedInput,
          command: customCommand.trim(),
          prompt: prompt.trim() || undefined,
        });
      } else if (agentId) {
        await createWorktreeWithAgent({
          ...sharedInput,
          agent: agentId,
          prompt: prompt.trim() || undefined,
        });
      } else {
        const record = await createWorktree(sharedInput);
        if (record) {
          // Bound terminal: CreateOrAttach carries the worktree id so the daemon
          // records session↔worktree ownership for teardown gating.
          void createTab(record.path, record.id).catch(() => {});
        }
      }
      closeWorktreeCreate();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="wt-modal-backdrop"
      data-motion="scrim"
      data-state={state}
      onClick={(e) => {
        if (e.target === e.currentTarget) closeWorktreeCreate();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="New Worktree"
    >
      <div className="wt-create-card" data-motion="modal" data-state={state}>
        <div className="wt-create-header">
          <h3>New Worktree</h3>
          <p>Creates a worktree (optionally with an agent) and attaches it to the active workspace grid.</p>
        </div>

        {error && <p className="wt-error" role="alert">{error}</p>}

        <div className="wt-form-group">
          <label htmlFor="wt-repo-select" className="wt-label">Repository</label>
          <select
            id="wt-repo-select"
            className="wt-select"
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
          {!isAddingRepo ? (
            <button
              type="button"
              className="wt-btn"
              onClick={() => setIsAddingRepo(true)}
            >
              + Add repo
            </button>
          ) : (
            <div className="wt-add-repo-row">
              <input
                type="text"
                className="wt-input"
                value={newRepoPath}
                onChange={(e) => setNewRepoPath(e.target.value)}
                placeholder="e.g. D:\dev\my-project"
                aria-label="Repository path"
              />
              <button
                type="button"
                className="wt-btn primary"
                onClick={() => void handleRegisterRepo()}
              >
                Register
              </button>
            </div>
          )}
        </div>

        <div className="wt-form-group">
          <label htmlFor="wt-name-input" className="wt-label">Worktree name</label>
          <input
            id="wt-name-input"
            type="text"
            className="wt-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="feat-a"
          />
        </div>

        <div className="wt-form-group">
          <label htmlFor="wt-base-input" className="wt-label">Base ref (optional)</label>
          <input
            id="wt-base-input"
            type="text"
            className="wt-input"
            value={baseRef}
            onChange={(e) => setBaseRef(e.target.value)}
            placeholder={repos.find((r) => r.path === repoPath)?.default_base_ref ?? "main"}
          />
        </div>

        <div className="wt-form-group">
          <label htmlFor="wt-agent-select" className="wt-label">Agent</label>
          <select
            id="wt-agent-select"
            className="wt-select"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
            aria-label="Agent"
          >
            <option value="">No agent</option>
            {profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
              </option>
            ))}
          </select>
        </div>

        {agentId === GENERIC_AGENT_ID && (
          <div className="wt-form-group">
            <label htmlFor="wt-command-input" className="wt-label">Command</label>
            <input
              id="wt-command-input"
              type="text"
              className="wt-input"
              value={customCommand}
              onChange={(e) => setCustomCommand(e.target.value)}
              placeholder="e.g. my-agent --yolo"
              aria-label="Command"
            />
          </div>
        )}

        {agentId && agentId !== GENERIC_AGENT_ID && (
          <div className="wt-form-group">
            <label htmlFor="wt-prompt-input" className="wt-label">First prompt (optional)</label>
            <textarea
              id="wt-prompt-input"
              className="wt-input"
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              aria-label="First prompt"
            />
          </div>
        )}

        <div className="wt-form-group">
          <label htmlFor="wt-parent-select" className="wt-label">Parent worktree (optional)</label>
          <select
            id="wt-parent-select"
            className="wt-select"
            value={parentWorktreeId}
            onChange={(e) => setParentWorktreeId(e.target.value)}
            aria-label="Parent worktree"
          >
            <option value="">(none)</option>
            {parentCandidates.map((entry) => (
              <option key={entry.record.id} value={entry.record.id}>
                {entry.record.display_name || entry.record.name}
              </option>
            ))}
          </select>
        </div>

        <div className="wt-create-actions">
          <button type="button" className="wt-btn" onClick={closeWorktreeCreate}>
            Cancel
          </button>
          <button
            type="button"
            className="wt-btn primary"
            disabled={busy}
            onClick={() => void handleCreate()}
          >
            Create Worktree
          </button>
        </div>
      </div>
    </div>
  );
}

// Repo ids are derived server-side; match the select value back to a repo_id by
// comparing registered paths so the parent list only shows siblings.
function repoIdFromPath(path: string, repos: RepoRecord[]): string {
  const normalized = normalizeRepoPath(path);
  return repos.find((r) => normalizeRepoPath(r.path) === normalized)?.repo_id ?? "";
}

function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}
