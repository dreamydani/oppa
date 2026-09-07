import { useTerminalStore } from "../../store/terminalStore";

// Transient controller notices (no-model, disabled, mic lost, no speech,
// engine errors). Auto-expire is owned by the controller; the optional
// action opens the Voice settings tab.
export function VoiceNotice(): React.ReactElement | null {
  const notice = useTerminalStore((s) => s.voiceNotice);
  const dismissVoiceNotice = useTerminalStore((s) => s.dismissVoiceNotice);
  const openSettings = useTerminalStore((s) => s.openSettings);

  if (!notice) {
    return null;
  }

  return (
    <div className="voice-notice" role="status">
      <span className="voice-notice-text">{notice.text}</span>
      {notice.action === "open-voice-settings" && (
        <button
          type="button"
          className="voice-notice-action"
          onClick={() => {
            openSettings("voice");
            dismissVoiceNotice(notice.id);
          }}
        >
          Open Settings
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss notification"
        className="voice-notice-dismiss"
        onClick={() => dismissVoiceNotice(notice.id)}
      >
        ×
      </button>
    </div>
  );
}
