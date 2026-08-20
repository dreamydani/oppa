import { type ReactElement } from "react";
import { useTerminalStore } from "../../store/terminalStore";
import {
  ChevronRight,
  GitCompare,
  Sparkles,
  Save,
  Check,
  Code,
  Eye,
  Columns2,
} from "lucide-react";

export function EditorBreadcrumbs(): ReactElement | null {
  const activeEditorPath = useTerminalStore((s) => s.activeEditorPath);
  const editorTabs = useTerminalStore((s) => s.editorTabs);
  const editorViewMode = useTerminalStore((s) => s.editorViewMode);
  const setEditorViewMode = useTerminalStore((s) => s.setEditorViewMode);
  const saveActiveFile = useTerminalStore((s) => s.saveActiveFile);
  const updateEditorContent = useTerminalStore((s) => s.updateEditorContent);

  const activeTab = editorTabs.find((t) => t.path === activeEditorPath);
  if (!activeTab) return null;

  // Split path into breadcrumb trail segments
  const normalizedPath = activeTab.path.replace(/^untitled:\/\//, "").replace(/\\/g, "/");
  const pathSegments = normalizedPath.split("/").filter(Boolean);

  const isMac =
    typeof navigator !== "undefined" &&
    (navigator.platform.toUpperCase().includes("MAC") || navigator.userAgent.includes("Mac"));
  const saveShortcut = isMac ? "⌘S" : "Ctrl+S";

  const handleToggleDiff = () => {
    if (editorViewMode === "diff") {
      setEditorViewMode(activeTab.isMarkdown ? "markdown-split" : "edit");
    } else {
      setEditorViewMode("diff");
    }
  };

  const handleFormatCode = () => {
    try {
      if (activeTab.language === "json") {
        const parsed = JSON.parse(activeTab.content);
        const formatted = JSON.stringify(parsed, null, 2) + "\n";
        updateEditorContent(activeTab.path, formatted);
      } else {
        const lines = activeTab.content.split("\n");
        const trimmed = lines.map((l) => l.trimEnd()).join("\n").replace(/\n+$/, "\n");
        updateEditorContent(activeTab.path, trimmed);
      }
    } catch {
      // Ignore syntax errors on invalid formats
    }
  };

  return (
    <div className="editor-breadcrumbs" data-testid="editor-breadcrumbs">
      <div className="editor-breadcrumbs-trail">
        {pathSegments.map((segment, index) => {
          const isLast = index === pathSegments.length - 1;
          return (
            <span key={index} className="editor-breadcrumb-item">
              {index > 0 && (
                <ChevronRight size={12} className="editor-breadcrumb-separator" strokeWidth={1.5} />
              )}
              <span className={`editor-breadcrumb-segment ${isLast ? "current" : ""}`}>
                {segment}
              </span>
            </span>
          );
        })}
        {activeTab.isDirty && <span className="editor-breadcrumb-dirty">●</span>}
      </div>

      <div className="editor-breadcrumbs-actions">
        {activeTab.isMarkdown && (
          <div className="editor-viewmode-group" role="group" aria-label="Markdown view modes">
            <button
              type="button"
              className={`editor-viewmode-btn ${editorViewMode === "edit" ? "active" : ""}`}
              aria-label="Code"
              title="Code view"
              onClick={() => setEditorViewMode("edit")}
            >
              <Code size={13} strokeWidth={1.75} />
              <span>Code</span>
            </button>
            <button
              type="button"
              className={`editor-viewmode-btn ${
                editorViewMode === "markdown-preview" ? "active" : ""
              }`}
              aria-label="Preview"
              title="Markdown preview"
              onClick={() => setEditorViewMode("markdown-preview")}
            >
              <Eye size={13} strokeWidth={1.75} />
              <span>Preview</span>
            </button>
            <button
              type="button"
              className={`editor-viewmode-btn ${
                editorViewMode === "markdown-split" ? "active" : ""
              }`}
              aria-label="Split"
              title="Split view"
              onClick={() => setEditorViewMode("markdown-split")}
            >
              <Columns2 size={13} strokeWidth={1.75} />
              <span>Split</span>
            </button>
          </div>
        )}

        <button
          type="button"
          className={`editor-action-btn ${editorViewMode === "diff" ? "active" : ""}`}
          aria-label="Toggle diff mode"
          title="Toggle Diff comparison"
          onClick={handleToggleDiff}
        >
          <GitCompare size={13} strokeWidth={1.75} />
          <span>Diff</span>
        </button>

        <button
          type="button"
          className="editor-action-btn"
          aria-label="Format code"
          title="Format code"
          onClick={handleFormatCode}
        >
          <Sparkles size={13} strokeWidth={1.75} />
          <span>Format</span>
        </button>

        <button
          type="button"
          className={`editor-action-btn editor-save-btn ${activeTab.isDirty ? "dirty" : "saved"}`}
          aria-label="Save file"
          title={`Save file (${saveShortcut})`}
          onClick={() => void saveActiveFile()}
        >
          {activeTab.isDirty ? (
            <Save size={13} strokeWidth={1.75} />
          ) : (
            <Check size={13} strokeWidth={2} />
          )}
          <span>{activeTab.isDirty ? "Save" : "Saved"}</span>
          <span className="editor-shortcut-hint">{saveShortcut}</span>
        </button>
      </div>
    </div>
  );
}
