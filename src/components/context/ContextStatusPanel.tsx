import { type ReactElement } from "react";
import { useContextStore } from "../../store/contextStore";
import { useTerminalStore } from "../../store/terminalStore";
import type { ContextSearchResult } from "../../lib/context/transport";

export function ContextStatusPanel(): ReactElement {
  const pages = useContextStore((s) => s.pages);
  const personas = useContextStore((s) => s.personas);
  const searchQuery = useContextStore((s) => s.searchQuery);
  const searchResults = useContextStore((s) => s.searchResults);
  const selectPage = useContextStore((s) => s.selectPage);

  const sessions = useTerminalStore((s) => s.sessions);
  const setSessionPersona = useTerminalStore((s) => s.setSessionPersona);
  const getActiveCwd = useTerminalStore((s) => s.getActiveCwd);

  const sessionList = Object.values(sessions);
  const pinnedPagesCount = pages.filter((p) => p.pinned).length;
  const workspacePagesCount = pages.filter((p) => p.scope === "workspace").length;
  const globalPagesCount = pages.filter((p) => p.scope === "global").length;

  const handlePersonaChange = (sessionId: string, value: string) => {
    setSessionPersona(sessionId, value === "none" ? null : value);
  };

  return (
    <aside className="context-status-panel" aria-label="Context Status & Search Panel">
      <div className="status-panel-header">
        <span className="status-panel-heading">CONTEXT & SESSIONS</span>
      </div>

      <div className="status-panel-content">
        {/* Section 1: Active Terminal Panes & Personas */}
        <div className="status-section active-panes-section">
          <div className="status-section-header">
            <span className="status-section-title">Active Terminal Sessions</span>
            <span className="status-section-badge">{sessionList.length}</span>
          </div>
          <div className="active-sessions-list">
            {sessionList.map((sess) => {
              const assignedPersona = personas.find((p) => p.id === sess.personaId);
              return (
                <div key={sess.id} className="active-session-card">
                  <div className="session-card-header">
                    <span className="session-card-title">{sess.title || sess.id}</span>
                    <span className={`session-status-dot ${sess.status}`} />
                  </div>
                  <div className="session-card-cwd">
                    <code>{sess.cwd || "~"}</code>
                  </div>
                  <div className="session-persona-selector-row">
                    <label
                      htmlFor={`persona-select-${sess.id}`}
                      className="session-persona-label"
                    >
                      Persona:
                    </label>
                    <select
                      id={`persona-select-${sess.id}`}
                      className="session-persona-select"
                      aria-label={`Assign Persona to session ${sess.title || sess.id}`}
                      value={sess.personaId || "none"}
                      onChange={(e) => handlePersonaChange(sess.id, e.target.value)}
                    >
                      <option value="none">None (Default Shell)</option>
                      {personas.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.icon || "🎭"} {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  {assignedPersona && (
                    <div className="assigned-persona-preview">
                      <span className="assigned-persona-icon">
                        {assignedPersona.icon || "🎭"}
                      </span>
                      <span className="assigned-persona-tagline">
                        {assignedPersona.tagline}
                      </span>
                    </div>
                  )}
                </div>
              );
            })}
            {sessionList.length === 0 && (
              <div className="status-empty-hint">No active terminal sessions</div>
            )}
          </div>
        </div>

        {/* Section 2: FTS5 Search Sandbox */}
        <div className="status-section search-sandbox-section">
          <div className="status-section-header">
            <span className="status-section-title">FTS5 Search Sandbox</span>
            {searchQuery && (
              <span className="status-section-badge">{searchResults.length}</span>
            )}
          </div>
          {searchQuery ? (
            <div className="search-sandbox-results">
              <div className="search-sandbox-meta">
                Query: <code>"{searchQuery}"</code>
              </div>
              {searchResults.map((result: ContextSearchResult) => (
                <div
                  key={result.id}
                  className="search-result-card"
                  onClick={() => selectPage(result.id)}
                  role="button"
                  tabIndex={0}
                >
                  <div className="search-result-header">
                    <span className="search-result-icon">{result.icon || "📄"}</span>
                    <span className="search-result-title">{result.title}</span>
                    <span className="search-result-badge">{result.category}</span>
                  </div>
                  {result.snippet ? (
                    <div
                      className="search-result-snippet"
                      dangerouslySetInnerHTML={{ __html: result.snippet }}
                    />
                  ) : (
                    <p className="search-result-snippet-text">{result.abstract_l0}</p>
                  )}
                </div>
              ))}
              {searchResults.length === 0 && (
                <div className="status-empty-hint">No matching context entries found</div>
              )}
            </div>
          ) : (
            <div className="search-sandbox-idle">
              <span className="search-sandbox-icon">🔍</span>
              <p>Type in the top search bar to test live SQLite FTS5 matching & snippet highlights.</p>
            </div>
          )}
        </div>

        {/* Section 3: Scope & Metadata Statistics */}
        <div className="status-section scope-metadata-section">
          <div className="status-section-header">
            <span className="status-section-title">Scope & Metadata</span>
          </div>
          <div className="metadata-stats-grid">
            <div className="metadata-stat-item">
              <span className="stat-label">Total Pages</span>
              <span className="stat-value">{pages.length}</span>
            </div>
            <div className="metadata-stat-item">
              <span className="stat-label">Pinned Notes</span>
              <span className="stat-value">{pinnedPagesCount}</span>
            </div>
            <div className="metadata-stat-item">
              <span className="stat-label">Personas</span>
              <span className="stat-value">{personas.length}</span>
            </div>
            <div className="metadata-stat-item">
              <span className="stat-label">Workspace Scope</span>
              <span className="stat-value">{workspacePagesCount}</span>
            </div>
            <div className="metadata-stat-item">
              <span className="stat-label">Global Scope</span>
              <span className="stat-value">{globalPagesCount}</span>
            </div>
            <div className="metadata-stat-item">
              <span className="stat-label">Active Path</span>
              <span className="stat-value path-val" title={getActiveCwd() || "Default"}>
                {(() => {
                  const cwd = getActiveCwd();
                  return cwd ? cwd.split(/[/\\]/).pop() || "Root" : "Root";
                })()}
              </span>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
