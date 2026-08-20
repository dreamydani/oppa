// Monaco Editor Theme Configuration & Language Mapper for OPPA

export function mapToMonacoLanguage(filePath: string, fallbackLang?: string): string {
  if (!filePath) return fallbackLang || "plaintext";
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
    case "html":
    case "htm":
      return "html";
    case "css":
    case "scss":
    case "less":
      return "css";
    case "json":
      return "json";
    case "rs":
      return "rust";
    case "py":
    case "pyw":
      return "python";
    case "md":
    case "markdown":
      return "markdown";
    case "yaml":
    case "yml":
      return "yaml";
    case "toml":
      return "toml";
    case "sh":
    case "bash":
    case "zsh":
      return "shell";
    case "sql":
      return "sql";
    case "go":
      return "go";
    case "xml":
    case "svg":
      return "xml";
    default:
      return fallbackLang || "plaintext";
  }
}

export const OPPA_DARK_THEME = "oppa-dark";
export const OPPA_LIGHT_THEME = "oppa-light";

export function defineOppaMonacoThemes(monaco: any) {
  if (!monaco?.editor?.defineTheme) return;

  monaco.editor.defineTheme(OPPA_DARK_THEME, {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6e7681", fontStyle: "italic" },
      { token: "keyword", foreground: "f472b6" },
      { token: "string", foreground: "86efac" },
      { token: "number", foreground: "fb923c" },
      { token: "type", foreground: "60a5fa" },
      { token: "tag", foreground: "60a5fa" },
      { token: "attribute.name", foreground: "facc15" },
    ],
    colors: {
      "editor.background": "#141414",
      "editor.foreground": "#ededec",
      "editorGutter.background": "#141414",
      "editorLineNumber.foreground": "#71717a",
      "editorLineNumber.activeForeground": "#ededec",
      "editorCursor.foreground": "#ededec",
      "editor.selectionBackground": "#264f78",
      "editor.inactiveSelectionBackground": "#3a3d41",
      "editor.lineHighlightBackground": "#18181b",
      "editorIndentGuide.background": "#27272a",
      "editorIndentGuide.activeBackground": "#3f3f46",
    },
  });

  monaco.editor.defineTheme(OPPA_LIGHT_THEME, {
    base: "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#fbfbfa",
      "editor.foreground": "#18181b",
      "editorGutter.background": "#fbfbfa",
      "editorLineNumber.foreground": "#a1a1aa",
      "editorLineNumber.activeForeground": "#18181b",
      "editor.lineHighlightBackground": "#f4f4f2",
    },
  });
}
