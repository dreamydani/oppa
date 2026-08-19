import {
  useRef,
  type ReactElement,
  type KeyboardEvent as ReactKeyboardEvent,
  type ChangeEvent,
} from "react";
import { useTerminalStore } from "../../store/terminalStore";

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

interface SideBySideLine {
  origNum?: number;
  origText: string;
  origType: "unchanged" | "removed" | "empty";
  modNum?: number;
  modText: string;
  modType: "unchanged" | "added" | "empty";
}

interface InlineDiffLine {
  type: "added" | "removed" | "unchanged";
  oldLineNumber?: number;
  newLineNumber?: number;
  text: string;
}

function computeDiff(original: string, modified: string) {
  const orig = original ? original.split("\n") : [];
  const mod = modified ? modified.split("\n") : [];

  const n = orig.length;
  const m = mod.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      if (orig[i] === mod[j]) {
        dp[i + 1][j + 1] = dp[i][j] + 1;
      } else {
        dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  let i = n;
  let j = m;
  const rawDiff: Array<{
    type: "added" | "removed" | "unchanged";
    text: string;
    origIdx?: number;
    modIdx?: number;
  }> = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && orig[i - 1] === mod[j - 1]) {
      rawDiff.unshift({ type: "unchanged", text: orig[i - 1], origIdx: i, modIdx: j });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      rawDiff.unshift({ type: "added", text: mod[j - 1], modIdx: j });
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      rawDiff.unshift({ type: "removed", text: orig[i - 1], origIdx: i });
      i--;
    }
  }

  const inlineLines: InlineDiffLine[] = [];
  const sideBySideLines: SideBySideLine[] = [];

  for (const item of rawDiff) {
    if (item.type === "unchanged") {
      inlineLines.push({
        type: "unchanged",
        oldLineNumber: item.origIdx,
        newLineNumber: item.modIdx,
        text: item.text,
      });
      sideBySideLines.push({
        origNum: item.origIdx,
        origText: item.text,
        origType: "unchanged",
        modNum: item.modIdx,
        modText: item.text,
        modType: "unchanged",
      });
    } else if (item.type === "removed") {
      inlineLines.push({
        type: "removed",
        oldLineNumber: item.origIdx,
        text: item.text,
      });
      sideBySideLines.push({
        origNum: item.origIdx,
        origText: item.text,
        origType: "removed",
        modText: "",
        modType: "empty",
      });
    } else if (item.type === "added") {
      inlineLines.push({
        type: "added",
        newLineNumber: item.modIdx,
        text: item.text,
      });
      const last = sideBySideLines[sideBySideLines.length - 1];
      if (last && last.origType === "removed" && last.modType === "empty") {
        last.modNum = item.modIdx;
        last.modText = item.text;
        last.modType = "added";
      } else {
        sideBySideLines.push({
          origText: "",
          origType: "empty",
          modNum: item.modIdx,
          modText: item.text,
          modType: "added",
        });
      }
    }
  }

  return { inlineLines, sideBySideLines };
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
  const editorWordWrap = useTerminalStore((s) => s.settings.general.editorWordWrap);

  const activeTab = editorTabs.find((t) => t.path === activeEditorPath);

  const content = value !== undefined ? value : activeTab ? activeTab.content : "";
  const currentLang = language || activeTab?.language || "plaintext";

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lineNumbersRef = useRef<HTMLDivElement>(null);

  const lines = content.split("\n");
  const lineCount = Math.max(lines.length, 1);

  // Sync scroll between textarea and line numbers gutter
  const handleScroll = () => {
    if (textareaRef.current && lineNumbersRef.current) {
      lineNumbersRef.current.scrollTop = textareaRef.current.scrollTop;
    }
  };

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const newVal = e.target.value;
    if (onChange) {
      onChange(newVal);
    } else if (activeEditorPath) {
      updateEditorContent(activeEditorPath, newVal);
    }
  };

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    const isMac =
      typeof navigator !== "undefined" &&
      (navigator.platform.toUpperCase().includes("MAC") || navigator.userAgent.includes("Mac"));
    const isSaveKey = isMac ? e.metaKey && e.key === "s" : e.ctrlKey && e.key === "s";

    if (isSaveKey) {
      e.preventDefault();
      void saveActiveFile();
      return;
    }

    if (e.key === "Tab" && !readOnly) {
      e.preventDefault();
      const textarea = textareaRef.current;
      if (!textarea) return;

      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const val = textarea.value;

      const updated = val.substring(0, start) + "  " + val.substring(end);
      if (onChange) {
        onChange(updated);
      } else if (activeEditorPath) {
        updateEditorContent(activeEditorPath, updated);
      }

      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.selectionStart = textareaRef.current.selectionEnd = start + 2;
        }
      }, 0);
    }
  };

  const isDiff = diffMode || !!pendingAiDiff;
  const origContent = original ?? pendingAiDiff?.original ?? "";
  const modContent = modified ?? pendingAiDiff?.modified ?? content;

  if (isDiff) {
    const { inlineLines, sideBySideLines } = computeDiff(origContent, modContent);

    if (isInlineDiff) {
      return (
        <div className="code-editor-container diff-mode inline-diff" data-testid="code-editor">
          <div className="diff-inline-view">
            {inlineLines.map((line, idx) => (
              <div key={idx} className={`diff-line-row diff-${line.type}`}>
                <span className="diff-gutter-num old-num">
                  {line.oldLineNumber !== undefined ? line.oldLineNumber : ""}
                </span>
                <span className="diff-gutter-num new-num">
                  {line.newLineNumber !== undefined ? line.newLineNumber : ""}
                </span>
                <span className="diff-line-sign">
                  {line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}
                </span>
                <pre className="diff-line-code">{line.text || " "}</pre>
              </div>
            ))}
          </div>
        </div>
      );
    }

    return (
      <div className="code-editor-container diff-mode split-diff" data-testid="code-editor">
        <div className="diff-split-view">
          <div className="diff-split-pane diff-pane-original">
            <div className="diff-pane-header">Original</div>
            <div className="diff-pane-content">
              {sideBySideLines.map((line, idx) => (
                <div key={idx} className={`diff-line-row diff-${line.origType}`}>
                  <span className="diff-gutter-num">{line.origNum ?? ""}</span>
                  <pre className="diff-line-code">{line.origText || " "}</pre>
                </div>
              ))}
            </div>
          </div>

          <div className="diff-split-pane diff-pane-modified">
            <div className="diff-pane-header">Modified (Proposed)</div>
            <div className="diff-pane-content">
              {sideBySideLines.map((line, idx) => (
                <div key={idx} className={`diff-line-row diff-${line.modType}`}>
                  <span className="diff-gutter-num">{line.modNum ?? ""}</span>
                  <pre className="diff-line-code">{line.modText || " "}</pre>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="code-editor-container" data-testid="code-editor">
      <div className="editor-gutter" ref={lineNumbersRef}>
        {Array.from({ length: lineCount }, (_, i) => (
          <div key={i + 1} className="editor-gutter-line">
            {i + 1}
          </div>
        ))}
      </div>

      <div className="editor-canvas-wrapper">
        <textarea
          ref={textareaRef}
          className="editor-textarea"
          value={content}
          onChange={handleChange}
          onScroll={handleScroll}
          onKeyDown={handleKeyDown}
          readOnly={readOnly}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          wrap={editorWordWrap ? "soft" : "off"}
          data-word-wrap={editorWordWrap ? "on" : "off"}
          style={{ whiteSpace: editorWordWrap ? "pre-wrap" : "pre" }}
          data-language={currentLang}
        />
      </div>
    </div>
  );
}
