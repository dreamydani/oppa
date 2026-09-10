import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearTerminalSelection,
  copyTerminalSelection,
  isCopyOrInterruptChord,
  isExplicitCopyChord,
  isPasteChord,
  isSelectAllChord,
  pasteTerminalClipboard,
  wrapBracketedPaste,
} from "./terminalClipboard";
import * as transport from "../pty/transport";

vi.mock("../pty/transport", () => ({
  ptyWrite: vi.fn().mockResolvedValue(undefined),
}));

const ptyWriteMock = vi.mocked(transport.ptyWrite);

const key = (
  overrides: Partial<{
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  }>,
) => ({
  key: "c",
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...overrides,
});

describe("terminalClipboard chords", () => {
  it("treats plain Ctrl+V and Ctrl+Shift+V and Shift+Insert as paste on Win/Linux", () => {
    expect(isPasteChord(key({ key: "v", ctrlKey: true }), false)).toBe(true);
    expect(
      isPasteChord(key({ key: "v", ctrlKey: true, shiftKey: true }), false),
    ).toBe(true);
    expect(
      isPasteChord(key({ key: "Insert", shiftKey: true }), false),
    ).toBe(true);
  });

  it("treats Cmd+V as paste on Mac but not Ctrl+V", () => {
    expect(isPasteChord(key({ key: "v", metaKey: true }), true)).toBe(true);
    expect(isPasteChord(key({ key: "v", ctrlKey: true }), true)).toBe(false);
  });

  it("routes plain Ctrl+C through the selection check on Win/Linux only", () => {
    expect(isCopyOrInterruptChord(key({ ctrlKey: true }), false)).toBe(true);
    expect(isCopyOrInterruptChord(key({ ctrlKey: true }), true)).toBe(false);
    expect(
      isCopyOrInterruptChord(key({ ctrlKey: true, shiftKey: true }), false),
    ).toBe(false);
  });

  it("always intercepts explicit copy chords", () => {
    expect(
      isExplicitCopyChord(key({ ctrlKey: true, shiftKey: true }), false),
    ).toBe(true);
    expect(
      isExplicitCopyChord(key({ key: "Insert", ctrlKey: true }), false),
    ).toBe(true);
    expect(isExplicitCopyChord(key({ metaKey: true }), true)).toBe(true);
  });

  it("reserves select-all for the Shift variant so Ctrl+A stays readline", () => {
    expect(
      isSelectAllChord(key({ key: "a", ctrlKey: true, shiftKey: true }), false),
    ).toBe(true);
    expect(isSelectAllChord(key({ key: "a", ctrlKey: true }), false)).toBe(
      false,
    );
    expect(isSelectAllChord(key({ key: "a", metaKey: true }), true)).toBe(true);
  });

  it("wraps pastes only when the terminal ACKs bracketed mode", () => {
    expect(
      wrapBracketedPaste({ modes: { bracketedPasteMode: true } } as never, "ls\n"),
    ).toBe("\x1b[200~ls\n\x1b[201~");
    expect(
      wrapBracketedPaste({ modes: { bracketedPasteMode: "none" } } as never, "ls"),
    ).toBe("ls");
  });
});

describe("terminalClipboard io", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("copies the selection and refocuses the terminal", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const term = { getSelection: vi.fn().mockReturnValue("hello"), focus: vi.fn() };
    expect(await copyTerminalSelection(term)).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(term.focus).toHaveBeenCalled();
  });

  it("skips empty selections", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    const term = { getSelection: vi.fn().mockReturnValue(""), focus: vi.fn() };
    expect(await copyTerminalSelection(term)).toBe(false);
  });

  it("pastes clipboard text through ptyWrite", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { readText: vi.fn().mockResolvedValue("echo hi") },
    });
    const term = { modes: {}, focus: vi.fn() };
    expect(await pasteTerminalClipboard("s1", term)).toBe(true);
    expect(ptyWriteMock).toHaveBeenCalledWith("s1", "echo hi");
  });

  it("refuses empty clipboard reads", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { readText: vi.fn().mockResolvedValue("") },
    });
    expect(await pasteTerminalClipboard("s1", { modes: {}, focus: vi.fn() })).toBe(
      false,
    );
    expect(ptyWriteMock).not.toHaveBeenCalled();
  });

  it("tolerates terminals without clearSelection", () => {
    expect(() =>
      clearTerminalSelection({} as never),
    ).not.toThrow();
  });
});
