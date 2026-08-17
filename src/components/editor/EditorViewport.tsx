import { useState, useEffect, useCallback, type ReactElement } from "react";
import { useTerminalStore } from "../../store/terminalStore";
import { readDir, FileEntry } from "../../lib/fs/transport";
import { EditorTabBar } from "./EditorTabBar";
import { EditorBreadcrumbs } from "./EditorBreadcrumbs";
import { CodeEditor } from "./CodeEditor";
import { AiDiffBanner } from "./AiDiffBanner";
import { MarkdownViewer } from "./MarkdownViewer";
import { FileIcon, PlusIcon } from "../icons/MinimalIcons";
import { PanelRight } from "lucide-react";
import "./EditorViewport.css";

export function EditorViewport(): ReactElement {
  const editorTabs = useTerminalStore((s) => s.editorTabs);
  const activeEditorPath = useTerminalStore((s) => s.activeEditorPath);
  const editorViewMode = useTerminalStore((s) => s.editorViewMode);
  const pendingAiDiff = useTerminalStore((s) => s.pendingAiDiff);
  const openFileInEditor = useTerminalStore((s) => s.openFileInEditor);
  const rightSidebarOpen = useTerminalStore((s) => s.rightSidebarOpen);
  const toggleRightSidebar = useTerminalStore((s) => s.toggleRightSidebar);
  const activeCwd = useTerminalStore((s) => s.getActiveCwd());
  const sessions = useTerminalStore((s) => s.sessions);

  const cwd = activeCwd || Object.values(sessions).find((s) => Boolean(s?.cwd))?.cwd;

  const [isInlineDiff, setIsInlineDiff] = useState(false);
  const [quickFiles, setQuickFiles] = useState<FileEntry[]>([]);

  const activeTab = editorTabs.find((t) => t.path === activeEditorPath);

  useEffect(() => {
    if (!cwd) return;
    let isMounted = true;
    void readDir(cwd).then((entries) => {
      if (isMounted) {
        setQuickFiles(entries.filter((e) => !e.is_dir).slice(0, 8));
      }
    });
    return () => {
      isMounted = false;
    };
  }, [cwd]);

  const handleCreateNewFile = () => {
    const untitledCount = editorTabs.filter((t) => t.name.startsWith("Untitled")).length + 1;
    const untitledName = `Untitled-${untitledCount}.txt`;
    void openFileInEditor(`untitled://${untitledName}`, "");
  };

  const handleOpenQuickFile = useCallback(
    (path: string) => {
      void openFileInEditor(path);
    },
    [openFileInEditor]
  );

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
          <div className="editor-empty-actions">
            <button
              type="button"
              className="editor-empty-create-btn"
              aria-label="Create New File"
              onClick={handleCreateNewFile}
            >
              <PlusIcon size={16} />
              <span>Create New File</span>
            </button>
            {!rightSidebarOpen && (
              <button
                type="button"
                className="editor-empty-secondary-btn"
                aria-label="Open File Explorer"
                onClick={toggleRightSidebar}
              >
                <PanelRight size={15} />
                <span>Open Explorer</span>
              </button>
            )}
          </div>

          {quickFiles.length > 0 && (
            <div className="editor-quick-files">
              <span className="editor-quick-files-label">Workspace Files</span>
              <div className="editor-quick-files-list">
                {quickFiles.map((file) => (
                  <button
                    key={file.path}
                    type="button"
                    className="editor-quick-file-chip"
                    onClick={() => handleOpenQuickFile(file.path)}
                    title={file.path}
                  >
                    <FileIcon size={13} />
                    <span>{file.name}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
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
