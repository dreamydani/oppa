import { useState, useEffect, type ReactElement } from "react";
import { useContextStore } from "../../store/contextStore";
import { useTerminalStore } from "../../store/terminalStore";
import { MarkdownViewer } from "../editor/MarkdownViewer";
import type { ContextPage, AgentPersona, ContextCategory } from "../../lib/context/transport";

export function ContextInspector(): ReactElement | null {
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
  const savePersona = useContextStore((s) => s.savePersona);

  const getActiveCwd = useTerminalStore((s) => s.getActiveCwd);

  const selectedPage = pages.find((p) => p.id === selectedPageId);
  const selectedPersona = personas.find((p) => p.id === selectedPersonaId);

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
    const updatedPage: ContextPage = {
      ...selectedPage,
      title: draftTitle.trim() || selectedPage.title,
      category: draftCategory,
      path: draftPath.trim() || selectedPage.path,
      abstract_l0: draftAbstract,
      overview_l1: draftOverview,
      details_l2: draftDetails,
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
          <span className="empty-inspector-icon">🧠</span>
          <h3>Context Inspector</h3>
          <p>
            Select a memory note or persona from the left explorer to inspect and
            edit context knowledge tiers (L0 Abstract, L1 Overview, L2 Raw Details).
          </p>
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
              <span className="persona-avatar-icon">{selectedPersona.icon || "🎭"}</span>
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
                  Cancel
                </button>
                <button
                  type="button"
                  className="inspector-action-btn primary"
                  onClick={handleSavePersona}
                >
                  💾 Save
                </button>
              </>
            ) : (
              <button
                type="button"
                className="inspector-action-btn"
                onClick={() => setIsEditing(true)}
              >
                ✏️ Edit
              </button>
            )}
          </div>
        </div>

        {/* Persona Sub-Tabs */}
        <div className="inspector-subtabs">
          <button
            type="button"
            className={`inspector-tab-btn ${activeTier === "l0" ? "active" : ""}`}
            onClick={() => setActiveTier("l0")}
          >
            L0 Summary
          </button>
          <button
            type="button"
            className={`inspector-tab-btn ${activeTier === "l1" ? "active" : ""}`}
            onClick={() => setActiveTier("l1")}
          >
            L1 System Rules & Prompt
          </button>
          <button
            type="button"
            className={`inspector-tab-btn ${activeTier === "l2" ? "active" : ""}`}
            onClick={() => setActiveTier("l2")}
          >
            L2 Attached Scopes
          </button>
        </div>

        {/* Persona Body */}
        <div className="inspector-body">
          {activeTier === "l0" && (
            <div className="inspector-tier-view">
              <div className="persona-overview-box">
                <h4>Persona Identity</h4>
                <p>{selectedPersona.tagline || "No summary provided."}</p>
                <div className="persona-meta-row">
                  <span>ID: <code>{selectedPersona.id}</code></span>
                  <span>Type: {selectedPersona.is_built_in ? "System Template" : "User Defined"}</span>
                </div>
              </div>
            </div>
          )}

          {activeTier === "l1" && (
            <div className="inspector-tier-view">
              {isEditing ? (
                <div className="inspector-edit-field">
                  <label htmlFor="persona-prompt-editor">System Rules & Persona Prompt</label>
                  <textarea
                    id="persona-prompt-editor"
                    className="inspector-textarea"
                    rows={12}
                    value={draftPersonaPrompt}
                    onChange={(e) => setDraftPersonaPrompt(e.target.value)}
                  />
                </div>
              ) : (
                <div className="persona-prompt-preview">
                  <MarkdownViewer
                    content={
                      selectedPersona.system_prompt ||
                      "_No system prompt defined for this persona._"
                    }
                  />
                </div>
              )}
            </div>
          )}

          {activeTier === "l2" && (
            <div className="inspector-tier-view">
              <h4>Attached Memory Scopes</h4>
              <p className="tier-desc">
                Defines which knowledge categories this persona automatically references when generating context.
              </p>
              <div className="persona-scope-tags">
                {selectedPersona.attached_scopes.map((scope) => (
                  <span key={scope} className="scope-tag">
                    {scope}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Render Memory Page View
  if (!selectedPage) return null;

  return (
    <div className="context-inspector" aria-label="Context Inspector">
      {/* Header */}
      <div className="inspector-header">
        <div className="inspector-header-meta">
          <div className="inspector-title-row">
            <span className="inspector-icon">{selectedPage.icon || "📄"}</span>
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
            <span className="inspector-badge scope-badge">{selectedPage.scope}</span>
            <span className="inspector-badge category-badge">{selectedPage.category}</span>
          </div>
          <div className="inspector-path-row">
            <code>{selectedPage.path}</code>
          </div>
        </div>

        <div className="inspector-actions">
          <button
            type="button"
            className={`inspector-action-btn pin-btn ${selectedPage.pinned ? "pinned" : ""}`}
            onClick={handleTogglePin}
            title={selectedPage.pinned ? "Unpin note" : "Pin note"}
            aria-label="Pin"
          >
            {selectedPage.pinned ? "📍 Unpin" : "📌 Pin"}
          </button>
          {isEditing ? (
            <>
              <button
                type="button"
                className="inspector-action-btn cancel"
                onClick={() => setIsEditing(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="inspector-action-btn primary"
                onClick={handleSavePage}
                aria-label="Save"
              >
                💾 Save
              </button>
            </>
          ) : (
            <button
              type="button"
              className="inspector-action-btn"
              onClick={() => setIsEditing(true)}
              aria-label="Edit"
            >
              ✏️ Edit
            </button>
          )}
          <button
            type="button"
            className="inspector-action-btn danger"
            onClick={handleDeletePage}
            title="Delete this note"
            aria-label="Delete"
          >
            🗑️ Delete
          </button>
        </div>
      </div>

      {/* 3 Knowledge Tiers Sub-Tabs */}
      <div className="inspector-subtabs">
        <button
          type="button"
          className={`inspector-tab-btn ${activeTier === "l0" ? "active" : ""}`}
          onClick={() => setActiveTier("l0")}
        >
          L0 Abstract
        </button>
        <button
          type="button"
          className={`inspector-tab-btn ${activeTier === "l1" ? "active" : ""}`}
          onClick={() => setActiveTier("l1")}
        >
          L1 Overview
        </button>
        <button
          type="button"
          className={`inspector-tab-btn ${activeTier === "l2" ? "active" : ""}`}
          onClick={() => setActiveTier("l2")}
        >
          L2 Raw Details
        </button>
      </div>

      {/* Inspector Body */}
      <div className="inspector-body">
        {isEditing ? (
          <div className="inspector-editor-wrapper">
            {activeTier === "l0" && (
              <div className="inspector-edit-field">
                <label htmlFor="tier-l0-textarea">
                  L0 Abstract (Ultra-concise high-level summary)
                </label>
                <textarea
                  id="tier-l0-textarea"
                  className="inspector-textarea"
                  rows={6}
                  value={draftAbstract}
                  onChange={(e) => setDraftAbstract(e.target.value)}
                  placeholder="L0 abstract summary..."
                />
              </div>
            )}
            {activeTier === "l1" && (
              <div className="inspector-edit-field">
                <label htmlFor="tier-l1-textarea">
                  L1 Overview (Markdown formatted structured explanation)
                </label>
                <textarea
                  id="tier-l1-textarea"
                  className="inspector-textarea"
                  rows={14}
                  value={draftOverview}
                  onChange={(e) => setDraftOverview(e.target.value)}
                  placeholder="## L1 Overview (Markdown)..."
                />
              </div>
            )}
            {activeTier === "l2" && (
              <div className="inspector-edit-field">
                <label htmlFor="tier-l2-textarea">
                  L2 Raw Details (Full deep implementation, code blocks & specs)
                </label>
                <textarea
                  id="tier-l2-textarea"
                  className="inspector-textarea"
                  rows={16}
                  value={draftDetails}
                  onChange={(e) => setDraftDetails(e.target.value)}
                  placeholder="### L2 Raw Details..."
                />
              </div>
            )}
          </div>
        ) : (
          <div className="inspector-tier-content">
            {activeTier === "l0" && (
              <div className="tier-l0-box">
                <p className="tier-l0-text">
                  {selectedPage.abstract_l0 || "No L0 abstract provided."}
                </p>
              </div>
            )}
            {activeTier === "l1" && (
              <div className="tier-l1-box">
                <MarkdownViewer
                  content={
                    selectedPage.overview_l1 ||
                    "_No L1 overview documentation provided._"
                  }
                />
              </div>
            )}
            {activeTier === "l2" && (
              <div className="tier-l2-box">
                {selectedPage.details_l2 ? (
                  <MarkdownViewer content={selectedPage.details_l2} />
                ) : (
                  <div className="empty-tier-placeholder">
                    <span>No raw details (L2) stored for this page.</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
