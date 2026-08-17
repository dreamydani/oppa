import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("Theme tokens", () => {
  it("defines top bar, workspace canvas, and soft-edge tokens in theme.css", () => {
    const cssPath = path.resolve(__dirname, "theme.css");
    const content = fs.readFileSync(cssPath, "utf-8");

    expect(content).toContain("--topbar-bg: #000000;");
    expect(content).toContain("--workspace-bg: #18181b;");
    expect(content).toContain("--soft-edge-radius: 12px;");
    expect(content).toContain("--background: #18181b;");
    expect(content).toContain("--sidebar: #141416;");
    expect(content).toContain("--card: #222225;");
    expect(content).toContain("--foreground: #ededec;");
    expect(content).toContain("--muted-foreground: #9e9e9a;");
  });
});
