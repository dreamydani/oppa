import { useState, type ReactElement } from "react";
import { useContextStore } from "../../store/contextStore";
import { useTerminalStore } from "../../store/terminalStore";
import type { AgentPersona } from "../../lib/context/transport";

export interface PersonaModalProps {
  isOpen: boolean;
  onClose: () => void;
  initialPersona?: AgentPersona | null;
}

const SCOPE_OPTIONS = [
  { id: "global", label: "Global Profile" },
  { id: "workspace", label: "Workspace" },
  { id: "architecture", label: "Architecture" },
  { id: "quirks", label: "Quirks" },
  { id: "runbooks", label: "Runbooks" },
];

export function PersonaModal({
  isOpen,
  onClose,
  initialPersona,
}: PersonaModalProps): ReactElement | null {
  const savePersona = useContextStore((s) => s.savePersona);
  const getActiveCwd = useTerminalStore((s) => s.getActiveCwd);

  const [name, setName] = useState(initialPersona?.name || "");
  const [icon, setIcon] = useState(initialPersona?.icon || "🎭");
  const [tagline, setTagline] = useState(initialPersona?.tagline || "");
  const [systemPrompt, setSystemPrompt] = useState(
    initialPersona?.system_prompt || ""
  );
  const [attachedScopes, setAttachedScopes] = useState<string[]>(
    initialPersona?.attached_scopes || ["workspace"]
  );

  if (!isOpen) return null;

  const handleScopeToggle = (scopeId: string) => {
    setAttachedScopes((prev) =>
      prev.includes(scopeId)
        ? prev.filter((s) => s !== scopeId)
        : [...prev, scopeId]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const id =
      initialPersona?.id ||
      name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + Date.now().toString(36);

    const persona: AgentPersona = {
      id,
      name: name.trim(),
      icon: icon.trim() || "🎭",
      tagline: tagline.trim(),
      system_prompt: systemPrompt.trim(),
      attached_scopes: attachedScopes,
      is_built_in: initialPersona?.is_built_in ?? false,
    };

    await savePersona(persona, getActiveCwd());
    onClose();
  };

  return (
    <div
      className="persona-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Create Persona"
      onClick={onClose}
    >
      <div
        className="persona-modal-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="persona-modal-header">
          <div className="persona-modal-title-box">
            <span className="persona-modal-icon-preview">{icon || "🎭"}</span>
            <h3 className="persona-modal-title">
              {initialPersona ? "Edit Persona" : "Create Persona"}
            </h3>
          </div>
          <button
            type="button"
            className="persona-modal-close-btn"
            onClick={onClose}
            aria-label="Close modal"
          >
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit} className="persona-modal-form">
          <div className="persona-modal-row">
            <div className="persona-input-group icon-field">
              <label htmlFor="persona-icon-input">Icon</label>
              <input
                id="persona-icon-input"
                type="text"
                className="persona-input"
                placeholder="🎭"
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                maxLength={4}
              />
            </div>
            <div className="persona-input-group name-field">
              <label htmlFor="persona-name-input">Persona Name</label>
              <input
                id="persona-name-input"
                type="text"
                className="persona-input"
                placeholder="Persona Name (e.g. Lead Architect)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoFocus
              />
            </div>
          </div>

          <div className="persona-input-group">
            <label htmlFor="persona-tagline-input">Tagline / Short Summary</label>
            <input
              id="persona-tagline-input"
              type="text"
              className="persona-input"
              placeholder="Tagline (e.g. Systems architect & code reviewer)"
              value={tagline}
              onChange={(e) => setTagline(e.target.value)}
            />
          </div>

          <div className="persona-input-group">
            <label htmlFor="persona-prompt-input">System Rules & Persona Prompt</label>
            <textarea
              id="persona-prompt-input"
              className="persona-textarea"
              rows={5}
              placeholder="System rules & behavioral prompt..."
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
            />
          </div>

          <div className="persona-input-group">
            <label className="persona-section-label">Attached Memory Scopes</label>
            <div className="persona-scopes-grid">
              {SCOPE_OPTIONS.map((scope) => {
                const checked = attachedScopes.includes(scope.id);
                return (
                  <label
                    key={scope.id}
                    className={`persona-scope-checkbox-label ${checked ? "active" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => handleScopeToggle(scope.id)}
                    />
                    <span>{scope.label}</span>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="persona-modal-actions">
            <button
              type="button"
              className="persona-modal-btn cancel"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="persona-modal-btn submit"
            >
              {initialPersona ? "Save Persona" : "Create Persona"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
