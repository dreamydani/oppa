// Dictation insertion targets — Orca's `dictation-insertion-target.ts`
// adapted to Oppa's DOM: terminal panes resolve through
// `.pane-leaf[data-pane-id]` (the leaf id IS the PTY session id) and insert
// via `pty_write`; text inputs and content-editables insert natively.
// The target is captured when dictation STARTS; focus moves mid-session
// never redirect the transcript.

import { ptyWrite } from "../pty/transport";

export type DictationInsertionTarget =
  | { kind: "terminal"; sessionId: string }
  | { kind: "text"; element: HTMLInputElement | HTMLTextAreaElement }
  | { kind: "contentEditable"; element: HTMLElement };

export function captureInsertionTarget(): DictationInsertionTarget | null {
  const activeElement = document.activeElement;

  if (!activeElement) {
    return null;
  }

  if (activeElement.classList.contains("xterm-helper-textarea")) {
    const paneElement = activeElement.closest(".pane-leaf[data-pane-id]") as HTMLElement | null;
    const sessionId = paneElement?.dataset.paneId;
    if (sessionId) {
      return { kind: "terminal", sessionId };
    }
    return null;
  }

  if (activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement) {
    return { kind: "text", element: activeElement };
  }

  if (activeElement instanceof HTMLElement && activeElement.isContentEditable) {
    return { kind: "contentEditable", element: activeElement };
  }

  return null;
}

export function insertText(text: string, target: DictationInsertionTarget): void {
  if (target.kind === "terminal") {
    // Typed input, not Enter — the user submits (Orca parity).
    void ptyWrite(target.sessionId, text).catch(() => {});
    return;
  }

  if (target.kind === "text") {
    insertIntoTextControl(target.element, text);
    return;
  }

  insertIntoContentEditable(target.element, text);
}

function insertIntoTextControl(
  element: HTMLInputElement | HTMLTextAreaElement,
  text: string,
): void {
  if (!element.isConnected) {
    return;
  }
  const start = element.selectionStart ?? element.value.length;
  const end = element.selectionEnd ?? element.value.length;
  const next = element.value.slice(0, start) + text + element.value.slice(end);
  // Native setter + bubbling input event so React-controlled inputs observe it.
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(element, next);
  element.setSelectionRange(start + text.length, start + text.length);
  element.dispatchEvent(new InputEvent("input", { bubbles: true }));
}

function insertIntoContentEditable(element: HTMLElement, text: string): void {
  if (!element.isConnected) {
    return;
  }
  element.focus({ preventScroll: true });
  if (!document.execCommand("insertText", false, text)) {
    // execCommand is deprecated and may no-op: range fallback.
    const selection = document.getSelection();
    if (selection && selection.rangeCount > 0) {
      const range = selection.getRangeAt(0);
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      range.collapse(false);
    } else {
      element.textContent = (element.textContent ?? "") + text;
    }
  }
}
