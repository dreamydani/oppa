import React, { useEffect, useState } from "react";

// OpenAI API key dialog — port of Orca's `OpenAiTranscriptionKeyDialog`.
// Password input with Save/Clear; errors render inline (no toast infra).

export function VoiceOpenAiDialog({
  open,
  configured,
  pending,
  error,
  onClose,
  onSave,
  onClear,
}: {
  open: boolean;
  configured: boolean;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (apiKey: string) => void;
  onClear: () => void;
}): React.ReactElement | null {
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (open) {
      setDraft("");
    }
  }, [open ]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="voice-dialog-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="OpenAI API key"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="voice-dialog-card">
        <h3 className="voice-dialog-title">OpenAI API key</h3>
        <p className="voice-dialog-desc">
          Needed for the cloud transcription models. Stored locally on this machine; usage bills
          to your OpenAI account.
        </p>
        <label className="voice-dialog-label" htmlFor="voice-openai-key">
          API key
        </label>
        <input
          id="voice-openai-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          className="settings-input voice-dialog-input"
          placeholder="sk-…"
          value={draft}
          disabled={pending}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim() !== "" && !pending) {
              onSave(draft);
            } else if (e.key === "Escape") {
              onClose();
            }
          }}
        />
        {error && (
          <p className="voice-dialog-error" role="alert">
            {error}
          </p>
        )}
        <div className="voice-dialog-actions">
          {configured && (
            <button
              type="button"
              className="settings-segmented-btn"
              disabled={pending}
              onClick={onClear}
            >
              Clear
            </button>
          )}
          <span className="voice-dialog-spacer" />
          <button type="button" className="settings-segmented-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="settings-segmented-btn active"
            disabled={pending || draft.trim() === ""}
            onClick={() => onSave(draft)}
          >
            {pending ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
