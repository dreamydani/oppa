import { describe, it, expect } from "vitest";
import { getFileVisual, getFolderColor, gitLetterClass } from "./fileIcons";

describe("fileIcons", () => {
  it("colors TS blue, JSON amber, MD green", () => {
    expect(getFileVisual("app.ts").color).toBe("#58a6ff");
    expect(getFileVisual("package.json").color).toBe("#e3b341");
    expect(getFileVisual("README.md").color).toBe("#4ade80");
  });

  it("marks gitignore red and lockfiles gray", () => {
    expect(getFileVisual(".gitignore").color).toBe("#f85149");
    expect(getFileVisual("package-lock.json").color).toBe("#8b949e");
  });

  it("tints well-known folders, defaults to amber", () => {
    expect(getFolderColor("node_modules")).toBe("#3fb950");
    expect(getFolderColor("src")).toBe("#f0883e");
    expect(getFolderColor("my-app")).toBe("#d29922");
  });

  it("maps git letters to badge classes", () => {
    expect(gitLetterClass("M")).toBe("git-badge-modified");
    expect(gitLetterClass("U")).toBe("git-badge-untracked");
  });
});
