// Code editor tabs: file open/close, content edits with autosave, AI-diff
// review flow, and the read-only diff view.

import { readFile, writeFile } from "../../lib/fs/transport";
import { scFileDiff } from "../../lib/git/transport";
import type { GitArea } from "../../lib/git/transport";
import type { TerminalState } from "../terminalStore";

type Set = (
  partial:
    | Partial<TerminalState>
    | ((state: TerminalState) => Partial<TerminalState>),
) => void;

export type EditorViewMode = "edit" | "diff" | "markdown-preview" | "markdown-split";

export interface EditorTab {
  path: string;
  name: string;
  content: string;
  originalContent: string;
  isDirty: boolean;
  language: string;
  isMarkdown: boolean;
}

export interface PendingAiDiff {
  path: string;
  original: string;
  modified: string;
  summary?: string;
  isInline?: boolean;
}

export interface ViewOnlyDiff {
  path: string;
  original: string;
  modified: string;
}

export function detectEditorLanguage(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "rs":
      return "rust";
    case "py":
    case "pyw":
      return "python";
    case "json":
      return "json";
    case "html":
    case "htm":
      return "html";
    case "css":
      return "css";
    case "scss":
      return "scss";
    case "less":
      return "less";
    case "md":
    case "markdown":
      return "markdown";
    case "toml":
      return "toml";
    case "yaml":
    case "yml":
      return "yaml";
    case "sh":
    case "bash":
    case "zsh":
      return "shell";
    case "go":
      return "go";
    case "c":
    case "h":
      return "c";
    case "cpp":
    case "cc":
    case "cxx":
    case "hpp":
      return "cpp";
    case "sql":
      return "sql";
    case "xml":
    case "svg":
      return "xml";
    case "diff":
    case "patch":
      return "diff";
    default:
      return "plaintext";
  }
}

