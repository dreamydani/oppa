import { useState, type ReactElement } from "react";
import { useContextStore } from "../../store/contextStore";
import { useTerminalStore } from "../../store/terminalStore";
import {
  IconFolder,
  IconArchitecture,
  IconQuirk,
  IconRunbook,
  IconPersona,
  IconPreferences,
  IconStandards,
  IconPin,
  IconChevronDown,
  IconChevronRight,
  IconPlus,
  IconFile,
  IconGlobe,
} from "./ContextIcons";
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
        <span className="context-tree-item-icon">
          <IconFile size={13} />
        </span>
        <span className="context-tree-item-title">{page.title}</span>
        {page.pinned && (
          <span className="context-tree-pin-badge" title="Pinned">
            <IconPin size={11} />
          </span>
        )}
      </div>
    );
  };

  return (
    <aside className="context-tree" aria-label="Context Navigation Tree">
      <div className="context-tree-header">
        <span className="context-tree-heading">EXPLORER</span>
      </div>

      <div className="context-tree-content">
        {/* Workspace Scope Section */}
        <div className="context-tree-section">
          <div
            className="context-tree-group-header root-header"
            onClick={() => toggleSection("workspace")}
          >
            <span className="tree-arrow">
              {collapsedSections.workspace ? <IconChevronRight size={11} /> : <IconChevronDown size={11} />}
            </span>
            <span className="tree-icon">
              <IconFolder size={14} />
            </span>
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
                    {collapsedSections.architecture ? <IconChevronRight size={10} /> : <IconChevronDown size={10} />}
                  </span>
                  <span className="tree-icon">
                    <IconArchitecture size={13} />
                  </span>
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
                    {collapsedSections.quirk ? <IconChevronRight size={10} /> : <IconChevronDown size={10} />}
                  </span>
                  <span className="tree-icon">
                    <IconQuirk size={13} />
                  </span>
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
                    {collapsedSections.runbook ? <IconChevronRight size={10} /> : <IconChevronDown size={10} />}
                  </span>
                  <span className="tree-icon">
                    <IconRunbook size={13} />
                  </span>
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
                    {collapsedSections.personas ? <IconChevronRight size={10} /> : <IconChevronDown size={10} />}
                  </span>
                  <span className="tree-icon">
                    <IconPersona size={13} />
                  </span>
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
                          className={`context-tree-item ${isSelected ? "selected" : ""}`}
                          onClick={() => selectPersona(persona.id)}
                          role="button"
                          tabIndex={0}
                        >
                          <span className="context-tree-item-icon">
                            <IconPersona size={13} />
                          </span>
                          <span className="context-tree-item-title">{persona.name}</span>
                          {persona.is_built_in && (
                            <span className="context-tree-builtin-pill">Core</span>
                          )}
                        </div>
                      );
                    })}
                    <button
                      type="button"
                      className="context-tree-add-persona-btn"
                      onClick={onOpenPersonaModal}
                    >
                      <IconPlus size={11} />
                      <span>New Persona</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Global Scope Section */}
        <div className="context-tree-section">
          <div
            className="context-tree-group-header root-header"
            onClick={() => toggleSection("global")}
          >
            <span className="tree-arrow">
              {collapsedSections.global ? <IconChevronRight size={11} /> : <IconChevronDown size={11} />}
            </span>
            <span className="tree-icon">
              <IconGlobe size={14} />
            </span>
            <span className="tree-label">Global Profile (User)</span>
          </div>

          {!collapsedSections.global && (
            <div className="context-tree-subgroup">
              {/* Preferences Category */}
              <div className="context-tree-category">
                <div
                  className="context-tree-group-header category-header"
                  onClick={() => toggleSection("preference")}
                >
                  <span className="tree-arrow">
                    {collapsedSections.preference ? <IconChevronRight size={10} /> : <IconChevronDown size={10} />}
                  </span>
                  <span className="tree-icon">
                    <IconPreferences size={13} />
                  </span>
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

              {/* Universal Standards Category */}
              <div className="context-tree-category">
                <div
                  className="context-tree-group-header category-header"
                  onClick={() => toggleSection("standards")}
                >
                  <span className="tree-arrow">
                    {collapsedSections.standards ? <IconChevronRight size={10} /> : <IconChevronDown size={10} />}
                  </span>
                  <span className="tree-icon">
                    <IconStandards size={13} />
                  </span>
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
