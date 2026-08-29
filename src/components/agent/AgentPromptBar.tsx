import React, { useEffect, useRef, useState } from "react";
import { Send, X } from "lucide-react";
import "./AgentPromptBar.css";

interface AgentPromptBarProps {
  targetTitle: string;
  disabled?: boolean;
  onSend: (prompt: string) => void | Promise<void>;
  onCancel: () => void;
}

// Send-target prompt bar (Orca parity): multiline, Enter submits,
// Shift+Enter newline, Esc or outside click cancels.
export function AgentPromptBar({
  targetTitle,
  disabled,
  onSend,
  onCancel,
}: AgentPromptBarProps): React.ReactElement {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (disabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    const onClick = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) onCancel();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [disabled, onCancel]);

  const submit = async () => {
    const prompt = value.trim();
    if (!prompt || disabled || sending) return;
    setSending(true);
    try {
      await onSend(prompt);
      setValue("");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="agent-prompt-bar" ref={barRef} role="group" aria-label={`Prompt ${targetTitle}`}>
      <span className="agent-prompt-target" title={targetTitle}>
        → {targetTitle}
      </span>
      <textarea
        ref={inputRef}
        className="agent-prompt-input"
        rows={1}
        value={value}
        placeholder={`Prompt ${targetTitle}…`}
        disabled={disabled || sending}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      <button
        type="button"
        className="agent-prompt-send"
        aria-label={`Send prompt to ${targetTitle}`}
        disabled={disabled || sending || !value.trim()}
        onClick={() => void submit()}
      >
        <Send size={13} />
      </button>
      <button
        type="button"
        className="agent-prompt-cancel"
        aria-label="Cancel prompt"
        onClick={onCancel}
      >
        <X size={13} />
      </button>
    </div>
  );
}