function getFileName(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

let editorAutoSaveTimer: ReturnType<typeof setTimeout> | null = null;

export interface CodeEditorSlice {
  editorTabs: EditorTab[];
  activeEditorPath: string | null;
  editorViewMode: EditorViewMode;
  pendingAiDiff: PendingAiDiff | null;
  viewOnlyDiff: ViewOnlyDiff | null;
  openFileInEditor: (path: string, content?: string) => Promise<void>;
  closeEditorTab: (path: string) => void;
  setActiveEditorTab: (path: string) => void;
  updateEditorContent: (path: string, content: string) => void;
  saveActiveFile: () => Promise<void>;
  stageAiDiff: (path: string, original: string, modified: string, summary?: string) => void;
  acceptAiDiff: () => Promise<void>;
  rejectAiDiff: () => void;
  setEditorViewMode: (mode: EditorViewMode) => void;
  openDiffView: (path: string, original: string, modified: string) => void;
  clearViewOnlyDiff: () => void;
  openGitDiff: (path: string, area: GitArea) => Promise<void>;
}

export function createCodeEditorSlice(
  set: Set,
  get: () => TerminalState,
): CodeEditorSlice {
  return {
    editorTabs: [],
    activeEditorPath: null,
    editorViewMode: "edit",
    pendingAiDiff: null,
    viewOnlyDiff: null,

    openFileInEditor: async (path, content) => {
      const state = get();
      const existing = state.editorTabs.find((t) => t.path === path);
      if (existing) {
        set({
          activeEditorPath: path,
          editorViewMode: existing.isMarkdown ? "markdown-split" : "edit",
          viewOnlyDiff: null,
        });
        return;
      }

      let fileContent = content;
      if (fileContent === undefined) {
        fileContent = await readFile(path);
      }

      const isMarkdown = path.endsWith(".md") || path.endsWith(".markdown");
      const newTab: EditorTab = {
        path,
        name: getFileName(path),
        content: fileContent,
        originalContent: fileContent,
        isDirty: false,
        language: detectEditorLanguage(path),
        isMarkdown,
      };

      set((s) => ({
        editorTabs: [...s.editorTabs, newTab],
        activeEditorPath: path,
        editorViewMode: isMarkdown ? "markdown-split" : "edit",
        viewOnlyDiff: null,
      }));
    },

    closeEditorTab: (path) => {
      set((state) => {
        const idx = state.editorTabs.findIndex((t) => t.path === path);
        if (idx === -1) return state;

        const remaining = state.editorTabs.filter((t) => t.path !== path);
        let activePath = state.activeEditorPath;

        if (activePath === path) {
          if (remaining.length === 0) {
            activePath = null;
          } else {
            const nextIdx = Math.min(Math.max(0, idx), remaining.length - 1);
            activePath = remaining[nextIdx].path;
          }
        }

        return {
          editorTabs: remaining,
          activeEditorPath: activePath,
        };
      });
    },

    setActiveEditorTab: (path) => set({ activeEditorPath: path }),

    updateEditorContent: (path, content) => {
      set((state) => ({
        editorTabs: state.editorTabs.map((t) =>
          t.path === path
            ? {
                ...t,
                content,
                isDirty: content !== t.originalContent,
              }
            : t,
        ),
      }));

      const delay = get().settings.general.editorAutoSaveDelay;
      if (delay > 0) {
        if (editorAutoSaveTimer) {
          clearTimeout(editorAutoSaveTimer);
        }
        editorAutoSaveTimer = setTimeout(() => {
          void get().saveActiveFile();
        }, delay);
      }
    },

    saveActiveFile: async () => {
      const { activeEditorPath, editorTabs } = get();
      if (!activeEditorPath) return;
      const activeTab = editorTabs.find((t) => t.path === activeEditorPath);
      if (!activeTab) return;

      await writeFile(activeTab.path, activeTab.content);
      set((state) => ({
        editorTabs: state.editorTabs.map((t) =>
          t.path === activeEditorPath
            ? {
                ...t,
                isDirty: false,
                originalContent: t.content,
              }
            : t,
        ),
      }));
    },

    stageAiDiff: (path, original, modified, summary) => {
      const state = get();
      const existing = state.editorTabs.find((t) => t.path === path);
      const isMarkdown = path.endsWith(".md") || path.endsWith(".markdown");

      let tabs = state.editorTabs;
      if (!existing) {
        const newTab: EditorTab = {
          path,
          name: getFileName(path),
          content: original,
          originalContent: original,
          isDirty: false,
          language: detectEditorLanguage(path),
          isMarkdown,
        };
        tabs = [...tabs, newTab];
      }

      set({
        editorTabs: tabs,
        activeEditorPath: path,
        pendingAiDiff: { path, original, modified, summary },
        editorViewMode: "diff",
        // Review-only diffs never mix with the AI accept/reject flow
        viewOnlyDiff: null,
      });
    },

    acceptAiDiff: async () => {
      const { pendingAiDiff } = get();
      if (!pendingAiDiff) return;

      const { path, modified } = pendingAiDiff;
      await writeFile(path, modified);

      set((state) => ({
        pendingAiDiff: null,
        editorViewMode: "edit",
        editorTabs: state.editorTabs.map((t) =>
          t.path === path
            ? {
                ...t,
                content: modified,
                originalContent: modified,
                isDirty: false,
              }
            : t,
        ),
      }));
    },

    rejectAiDiff: () => {
      set({
        pendingAiDiff: null,
        editorViewMode: "edit",
      });
    },

    setEditorViewMode: (mode) => set({ editorViewMode: mode }),

    openDiffView: (path, original, modified) => {
      set({
        viewOnlyDiff: { path, original, modified },
        pendingAiDiff: null,
        activeAppMode: "editor",
      });
    },

    clearViewOnlyDiff: () =>
      set((s) => ({
        viewOnlyDiff: null,
        editorViewMode: s.pendingAiDiff ? s.editorViewMode : "edit",
      })),

    openGitDiff: async (path, area) => {
      const dir = get().getActiveCwd();
      if (!dir) return;
      // Untracked has no HEAD version, so compare worktree against empty base
      const staged = area === "staged";
      const compareAgainstHead = area === "untracked";
      const diff = await scFileDiff(dir, path, staged, compareAgainstHead);
      const modified =
        diff.kind === "binary"
          ? "<binary file>"
          : diff.truncated
            ? "<diff too large — truncated>"
            : diff.modified_content;
      get().openDiffView(path, diff.original_content, modified);
    },
  };
}
