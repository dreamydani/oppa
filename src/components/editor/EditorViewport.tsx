import { useState, type ReactElement } from "react";
import { useTerminalStore } from "../../store/terminalStore";
import { EditorTabBar } from "./EditorTabBar";
import { EditorBreadcrumbs } from "./EditorBreadcrumbs";
import { CodeEditor } from "./CodeEditor";
import { AiDiffBanner } from "./AiDiffBanner";
import { MarkdownViewer } from "./MarkdownViewer";
import { FileIcon, PlusIcon } from "../icons/MinimalIcons";
import "./EditorViewport.css";

export function EditorViewport(): ReactElement {
  const editorTabs = useTerminalStore((s) => s.editorTabs);
  const activeEditorPath = useTerminalStore((s) => s.activeEditorPath);
  const editorViewMode = useTerminalStore((s) => s.editorViewMode);
  const pendingAiDiff = useTerminalStore((s) => s.pendingAiDiff);
  const openFileInEditor = useTerminalStore((s) => s.openFileInEditor);

  const [isInlineDiff, setIsInlineDiff] = useState(false);

  const activeTab = editorTabs.find((t) => t.path === activeEditorPath);

  const handleCreateNewFile = () => {
    const untitledCount = editorTabs.filter((t) => t.name.startsWith("Untitled")).length + 1;
    const untitledName = `Untitled-${untitledCount}.txt`;
    void openFileInEditor(`untitled://${untitledName}`, "");
  };

  const renderContent = () => {
    if (editorTabs.length === 0 || !activeTab) {
      return (
        <div className="editor-empty-state" data-testid="editor-empty-state">
          <div className="editor-empty-icon">
            <FileIcon size={48} strokeWidth={1} />
          </div>
          <h2 className="editor-empty-title">No File Open</h2>
          <p className="editor-empty-subtitle">
            Select a file from the explorer or create a new file to start editing.
          </p>
          <button
            type="button"
            className="editor-empty-create-btn"
            aria-label="Create New File"
            onClick={handleCreateNewFile}
          >
            <PlusIcon size={16} />
            <span>Create New File</span>
          </button>
        </div>
      );
    }

    if (editorViewMode === "diff" || pendingAiDiff) {
      return <CodeEditor diffMode isInlineDiff={isInlineDiff} />;
    }

    if (editorViewMode === "markdown-preview") {
      return <MarkdownViewer content={activeTab.content} />;
    }

    if (editorViewMode === "markdown-split") {
      return (
        <div className="editor-split-workspace">
          <div className="editor-split-pane left-pane">
            <CodeEditor />
          </div>
          <div className="editor-split-pane right-pane">
            <MarkdownViewer content={activeTab.content} />
          </div>
        </div>
      );
    }

    // Default: edit mode
    return <CodeEditor />;
  };

  return (
    <div className="editor-viewport" data-testid="editor-viewport">
      <EditorTabBar />
      {activeTab && <EditorBreadcrumbs />}
      {pendingAiDiff && (
        <AiDiffBanner isInline={isInlineDiff} onToggleInline={setIsInlineDiff} />
      )}
      <div className="editor-main-canvas">{renderContent()}</div>
    </div>
  );
}
