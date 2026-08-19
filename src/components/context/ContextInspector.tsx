import { useState, useEffect, type ReactElement } from "react";
import { useContextStore } from "../../store/contextStore";
import { useTerminalStore } from "../../store/terminalStore";
import { MarkdownViewer } from "../editor/MarkdownViewer";
import {
  IconPin,
  IconEdit,
  IconTrash,
  IconCheck,
  IconClose,
  IconBrain,
  IconPlus,
  IconPersona,
} from "./ContextIcons";
import type { ContextPage, AgentPersona, ContextCategory } from "../../lib/context/transport";

export interface ContextInspectorProps {
  onOpenNewNote?: () => void;
  onOpenNewPersona?: () => void;
}

export interface ScopeChipEditorProps {
  scopes: string[];
  onChange: (scopes: string[]) => void;
  disabled?: boolean;
}

export const SCOPE_TOKEN_OPTIONS = [
  "global",
  "workspace",
  "architecture",
  "quirks",
  "runbooks",
  "preferences",
  "personas",
];

export function ScopeChipEditor({
  scopes,
  onChange,
  disabled,
}: ScopeChipEditorProps): ReactElement {
  const toggle = (token: string) => {
    if (disabled) return;
    onChange(
      scopes.includes(token) ? scopes.filter((s) => s !== token) : [...scopes, token]
    );
  };

  return (
    <div className="persona-scopes-editor">
      <p className="persona-scopes-help">Toggle the memory folders this persona mounts:</p>
      <div className="persona-scopes-list">
        {SCOPE_TOKEN_OPTIONS.map((token) => {
          const active = scopes.includes(token);
          return (
            <button
              key={token}
              type="button"
              className={`persona-scope-chip monospace ${active ? "active" : ""}`}
              onClick={() => toggle(token)}
            >
              {token}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function ContextInspector({
  onOpenNewNote,
  onOpenNewPersona,
}: ContextInspectorProps): ReactElement | null {
  const pages = useContextStore((s) => s.pages);
  const personas = useContextStore((s) => s.personas);
  const selectedPageId = useContextStore((s) => s.selectedPageId);
  const selectedPersonaId = useContextStore((s) => s.selectedPersonaId);
  const activeTier = useContextStore((s) => s.activeTier);
  const setActiveTier = useContextStore((s) => s.setActiveTier);
  const isEditing = useContextStore((s) => s.isEditing);
  const setIsEditing = useContextStore((s) => s.setIsEditing);
  const savePage = useContextStore((s) => s.savePage);
  const deletePage = useContextStore((s) => s.deletePage);
  const restorePage = useContextStore((s) => s.restorePage);
  const savePersona = useContextStore((s) => s.savePersona);
  const lastError = useContextStore((s) => s.lastError);
  const clearError = useContextStore((s) => s.clearError);

  const getActiveCwd = useTerminalStore((s) => s.getActiveCwd);

  const selectedPage = (pages ?? []).find((p) => p.id === selectedPageId);
  const selectedPersona = (personas ?? []).find((p) => p.id === selectedPersonaId);

  // Local edit states for page
  const [draftTitle, setDraftTitle] = useState("");
  const [draftCategory, setDraftCategory] = useState<ContextCategory>("architecture");
  const [draftPath, setDraftPath] = useState("");
  const [draftAbstract, setDraftAbstract] = useState("");
  const [draftOverview, setDraftOverview] = useState("");
  const [draftDetails, setDraftDetails] = useState("");

  // Local edit states for persona
  const [draftPersonaPrompt, setDraftPersonaPrompt] = useState("");
  const [draftPersonaScopes, setDraftPersonaScopes] = useState<string[]>([]);

  useEffect(() => {
    if (selectedPage) {
      setDraftTitle(selectedPage.title);
      setDraftCategory(selectedPage.category);
      setDraftPath(selectedPage.path);
      setDraftAbstract(selectedPage.abstract_l0 || "");
      setDraftOverview(selectedPage.overview_l1 || "");
      setDraftDetails(selectedPage.details_l2 || "");
      if (selectedPage.category === "persona") {
        try {
          const parsed = JSON.parse(selectedPage.attached_scopes_json || "[]");
          setDraftPersonaScopes(Array.isArray(parsed) ? parsed : []);
        } catch {
          setDraftPersonaScopes([]);
        }
      }
    }
  }, [selectedPage]);

  useEffect(() => {
    if (selectedPersona) {
      setDraftPersonaPrompt(selectedPersona.system_prompt || "");
      setDraftPersonaScopes(selectedPersona.attached_scopes || []);
    }
  }, [selectedPersona]);

  // Handle saving page edits
  const handleSavePage = async () => {
    if (!selectedPage) return;
    const isPersona = selectedPage.category === "persona";
    const updatedPage: ContextPage = {
      ...selectedPage,
      title: draftTitle.trim() || selectedPage.title,
      category: draftCategory,
      path: draftPath.trim() || selectedPage.path,
      abstract_l0: draftAbstract,
      overview_l1: draftOverview,
      details_l2: isPersona ? undefined : draftDetails,
      attached_scopes_json: isPersona
        ? JSON.stringify(draftPersonaScopes)
        : selectedPage.attached_scopes_json,
      updated_at: Date.now(),
    };
    await savePage(updatedPage, getActiveCwd());
  };

  // Handle toggling pin
  const handleTogglePin = async () => {
    if (!selectedPage) return;
    const updatedPage: ContextPage = {
      ...selectedPage,
      pinned: !selectedPage.pinned,
      updated_at: Date.now(),
    };
    await savePage(updatedPage, getActiveCwd());
  };

  // Handle delete
  const handleDeletePage = async () => {
    if (!selectedPage) return;
    await deletePage(selectedPage.id, selectedPage.scope, getActiveCwd());
  };

  // Handle restore
  const handleRestorePage = async () => {
    if (!selectedPage) return;
    await restorePage(selectedPage.id, selectedPage.scope, getActiveCwd());
  };

  // Handle save persona prompt / scopes
  const handleSavePersona = async () => {
    if (!selectedPersona) return;
    const updatedPersona: AgentPersona = {
      ...selectedPersona,
      system_prompt: draftPersonaPrompt,
      attached_scopes: draftPersonaScopes,
    };
    await savePersona(updatedPersona, getActiveCwd());
    setIsEditing(false);
  };

  if (!selectedPage && !selectedPersona) {
    return (
      <div className="context-inspector context-inspector-empty">
        <div className="empty-inspector-card">
          <div className="empty-inspector-icon-wrapper">
            <IconBrain size={28} className="empty-inspector-icon" />
          </div>
          <h3 className="empty-inspector-title">Context & Persona Studio</h3>
          <p className="empty-inspector-desc">
            Select a memory note or persona from the left explorer to inspect and edit context knowledge tiers (L0 Abstract, L1 Overview, L2 Raw Details).
          </p>
          <div className="empty-inspector-actions">
            <button
              type="button"
              className="empty-inspector-btn primary"
              onClick={onOpenNewNote}
            >
              <IconPlus size={12} />
              <span>+ New Memory Note</span>
            </button>
            <button
              type="button"
              className="empty-inspector-btn secondary"
              onClick={onOpenNewPersona}
            >
              <IconPersona size={12} />
              <span>+ New Persona</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Render Persona View
  if (selectedPersona) {
    return (
      <div className="context-inspector" aria-label="Persona Inspector">
        <div className="inspector-header persona-header">
          <div className="inspector-header-meta">
            <div className="inspector-title-row">
              <span className="persona-avatar-icon">
                <IconPersona size={16} />
              </span>
              <h2 className="inspector-title">{selectedPersona.name}</h2>
              <span
                className={`inspector-badge ${
                  selectedPersona.is_built_in ? "builtin" : "custom"
                }`}
              >
                {selectedPersona.is_built_in ? "Built-in" : "Custom"}
              </span>
            </div>
            <div className="persona-tagline-text">{selectedPersona.tagline}</div>
          </div>
          <div className="inspector-actions">
            {isEditing ? (
              <>
                <button
                  type="button"
                  className="inspector-action-btn cancel"
                  onClick={() => setIsEditing(false)}
                >
                  <IconClose size={12} />
                  <span>Cancel</span>
                </button>
                <button
                  type="button"
                  className="inspector-action-btn save"
                  onClick={handleSavePersona}
                >
                  <IconCheck size={12} />
                  <span>Save Persona</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                className="inspector-action-btn edit"
                onClick={() => setIsEditing(true)}
              >
                <IconEdit size={12} />
                <span>Edit Prompt</span>
              </button>
            )}
          </div>
        </div>

        {/* Segmented Control Sub-Tabs */}
        <div className="inspector-tier-tabs">
          <button
            type="button"
            className={`tier-tab-btn ${activeTier === "l0" ? "active" : ""}`}
            onClick={() => setActiveTier("l0")}
          >
            <span>L0 Summary</span>
            <span className="tier-pill">Abstract</span>
          </button>
          <button
            type="button"
            className={`tier-tab-btn ${activeTier === "l1" ? "active" : ""}`}
            onClick={() => setActiveTier("l1")}
          >
            <span>L1 System Rules</span>
            <span className="tier-pill">Prompt</span>
          </button>
          <button
            type="button"
            className={`tier-tab-btn ${activeTier === "l2" ? "active" : ""}`}
            onClick={() => setActiveTier("l2")}
          >
            <span>L2 Attached Scopes</span>
            <span className="tier-pill">Knowledge</span>
          </button>
        </div>

        {/* Content Body */}
        <div className="inspector-body">
          {lastError && (
            <div className="inspector-error-banner" role="alert">
              <span>{lastError}</span>
              <button
                type="button"
                className="inspector-error-dismiss-btn"
                onClick={clearError}
              >
                Dismiss
              </button>
            </div>
          )}

          {activeTier === "l0" && (
            <div className="persona-l0-view">
              <div className="persona-meta-grid">
                <div className="persona-meta-card">
                  <div className="meta-card-label">ROLE IDENTIFIER</div>
                  <div className="meta-card-value monospace">{selectedPersona.id}</div>
                </div>
                <div className="persona-meta-card">
                  <div className="meta-card-label">CLASSIFICATION</div>
                  <div className="meta-card-value">
                    {selectedPersona.is_built_in ? "Core System Role" : "Custom Workspace Role"}
                  </div>
                </div>
              </div>
              <div className="persona-summary-box">
                <h4>System Role Summary</h4>
                <p>{selectedPersona.tagline}</p>
              </div>
            </div>
          )}

          {activeTier === "l1" && (
            <div className="persona-l1-view">
              {isEditing ? (
                <div className="persona-edit-box">
                  <label htmlFor="persona-prompt-editor" className="editor-label">
                    System Rules & Behavioral Instructions
                  </label>
                  <textarea
                    id="persona-prompt-editor"
                    className="inspector-textarea monospace"
                    rows={12}
                    value={draftPersonaPrompt}
                    onChange={(e) => setDraftPersonaPrompt(e.target.value)}
                    placeholder="Instructions for CLI agents running under this persona..."
                  />
                </div>
              ) : (
                <div className="persona-prompt-display">
                  <div className="prompt-display-header">
                    <span>SYSTEM PROMPT INJECTION</span>
                  </div>
                  <pre className="persona-prompt-pre monospace">
                    {selectedPersona.system_prompt || "No behavioral prompt defined."}
                  </pre>
                </div>
              )}
            </div>
          )}

          {activeTier === "l2" && (
            <div className="persona-l2-view">
              <div className="persona-scopes-header">
                <h4>Mounted Context Folders</h4>
                <p>When this persona is assigned to a terminal, these memory folders are loaded into context.</p>
              </div>
              <ScopeChipEditor
                scopes={draftPersonaScopes}
                onChange={setDraftPersonaScopes}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  if (!selectedPage) return null;

  const isPersonaPage = selectedPage.category === "persona";

  // Render Memory Page View
  return (
    <div className="context-inspector" aria-label="Context Page Inspector">
      <div className="inspector-header page-header">
        <div className="inspector-header-meta">
          <div className="inspector-title-row">
            <span className="page-category-badge">{selectedPage.category.toUpperCase()}</span>
            {isEditing ? (
              <input
                type="text"
                className="inspector-title-input"
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                placeholder="Page Title"
              />
            ) : (
              <h2 className="inspector-title">{selectedPage.title}</h2>
            )}
          </div>
          <div className="inspector-path-row monospace">
            <span className="path-prefix">{selectedPage.scope}://</span>
            {isEditing ? (
              <input
                type="text"
                className="inspector-path-input monospace"
                value={draftPath}
                onChange={(e) => setDraftPath(e.target.value)}
                placeholder="path/to/note"
              />
            ) : (
              <span className="path-text">{selectedPage.path}</span>
            )}
          </div>
        </div>

        <div className="inspector-actions">
          {selectedPage.deleted_at ? (
            <button
              type="button"
              className="inspector-action-btn restore"
              onClick={handleRestorePage}
              title="Restore deleted memory page"
            >
              <IconCheck size={12} />
              <span>Restore</span>
            </button>
          ) : (
            <>
              <button
                type="button"
                className={`inspector-action-btn pin ${selectedPage.pinned ? "active" : ""}`}
                onClick={handleTogglePin}
                title={selectedPage.pinned ? "Unpin memory" : "Pin memory"}
              >
                <IconPin size={13} />
                <span>{selectedPage.pinned ? "Pinned" : "Pin"}</span>
              </button>
              {isEditing ? (
                <>
                  <button
                    type="button"
                    className="inspector-action-btn cancel"
                    onClick={() => setIsEditing(false)}
                  >
                    <IconClose size={12} />
                    <span>Cancel</span>
                  </button>
                  <button
                    type="button"
                    className="inspector-action-btn save"
                    onClick={handleSavePage}
                  >
                    <IconCheck size={12} />
                    <span>Save</span>
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="inspector-action-btn edit"
                  onClick={() => setIsEditing(true)}
                >
                  <IconEdit size={12} />
                  <span>Edit</span>
                </button>
              )}
              {!selectedPage.is_built_in && (
                <button
                  type="button"
                  className="inspector-action-btn delete"
                  onClick={handleDeletePage}
                  title="Delete memory page"
                >
                  <IconTrash size={13} />
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Segmented Control Sub-Tabs */}
      <div className="inspector-tier-tabs">
        <button
          type="button"
          className={`tier-tab-btn ${activeTier === "l0" ? "active" : ""}`}
          onClick={() => setActiveTier("l0")}
        >
          <span>{isPersonaPage ? "L0 Summary" : "L0 Abstract"}</span>
          <span className="tier-pill">{isPersonaPage ? "Abstract" : "~100 Tokens"}</span>
        </button>
        <button
          type="button"
          className={`tier-tab-btn ${activeTier === "l1" ? "active" : ""}`}
          onClick={() => setActiveTier("l1")}
        >
          <span>{isPersonaPage ? "L1 System Rules" : "L1 Overview"}</span>
          <span className="tier-pill">{isPersonaPage ? "Prompt" : "~1.5k Tokens"}</span>
        </button>
        <button
          type="button"
          className={`tier-tab-btn ${activeTier === "l2" ? "active" : ""}`}
          onClick={() => setActiveTier("l2")}
        >
          <span>{isPersonaPage ? "L2 Attached Scopes" : "L2 Raw Details"}</span>
          <span className="tier-pill">{isPersonaPage ? "Knowledge" : "Full Text"}</span>
        </button>
      </div>

      {/* Content Body */}
      <div className="inspector-body">
        {lastError && (
          <div className="inspector-error-banner" role="alert">
            <span>{lastError}</span>
            <button
              type="button"
              className="inspector-error-dismiss-btn"
              onClick={clearError}
            >
              Dismiss
            </button>
          </div>
        )}

        {activeTier === "l0" && (
          <div className="tier-content l0-content">
            <div className="tier-info-banner">
              <span className="tier-info-title">
                {isPersonaPage
                  ? "L0 Role Summary (System Injection)"
                  : "L0 Abstract (System Prompt Injection)"}
              </span>
              <span className="tier-info-desc">
                {isPersonaPage
                  ? "Tagline and concise high-level description for this agent role."
                  : "High-density 1-2 sentence summary used for fast scanning and prompt routing."}
              </span>
            </div>
            {isEditing ? (
              <textarea
                className="inspector-textarea"
                rows={5}
                value={draftAbstract}
                onChange={(e) => setDraftAbstract(e.target.value)}
                placeholder={
                  isPersonaPage
                    ? "Write a concise role summary tagline..."
                    : "Write a concise ~100-token summary..."
                }
              />
            ) : (
              <div className="rendered-abstract-box">
                <p>{selectedPage.abstract_l0 || "No abstract written."}</p>
              </div>
            )}
          </div>
        )}

        {activeTier === "l1" && (
          <div className="tier-content l1-content">
            <div className="tier-info-banner">
              <span className="tier-info-title">
                {isPersonaPage
                  ? "L1 System Rules (System Prompt)"
                  : "L1 Structured Overview (Markdown)"}
              </span>
              <span className="tier-info-desc">
                {isPersonaPage
                  ? "Core behavioral instructions and system prompt for agent sessions."
                  : "Core architectural documentation, key endpoints, resolution steps, and patterns."}
              </span>
            </div>
            {isEditing ? (
              <textarea
                className="inspector-textarea monospace"
                rows={14}
                value={draftOverview}
                onChange={(e) => setDraftOverview(e.target.value)}
                placeholder={
                  isPersonaPage
                    ? "Write system rules and behavioral prompt..."
                    : "Write structured Markdown overview..."
                }
              />
            ) : (
              <div className="rendered-markdown-wrapper">
                <MarkdownViewer
                  content={
                    selectedPage.overview_l1 ||
                    (isPersonaPage ? "*No system prompt defined.*" : "*No overview documentation.*")
                  }
                />
              </div>
            )}
          </div>
        )}

        {activeTier === "l2" && (
          <div className="tier-content l2-content">
            <div className="tier-info-banner">
              <span className="tier-info-title">
                {isPersonaPage ? "L2 Attached Scopes" : "L2 Raw Details (On-Demand Retrieval)"}
              </span>
              <span className="tier-info-desc">
                {isPersonaPage
                  ? "Memory folders this persona automatically loads into agent context."
                  : "Uncompressed stack traces, code snippets, logs, or original diffs."}
              </span>
            </div>
            {isPersonaPage ? (
              <ScopeChipEditor
                scopes={draftPersonaScopes}
                onChange={setDraftPersonaScopes}
              />
            ) : isEditing ? (
              <textarea
                className="inspector-textarea monospace"
                rows={14}
                value={draftDetails}
                onChange={(e) => setDraftDetails(e.target.value)}
                placeholder="Paste raw compiler logs, stack traces, or code snippets..."
              />
            ) : (
              <div className="rendered-details-box monospace">
                {selectedPage.details_l2 ? (
                  <pre>{selectedPage.details_l2}</pre>
                ) : (
                  <div className="details-empty-state">No raw details attached.</div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
