import { describe, it, expect } from "vitest";
import { formatDiffComments } from "./diffCommentFormat";
import type { DiffComment } from "./transport";

function makeComment(overrides: Partial<DiffComment> = {}): DiffComment {
  return {
    id: "c-1",
    worktree_id: "wt-1",
    file_path: "src/lib/mod.rs",
    source: "diff",
    selected_text: null,
    start_line: null,
    line_number: 3,
    body: "fix this",
    scope: "unstaged",
    old_path: null,
    created_at_ms: 1,
    updated_at_ms: null,
    sent_at: null,
    ...overrides,
  };
}

describe("formatDiffComments", () => {
  it("returns empty string for no comments", () => {
    expect(formatDiffComments([])).toBe("");
  });

  it("formats a single-line unstaged comment with a Line line", () => {
    expect(formatDiffComments([makeComment()])).toBe(
      'File: src/lib/mod.rs\nLine: 3\nUser comment: "fix this"',
    );
  });

  it("formats a range comment with Lines when start_line is present", () => {
    const comment = makeComment({ start_line: 2, line_number: 5 });
    expect(formatDiffComments([comment])).toBe(
      'File: src/lib/mod.rs\nLines: 2-5\nUser comment: "fix this"',
    );
  });

  it("uses a Scope line for branch-scope comments even with a range", () => {
    const comment = makeComment({ scope: "branch", start_line: 2, line_number: 5 });
    expect(formatDiffComments([comment])).toBe(
      'File: src/lib/mod.rs\nScope: branch\nUser comment: "fix this"',
    );
  });

  it("puts raw selected text on its own line between location and body", () => {
    const comment = makeComment({
      selected_text: "let x = compute();",
      line_number: 7,
    });
    expect(formatDiffComments([comment])).toBe(
      'File: src/lib/mod.rs\nLine: 7\nlet x = compute();\nUser comment: "fix this"',
    );
  });

  it("keeps multi-line selected text raw and unescaped", () => {
    const comment = makeComment({
      selected_text: 'if (a) {\n  b();\n}',
      line_number: 9,
    });
    expect(formatDiffComments([comment])).toBe(
      'File: src/lib/mod.rs\nLine: 9\nif (a) {\n  b();\n}\nUser comment: "fix this"',
    );
  });

  it("escapes backslashes and double quotes in the body only", () => {
    const comment = makeComment({ body: 'say "hi" to C:\\path' });
    expect(formatDiffComments([comment])).toBe(
      'File: src/lib/mod.rs\nLine: 3\nUser comment: "say \\"hi\\" to C:\\\\path"',
    );
  });

  it("joins multiple comments across files with blank lines in input order", () => {
    const first = makeComment();
    const second = makeComment({
      id: "c-2",
      file_path: "README.md",
      scope: "staged",
      line_number: 12,
      body: "typo",
    });
    expect(formatDiffComments([first, second])).toBe(
      'File: src/lib/mod.rs\nLine: 3\nUser comment: "fix this"\n\n' +
        'File: README.md\nLine: 12\nUser comment: "typo"',
    );
  });
});
