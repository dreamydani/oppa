import { useEffect, useRef, useState } from "react";
import { Loader2, Minus, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  classifyUpdateError,
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
  UPDATE_CARD_EXPAND_REQUEST_EVENT,
  announceCardCollapsed,
  announceDownloadProgress,
  getReleaseNotesUrl,
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
  | "not-available"
  | "error";

// "Update now / Not now" card — Orca parity: fixed bottom-right 360px rich
// card with release notes, collapse to the status segment, and error taxonomy.
//
// Renderer for the scheduler's announcements (native preferred, legacy
// browser fallback): one card, two engines, never both.
// `dismissedUpdateVersion` stays per-version across engines.
//
// Update flow (native): available → "Download now" (percent bar + collapse,
// no cancel) → downloaded → "Restart to Update" (flush + install + relaunch).
// Failures surface the error card with Retry + Dismiss; the retry card only
// appears after an explicit user action fails — checks stay fail-silent.
//
// Session-running warning: "Restart now" (native) and "Update now" (legacy)
// surface "N sessions are still running. Updating will close them." with
// Update anyway / Not now — the interruption is always the user's informed
// choice. Unknown (can't verify — an old daemon, or a transport error) →
// proceed to the download, which itself cannot kill sessions; we never claim
// "safe" on unknown.
//
// Orca-style restore: Restart flushes layout + scrollbacks first so the
// relaunch cold-restores tabs/cwd/scrollback even though live shells end.
// Copy says "Sessions restore after restart" (accurate, not "won't be
// interrupted").
//
// "Not now" hides the card and persists `general.dismissedUpdateVersion`
// (debounced save via settingsDataSlice), so it never nags again for the same
// version — but reappears when a NEWER version is published.
const ARIA_LABELS: Record<CardPhase, string> = {
  checking: "Checking for updates",
  available: "Update available",
  downloading: "Downloading update",
  downloaded: "Update ready to install",
  browser: "Downloading update",
  "not-available": "No updates available",
  error: "Update failed",
};

function errorHint(
  kind: "signature" | "network" | "install" | "generic",
  origin: "download" | "install" | null,
): string | null {
  if (kind === "signature") {
    return "The update signature could not be verified. Download from GitHub releases instead — retrying won't help.";
  }
  if (kind === "network") {
    return "Couldn't reach the update server. Check your connection and retry.";
  }
  if (kind === "install" || origin === "install") {
    return "The install step failed before restart. Your sessions are untouched — retry when ready.";
  }
  return null;
}

export function UpdateBanner() {
  const [engine, setEngine] = useState<Engine | null>(null);
  const [native, setNative] = useState<NativeUpdateInfo | null>(null);
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [phase, setPhase] = useState<CardPhase | null>(null);
  const [progress, setProgress] = useState<{ downloaded: number; total?: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorOrigin, setErrorOrigin] = useState<"download" | "install" | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  // When an update action finds the daemon busy, this holds the live
  // session count so the inline warning can name it. null = no warning shown.
  const [busySessionCount, setBusySessionCount] = useState<number | null>(null);
  const [releaseUrl, setReleaseUrl] = useState<string | null>(null);
  const [releaseBody, setReleaseBody] = useState<string | null>(null);
  const dismissedUpdateVersion = useTerminalStore(
    (s) => s.settings.general.dismissedUpdateVersion,
  );
  const updateSettings = useTerminalStore((s) => s.updateSettings);
  const mountedRef = useRef(true);
  const notAvailableTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const phaseRef = useRef<CardPhase | null>(null);
  phaseRef.current = phase;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (notAvailableTimer.current) clearTimeout(notAvailableTimer.current);
    };
  }, []);

  const setCollapsedAndAnnounce = (value: boolean) => {
    setCollapsed(value);
    announceCardCollapsed(value);
  };

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
      // Manual check with no update → transient "latest" card (Orca
      // not-available, 3s autodismiss). Background clears stay silent so a
      // staged offer survives. phaseRef avoids the mount-only listener stale
      // closure (phase state at mount is always null).
      if (phaseRef.current === "checking") {
        setPhase("not-available");
        if (notAvailableTimer.current) clearTimeout(notAvailableTimer.current);
        notAvailableTimer.current = setTimeout(() => {
          if (mountedRef.current) setPhase(null);
        }, 3000);
        return;
      }
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
        ? {
            version: detail.version,
            currentVersion: detail.currentVersion ?? detail.version,
            body: detail.body,
            date: detail.date,
          }
        : null,
    );
    setInfo(
      announcedEngine === "legacy"
        ? { version: detail.version, download: detail.download ?? "", available: true }
        : null,
    );
    setReleaseUrl(detail.releaseUrl ?? getReleaseNotesUrl(detail.version));
    setReleaseBody(detail.body ?? null);
    setError(null);
    setErrorOrigin(null);
    setBusySessionCount(null);
    setProgress(null);
    // Any state change resets collapse (Orca parity) and announces it.
    setCollapsed(false);
    announceCardCollapsed(false);
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
      setCollapsed(false);
      announceCardCollapsed(false);
      setReleaseUrl(null);
      setReleaseBody(null);
      setPhase("checking");
    };
    const onExpandRequest = () => {
      if (!mountedRef.current) return;
      setCollapsed(false);
      announceCardCollapsed(false);
    };
    window.addEventListener(UPDATE_AVAILABILITY_EVENT, onAvailability);
    window.addEventListener(MANUAL_UPDATE_CHECK_EVENT, onManualCheck);
    window.addEventListener(UPDATE_CARD_EXPAND_REQUEST_EVENT, onExpandRequest);
    return () => {
      window.removeEventListener(UPDATE_AVAILABILITY_EVENT, onAvailability);
      window.removeEventListener(MANUAL_UPDATE_CHECK_EVENT, onManualCheck);
      window.removeEventListener(UPDATE_CARD_EXPAND_REQUEST_EVENT, onExpandRequest);
    };
    // Mount-only listeners; work flows through refs and getState.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape collapses in-progress/failure states, hides transient states
  // (Orca parity). Available hides without persisting dismissal (Later).
  useEffect(() => {
    if (!phase || collapsed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (phase === "downloading" || phase === "downloaded" || phase === "error") {
        setCollapsedAndAnnounce(true);
      } else if (phase === "available" || phase === "checking" || phase === "not-available") {
        setPhase(null);
        emitAvailability({ version: null, phase: null });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, collapsed]);

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
    const version = native.version;
    const onProgress: NativeProgressCallback = (downloaded, total) => {
      if (mountedRef.current) setProgress({ downloaded, total });
      announceDownloadProgress({ version, downloaded, total });
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
        body: native.body,
        date: native.date,
        releaseUrl: releaseUrl ?? getReleaseNotesUrl(native.version),
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
    // Flush layout + scrollbacks first (Orca-style restore), then install.
    // The seam probes the daemon first and blocks on busy without touching
    // the plugin; idle/unknown proceed to install + relaunch.
    const outcome = await installNativeUpdateAndRelaunch(() => {}, {
      onBeforeInstall: () => useTerminalStore.getState().saveLayout(),
    });
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
    setReleaseUrl(null);
    setReleaseBody(null);
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

  const handleCollapse = () => {
    setCollapsedAndAnnounce(true);
  };

  const version = engine === "native" ? native?.version : info?.version;
  if (!phase) return null;
  if (collapsed) return null;
  // Checking / not-available need no version yet; every other phase is
  // per-version and honors the persisted dismissal.
  if (phase !== "checking" && phase !== "not-available" && (!engine || !version)) return null;
  if (phase !== "checking" && phase !== "not-available" && dismissedUpdateVersion === version)
    return null;

  const percent =
    progress?.total != null && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : null;

  const errorKind = error ? classifyUpdateError(error, errorOrigin) : null;
  const hint = error && errorKind ? errorHint(errorKind, errorOrigin) : null;

  return (
    <div
      role="complementary"
      aria-label={ARIA_LABELS[phase]}
      aria-live="polite"
      data-testid="update-banner"
      style={{
        position: "fixed",
        bottom: 40,
        right: 16,
        zIndex: 1000,
        width: 360,
        maxWidth: "calc(100vw - 32px)",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "12px 14px",
        borderRadius: 10,
        background: "var(--bg-secondary, #2a2a2a)",
        color: "var(--text-primary, #ddd)",
        border: "1px solid rgba(120, 180, 255, 0.35)",
        fontSize: 12,
        lineHeight: 1.5,
        boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
      }}
    >
      {busySessionCount !== null ? (
        <div
          role="alert"
          style={{ display: "flex", alignItems: "center", gap: 12 }}
        >
          <span style={{ wordBreak: "break-word", flex: 1 }}>
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
      ) : phase === "not-available" ? (
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
          You&apos;re on the latest version.
        </span>
      ) : phase === "downloading" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Loader2 size={13} aria-hidden="true" />
            <span style={{ flex: 1 }}>
              Downloading update{percent !== null ? `… ${percent}%` : "…"}
            </span>
            <button
              type="button"
              aria-label="Collapse update card"
              title="Collapse"
              onClick={handleCollapse}
              style={{ background: "transparent", border: "none", cursor: "pointer", color: "inherit" }}
            >
              <Minus size={14} aria-hidden="true" />
            </button>
          </div>
          <span
            role="progressbar"
            aria-label="Update download progress"
            aria-valuemin={0}
            aria-valuemax={100}
            {...(percent !== null ? { "aria-valuenow": percent } : {})}
            style={{
              display: "block",
              width: "100%",
              height: 6,
              borderRadius: 3,
              background: "rgba(255,255,255,0.15)",
              overflow: "hidden",
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
        </div>
      ) : phase === "downloaded" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ wordBreak: "break-word", flex: 1 }}>
              {`v${version} downloaded. Restart to update.`}
            </span>
            <button
              type="button"
              aria-label="Collapse update card"
              title="Collapse"
              onClick={handleCollapse}
              style={{ background: "transparent", border: "none", cursor: "pointer", color: "inherit" }}
            >
              <Minus size={14} aria-hidden="true" />
            </button>
          </div>
          <span style={{ opacity: 0.75 }}>Sessions restore after restart.</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={() => void handleRestartNow()}>
              Restart now
            </button>
            <button type="button" onClick={handleLater}>
              Later
            </button>
          </div>
        </div>
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
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span role="alert" style={{ wordBreak: "break-word", flex: 1 }}>
              {errorKind === "signature"
                ? `Update blocked: ${error ?? "signature check failed"}`
                : `Update failed: ${error ?? "unknown error"}`}
            </span>
            <button
              type="button"
              aria-label="Collapse update card"
              title="Collapse"
              onClick={handleCollapse}
              style={{ background: "transparent", border: "none", cursor: "pointer", color: "inherit" }}
            >
              <Minus size={14} aria-hidden="true" />
            </button>
          </div>
          {hint ? <span style={{ opacity: 0.8 }}>{hint}</span> : null}
          {errorKind === "signature" && releaseUrl ? (
            <a href={releaseUrl} target="_blank" rel="noreferrer">
              Download from GitHub releases
            </a>
          ) : null}
          <div style={{ display: "flex", gap: 8 }}>
            {errorKind !== "signature" ? (
              <button type="button" onClick={() => void handleRetry()}>
                Retry
              </button>
            ) : null}
            <button type="button" onClick={handleNotNow}>
              Dismiss
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
              <span style={{ wordBreak: "break-word", fontWeight: 600 }}>
                {engine === "native"
                  ? `Oppa v${version} is ready.`
                  : `A new version of OPPA is available (v${version}).`}
              </span>
              <span style={{ opacity: 0.75 }}>Sessions restore after restart.</span>
              {releaseBody ? (
                <span style={{ opacity: 0.85, wordBreak: "break-word" }}>
                  {releaseBody.slice(0, 220)}
                </span>
              ) : null}
              {releaseUrl ? (
                <a href={releaseUrl} target="_blank" rel="noreferrer" style={{ opacity: 0.85 }}>
                  Release notes
                </a>
              ) : null}
            </div>
            <button
              type="button"
              aria-label="Dismiss update card"
              title="Dismiss"
              onClick={handleNotNow}
              style={{ background: "transparent", border: "none", cursor: "pointer", color: "inherit" }}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
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
          </div>
        </div>
      )}
    </div>
  );
}
