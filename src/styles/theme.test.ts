import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("Theme tokens", () => {
  it("defines top bar, workspace canvas, and soft-edge tokens in theme.css", () => {
    const cssPath = path.resolve(__dirname, "theme.css");
    const content = fs.readFileSync(cssPath, "utf-8");

    expect(content).toContain("--topbar-bg: #171717;");
    expect(content).toContain("--workspace-bg: #171717;");
    expect(content).toContain("--soft-edge-radius: 12px;");
    expect(content).toContain("--background: #171717;");
    expect(content).toContain("--sidebar: #242424;");
    expect(content).toContain("--card: #2c2c2c;");
    expect(content).toContain("--foreground: #cccccc;");
    expect(content).toContain("--muted-foreground: #999999;");
  });
});
