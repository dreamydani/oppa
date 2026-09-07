import { describe, it, expect, vi, beforeEach } from "vitest";
import { ptyWrite } from "../pty/transport";
import { captureInsertionTarget, insertText } from "./dictationInsertion";

vi.mock("../pty/transport", () => ({ ptyWrite: vi.fn(async () => {}) }));

const ptyWriteMock = vi.mocked(ptyWrite);

describe("dictationInsertion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = "";
    (document.activeElement as HTMLElement | null)?.blur?.();
  });

  describe("captureInsertionTarget", () => {
    it("captures the terminal session from the xterm helper textarea", () => {
      document.body.innerHTML =
        `<div class="pane-leaf" data-pane-id="s-7">` +
        `<textarea class="xterm-helper-textarea"></textarea></div>`;
      const area = document.querySelector("textarea")!;
      area.focus();
      expect(captureInsertionTarget()).toEqual({ kind: "terminal", sessionId: "s-7" });
    });

    it("returns null for helper textareas outside a pane leaf", () => {
      document.body.innerHTML = `<textarea class="xterm-helper-textarea"></textarea>`;
      document.querySelector("textarea")!.focus();
      expect(captureInsertionTarget()).toBeNull();
    });

    it("captures text inputs and textareas", () => {
      document.body.innerHTML = `<input type="text" />`;
      const input = document.querySelector("input")!;
      input.focus();
      const target = captureInsertionTarget();
      expect(target?.kind).toBe("text");
    });

    it("captures contentEditable elements", () => {
      document.body.innerHTML = `<div contenteditable="true"></div>`;
      document.querySelector("div")!.focus();
      expect(captureInsertionTarget()?.kind).toBe("contentEditable");
    });

    it("returns null when nothing relevant is focused", () => {
      document.body.innerHTML = `<div tabindex="0"></div>`;
      document.querySelector("div")!.focus();
      expect(captureInsertionTarget()).toBeNull();
    });
  });

  describe("insertText", () => {
    it("writes terminal transcripts through ptyWrite to the captured session", () => {
      insertText("hello", { kind: "terminal", sessionId: "s-7" });
      expect(ptyWriteMock).toHaveBeenCalledWith("s-7", "hello");
    });

    it("splices text inputs at the cursor and notifies React", () => {
      document.body.innerHTML = `<input type="text" />`;
      const input = document.querySelector("input")!;
      input.value = "helloworld";
      input.setSelectionRange(5, 5);
      const onInput = vi.fn();
      input.addEventListener("input", onInput);

      insertText(" brave ", { kind: "text", element: input });

      expect(input.value).toBe("hello brave world");
      expect(onInput).toHaveBeenCalledTimes(1);
      expect(input.selectionStart).toBe(12);
    });

    it("skips detached inputs", () => {
      document.body.innerHTML = `<input type="text" />`;
      const input = document.querySelector("input")!;
      input.remove();
      expect(() =>
        insertText("hi", { kind: "text", element: input }),
      ).not.toThrow();
      expect(ptyWriteMock).not.toHaveBeenCalled();
    });
  });
});
