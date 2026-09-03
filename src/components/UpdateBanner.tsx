import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  downloadNativeUpdate,
  installNativeUpdateAndRelaunch,
  probeUpgradeSafety,
  type UpdateInfo,
  type NativeUpdateInfo,
  type NativeProgressCallback,
  type NativeDownloadResult,
} from "../lib/updater";
import {
  MANUAL_UPDATE_CHECK_EVENT,
  UPDATE_AVAILABILITY_EVENT,
  type UpdateAvailabilityDetail,
} from "../lib/updateScheduler";
import { useTerminalStore } from "../store/terminalStore";

// The scheduler owns the event bus; re-exported so existing importers
// (Settings, status segment) keep working untouched.
export {
  MANUAL_UPDATE_CHECK_EVENT,
  UPDATE_AVAILABILITY_EVENT,
  type UpdateAvailabilityDetail,
} from "../lib/updateScheduler";

type Engine = "native" | "legacy";
type CardPhase =
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "browser"
  | "error";

// "Update now / Not now" card shown at stable startup when a newer version
// is available. Mirrors GlobalFailureBanner's fixed bottom-centered bar.
//
// Renderer for the scheduler's announcements (native preferred, legacy
// browser fallback): one card, two engines, never both.
// `dismissedUpdateVersion` stays per-version across engines.
//
// Update flow (native): available → "Download now" (percent bar, no cancel)
// → downloaded → "Restart now" (install + relaunch). Failures surface the
// error card with Retry + Dismiss; the retry card only appears after an
// explicit user action fails — checks stay fail-silent.
//
// Session-running warning: "Restart now" (native) and "Update now" (legacy)
// surface "N sessions are still running. Updating will close them." with
// Update anyway / Not now — the interruption is always the user's informed
// choice. Unknown (can't verify — an old daemon, or a transport error) →
// proceed to the download, which itself cannot kill sessions; we never claim
// "safe" on unknown (Task 6 carried note).
//
// "Not now" hides the card and persists `general.dismissedUpdateVersion`
// (debounced save via settingsDataSlice), so it never nags again for the same
// version — but reappears when a NEWER version is published.
export function UpdateBanner() {
  const [engine, setEngine] = useState<Engine | null>(null);
  const [native, setNative] = useState<NativeUpdateInfo | null>(null);
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [phase, setPhase] = useState<CardPhase | null>(null);
  const [progress, setProgress] = useState<{ downloaded: number; total?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorOrigin, setErrorOrigin] = useState<"download" | "install" | null>(null);
  // When an update action finds the daemon busy, this holds the live
  // session count so the inline warning can name it. null = no warning shown.
  const [busySessionCount, setBusySessionCount] = useState<number | null>(null);
  const dismissedUpdateVersion = useTerminalStore(
    (s) => s.settings.general.dismissedUpdateVersion,
  );
  const updateSettings = useTerminalStore((s) => s.updateSettings);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Announces card-side transitions (downloaded, error/dismiss/later
  // clears) for the status segment. Carries the full detail so re-processing
  // the card's own announcement is idempotent and never flips the engine.
  const emitAvailability = (detail: UpdateAvailabilityDetail) => {
    window.dispatchEvent(new CustomEvent<UpdateAvailabilityDetail>(UPDATE_AVAILABILITY_EVENT, { detail }));
  };

  // Renders a scheduler announcement: clears on null (resolved-negative or
  // failed check), suppresses dismissed versions, otherwise stages the
  // matching engine's payload for the action handlers below.
  const presentAvailability = (detail: UpdateAvailabilityDetail) => {
    if (detail.version === null || detail.phase === null) {
      setPhase(null);
      return;
    }
    if (useTerminalStore.getState().settings.general.dismissedUpdateVersion === detail.version) {
      setPhase(null);
      return;
    }
    const announcedEngine = detail.engine ?? "legacy";
    setEngine(announcedEngine);
    setNative(
      announcedEngine === "native"
        ? { version: detail.version, currentVersion: detail.currentVersion ?? detail.version }
        : null,
    );
    setInfo(
      announcedEngine === "legacy"
        ? { version: detail.version, download: detail.download ?? "", available: true }
        : null,
    );
    setError(null);
    setErrorOrigin(null);
    setBusySessionCount(null);
    setProgress(null);
    // The scheduler only announces available/clears; "downloaded" arrives
    // from the card's own emit below — render it, don't downgrade it.
    setPhase(detail.phase === "downloaded" ? "downloaded" : "available");
  };

  // Renderer only: the scheduler owns every check and announces outcomes on
  // the bus. Manual requests surface the checking state; the matching
  // availability announcement below resolves it.
  useEffect(() => {
    const onAvailability = (event: Event) => {
      if (!mountedRef.current) return;
      presentAvailability((event as CustomEvent<UpdateAvailabilityDetail>).detail);
    };
    const onManualCheck = () => {
      if (!mountedRef.current) return;
      setBusySessionCount(null);
      setError(null);
      setErrorOrigin(null);
      setProgress(null);
      setPhase("checking");
    };
    window.addEventListener(UPDATE_AVAILABILITY_EVENT, onAvailability);
    window.addEventListener(MANUAL_UPDATE_CHECK_EVENT, onManualCheck);
    return () => {
      window.removeEventListener(UPDATE_AVAILABILITY_EVENT, onAvailability);
      window.removeEventListener(MANUAL_UPDATE_CHECK_EVENT, onManualCheck);
    };
    // Mount-only listeners; work flows through refs and getState.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openDownload = () => {
    if (!info) return;
    setPhase("browser");
    // The download URL is the real installer from the release pipeline; open
    // it in the default browser / system opener (v1 flow — see header note).
    openUrl(info.download).catch(() => {
      window.open(info.download, "_blank", "noopener,noreferrer");
    });
  };

  const handleUpdateNow = async () => {
    // Ask the daemon whether an upgrade is safe (idle → yes; busy → no, with
    // the live session count; unknown → can't verify). On unknown we still
    // proceed to the download URL — opening it cannot itself kill sessions —
    // but we never present the update as "safe" in that case.
    const probe = await probeUpgradeSafety().catch(() => null);
    if (!mountedRef.current) return;
    if (probe?.status === "busy") {
      setBusySessionCount(probe.sessionCount);
      return;
    }
    openDownload();
  };

  const handleDownloadNow = async () => {
    if (!native) return;
    setBusySessionCount(null);
    setError(null);
    setErrorOrigin(null);
    setPhase("downloading");
    // Pending keeps the dot: no availability emit until downloaded or error.
    setProgress({ downloaded: 0 });
    const onProgress: NativeProgressCallback = (downloaded, total) => {
      if (mountedRef.current) setProgress({ downloaded, total });
    };
    const result: NativeDownloadResult = await downloadNativeUpdate(onProgress).catch(
      (downloadError: unknown) => ({
        ok: false as const,
        error: downloadError instanceof Error ? downloadError.message : String(downloadError),
      }),
    );
    if (!mountedRef.current) return;
    if (result.ok) {
      // Restart installs what was checked: no re-check here — a newer
      // release landing mid-download is the scheduler's supersede case (T7),
      // which also owns the pending-update close().
      setPhase("downloaded");
      emitAvailability({
        version: native.version,
        phase: "downloaded",
        engine: "native",
        currentVersion: native.currentVersion,
      });
    } else {
      // Error card itself is visible; clear the dot to avoid double-signaling.
      emitAvailability({ version: null, phase: null });
      setError(result.error);
      setErrorOrigin("download");
      setPhase("error");
    }
  };

  const handleRestartNow = async () => {
    // The seam probes the daemon first and blocks on busy without touching
    // the plugin; idle/unknown proceed to install + relaunch.
    const outcome = await installNativeUpdateAndRelaunch(() => {});
    if (!mountedRef.current) return;
    if (outcome.proceeded) return;
    if (outcome.reason === "busy") {
      setBusySessionCount(outcome.sessionCount);
      return;
    }
    // Error card itself is visible; clear the dot to avoid double-signaling.
    emitAvailability({ version: null, phase: null });
    setError(outcome.error);
    setErrorOrigin("install");
    setPhase("error");
  };

  const handleUpdateAnyway = async () => {
    // The informed-choice path: the user saw the warning and accepted that
    // updating will close their sessions.
    setBusySessionCount(null);
    if (engine === "native") {
      // No force flag on the seam by design — re-attempt re-probes and
      // proceeds once sessions drain.
      await handleRestartNow();
    } else {
      openDownload();
    }
  };

  const handleRetry = async () => {
    setError(null);
    if (errorOrigin === "install") {
      await handleRestartNow();
    } else {
      await handleDownloadNow();
    }
  };

  const dismissVersion = (version: string) => {
    updateSettings({ general: { dismissedUpdateVersion: version } });
    setPhase(null);
    setEngine(null);
    setNative(null);
    setInfo(null);
    setError(null);
    setBusySessionCount(null);
    emitAvailability({ version: null, phase: null });
  };

  const handleNotNow = () => {
    const version = engine === "native" ? native?.version : info?.version;
    if (version) dismissVersion(version);
  };

  const handleLater = () => {
    // Remind on next launch: hide without persisting a dismissal, so the
    // next check offers the downloaded update again.
    setPhase(null);
    emitAvailability({ version: null, phase: null });
  };

  const version = engine === "native" ? native?.version : info?.version;
  if (!phase) return null;
  // Checking needs no version yet; every other phase is per-version and
  // honors the persisted dismissal.
  if (phase !== "checking" && (!engine || !version)) return null;
  if (phase !== "checking" && dismissedUpdateVersion === version) return null;

  const percent =
    progress?.total != null && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;

  return (
    <div
      role="status"
      aria-busy={phase === "checking" || phase === "downloading"}
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
          <button type="button" onClick={() => void handleUpdateAnyway()}>
            Update anyway
          </button>
          <button type="button" onClick={() => setBusySessionCount(null)}>
            Not now
          </button>
        </div>
      ) : phase === "checking" ? (
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Loader2 size={13} aria-hidden="true" />
          Checking for updates…
        </span>
      ) : phase === "downloading" ? (
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Downloading update{percent !== null ? `… ${percent}%` : "…"}
          <span
            role="progressbar"
            aria-label="Update download progress"
            aria-valuemin={0}
            aria-valuemax={100}
            {...(percent !== null ? { "aria-valuenow": percent } : {})}
            style={{
              display: "inline-block",
              width: 96,
              height: 6,
              borderRadius: 3,
              background: "rgba(255,255,255,0.15)",
              overflow: "hidden",
              verticalAlign: "middle",
            }}
          >
            <span
              style={{
                display: "block",
                height: "100%",
                width: percent !== null ? `${percent}%` : "30%",
                background: "var(--text-primary, #ddd)",
              }}
            />
          </span>
        </span>
      ) : phase === "downloaded" ? (
        <>
          <span style={{ wordBreak: "break-word" }}>
            {`v${version} downloaded. Restart now to apply the update.`}
          </span>
          <button type="button" onClick={() => void handleRestartNow()}>
            Restart now
          </button>
          <button type="button" onClick={handleLater}>
            Later
          </button>
        </>
      ) : phase === "browser" ? (
        <>
          <span style={{ wordBreak: "break-word" }}>
            Downloading update… opening in your browser.
          </span>
          <button type="button" onClick={handleNotNow}>
            Not now
          </button>
        </>
      ) : phase === "error" ? (
        <>
          <span role="alert" style={{ wordBreak: "break-word" }}>
            {`Update failed: ${error ?? "unknown error"}`}
          </span>
          <button type="button" onClick={() => void handleRetry()}>
            Retry
          </button>
          <button type="button" onClick={handleNotNow}>
            Dismiss
          </button>
        </>
      ) : (
        <>
          <span style={{ wordBreak: "break-word" }}>
            {`A new version of OPPA is available (v${version}).`}
          </span>
          {engine === "native" ? (
            <button type="button" onClick={() => void handleDownloadNow()}>
              Download now
            </button>
          ) : (
            <button type="button" onClick={() => void handleUpdateNow()}>
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
