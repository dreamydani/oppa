import { type ReactElement } from "react";
import { useTerminalStore } from "../../store/terminalStore";
import { PlusIcon, CloseIcon } from "../icons/MinimalIcons";

function getFileLanguageBadge(name: string, language: string): { label: string; color: string } {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  switch (ext) {
    case "ts":
    case "tsx":
      return { label: "TS", color: "#3178c6" };
    case "js":
    case "jsx":
      return { label: "JS", color: "#f7df1e" };
    case "rs":
      return { label: "RS", color: "#dea584" };
    case "py":
      return { label: "PY", color: "#3572a5" };
    case "json":
      return { label: "{}", color: "#cbcb41" };
    case "md":
    case "markdown":
      return { label: "MD", color: "#519aba" };
    case "css":
    case "scss":
    case "less":
      return { label: "#", color: "#563d7c" };
    case "html":
      return { label: "<>", color: "#e34c26" };
    case "toml":
    case "yaml":
    case "yml":
      return { label: "YML", color: "#cb171e" };
    default:
      return { label: language.slice(0, 2).toUpperCase() || "TXT", color: "#9e9e9a" };
  }
}

export function EditorTabBar(): ReactElement {
  const editorTabs = useTerminalStore((s) => s.editorTabs);
  const activeEditorPath = useTerminalStore((s) => s.activeEditorPath);
  const setActiveEditorTab = useTerminalStore((s) => s.setActiveEditorTab);
  const closeEditorTab = useTerminalStore((s) => s.closeEditorTab);
  const openFileInEditor = useTerminalStore((s) => s.openFileInEditor);

  const handleCreateNewFile = () => {
    const untitledCount = editorTabs.filter((t) => t.name.startsWith("Untitled")).length + 1;
    const untitledName = `Untitled-${untitledCount}.txt`;
    void openFileInEditor(`untitled://${untitledName}`, "");
  };

  return (
    <div className="editor-tab-bar" data-testid="editor-tab-bar">
      <div className="editor-tab-list">
        {editorTabs.map((tab) => {
          const isActive = tab.path === activeEditorPath;
          const badge = getFileLanguageBadge(tab.name, tab.language);

          return (
            <div
              key={tab.path}
              className={`editor-tab ${isActive ? "active" : ""}`}
              onClick={() => setActiveEditorTab(tab.path)}
              title={tab.path}
            >
              <span
                className="editor-tab-lang-badge"
                style={{ color: badge.color }}
                aria-hidden="true"
              >
                {badge.label}
              </span>
              <span className="editor-tab-title">{tab.name}</span>
              {tab.isDirty && (
                <span className="editor-tab-dirty" title="Unsaved changes">
                  ●
                </span>
              )}
              <button
                type="button"
                className="editor-tab-close"
                aria-label={`Close ${tab.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  closeEditorTab(tab.path);
                }}
              >
                <CloseIcon size={12} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="editor-tab-actions">
        <button
          type="button"
          className="editor-tab-btn editor-new-tab-btn"
          aria-label="New File"
          title="New File"
          onClick={handleCreateNewFile}
        >
          <PlusIcon size={14} />
        </button>
      </div>
    </div>
  );
}
