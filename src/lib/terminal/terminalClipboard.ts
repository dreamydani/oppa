import { ptyWrite } from "../pty/transport";
import {
  readText as readBackendClipboard,
  writeText as writeBackendClipboard,
} from "@tauri-apps/plugin-clipboard-manager";

// WHY: xterm sends Ctrl+C/V to the PTY by default; Orca parity needs clipboard to own these chords.
export interface ClipboardKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

// Structural targets so tests and mocks never need the full xterm type.
export interface SelectionSource {
  getSelection(): string;
  focus?: () => void;
}

export interface PasteTarget {
  modes?: { bracketedPasteMode?: unknown };
  focus?: () => void;
}

export interface SelectionClearer {
  clearSelection?: () => void;
}

export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    navigator.platform.toUpperCase().includes("MAC") ||
    navigator.userAgent.includes("Mac")
  );
}

const lowerKey = (e: ClipboardKey): string => e.key.toLowerCase();

// Always intercept: explicit copy chords (never SIGINT).
export function isExplicitCopyChord(e: ClipboardKey, isMac: boolean): boolean {
  const key = lowerKey(e);
  if (isMac) return e.metaKey && !e.ctrlKey && !e.altKey && key === "c";
  if (e.ctrlKey && !e.metaKey && !e.altKey && key === "c" && e.shiftKey) return true;
  return e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && key === "insert";
}

// Plain Ctrl+C on Win/Linux: copy only when text is selected, else SIGINT.
export function isCopyOrInterruptChord(e: ClipboardKey, isMac: boolean): boolean {
  if (isMac) return false;
  return (
    e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && lowerKey(e) === "c"
  );
}

export function isPasteChord(e: ClipboardKey, isMac: boolean): boolean {
  const key = lowerKey(e);
  if (isMac) return e.metaKey && !e.ctrlKey && !e.altKey && key === "v";
  if (e.ctrlKey && !e.metaKey && !e.altKey && key === "v") return true;
  return e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && key === "insert";
}

// WHY: plain Ctrl+A is readline beginning-of-line; only the Shift variant may select all.
export function isSelectAllChord(e: ClipboardKey, isMac: boolean): boolean {
  const key = lowerKey(e);
  if (key !== "a" || e.altKey) return false;
  if (isMac) return e.metaKey && !e.ctrlKey;
  return e.ctrlKey && !e.metaKey && e.shiftKey;
}

export function wrapBracketedPaste(term: PasteTarget, text: string): string {
  return term.modes?.bracketedPasteMode === true
    ? `\x1b[200~${text}\x1b[201~`
    : text;
}

// WHY: backend clipboard never triggers the browser Allow/Block prompt; navigator is vite-dev fallback only.
async function readClipboard(): Promise<string | null> {
  try {
    return await readBackendClipboard();
  } catch {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return null;
    }
  }
}

async function writeText(text: string): Promise<boolean> {
  try {
    await writeBackendClipboard(text);
    return true;
  } catch {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // WHY: clipboard API can reject without focus/permission; execCommand covers the last mile.
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        area.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }
}

export async function copyTerminalSelection(term: SelectionSource): Promise<boolean> {
  const selection = term.getSelection();
  if (!selection) return false;
  const ok = await writeText(selection);
  if (ok) {
    try {
      term.focus?.();
    } catch {}
  }
  return ok;
}

export function clearTerminalSelection(term: SelectionClearer): void {
  try {
    term.clearSelection?.();
  } catch {}
}

export async function pasteTerminalClipboard(
  sessionId: string,
  term: PasteTarget,
): Promise<boolean> {
  const text = await readClipboard();
  if (!text) return false;
  // WHY: bracketed mode lets shells paste multiline safely instead of executing line by line.
  await ptyWrite(sessionId, wrapBracketedPaste(term, text));
  try {
    term.focus?.();
  } catch {}
  return true;
}
