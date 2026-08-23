import type { DiffComment } from "../pty/transport";

// Deterministic prompt blocks ported from Orca's diff-comments format; joined
// by blank lines so agents receive one stable shape per note.
function escapeBody(body: string): string {
  return body.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function formatDiffComments(comments: DiffComment[]): string {
  return comments
    .map((comment) => {
      const lines: string[] = [`File: ${comment.file_path}`];
      if (comment.scope === "branch") {
        lines.push("Scope: branch");
      } else if (comment.start_line !== null && comment.start_line !== undefined) {
        lines.push(`Lines: ${comment.start_line}-${comment.line_number}`);
      } else {
        lines.push(`Line: ${comment.line_number}`);
      }
      if (comment.selected_text) {
        lines.push(comment.selected_text);
      }
      lines.push(`User comment: "${escapeBody(comment.body)}"`);
      return lines.join("\n");
    })
    .join("\n\n");
}
