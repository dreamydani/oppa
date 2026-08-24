import React, { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, PackageX, Puzzle } from "lucide-react";
import { useExtensionStore } from "../../store/extensionStore";
import "./ExtensionsPanel.css";

// Sidebar view listing installed extensions. Enable/disable plus the Phase 2
// consent flow for scriptable ("Code") extensions; install/uninstall is P4.
// The consent modal + toast stack render at app level (ExtensionConsent.tsx).

function ContributionBadges({
  themeCount,
  snippetCount,
  commandCount,
}: {
  themeCount: number;
  snippetCount: number;
  commandCount: number;
}) {
  const badges: string[] = [];
  if (themeCount > 0) badges.push(`${themeCount} theme${themeCount === 1 ? "" : "s"}`);
  if (snippetCount > 0)
    badges.push(`${snippetCount} snippet${snippetCount === 1 ? "" : "s"}`);
  if (commandCount > 0) badges.push(`${commandCount} command${commandCount === 1 ? "" : "s"}`);
  if (badges.length === 0) return null;
  return (
    <div className="ext-card-contributions">
      {badges.map((label) => (
        <span key={label} className="ext-contribution-badge">
          {label}
        </span>
      ))}
    </div>
  );
}

export function ExtensionsPanel(): React.ReactElement {
  const status = useExtensionStore((s) => s.status);
  const extensions = useExtensionStore((s) => s.extensions);
  const loadError = useExtensionStore((s) => s.loadError);
  const load = useExtensionStore((s) => s.load);
  const toggleExtension = useExtensionStore((s) => s.toggleExtension);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    if (status === "idle") void load();
  }, [status, load]);

  if (status === "unavailable") {
    return (
      <div className="extensions-panel" role="region" aria-label="Extensions">
        <div className="extensions-empty">
          <PackageX size={20} />
          <p>Extensions are unavailable in this session.</p>
          {loadError && <p className="extensions-empty-detail">{loadError}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="extensions-panel" role="region" aria-label="Extensions">
      <div className="extensions-header">
        <h3 className="extensions-title">Extensions</h3>
        <span className="extensions-count">{extensions.length}</span>
      </div>

      {status === "loading" && (
        <div className="extensions-empty">
          <p>Loading extensions…</p>
        </div>
      )}

      {status === "ready" && extensions.length === 0 && (
        <div className="extensions-empty">
          <Puzzle size={20} />
          <p>No extensions installed.</p>
          <p className="extensions-empty-detail">
            Built-in extensions ship with oppa; installing your own is coming soon.
          </p>
        </div>
      )}

      <div className="extensions-list">
        {extensions.map((ext) => {
          const expanded = expandedId === ext.id;
          const hasError = ext.error !== null;
          const crashed = ext.crash_error !== null;
          return (
            <section
              key={ext.id || ext.name}
              className={`ext-card${hasError ? " error" : ""}${crashed ? " crashed" : ""}`}
            >
              <div className="ext-card-main">
                <button
                  type="button"
                  className="ext-card-expand"
                  onClick={() => setExpandedId(expanded ? null : ext.id)}
                  aria-expanded={expanded}
                  aria-label={`${expanded ? "Collapse" : "Expand"} ${ext.name}`}
                >
                  {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                </button>
                <div className="ext-card-info">
                  <div className="ext-card-title-row">
                    <span className="ext-card-name">{ext.name}</span>
                    {ext.version && <span className="ext-card-version">v{ext.version}</span>}
                    {ext.is_builtin && <span className="ext-badge builtin">Built-in</span>}
                    {ext.is_scriptable && <span className="ext-badge code">Code</span>}
                    {hasError && <span className="ext-badge error-badge">Failed to load</span>}
                  </div>
                  {(ext.description || hasError) && (
                    <p className="ext-card-desc">
                      {hasError ? ext.error : ext.description}
                    </p>
                  )}
                  {crashed && (
                    <p className="ext-crash-banner" role="alert">
                      Crashed: {ext.crash_error}
                    </p>
                  )}
                  {!hasError && (
                    <ContributionBadges
                      themeCount={ext.theme_count}
                      snippetCount={ext.snippet_count}
                      commandCount={ext.command_count}
                    />
                  )}
                </div>
                {!hasError && (
                  <button
                    type="button"
                    role="switch"
                    aria-checked={ext.enabled}
                    aria-label={`Enable ${ext.name}`}
                    className={`ext-switch ${ext.enabled ? "checked" : ""}`}
                    onClick={() => void toggleExtension(ext.id, !ext.enabled).catch(() => {})}
                  >
                    <span className="ext-switch-thumb" />
                  </button>
                )}
              </div>

              {expanded && !hasError && (
                <div className="ext-card-details">
                  <dl className="ext-detail-grid">
                    <dt>ID</dt>
                    <dd>{ext.id}</dd>
                    <dt>Publisher</dt>
                    <dd>{ext.id.split(".")[0]}</dd>
                    <dt>Kind</dt>
                    <dd>{ext.is_builtin ? "Ships with oppa" : "User-installed"}</dd>
                  </dl>
                  <p className="ext-managed-note">
                    Items contributed by this extension disappear from pickers while it is
                    disabled.
                  </p>
                </div>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
