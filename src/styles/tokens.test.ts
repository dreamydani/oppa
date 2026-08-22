import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

// One-home invariant: theme.css is the ONLY stylesheet allowed to define
// global custom properties. Component-scoped token systems are permitted
// beside their component when prefixed (the wizard's --wizard-*).
const TOKEN_SHEET = join(dirname(fileURLToPath(import.meta.url)), "theme.css");
const SRC_DIR = dirname(dirname(TOKEN_SHEET));

const DECL_LINE_RE = /^\s*--([a-zA-Z][\w-]*)\s*:/;
const WIZARD_PREFIX = "--wizard-";

function listCssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listCssFiles(full);
    return entry.name.endsWith(".css") ? [full] : [];
  });
}

function findGlobalTokenDeclarations(
  cssPath: string,
): { name: string; line: number }[] {
  const hits: { name: string; line: number }[] = [];
  const lines = readFileSync(cssPath, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    const match = line.match(DECL_LINE_RE);
    if (!match) return;
    const name = `--${match[1]}`;
    if (name.startsWith(WIZARD_PREFIX)) return;
    hits.push({ name, line: index + 1 });
  });
  return hits;
}

describe("design token one-home invariant", () => {
  it("theme.css defines the core global tokens", () => {
    const declared = new Set(
      findGlobalTokenDeclarations(TOKEN_SHEET).map((d) => d.name),
    );
    for (const required of [
      "--font-sans",
      "--font-mono",
      "--background",
      "--foreground",
      "--bg-window",
      "--bg-terminal",
      "--border",
      "--accent-blue",
      "--destructive",
    ]) {
      expect(declared.has(required), `${required} must live in theme.css`).toBe(
        true,
      );
    }
  });

  it("no other stylesheet defines non-wizard custom properties", () => {
    const offenders: string[] = [];
    for (const file of listCssFiles(SRC_DIR)) {
      if (file === TOKEN_SHEET) continue;
      for (const { name, line } of findGlobalTokenDeclarations(file)) {
        offenders.push(`${relative(SRC_DIR, file)}:${line} defines ${name}`);
      }
    }
    expect(
      offenders,
      `Global tokens defined outside theme.css:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
