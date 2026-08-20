import { type ReactElement } from "react";
import { useTerminalStore } from "../../store/terminalStore";
import { Plus, X, FileCode, FileText, FileJson, FileSpreadsheet, File } from "lucide-react";

function getFileIcon(name: string, language: string) {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  switch (ext) {
    case "ts":
    case "tsx":
      return { icon: FileCode, color: "#60a5fa" };
    case "js":
    case "jsx":
      return { icon: FileCode, color: "#facc15" };
    case "rs":
      return { icon: FileCode, color: "#fb923c" };
    case "py":
      return { icon: FileCode, color: "#38bdf8" };
    case "json":
      return { icon: FileJson, color: "#fcd34d" };
    case "md":
    case "markdown":
      return { icon: FileText, color: "#a5b4fc" };
    case "css":
    case "scss":
    case "less":
    case "html":
      return { icon: FileCode, color: "#f472b6" };
    case "csv":
      return { icon: FileSpreadsheet, color: "#4ade80" };
    default:
      return {
        icon: language === "markdown" ? FileText : File,
        color: "#94a3b8",
      };
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
          const fileInfo = getFileIcon(tab.name, tab.language);
          const IconComponent = fileInfo.icon;

          return (
            <div
              key={tab.path}
              className={`editor-tab ${isActive ? "active" : ""}`}
              onClick={() => setActiveEditorTab(tab.path)}
              title={tab.path}
            >
              <span
                className="editor-tab-icon-wrapper"
                style={{ color: fileInfo.color }}
                aria-hidden="true"
              >
                <IconComponent size={14} strokeWidth={1.75} />
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
                title="Close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeEditorTab(tab.path);
                }}
              >
                <X size={12} strokeWidth={2} />
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
          <Plus size={14} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
