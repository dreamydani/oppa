import { useEffect, useState, type ReactElement } from "react";
import { MessageSquarePlus, X } from "lucide-react";
import { useTerminalStore } from "../../store/terminalStore";
import { readDiffSelection } from "./diffSelectionBridge";
import type { DiffCommentScope } from "../../lib/pty/transport";

interface NoteDraft {
  body: string;
  line: number;
  scope: DiffCommentScope;
  selectedText: string;
  rangeStartLine: number | null;
}

export function ViewOnlyDiffBar(): ReactElement | null {
  const viewOnlyDiff = useTerminalStore((s) => s.viewOnlyDiff);
  const clearViewOnlyDiff = useTerminalStore((s) => s.clearViewOnlyDiff);
  const worktreeId = useTerminalStore((s) => s.getActiveWorktreeId());
  const addComment = useTerminalStore((s) => s.addComment);

  const [draft, setDraft] = useState<NoteDraft | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!viewOnlyDiff) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearViewOnlyDiff();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [viewOnlyDiff, clearViewOnlyDiff]);

  if (!viewOnlyDiff) return null;

  const openNoteForm = () => {
    const snap = readDiffSelection();
    setDraft({
      body: "",
      line: snap?.lineNumber ?? 1,
      scope: "unstaged",
      selectedText: snap?.selectedText ?? "",
      rangeStartLine: snap?.rangeStartLine ?? null,
    });
  };

  const saveNote = async () => {
    if (!draft || !worktreeId) return;
    setSaving(true);
    try {
      await addComment(worktreeId, {
        worktree_id: worktreeId,
        file_path: viewOnlyDiff.path,
        source: "diff",
        selected_text: draft.selectedText || null,
        start_line: draft.rangeStartLine,
        line_number: Math.max(1, Math.floor(draft.line) || 1),
        body: draft.body.trim(),
        scope: draft.scope,
      });
      setDraft(null);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="view-only-diff-bar-wrap">
      <div className="view-only-diff-bar" data-testid="view-only-diff-bar">
        <span className="view-only-diff-label">Viewing diff — Esc to close</span>
        <span className="view-only-diff-path" title={viewOnlyDiff.path}>
          {viewOnlyDiff.path}
        </span>
        <button
          type="button"
          className="view-only-diff-note-btn"
          data-testid="add-diff-note"
          disabled={!worktreeId}
          title={worktreeId ? "Add a review note" : "Bind a terminal to a worktree to leave review notes"}
          onClick={openNoteForm}
        >
          <MessageSquarePlus size={13} />
          Note
        </button>
        <button
          type="button"
          className="view-only-diff-close"
          aria-label="Close diff view"
          onClick={clearViewOnlyDiff}
        >
          <X size={13} />
        </button>
      </div>
      {draft && (
        <div className="diff-note-form" data-testid="diff-note-form">
          <textarea
            className="diff-note-body"
            data-testid="diff-note-body"
            placeholder="Review note…"
            rows={2}
            value={draft.body}
            autoFocus
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
          />
          <div className="diff-note-form-row">
            <label className="diff-note-field">
              Line
              <input
                type="number"
                min={1}
                className="diff-note-line-input"
                data-testid="diff-note-line"
                value={draft.line}
                onChange={(e) => setDraft({ ...draft, line: Number(e.target.value) })}
              />
            </label>
            <label className="diff-note-field">
              Scope
              <select
                className="diff-note-scope-select"
                data-testid="diff-note-scope"
                value={draft.scope}
                onChange={(e) =>
                  setDraft({ ...draft, scope: e.target.value as DiffCommentScope })
                }
              >
                <option value="unstaged">unstaged</option>
                <option value="staged">staged</option>
                <option value="branch">branch</option>
              </select>
            </label>
            <div className="diff-note-form-actions">
              <button
                type="button"
                className="git-bulk-btn"
                data-testid="diff-note-cancel"
                onClick={() => setDraft(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="git-bulk-btn git-note-save-btn"
                data-testid="diff-note-save"
                disabled={!draft.body.trim() || saving || !worktreeId}
                onClick={() => void saveNote()}
              >
                Save note
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
