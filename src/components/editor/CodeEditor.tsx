import {
  type ReactElement,
  useCallback,
  useRef,
  type KeyboardEvent,
} from "react";
import Editor, { DiffEditor, type OnMount, type BeforeMount } from "@monaco-editor/react";
import { useTerminalStore } from "../../store/terminalStore";
import {
  mapToMonacoLanguage,
  defineOppaMonacoThemes,
  OPPA_DARK_THEME,
  OPPA_LIGHT_THEME,
} from "./monacoTheme";

export interface CodeEditorProps {
  value?: string;
  onChange?: (value: string) => void;
  language?: string;
  readOnly?: boolean;
  diffMode?: boolean;
  original?: string;
  modified?: string;
  isInlineDiff?: boolean;
}

export function CodeEditor({
  value,
  onChange,
  language,
  readOnly = false,
  diffMode = false,
  original,
  modified,
  isInlineDiff = false,
}: CodeEditorProps): ReactElement {
  const activeEditorPath = useTerminalStore((s) => s.activeEditorPath);
  const editorTabs = useTerminalStore((s) => s.editorTabs);
  const updateEditorContent = useTerminalStore((s) => s.updateEditorContent);
  const saveActiveFile = useTerminalStore((s) => s.saveActiveFile);
  const pendingAiDiff = useTerminalStore((s) => s.pendingAiDiff);
  const viewOnlyDiff = useTerminalStore((s) => s.viewOnlyDiff);
  const editorWordWrap = useTerminalStore((s) => s.settings.general.editorWordWrap);
  const appTheme = useTerminalStore((s) => s.settings.appearance.appTheme);

  const activeTab = editorTabs.find((t) => t.path === activeEditorPath);
  const content = value !== undefined ? value : activeTab ? activeTab.content : "";
  const langSourcePath = viewOnlyDiff?.path ?? activeEditorPath ?? "";
  const currentLang = mapToMonacoLanguage(langSourcePath, language || activeTab?.language);
  const monacoTheme = appTheme === "light" ? OPPA_LIGHT_THEME : OPPA_DARK_THEME;

  const editorRef = useRef<any>(null);

  const handleBeforeMount: BeforeMount = (monaco) => {
    defineOppaMonacoThemes(monaco);
  };

  const handleOnMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;

    // Register Save command (Ctrl+S / Cmd+S)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveActiveFile();
    });
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const isMac =
      typeof navigator !== "undefined" &&
      (navigator.platform.toUpperCase().includes("MAC") || navigator.userAgent.includes("Mac"));
    const isSaveKey = isMac ? e.metaKey && e.key === "s" : e.ctrlKey && e.key === "s";

    if (isSaveKey) {
      e.preventDefault();
      void saveActiveFile();
    }
  };

  const handleChange = useCallback(
    (newVal: string | undefined) => {
      const updated = newVal ?? "";
      if (onChange) {
        onChange(updated);
      } else if (activeEditorPath) {
        updateEditorContent(activeEditorPath, updated);
      }
    },
    [onChange, activeEditorPath, updateEditorContent],
  );

  const isDiff = diffMode || !!pendingAiDiff || !!viewOnlyDiff;
  const origContent = original ?? pendingAiDiff?.original ?? viewOnlyDiff?.original ?? "";
  const modContent = modified ?? pendingAiDiff?.modified ?? viewOnlyDiff?.modified ?? content;

  if (isDiff) {
    return (
      <div className="code-editor-container diff-mode" data-testid="code-editor">
        <DiffEditor
          original={origContent}
          modified={modContent}
          language={currentLang}
          theme={monacoTheme}
          beforeMount={handleBeforeMount}
          options={{
            readOnly: true,
            renderSideBySide: !isInlineDiff,
            fontSize: 13,
            fontFamily: "'Geist Mono', 'SF Mono', Consolas, 'Cascadia Code', monospace",
            lineHeight: 20,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            smoothScrolling: true,
            automaticLayout: true,
            padding: { top: 12, bottom: 12 },
          }}
        />
      </div>
    );
  }

  return (
    <div
      className="code-editor-container"
      data-testid="code-editor"
      onKeyDown={handleKeyDown}
    >
      <Editor
        value={content}
        language={currentLang}
        theme={monacoTheme}
        onChange={handleChange}
        beforeMount={handleBeforeMount}
        onMount={handleOnMount}
        options={{
          readOnly,
          fontSize: 13,
          fontFamily: "'Geist Mono', 'SF Mono', Consolas, 'Cascadia Code', monospace",
          lineHeight: 20,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          automaticLayout: true,
          tabSize: 2,
          wordWrap: editorWordWrap ? "on" : "off",
          padding: { top: 12, bottom: 12 },
          renderLineHighlight: "all",
          cursorBlinking: "smooth",
          bracketPairColorization: { enabled: true },
        }}
      />
    </div>
  );
}
