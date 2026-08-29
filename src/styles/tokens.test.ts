// @vitest-environment node
// This sheet reads the filesystem to police other stylesheets, so it cannot
// run in the happy-dom default project. Without the override vite externalises
// `node:fs` and the whole file silently fails to collect — the guard the
// theme.css header advertises would otherwise never execute.
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

// Blank out CSS comment bodies while preserving every line number, so the
// scanners below cannot be fooled by prose. Without this, a sentence like
// "why data-state rather than a transition:" parses as a declaration whose
// value runs until the next semicolon in the file, so the comment swallows real
// rules and the guard reports phantom offenders.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (block) =>
    block.replace(/[^\n]/g, " "),
  );
}

function readSheet(cssPath: string): string {
  return stripComments(readFileSync(cssPath, "utf8"));
}

function findGlobalTokenDeclarations(
  cssPath: string,
): { name: string; line: number }[] {
  const hits: { name: string; line: number }[] = [];
  readSheet(cssPath).split(/\r?\n/).forEach((line, index) => {
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
      "--dur-zoom-out",
      "--dur-zoom-in",
      "--dur-panel-open",
      "--dur-panel-close",
      "--ease-dolly",
      // Motion system tiers — see the review of 2026-08-29: one duration per
      // interaction weight, one named curve per intent. Guarded here so no
      // component can reintroduce a private literal and drift again.
      "--dur-micro",
      "--dur-fast",
      "--dur-base",
      "--dur-mid",
      "--dur-slow",
      "--ease-out",
      "--ease-in",
      "--ease-in-out",
      "--ease-spring",
      "--stagger-step",
      "--stagger-cap",
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

/* ==========================================================================
   Motion discipline ratchets.

   The 2026-08-29 motion review found 116 transitions of which 114 hardcoded
   their own duration/easing and 42 used `transition: all`. These lock the
   fixed state in place so new CSS cannot reintroduce the drift.
   ========================================================================== */
const TRANSITION_RE = /transition\s*:\s*([^;]+);/g;
const ANIMATION_RE = /(?:^|[^-])animation\s*:\s*([^;]+);/g;
// A raw duration is any <number>m?s literal. `0s` stays legal: it is how a
// transition delays a discrete property (visibility) without moving anything.
const RAW_DURATION_RE = /(?:^|[\s,(])(?!0s(?:\s|$))(\d*\.?\d+m?s)\b/;
const ALL_TRANSITION_RE = /^\s*all(?:$|[\s,])/;
// An aesthetic curve. `linear` and `steps()` are deliberately absent: those are
// functional timing for rotations and blinkers, not taste, so they are allowed
// to stay literal.
const CURVE_RE = /(cubic-bezier|ease-in-out|ease-out|ease-in|\bease\b)/;
const NAMED_TOKEN_RE = /var\(--ease-[\w-]+\)/;
// Anything here forces a relayout on every frame of the animation. `gap` and
// `font-size` are included because they reflow siblings too.
const LAYOUT_PROP_RE =
  /^(width|height|top|left|right|bottom|inset|margin|padding|gap|font-size|line-height|flex-basis)$/;

type Clause = { text: string; line: number };

/**
 * Split a declaration into per-property clauses. Paren-aware, so the commas
 * inside `cubic-bezier(a, b, c, d)` are never treated as separators — and
 * checks are therefore per clause: a single tokenised property in a
 * multi-property declaration must not excuse its neighbours.
 */
function splitClauses(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of body) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function declarations(re: RegExp, cssPath: string): Clause[] {
  const raw = readSheet(cssPath);
  const hits: Clause[] = [];
  let m: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((m = re.exec(raw)) !== null) {
    const line = raw.slice(0, m.index).split(/\r?\n/).length;
    const collapsed = m[1].replace(/\s*\n\s*/g, " ").trim();
    for (const text of splitClauses(collapsed)) hits.push({ text, line });
  }
  return hits;
}

const transitionClauses = (p: string) => declarations(TRANSITION_RE, p);
const animationClauses = (p: string) => declarations(ANIMATION_RE, p);

describe("motion discipline", () => {
  const componentSheets = listCssFiles(SRC_DIR).filter(
    (f) => f !== TOKEN_SHEET,
  );

  it("forbids `transition: all` (it animates layout + non-interpolable props)", () => {
    const offenders: string[] = [];
    for (const file of componentSheets) {
      for (const { text, line } of transitionClauses(file)) {
        if (ALL_TRANSITION_RE.test(text)) {
          offenders.push(`${relative(SRC_DIR, file)}:${line} → ${text}`);
        }
      }
    }
    expect(
      offenders,
      `\`transition: all\` is banned; list properties explicitly:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("requires every component transition to use a --dur-* token", () => {
    const offenders: string[] = [];
    for (const file of componentSheets) {
      for (const { text, line } of transitionClauses(file)) {
        if (/^\s*none\b/.test(text)) continue;
        if (RAW_DURATION_RE.test(text)) {
          offenders.push(
            `${relative(SRC_DIR, file)}:${line} → ${text.slice(0, 70)}`,
          );
        }
      }
    }
    expect(
      offenders,
      `Hardcoded durations must be replaced by --dur-* tokens:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("requires every component transition clause to use an --ease-* token", () => {
    const offenders: string[] = [];
    for (const file of componentSheets) {
      for (const { text, line } of transitionClauses(file)) {
        if (CURVE_RE.test(text) && !NAMED_TOKEN_RE.test(text)) {
          offenders.push(
            `${relative(SRC_DIR, file)}:${line} → ${text.slice(0, 70)}`,
          );
        }
      }
    }
    expect(
      offenders,
      `Easing must come from an --ease-* token:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps animation easing on tokens (linear/steps stay legal)", () => {
    const offenders: string[] = [];
    for (const file of componentSheets) {
      for (const { text, line } of animationClauses(file)) {
        if (CURVE_RE.test(text) && !NAMED_TOKEN_RE.test(text)) {
          offenders.push(
            `${relative(SRC_DIR, file)}:${line} → ${text.slice(0, 70)}`,
          );
        }
      }
    }
    expect(
      offenders,
      `Animation easing must come from an --ease-* token:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("never interpolates a layout property", () => {
    const offenders: string[] = [];
    for (const file of componentSheets) {
      for (const { text, line } of transitionClauses(file)) {
        const prop = text.split(/\s+/)[0];
        if (LAYOUT_PROP_RE.test(prop)) {
          offenders.push(`${relative(SRC_DIR, file)}:${line} → ${text.slice(0, 70)}`);
        }
      }
    }
    expect(
      offenders,
      `Layout properties trigger relayout+repaint each frame; animate ` +
        `transform/opacity instead:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
