import { useState, type ReactElement } from "react";
import { useContextStore } from "../../store/contextStore";
import { useTerminalStore } from "../../store/terminalStore";
import {
  IconSearch,
  IconTerminal,
  IconPersona,
  IconSparkles,
} from "./ContextIcons";

export function ContextStatusPanel(): ReactElement {
  const pages = useContextStore((s) => s.pages);
  const personas = useContextStore((s) => s.personas);
  const searchResults = useContextStore((s) => s.searchResults);
  const selectPage = useContextStore((s) => s.selectPage);

  const sessions = useTerminalStore((s) => s.sessions);
  const setSessionPersona = useTerminalStore((s) => s.setSessionPersona);
  const getActiveCwd = useTerminalStore((s) => s.getActiveCwd);

  const [sandboxQuery, setSandboxQuery] = useState("");
  const searchContext = useContextStore((s) => s.searchContext);

  const sessionList = Object.values(sessions);

  // Scope statistics
  const totalPages = pages.length;
  const pinnedPages = pages.filter((p) => p.pinned).length;
  const workspacePages = pages.filter((p) => p.scope === "workspace").length;
  const globalPages = pages.filter((p) => p.scope === "global").length;

  const handleSandboxSearch = (q: string) => {
    setSandboxQuery(q);
    void searchContext(q, getActiveCwd());
  };

  return (
    <aside className="context-status-panel" aria-label="Context and Session Status">
      <div className="status-panel-header">
        <span className="status-panel-heading">CONTEXT & SESSIONS</span>
      </div>

      <div className="status-panel-content">
        {/* Bento Card 1: Active Terminal Sessions */}
        <section className="status-bento-card" aria-label="Active Terminal Sessions">
          <div className="bento-card-header">
            <div className="bento-card-title-row">
              <IconTerminal size={14} className="bento-icon" />
              <h4>Active Terminal Sessions</h4>
            </div>
            <span className="bento-card-badge">{sessionList.length}</span>
          </div>

          <div className="bento-sessions-list">
            {sessionList.length === 0 ? (
              <div className="bento-empty-hint">No active terminal sessions</div>
            ) : (
              sessionList.map((session) => {
                const assignedPersona = personas.find((p) => p.id === session.personaId);
                return (
                  <div key={session.id} className="bento-session-item">
                    <div className="session-item-top">
                      <div className="session-item-status-dot running" />
                      <span className="session-item-title monospace">
                        {session.title || session.id}
                      </span>
                    </div>
                    <div className="session-item-cwd monospace">{session.cwd || "~"}</div>
                    <div className="session-persona-picker-row">
                      <span className="persona-picker-label">Role:</span>
                      <select
                        className="session-persona-select"
                        value={session.personaId || ""}
                        onChange={(e) =>
                          setSessionPersona(session.id, e.target.value || null)
                        }
                        aria-label={`Assign Persona to session ${session.title || session.id}`}
                      >
                        <option value="">None (Default Shell)</option>
                        {personas.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    {assignedPersona && (
                      <div className="session-assigned-chip">
                        <IconPersona size={11} />
                        <span>Active: {assignedPersona.name}</span>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </section>

        {/* Bento Card 2: FTS5 Search Sandbox */}
        <section className="status-bento-card" aria-label="FTS5 Search Sandbox">
          <div className="bento-card-header">
            <div className="bento-card-title-row">
              <IconSearch size={14} className="bento-icon" />
              <h4>FTS5 Search Sandbox</h4>
            </div>
          </div>

          <div className="sandbox-input-wrapper">
            <IconSearch size={12} className="sandbox-icon" />
            <input
              type="text"
              className="sandbox-input"
              placeholder="Test live keyword query..."
              value={sandboxQuery}
              onChange={(e) => handleSandboxSearch(e.target.value)}
            />
          </div>

          <div className="sandbox-results-list">
            {searchResults.length > 0 ? (
              searchResults.map((res) => (
                <div
                  key={res.id}
                  className="sandbox-result-card"
                  onClick={() => selectPage(res.id)}
                  role="button"
                  tabIndex={0}
                >
                  <div className="result-card-top">
                    <span className="result-title">{res.title}</span>
                    <span className="result-scope-pill monospace">{res.scope}</span>
                  </div>
                  <div
                    className="result-snippet monospace"
                    dangerouslySetInnerHTML={{ __html: res.snippet }}
                  />
                </div>
              ))
            ) : (
              <div className="sandbox-empty-hint">
                <IconSparkles size={16} className="sandbox-empty-icon" />
                <span>Type in search box above to test live SQLite FTS5 matching & snippet extraction.</span>
              </div>
            )}
          </div>
        </section>

        {/* Bento Card 3: Scope & Metadata 2x2 Grid */}
        <section className="status-bento-card" aria-label="Scope & Metadata">
          <div className="bento-card-header">
            <h4>Scope & Metadata</h4>
          </div>
          <div className="metrics-2x2-grid">
            <div className="metric-tile">
              <span className="metric-tile-label">TOTAL PAGES</span>
              <span className="metric-tile-value">{totalPages}</span>
            </div>
            <div className="metric-tile">
              <span className="metric-tile-label">PINNED MEMORIES</span>
              <span className="metric-tile-value">{pinnedPages}</span>
            </div>
            <div className="metric-tile">
              <span className="metric-tile-label">WORKSPACE SCOPE</span>
              <span className="metric-tile-value">{workspacePages}</span>
            </div>
            <div className="metric-tile">
              <span className="metric-tile-label">GLOBAL SCOPE</span>
              <span className="metric-tile-value">{globalPages}</span>
            </div>
          </div>
        </section>
      </div>
    </aside>
  );
}
