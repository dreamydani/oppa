import { useState, type ReactElement } from "react";
import { useContextStore } from "../../store/contextStore";
import { useTerminalStore } from "../../store/terminalStore";
import type { ContextPage } from "../../lib/context/transport";

export interface ContextTreeProps {
  onOpenPersonaModal?: () => void;
}

export function ContextTree({ onOpenPersonaModal }: ContextTreeProps): ReactElement {
  const pages = useContextStore((s) => s.pages);
  const personas = useContextStore((s) => s.personas);
  const selectedPageId = useContextStore((s) => s.selectedPageId);
  const selectedPersonaId = useContextStore((s) => s.selectedPersonaId);
  const selectPage = useContextStore((s) => s.selectPage);
  const selectPersona = useContextStore((s) => s.selectPersona);

  const getActiveCwd = useTerminalStore((s) => s.getActiveCwd);
  const cwd = getActiveCwd();

  const getProjectName = () => {
    if (!cwd) return "Default Workspace";
    const parts = cwd.split(/[/\\]/).filter(Boolean);
    return parts[parts.length - 1] || cwd;
  };

  const projectName = getProjectName();

  // Collapsed sections state
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({
    workspace: false,
    global: false,
    architecture: false,
    quirk: false,
    runbook: false,
    personas: false,
    preference: false,
    standards: false,
  });

  const toggleSection = (key: string) => {
    setCollapsedSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // Group pages by scope & category
  const workspaceArchPages = pages.filter(
    (p) => p.scope === "workspace" && p.category === "architecture"
  );
  const workspaceQuirkPages = pages.filter(
    (p) => p.scope === "workspace" && p.category === "quirk"
  );
  const workspaceRunbookPages = pages.filter(
    (p) => p.scope === "workspace" && p.category === "runbook"
  );

  const globalPrefPages = pages.filter(
    (p) => p.scope === "global" && p.category === "preference"
  );
  const globalStandardsPages = pages.filter(
    (p) => p.scope === "global" && p.category !== "preference"
  );

  const renderPageItem = (page: ContextPage) => {
    const isSelected = selectedPageId === page.id;
    return (
      <div
        key={page.id}
        className={`context-tree-item ${isSelected ? "selected" : ""}`}
        onClick={() => selectPage(page.id)}
        role="button"
        tabIndex={0}
      >
        <span className="context-tree-item-icon">{page.icon || "📄"}</span>
        <span className="context-tree-item-title">{page.title}</span>
        {page.pinned && <span className="context-tree-pin-badge" title="Pinned">📌</span>}
      </div>
    );
  };

  return (
    <aside className="context-tree" aria-label="Context Navigation Tree">
      <div className="context-tree-header">
        <span className="context-tree-heading">EXPLORER</span>
      </div>

      <div className="context-tree-content">
        {/* Workspace Section */}
        <div className="context-tree-section">
          <div
            className="context-tree-group-header root-header"
            onClick={() => toggleSection("workspace")}
          >
            <span className="tree-arrow">{collapsedSections.workspace ? "▶" : "▼"}</span>
            <span className="tree-icon">📁</span>
            <span className="tree-label">Workspace ({projectName})</span>
          </div>

          {!collapsedSections.workspace && (
            <div className="context-tree-subgroup">
              {/* Architecture Category */}
              <div className="context-tree-category">
                <div
                  className="context-tree-group-header category-header"
                  onClick={() => toggleSection("architecture")}
                >
                  <span className="tree-arrow">
                    {collapsedSections.architecture ? "▶" : "▼"}
                  </span>
                  <span className="tree-icon">🏗️</span>
                  <span className="tree-label">Architecture</span>
                  <span className="tree-count">{workspaceArchPages.length}</span>
                </div>
                {!collapsedSections.architecture && (
                  <div className="context-tree-leaves">
                    {workspaceArchPages.map(renderPageItem)}
                    {workspaceArchPages.length === 0 && (
                      <div className="context-tree-empty-hint">No notes</div>
                    )}
                  </div>
                )}
              </div>

              {/* Solved Quirks Category */}
              <div className="context-tree-category">
                <div
                  className="context-tree-group-header category-header"
                  onClick={() => toggleSection("quirk")}
                >
                  <span className="tree-arrow">
                    {collapsedSections.quirk ? "▶" : "▼"}
                  </span>
                  <span className="tree-icon">🐛</span>
                  <span className="tree-label">Solved Quirks</span>
                  <span className="tree-count">{workspaceQuirkPages.length}</span>
                </div>
                {!collapsedSections.quirk && (
                  <div className="context-tree-leaves">
                    {workspaceQuirkPages.map(renderPageItem)}
                    {workspaceQuirkPages.length === 0 && (
                      <div className="context-tree-empty-hint">No notes</div>
                    )}
                  </div>
                )}
              </div>

              {/* Runbooks Category */}
              <div className="context-tree-category">
                <div
                  className="context-tree-group-header category-header"
                  onClick={() => toggleSection("runbook")}
                >
                  <span className="tree-arrow">
                    {collapsedSections.runbook ? "▶" : "▼"}
                  </span>
                  <span className="tree-icon">⚡</span>
                  <span className="tree-label">Runbooks</span>
                  <span className="tree-count">{workspaceRunbookPages.length}</span>
                </div>
                {!collapsedSections.runbook && (
                  <div className="context-tree-leaves">
                    {workspaceRunbookPages.map(renderPageItem)}
                    {workspaceRunbookPages.length === 0 && (
                      <div className="context-tree-empty-hint">No notes</div>
                    )}
                  </div>
                )}
              </div>

              {/* Personas Category */}
              <div className="context-tree-category">
                <div
                  className="context-tree-group-header category-header"
                  onClick={() => toggleSection("personas")}
                >
                  <span className="tree-arrow">
                    {collapsedSections.personas ? "▶" : "▼"}
                  </span>
                  <span className="tree-icon">🎭</span>
                  <span className="tree-label">Personas</span>
                  <span className="tree-count">{personas.length}</span>
                </div>
                {!collapsedSections.personas && (
                  <div className="context-tree-leaves">
                    {personas.map((persona) => {
                      const isSelected = selectedPersonaId === persona.id;
                      return (
                        <div
                          key={persona.id}
                          className={`context-tree-item persona-item ${
                            isSelected ? "selected" : ""
                          }`}
                          onClick={() => selectPersona(persona.id)}
                          role="button"
                          tabIndex={0}
                        >
                          <span className="context-tree-item-icon">
                            {persona.icon || "🎭"}
                          </span>
                          <span className="context-tree-item-title">{persona.name}</span>
                          {persona.is_built_in && (
                            <span className="context-tree-builtin-badge">Built-in</span>
                          )}
                        </div>
                      );
                    })}
                    {onOpenPersonaModal && (
                      <button
                        type="button"
                        className="context-tree-add-btn"
                        onClick={onOpenPersonaModal}
                      >
                        + New Persona
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Global Profile Section */}
        <div className="context-tree-section">
          <div
            className="context-tree-group-header root-header"
            onClick={() => toggleSection("global")}
          >
            <span className="tree-arrow">{collapsedSections.global ? "▶" : "▼"}</span>
            <span className="tree-icon">🌐</span>
            <span className="tree-label">Global Profile (User)</span>
          </div>

          {!collapsedSections.global && (
            <div className="context-tree-subgroup">
              {/* Preferences */}
              <div className="context-tree-category">
                <div
                  className="context-tree-group-header category-header"
                  onClick={() => toggleSection("preference")}
                >
                  <span className="tree-arrow">
                    {collapsedSections.preference ? "▶" : "▼"}
                  </span>
                  <span className="tree-icon">⚙️</span>
                  <span className="tree-label">Preferences</span>
                  <span className="tree-count">{globalPrefPages.length}</span>
                </div>
                {!collapsedSections.preference && (
                  <div className="context-tree-leaves">
                    {globalPrefPages.map(renderPageItem)}
                    {globalPrefPages.length === 0 && (
                      <div className="context-tree-empty-hint">No preferences</div>
                    )}
                  </div>
                )}
              </div>

              {/* Universal Standards */}
              <div className="context-tree-category">
                <div
                  className="context-tree-group-header category-header"
                  onClick={() => toggleSection("standards")}
                >
                  <span className="tree-arrow">
                    {collapsedSections.standards ? "▶" : "▼"}
                  </span>
                  <span className="tree-icon">📜</span>
                  <span className="tree-label">Universal Standards</span>
                  <span className="tree-count">{globalStandardsPages.length}</span>
                </div>
                {!collapsedSections.standards && (
                  <div className="context-tree-leaves">
                    {globalStandardsPages.map(renderPageItem)}
                    {globalStandardsPages.length === 0 && (
                      <div className="context-tree-empty-hint">No standards</div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
