import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { checkForUpdate, probeUpgradeSafety, type UpdateInfo } from "../lib/updater";
import { getChannel } from "../lib/channel";
import { useTerminalStore } from "../store/terminalStore";

// Floor between banner-driven re-checks so repeated window focus can't poll
// the manifest; the one-shot recovery check after an empty mount is exempt.
const RECHECK_FLOOR_MS = 6 * 60 * 60 * 1000;

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
// warning.
//
// Session-running warning (Task 7): before opening the download, "Update now"
// probes the daemon via `probeUpgradeSafety` (stable channel; dev never gets
// here). Idle → proceed. Busy → an inline alert shows "N sessions are still
// running. Updating will close them." with Update anyway / Not now — the
// interruption is always the user's informed choice. Unknown (can't verify —
// an old daemon, or a transport error) → proceed to the download, which
// itself cannot kill sessions; we never claim "safe" on unknown (Task 6
// carried note).
//
// "Not now" hides the banner and persists `general.dismissedUpdateVersion`
// (debounced save via settingsDataSlice), so it never nags again for the same
// version — but reappears when a NEWER version is published.
export function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [downloading, setDownloading] = useState(false);
  // Task 7: when "Update now" finds the daemon busy, this holds the live
  // session count so the inline warning can name it. null = no warning shown.
  const [busySessionCount, setBusySessionCount] = useState<number | null>(null);
  const dismissedUpdateVersion = useTerminalStore(
    (s) => s.settings.general.dismissedUpdateVersion,
  );
  const updateSettings = useTerminalStore((s) => s.updateSettings);

  // Check once on mount. checkForUpdate already gates on the channel (dev →
  // null, never invokes) and resolves to null on any failure (offline, 404,
  // bad JSON), so the banner simply never appears in those cases and the app
  // works fine offline. An empty mount (the startup race: the channel cache
  // was still null) arms a one-shot focus listener as recovery; it is
  // removed on info or unmount.
  useEffect(() => {
    let cancelled = false;
    // One debug line per check outcome so a missing card is diagnosable.
    const finish = (result: UpdateInfo | null, recordCheck: boolean) => {
      if (cancelled) return;
      setInfo(result);
      if (recordCheck) {
        updateSettings({ general: { lastCheckAt: Date.now() } });
      }
      console.debug(
        `[updater] channel=${getChannel() ?? "unresolved"} available=${result?.available ?? false} version=${result?.version ?? "none"}`,
      );
    };
    const onFocus = () => {
      const lastCheckAt = useTerminalStore.getState().settings.general.lastCheckAt;
      if (lastCheckAt != null && Date.now() - lastCheckAt < RECHECK_FLOOR_MS) return;
      // The seam resolves null on failure, but guard the rejection anyway: a
      // future rewire or a different transport must never surface an unhandled
      // rejection from the re-check.
      void checkForUpdate()
        .then((result) => {
          finish(result, true);
          if (result && !cancelled) window.removeEventListener("focus", onFocus);
        })
        .catch(() => finish(null, true));
    };
    // The seam resolves null on failure, but guard the rejection anyway: a
    // future rewire or a different transport must never surface an unhandled
    // rejection from the mount check.
    void checkForUpdate()
      .then((result) => {
        // Only a resolving check counts toward the floor; an empty mount must
        // not suppress the focus recovery check.
        finish(result, result != null);
        if (!cancelled && !result) window.addEventListener("focus", onFocus);
      })
      .catch(() => {
        finish(null, false);
        if (!cancelled) window.addEventListener("focus", onFocus);
      });
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  if (!info?.available) return null;
  if (dismissedUpdateVersion === info.version) return null;

  const handleUpdateNow = async () => {
    // Ask the daemon whether an upgrade is safe (idle → yes; busy → no, with
    // the live session count; unknown → can't verify). On unknown we still
    // proceed to the download URL — opening it cannot itself kill sessions —
    // but we never present the update as "safe" in that case.
    const probe = await probeUpgradeSafety().catch(() => null);
    if (probe?.status === "busy") {
      setBusySessionCount(probe.sessionCount);
      return;
    }
    openDownload();
  };

  const openDownload = () => {
    if (!info) return;
    setDownloading(true);
    // The download URL is the real installer from the release pipeline; open
    // it in the default browser / system opener (v1 flow — see header note).
    openUrl(info.download).catch(() => {
      window.open(info.download, "_blank", "noopener,noreferrer");
    });
  };

  const handleUpdateAnyway = () => {
    // The informed-choice path: the user saw the warning and accepted that
    // updating will close their sessions.
    setBusySessionCount(null);
    openDownload();
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
      {busySessionCount !== null ? (
        <div
          role="alert"
          style={{ display: "flex", alignItems: "center", gap: 12 }}
        >
          <span style={{ wordBreak: "break-word" }}>
            {busySessionCount} {busySessionCount === 1 ? "session is" : "sessions are"} still
            running. Updating will close {busySessionCount === 1 ? "it" : "them"}.
          </span>
          <button type="button" onClick={handleUpdateAnyway}>
            Update anyway
          </button>
          <button type="button" onClick={() => setBusySessionCount(null)}>
            Not now
          </button>
        </div>
      ) : (
        <>
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
        </>
      )}
    </div>
  );
}
