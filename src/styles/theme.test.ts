import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("theme tokens", () => {
  it("defines standard color tokens matching the #141414 and #212120 palette", () => {
    const cssPath = path.resolve(__dirname, "./theme.css");
    const content = fs.readFileSync(cssPath, "utf-8");

    expect(content).toContain("--background: #141414;");
    expect(content).toContain("--sidebar: #212120;");
    expect(content).toContain("--card: #282827;");
    expect(content).toContain("--foreground: #ededec;");
    expect(content).toContain("--muted-foreground: #9e9e9a;");
  });
});
