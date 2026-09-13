import {
  File,
  FileArchive,
  FileCog,
  FileCode,
  FileImage,
  FileJson,
  FileLock,
  FileTerminal,
  FileText,
  FileWarning,
  type LucideIcon,
} from "lucide-react";

export interface FileVisual {
  Icon: LucideIcon;
  color: string;
}

// VSCode-like per-extension colors; lucide only, no new deps.
export function getFileVisual(fileName: string): FileVisual {
  const lower = fileName.toLowerCase();
  if (lower === ".gitignore" || lower === ".gitattributes" || lower === ".gitmodules") {
    return { Icon: FileWarning, color: "#f85149" };
  }
  if (
    lower === "package-lock.json" ||
    lower === "pnpm-lock.yaml" ||
    lower === "cargo.lock" ||
    lower.endsWith(".lock")
  ) {
    return { Icon: FileLock, color: "#8b949e" };
  }
  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) {
    return { Icon: FileCog, color: "#58a6ff" };
  }
  if (lower === "tsconfig.json" || lower.startsWith("tsconfig.")) {
    return { Icon: FileCog, color: "#58a6ff" };
  }
  const dot = lower.lastIndexOf(".");
  const ext = dot === -1 ? "" : lower.slice(dot + 1);
  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return { Icon: FileCode, color: "#58a6ff" };
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return { Icon: FileCode, color: "#e3b341" };
    case "rs":
      return { Icon: FileTerminal, color: "#f0883e" };
    case "json":
    case "jsonc":
      return { Icon: FileJson, color: "#e3b341" };
    case "md":
    case "markdown":
    case "mdx":
      return { Icon: FileText, color: "#4ade80" };
    case "toml":
    case "yaml":
    case "yml":
    case "ini":
    case "cfg":
    case "conf":
      return { Icon: FileCog, color: "#8b949e" };
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "svg":
    case "ico":
    case "webp":
      return { Icon: FileImage, color: "#a371f7" };
    case "zip":
    case "tar":
    case "gz":
    case "7z":
    case "rar":
      return { Icon: FileArchive, color: "#8b949e" };
    case "sh":
    case "ps1":
    case "bat":
    case "cmd":
      return { Icon: FileTerminal, color: "#3fb950" };
    default:
      return { Icon: File, color: "#8b949e" };
  }
}

// WHY single amber default: VSCode folders read as one family; only well-known
// roots get a tint so the tree stays scannable instead of rainbow.
export function getFolderColor(folderName: string): string {
  const lower = folderName.toLowerCase();
  if (lower === "node_modules") return "#3fb950";
  if (lower === "docs") return "#58a6ff";
  if (lower === "public" || lower === "assets" || lower === "static") return "#a371f7";
  if (lower === "src") return "#f0883e";
  if (lower === "dist" || lower === "build" || lower === "out") return "#8b949e";
  if (folderName.startsWith(".")) return "#8b949e";
  return "#d29922";
}

export type GitLetter = "M" | "U" | "A" | "D" | "C";

// ponytail: O(n) scan per row; Map precompute in caller if tree exceeds ~2k rows.
export function gitLetterClass(letter: GitLetter): string {
  switch (letter) {
    case "M":
      return "git-badge-modified";
    case "U":
      return "git-badge-untracked";
    case "A":
      return "git-badge-added";
    case "D":
    case "C":
      return "git-badge-deleted";
  }
}
