import React, { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Copy, Pencil, Send, StickyNote, Trash2 } from "lucide-react";
import { useTerminalStore } from "../../store/terminalStore";
import { formatDiffComments } from "../../lib/git/diffCommentFormat";

const BODY_PREVIEW_CHARS = 60;

function truncateBody(body: string): string {
  const firstLine = body.split("\n")[0];
  return firstLine.length > BODY_PREVIEW_CHARS
    ? `${firstLine.slice(0, BODY_PREVIEW_CHARS)}…`
    : firstLine;
}

export function DiffNotesShelf(): React.ReactElement {
  const worktreeId = useTerminalStore((s) => s.getActiveWorktreeId());
  const worktrees = useTerminalStore((s) => s.worktrees);
  // Raw bucket only — deriving a fallback array here would re-render forever.
  const storedComments = useTerminalStore((s) =>
    worktreeId ? s.diffComments[worktreeId] : undefined,
  );
  const commentsForWorktree = storedComments ?? [];
  const sessions = useTerminalStore((s) => s.sessions);
  const loadComments = useTerminalStore((s) => s.loadComments);
  const updateComment = useTerminalStore((s) => s.updateComment);
  const deleteComment = useTerminalStore((s) => s.deleteComment);
  const markCommentsSent = useTerminalStore((s) => s.markCommentsSent);
  const sendToSession = useTerminalStore((s) => s.sendToSession);

  const [collapsed, setCollapsed] = useState(false);
  const [sendMenuOpen, setSendMenuOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [sentLine, setSentLine] = useState("");

  useEffect(() => {
    if (!worktreeId) return;
    void loadComments(worktreeId).catch(() => {});
  }, [worktreeId, loadComments]);

  const record = worktrees.find((w) => w.record.id === worktreeId)?.record ?? null;
  const worktreeName = record?.display_name || record?.name || worktreeId;

  const unsent = useMemo(
    () => commentsForWorktree.filter((c) => c.sent_at === null),
    [commentsForWorktree],
  );

  const groups = useMemo(() => {
    const byFile = new Map<string, typeof unsent>();
    for (const comment of unsent) {
      const list = byFile.get(comment.file_path) ?? [];
      list.push(comment);
      byFile.set(comment.file_path, list);
    }
    return Array.from(byFile.entries());
  }, [unsent]);

  const liveSessions = useMemo(
    () =>
      Object.values(sessions).filter((s) => s.status === "running" && !s.id.startsWith("error-")),
    [sessions],
  );

  // Notes only make sense against a bound worktree; everything else is hint text.
  if (!worktreeId) {
    return (
      <div className="git-notes-unbound" data-testid="notes-unbound-hint">
        bind a terminal to a worktree to leave review notes
      </div>
    );
  }

  const buildPrompt = (): string =>
    `Review notes for worktree ${worktreeName}:\n${formatDiffComments(unsent)}`;

  const handleSendTo = async (sessionId: string) => {
    setSendMenuOpen(false);
    const targetTitle = sessions[sessionId]?.title ?? sessionId;
    try {
      await sendToSession(sessionId, `${buildPrompt()}\r`);
      await markCommentsSent(unsent.map((c) => c.id));
      setSentLine(`Sent ${unsent.length} notes to ${targetTitle}`);
    } catch {
      setSentLine(`Failed to send notes to ${targetTitle}`);
    }
  };

  const handleCopyPrompt = async () => {
    await navigator.clipboard.writeText(buildPrompt());
    setSentLine("Prompt copied to clipboard");
  };

  const startEdit = (id: string, body: string) => {
    setEditingId(id);
    setEditDraft(body);
  };

  const commitEdit = async () => {
    const id = editingId;
    const body = editDraft.trim();
    setEditingId(null);
    if (!id || !body) return;
    await updateComment(id, body);
  };

  return (
    <div className="git-notes-shelf" data-testid="notes-shelf">
      <button
        type="button"
        className="git-section-header"
        data-testid="notes-shelf-toggle"
        onClick={() => setCollapsed((v) => !v)}
      >
        {collapsed ? (
          <ChevronRight size={13} className="git-section-chevron" />
        ) : (
          <ChevronDown size={13} className="git-section-chevron" />
        )}
        <StickyNote size={13} />
        <span className="git-section-label">Notes</span>
        <span className="git-count-badge">{unsent.length}</span>
      </button>

      {!collapsed && (
        <>
          <div className="git-notes-toolbar">
            <div className="git-notes-send-wrap">
              {unsent.length > 0 && (
                <button
                  type="button"
                  className="git-bulk-btn git-notes-send-btn"
                  data-testid="send-notes-btn"
                  onClick={() => setSendMenuOpen((v) => !v)}
                >
                  <Send size={11} />
                  Send {unsent.length} note{unsent.length === 1 ? "" : "s"} to…
                </button>
              )}
              {sendMenuOpen && (
                <div className="git-notes-send-menu">
                  {liveSessions.length === 0 && (
                    <div className="git-notes-menu-empty">no live sessions</div>
                  )}
                  {liveSessions.map((session) => (
                    <button
                      key={session.id}
                      type="button"
                      className="git-notes-menu-item"
                      data-testid={`send-target-${session.id}`}
                      title={session.title}
                      onClick={() => void handleSendTo(session.id)}
                    >
                      {session.title}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {unsent.length > 0 && (
              <button
                type="button"
                className="git-bulk-btn"
                data-testid="copy-prompt-btn"
                title="Copy prompt"
                onClick={() => void handleCopyPrompt()}
              >
                <Copy size={11} />
              </button>
            )}
          </div>

          {sentLine && (
            <div className="git-status-line info" data-testid="notes-sent-line">
              {sentLine}
            </div>
          )}

          <div className="git-notes-groups">
            {groups.map(([filePath, fileNotes]) => (
              <div key={filePath} className="git-notes-group">
                <div className="git-notes-file-row" title={filePath}>
                  {filePath} ({fileNotes.length})
                </div>
                {fileNotes.map((note) => (
                  <div key={note.id} className="git-note-item">
                    {editingId === note.id ? (
                      <div className="git-note-edit">
                        <textarea
                          className="git-note-edit-input"
                          data-testid="note-edit-input"
                          rows={2}
                          value={editDraft}
                          autoFocus
                          onChange={(e) => setEditDraft(e.target.value)}
                        />
                        <div className="git-note-edit-actions">
                          <button
                            type="button"
                            className="git-bulk-btn"
                            onClick={() => setEditingId(null)}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="git-bulk-btn git-note-save-btn"
                            data-testid="note-edit-save"
                            disabled={!editDraft.trim()}
                            onClick={() => void commitEdit()}
                          >
                            Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <span
                          className="git-note-preview"
                          title={note.body}
                        >{`L${note.line_number}: ${truncateBody(note.body)}`}</span>
                        <span className="git-note-actions">
                          <button
                            type="button"
                            className="git-action-btn"
                            title="Edit note"
                            onClick={() => startEdit(note.id, note.body)}
                          >
                            <Pencil size={12} />
                          </button>
                          <button
                            type="button"
                            className="git-action-btn"
                            title="Delete note"
                            onClick={() => void deleteComment(note.id).catch(() => {})}
                          >
                            <Trash2 size={12} />
                          </button>
                        </span>
                      </>
                    )}
                  </div>
                ))}
              </div>
            ))}
            {groups.length === 0 && (
              <div className="git-notes-empty">No unsent notes for this worktree</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
