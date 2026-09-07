import { Mic, Square } from "lucide-react";
import { useTerminalStore } from "../../store/terminalStore";
import { dispatchDictationControl } from "../../lib/voice/dictationControl";

function shortcutLabel(): string {
  const isMac =
    typeof navigator !== "undefined" &&
    (navigator.platform.toUpperCase().includes("MAC") || navigator.userAgent.includes("Mac"));
  return isMac ? "⌘E" : "Ctrl+E";
}

export function DictationIndicator(): React.ReactElement | null {
  const dictationState = useTerminalStore((s) => s.dictationState);
  const partialTranscript = useTerminalStore((s) => s.partialTranscript);
  const isHoldMode = useTerminalStore((s) => s.settings?.voice?.dictationMode === "hold");

  if (
    dictationState !== "listening" &&
    dictationState !== "starting" &&
    dictationState !== "stopping"
  ) {
    return null;
  }

  const label =
    dictationState === "starting"
      ? "Starting..."
      : dictationState === "stopping"
        ? "Processing..."
        : partialTranscript || "Listening...";

  // Why: the stop path is a no-op once the session is already tearing down.
  const canStop = dictationState !== "stopping";
  // Hold mode stops on key release, so a "press Ctrl+E" chip would misstate it.
  const showShortcut = !isHoldMode;

  return (
    <div
      className="dictation-indicator"
      role="status"
      aria-label={dictationState === "listening" ? "Dictation listening" : `Dictation ${dictationState}`}
    >
      <Mic
        size={14}
        className={`dictation-indicator-mic${dictationState === "listening" ? " pulsing" : ""}`}
        aria-hidden="true"
      />
      <span className="dictation-indicator-label">{label}</span>
      {canStop && (
        <>
          <span aria-hidden="true" className="dictation-indicator-divider" />
          <button
            type="button"
            aria-label="Stop dictation"
            title={`Stop dictation${showShortcut ? ` (${shortcutLabel()})` : ""}`}
            className="dictation-indicator-stop"
            // Why: dictation inserts into the element focused when it started;
            // taking focus on click would drop the final transcript.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => dispatchDictationControl("stop")}
          >
            <Square size={11} fill="currentColor" aria-hidden="true" />
          </button>
          {showShortcut && (
            <kbd className="dictation-indicator-shortcut">{shortcutLabel()}</kbd>
          )}
        </>
      )}
    </div>
  );
}
