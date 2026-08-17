import { type ReactElement } from "react";
import { useTerminalStore } from "../../store/terminalStore";

export interface AiDiffBannerProps {
  isInline?: boolean;
  onToggleInline?: (isInline: boolean) => void;
}

export function AiDiffBanner({
  isInline = false,
  onToggleInline,
}: AiDiffBannerProps): ReactElement | null {
  const pendingAiDiff = useTerminalStore((s) => s.pendingAiDiff);
  const acceptAiDiff = useTerminalStore((s) => s.acceptAiDiff);
  const rejectAiDiff = useTerminalStore((s) => s.rejectAiDiff);

  if (!pendingAiDiff) return null;

  return (
    <div className="ai-diff-banner" data-testid="ai-diff-banner">
      <div className="ai-diff-info">
        <div className="ai-diff-header">
          <span className="ai-diff-badge">🤖 AI Proposed Changes</span>
          <span className="ai-diff-file-path">{pendingAiDiff.path}</span>
        </div>
        {pendingAiDiff.summary && (
          <div className="ai-diff-summary">{pendingAiDiff.summary}</div>
        )}
      </div>

      <div className="ai-diff-controls">
        <div className="ai-diff-view-toggle" role="group" aria-label="Diff view options">
          <button
            type="button"
            className={`ai-diff-toggle-btn ${!isInline ? "active" : ""}`}
            aria-label="Side-by-side Diff"
            title="Side-by-side comparison"
            onClick={() => onToggleInline?.(false)}
          >
            Split
          </button>
          <button
            type="button"
            className={`ai-diff-toggle-btn ${isInline ? "active" : ""}`}
            aria-label="Inline Diff"
            title="Inline unified diff"
            onClick={() => onToggleInline?.(true)}
          >
            Inline
          </button>
        </div>

        <div className="ai-diff-actions">
          <button
            type="button"
            className="ai-diff-btn ai-diff-reject-btn"
            aria-label="Reject / Discard changes"
            title="Discard AI proposed changes"
            onClick={() => rejectAiDiff()}
          >
            ✕ Discard
          </button>
          <button
            type="button"
            className="ai-diff-btn ai-diff-accept-btn"
            aria-label="Accept & Apply changes"
            title="Accept and apply AI proposed changes to file"
            onClick={() => void acceptAiDiff()}
          >
            ✓ Accept &amp; Apply
          </button>
        </div>
      </div>
    </div>
  );
}
