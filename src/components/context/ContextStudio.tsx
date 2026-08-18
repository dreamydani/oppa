import { useState, useEffect, type ReactElement } from "react";
import { useContextStore } from "../../store/contextStore";
import { useTerminalStore } from "../../store/terminalStore";
import { ContextTree } from "./ContextTree";
import { ContextInspector } from "./ContextInspector";
import { ContextStatusPanel } from "./ContextStatusPanel";
import { PersonaModal } from "./PersonaModal";
import { McpConfigModal } from "./McpConfigModal";
import {
  IconSearch,
  IconPlus,
  IconClose,
  IconFile,
  IconPersona,
  IconChevronDown,
  IconServer,
} from "./ContextIcons";
import type { ContextPage } from "../../lib/context/transport";
import "./ContextStudio.css";

export function ContextStudio(): ReactElement {
  const loadContext = useContextStore((s) => s.loadContext);
  const searchQuery = useContextStore((s) => s.searchQuery);
  const setSearchQuery = useContextStore((s) => s.setSearchQuery);
  const searchContext = useContextStore((s) => s.searchContext);
  const savePage = useContextStore((s) => s.savePage);
  const setIsEditing = useContextStore((s) => s.setIsEditing);
  const selectPage = useContextStore((s) => s.selectPage);

  const getActiveCwd = useTerminalStore((s) => s.getActiveCwd);

  const [isPersonaModalOpen, setIsPersonaModalOpen] = useState(false);
  const [isMcpModalOpen, setIsMcpModalOpen] = useState(false);
  const [isAddMenuOpen, setIsAddMenuOpen] = useState(false);

  // Load context on initial mount
  useEffect(() => {
    void loadContext(getActiveCwd());
  }, [loadContext, getActiveCwd]);

  const handleSearchChange = (val: string) => {
    setSearchQuery(val);
    void searchContext(val, getActiveCwd());
  };

  const handleClearSearch = () => {
    setSearchQuery("");
    void searchContext("", getActiveCwd());
  };

  const handleCreateDraftNote = async () => {
    setIsAddMenuOpen(false);
    const draftId = `page-note-${Date.now()}`;
    const newPage: ContextPage = {
      id: draftId,
      scope: "workspace",
      category: "architecture",
      path: `architecture/note-${Date.now().toString(36)}`,
      title: "Untitled Note",
      icon: "file",
      abstract_l0: "",
      overview_l1: "",
      details_l2: "",
      pinned: false,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    await savePage(newPage, getActiveCwd());
    selectPage(draftId);
    setIsEditing(true);
  };

  return (
    <div className="context-studio" data-testid="context-studio">
      {/* Minimalist Studio Top Bar */}
      <header className="context-studio-header">
        <div className="context-search-bar-wrapper">
          <IconSearch size={14} className="context-search-icon" />
          <input
            type="text"
            className="context-search-input"
            placeholder="Search all context, rules & personas... (FTS5 instant lookup)"
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
          />
          {searchQuery ? (
            <button
              type="button"
              className="context-search-clear-btn"
              onClick={handleClearSearch}
              title="Clear search"
              aria-label="Clear search"
            >
              <IconClose size={12} />
            </button>
          ) : (
            <span className="context-search-kbd">⌘K</span>
          )}
        </div>

        <div className="context-studio-actions">
          <button
            type="button"
            className="context-mcp-config-btn"
            onClick={() => setIsMcpModalOpen(true)}
            aria-label="MCP Config"
          >
            <IconServer size={13} />
            <span>MCP Config</span>
          </button>

          <div className="context-add-dropdown-container">
            <button
              type="button"
              className="context-add-btn"
              onClick={() => setIsAddMenuOpen((prev) => !prev)}
              aria-label="+ Add Item"
            >
              <IconPlus size={13} />
              <span>+ Add Item</span>
              <IconChevronDown size={10} className="dropdown-arrow-icon" />
            </button>
            {isAddMenuOpen && (
              <div className="context-add-menu">
                <button
                  type="button"
                  className="context-add-menu-item"
                  onClick={handleCreateDraftNote}
                >
                  <IconFile size={14} className="menu-item-icon" />
                  <span>+ New Memory Note</span>
                </button>
                <button
                  type="button"
                  className="context-add-menu-item"
                  onClick={() => {
                    setIsAddMenuOpen(false);
                    setIsPersonaModalOpen(true);
                  }}
                >
                  <IconPersona size={14} className="menu-item-icon" />
                  <span>+ New Persona</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* 3-Column Studio Workbench */}
      <div className="context-studio-workbench">
        <ContextTree onOpenPersonaModal={() => setIsPersonaModalOpen(true)} />
        <ContextInspector
          onOpenNewNote={handleCreateDraftNote}
          onOpenNewPersona={() => setIsPersonaModalOpen(true)}
        />
        <ContextStatusPanel />
      </div>

      {/* Persona Creation Modal */}
      {isPersonaModalOpen && (
        <PersonaModal
          isOpen={isPersonaModalOpen}
          onClose={() => setIsPersonaModalOpen(false)}
        />
      )}

      {/* MCP Configuration Modal */}
      {isMcpModalOpen && (
        <McpConfigModal
          isOpen={isMcpModalOpen}
          onClose={() => setIsMcpModalOpen(false)}
          workspacePath={getActiveCwd()}
        />
      )}
    </div>
  );
}
