import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// Pins the Orca-derived scrollbar rules so refactors cannot silently drop
// the invisible-gutter / border-clip-pill behavior.
describe("terminal scrollbar styling", () => {
  const css = fs.readFileSync(path.resolve(__dirname, "TerminalPane.css"), "utf8");

  it("keeps the native gutter constant-width and transparent", () => {
    expect(css).toMatch(
      /\.terminal-pane \.xterm-viewport \{\s*background-color: transparent !important;/,
    );
    expect(css).toMatch(
      /\.terminal-pane \.xterm-viewport::-webkit-scrollbar \{\s*width: 6px;/,
    );
    expect(css).toMatch(
      /\.terminal-pane \.xterm-viewport::-webkit-scrollbar-thumb \{\s*background: transparent;/,
    );
  });

  it("builds the overlay pill with the border-clip recipe", () => {
    expect(css).toMatch(
      /\.terminal-scrollbar-thumb \{[^}]*border: 2px solid transparent;[^}]*border-radius: 7px;[^}]*background-color: var\(--border-strong\);[^}]*background-clip: padding-box;/s,
    );
  });

  it("mounts the overlay below the pane header", () => {
    expect(css).toMatch(/\.terminal-scrollbar \{[^}]*top: 34px;/s);
  });
});
