import { describe, it, expect } from "vitest";
import { FRIENDLY_NAMES, isSyntheticTitle, pickFriendlyName } from "./friendlyNames";

describe("friendlyNames", () => {
  it("picked name is never synthetic or empty", () => {
    for (const id of ["s-1786150000000-1", "s-1", "abc", ""]) {
      const name = pickFriendlyName(id, new Set());
      expect(name).not.toBe("");
      expect(isSyntheticTitle(name, id)).toBe(false);
    }
  });

  it("same id picks the same word for restore stability", () => {
    expect(pickFriendlyName("s-1", new Set())).toBe(pickFriendlyName("s-1", new Set()));
  });

  it("skips taken words", () => {
    const first = pickFriendlyName("s-2", new Set());
    expect(pickFriendlyName("s-2", new Set([first]))).not.toBe(first);
  });

  it("exhausted pool falls back to a suffixed word", () => {
    const name = pickFriendlyName("s-3", new Set(FRIENDLY_NAMES));
    expect(name).toContain("-");
    expect(FRIENDLY_NAMES).not.toContain(name);
  });

  it("synthetic detection covers id-equal and s- prefix", () => {
    expect(isSyntheticTitle("s-1-2", "other")).toBe(true);
    expect(isSyntheticTitle("s1", "s1")).toBe(true);
    expect(isSyntheticTitle("fox", "s-1-2")).toBe(false);
    expect(isSyntheticTitle(undefined, "s-1")).toBe(true);
  });

  it("pool words are single lowercase tokens", () => {
    expect(FRIENDLY_NAMES.length).toBeGreaterThanOrEqual(60);
    expect(new Set(FRIENDLY_NAMES).size).toBe(FRIENDLY_NAMES.length);
    for (const w of FRIENDLY_NAMES) {
      expect(w).toMatch(/^[a-z]+$/);
    }
  });
});
