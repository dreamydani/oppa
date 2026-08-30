import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { checkForUpdate, type UpdateInfo } from "../lib/updater";
import { useTerminalStore } from "../store/terminalStore";

// "Update now / Not now" banner shown at stable startup when a newer version
// is available. Mirrors GlobalFailureBanner's fixed bottom-centered bar.
//
// Update flow (v1): "Update now" opens the download URL from the update
// manifest in the default browser via @tauri-apps/plugin-opener (with a
// window.open fallback). A silent in-app install is intentionally NOT
// attempted: our manifest is a custom `{version, download}` shape that
// tauri-plugin-updater's native check cannot parse, and an installer signed
// with our own key (for direct download + run) is a later milestone. Task 6/7
// own the seamless daemon-survives-update mechanics and the session-running
// warning; when they land, "Update now" will be rewired to that flow.
//
// "Not now" hides the banner and persists `general.dismissedUpdateVersion`
// (debounced save via settingsDataSlice), so it never nags again for the same
// version — but reappears when a NEWER version is published.
export function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [downloading, setDownloading] = useState(false);
  const dismissedUpdateVersion = useTerminalStore(
    (s) => s.settings.general.dismissedUpdateVersion,
  );
  const updateSettings = useTerminalStore((s) => s.updateSettings);

  // Check once on mount. checkForUpdate already gates on the channel (dev /
  // unresolved → null, never invokes) and resolves to null on any failure
  // (offline, 404, bad JSON), so the banner simply never appears in those
  // cases and the app works fine offline.
  useEffect(() => {
    let cancelled = false;
    void checkForUpdate().then((result) => {
      if (!cancelled) setInfo(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!info?.available) return null;
  if (dismissedUpdateVersion === info.version) return null;

  const handleUpdateNow = () => {
    setDownloading(true);
    // The download URL is the real installer from the release pipeline; open
    // it in the default browser / system opener (v1 flow — see header note).
    openUrl(info.download).catch(() => {
      window.open(info.download, "_blank", "noopener,noreferrer");
    });
  };

  const handleNotNow = () => {
    updateSettings({ general: { dismissedUpdateVersion: info.version } });
  };

  return (
    <div
      role="status"
      data-testid="update-banner"
      style={{
        position: "fixed",
        bottom: 36,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        gap: 12,
        maxWidth: "80vw",
        padding: "8px 12px",
        borderRadius: 8,
        background: "var(--bg-secondary, #2a2a2a)",
        color: "var(--text-primary, #ddd)",
        border: "1px solid rgba(120, 180, 255, 0.35)",
        fontSize: 12,
        boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
      }}
    >
      <span style={{ wordBreak: "break-word" }}>
        {downloading
          ? "Downloading update… opening in your browser."
          : `A new version of OPPA is available (v${info.version}).`}
      </span>
      {!downloading && (
        <button type="button" onClick={handleUpdateNow}>
          Update now
        </button>
      )}
      <button type="button" onClick={handleNotNow}>
        Not now
      </button>
    </div>
  );
}
