import { describe, it, expect } from "vitest";
import {
  registerDiffSelectionGetter,
  readDiffSelection,
} from "./diffSelectionBridge";

describe("diffSelectionBridge", () => {
  it("returns null when no editor is registered", () => {
    expect(readDiffSelection()).toBeNull();
  });

  it("returns the snapshot of the most recently registered getter", () => {
    registerDiffSelectionGetter(() => ({
      selectedText: "a",
      lineNumber: 3,
      rangeStartLine: null,
    }));
    expect(readDiffSelection()).toEqual({
      selectedText: "a",
      lineNumber: 3,
      rangeStartLine: null,
    });

    registerDiffSelectionGetter(() => ({
      selectedText: "b",
      lineNumber: 5,
      rangeStartLine: 2,
    }));
    expect(readDiffSelection()).toEqual({
      selectedText: "b",
      lineNumber: 5,
      rangeStartLine: 2,
    });
  });

  it("clears the registry when unregistered with null", () => {
    registerDiffSelectionGetter(() => ({
      selectedText: "",
      lineNumber: 1,
      rangeStartLine: null,
    }));
    registerDiffSelectionGetter(null);
    expect(readDiffSelection()).toBeNull();
  });

  it("treats a throwing or missing-editor getter as no selection", () => {
    registerDiffSelectionGetter(() => {
      throw new Error("disposed");
    });
    expect(readDiffSelection()).toBeNull();
  });
});
