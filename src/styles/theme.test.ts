import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("Theme CSS", () => {
  it("defines all core Orca-matched CSS custom properties", () => {
    const css = readFileSync(resolve(__dirname, "theme.css"), "utf-8");
    expect(css).toContain("--background: #0a0a0a;");
    expect(css).toContain("--foreground: #fafafa;");
    expect(css).toContain("--card: #171717;");
    expect(css).toContain("--card-foreground: #fafafa;");
    expect(css).toContain("--sidebar: #121212;");
    expect(css).toContain("--sidebar-foreground: #fafafa;");
    expect(css).toContain("--sidebar-border: rgba(255, 255, 255, 0.08);");
    expect(css).toContain("--border: rgba(255, 255, 255, 0.08);");
    expect(css).toContain("--muted: #262626;");
    expect(css).toContain("--muted-foreground: #a1a1a1;");
    expect(css).toContain("--accent: #2c2c2c;");
    expect(css).toContain("--accent-foreground: #ffffff;");
    expect(css).toContain("--primary: #e5e5e5;");
    expect(css).toContain("--primary-foreground: #171717;");
    expect(css).toContain("--destructive: #ff6568;");
    expect(css).toContain("--ring: #737373;");
    expect(css).toContain("--git-added: #4ade80;");
    expect(css).toContain("--git-modified: #fbbf24;");
    expect(css).toContain("--git-deleted: #f87171;");
    expect(css).toContain("--git-untracked: #a3e635;");
    expect(css).toContain("--font-sans:");
    expect(css).toContain("--font-mono:");
  });
});
