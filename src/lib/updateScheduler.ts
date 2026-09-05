import { checkForNativeUpdate, checkForUpdate } from "./updater";
import { getChannel } from "./channel";
import { useTerminalStore } from "../store/terminalStore";

// Single owner for WHEN update checks run. The card (UpdateBanner) and the
// status segment are renderers: they announce nothing, they only listen for
// availability events and dispatch manual requests through requestManualCheck.
export const MANUAL_UPDATE_CHECK_EVENT = "oppa:manual-update-check";
export const UPDATE_AVAILABILITY_EVENT = "oppa:update-availability";
// Card collapse contract (Orca parity): the banner owns `collapsed` and
// announces it; the status segment toggles via expand requests.
export const UPDATE_CARD_COLLAPSE_EVENT = "oppa:update-card-collapse";
export const UPDATE_CARD_EXPAND_REQUEST_EVENT = "oppa:expand-update-card";
export const UPDATE_DOWNLOAD_PROGRESS_EVENT = "oppa:update-download-progress";

export interface UpdateAvailabilityDetail {
  version: string | null;
  phase: "available" | "downloaded" | null;
  // Which engine produced the offer, so the card can render the matching
  // action (native download vs legacy browser flow). Absent on clears.
  engine?: "native" | "legacy";
  // Legacy installer URL (v1 browser flow); native offers carry no URL.
  download?: string;
  currentVersion?: string;
  // Native release notes (plugin Update.body/date) for the rich card.
  body?: string;
  date?: string;
  releaseUrl?: string;
}

export interface UpdateCardCollapseDetail {
  collapsed: boolean;
}

export interface UpdateDownloadProgressDetail {
  version: string;
  downloaded: number;
  total?: number;
}

// First check is deferred past window-ready so cold startup stays fast.
export const UPDATE_INITIAL_DELAY_MS = 30_000;
// Steady-state cadence once checks resolve.
export const UPDATE_DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Resolved checks throttle later automatic triggers (T1 semantics preserved).
export const UPDATE_RECHECK_FLOOR_MS = 6 * 60 * 60 * 1000;
// Failed checks retry soon, doubling per consecutive failure up to the cap.
export const UPDATE_BACKOFF_BASE_MS = 60 * 60 * 1000;
export const UPDATE_BACKOFF_CAP_MS = 6 * 60 * 60 * 1000;

export interface UpdateSchedulerOptions {
  initialDelayMs?: number;
  dailyIntervalMs?: number;
  recheckFloorMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  // Injectable clock for fake-timer tests; defaults to the globals.
  timers?: {
    setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
    clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
  };
}

type CheckReason = "mount" | "daily" | "focus" | "resume" | "online" | "manual";

type RawOutcome =
  | { kind: "native"; version: string; currentVersion?: string; body?: string; date?: string }
  | { kind: "legacy"; version: string; download: string; available: boolean }
  | { kind: "empty" };

export function getReleaseNotesUrl(version: string): string {
  return `https://github.com/dreamydani/oppa/releases/tag/v${version}`;
}

// Manual Check-now (Settings, status segment): bypasses the floor and the
// opt-out but stays channel-gated inside the seam fns. The scheduler performs
// the check; the card shows its checking state off this same event.
export function requestManualCheck(): void {
  window.dispatchEvent(new CustomEvent(MANUAL_UPDATE_CHECK_EVENT));
}

export function announceCardCollapsed(collapsed: boolean): void {
  window.dispatchEvent(
    new CustomEvent<UpdateCardCollapseDetail>(UPDATE_CARD_COLLAPSE_EVENT, {
      detail: { collapsed },
    }),
  );
}

export function requestExpandUpdateCard(): void {
  window.dispatchEvent(new CustomEvent(UPDATE_CARD_EXPAND_REQUEST_EVENT));
}

export function announceDownloadProgress(detail: UpdateDownloadProgressDetail): void {
  window.dispatchEvent(
    new CustomEvent<UpdateDownloadProgressDetail>(UPDATE_DOWNLOAD_PROGRESS_EVENT, { detail }),
  );
}

// Starts the centralized check loop; the returned stop removes ALL
// listeners/timers (unmount-safe). Concurrent triggers coalesce onto the one
// in-flight check — never two downloads from overlapping triggers.
export function startUpdateScheduler(options: UpdateSchedulerOptions = {}): () => void {
  const initialDelayMs = options.initialDelayMs ?? UPDATE_INITIAL_DELAY_MS;
  const dailyIntervalMs = options.dailyIntervalMs ?? UPDATE_DAILY_INTERVAL_MS;
  const recheckFloorMs = options.recheckFloorMs ?? UPDATE_RECHECK_FLOOR_MS;
  const backoffBaseMs = options.backoffBaseMs ?? UPDATE_BACKOFF_BASE_MS;
  const backoffCapMs = options.backoffCapMs ?? UPDATE_BACKOFF_CAP_MS;
  // Looked up at fire time so fake timers installed around start() apply.
  const schedule = (fn: () => void, ms: number): ReturnType<typeof setTimeout> =>
    options.timers ? options.timers.setTimeout(fn, ms) : globalThis.setTimeout(fn, ms);
  const clearTimer = (id: ReturnType<typeof setTimeout>): void => {
    if (options.timers) options.timers.clearTimeout(id);
    else globalThis.clearTimeout(id);
  };

  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = backoffBaseMs;
  // What was last checked (for the debug log); install uses what was checked.
  let checkedVersion: string | null = null;

  const readGeneral = () => useTerminalStore.getState().settings.general;
  const autoChecksEnabled = () => readGeneral().autoCheckUpdates !== false;
  const floorRemainingMs = () => {
    const lastCheckAt = readGeneral().lastCheckAt;
    if (lastCheckAt == null) return 0;
    return Math.max(0, lastCheckAt + recheckFloorMs - Date.now());
  };

  const emitAvailability = (detail: UpdateAvailabilityDetail): void => {
    window.dispatchEvent(new CustomEvent<UpdateAvailabilityDetail>(UPDATE_AVAILABILITY_EVENT, { detail }));
  };

  const scheduleNext = (delayMs: number): void => {
    if (pendingTimer !== null) clearTimer(pendingTimer);
    pendingTimer = schedule(() => {
      pendingTimer = null;
      void triggerCheck("daily", true);
    }, delayMs);
  };

  // Parked while opted out: no daily/backoff wakeups remain queued (a staged
  // offer survives, manual checks still work, the next opt-in focus resumes).
  const parkTimer = (): void => {
    if (pendingTimer !== null) {
      clearTimer(pendingTimer);
      pendingTimer = null;
    }
  };

  // Native-first priority; the legacy fallback drives the old browser flow.
  // Seams resolve null on failure, but guard rejections anyway. Automatic
  // checks preserve a staged pending update on empty so a failing background
  // check can't strand a downloaded card; manual checks discard as before.
  const probeSeams = async (preservePending: boolean): Promise<RawOutcome> => {
    try {
      const native = await checkForNativeUpdate(
        preservePending ? { preservePendingOnEmpty: true } : undefined,
      ).catch(() => null);
      if (native)
        return {
          kind: "native",
          version: native.version,
          currentVersion: native.currentVersion,
          body: native.body,
          date: native.date,
        };
      const legacy = await checkForUpdate().catch(() => null);
      if (legacy) {
        return { kind: "legacy", version: legacy.version, download: legacy.download, available: legacy.available };
      }
      return { kind: "empty" };
    } catch {
      return { kind: "empty" };
    }
  };

  // Presents an outcome exactly like the card used to: resolved checks stamp
  // (empty ones never stamp, so recovery isn't suppressed), every outcome is
  // debug-logged so a missing card stays diagnosable. Automatic failures only
  // log + back off — they emit nothing, so a staged offer survives a failed
  // background check. Manual failures and resolved negatives announce a
  // clear, so checking states resolve and pulled releases vanish.
  const presentOutcome = (outcome: RawOutcome, reason: CheckReason, automatic: boolean): void => {
    const channel = getChannel() ?? "unresolved";
    if (outcome.kind === "native") {
      checkedVersion = outcome.version;
      useTerminalStore.getState().updateSettings({ general: { lastCheckAt: Date.now() } });
      console.debug(
        `[updater] channel=${channel} reason=${reason} engine=native available=true version=${outcome.version} checkedVersion=${checkedVersion}`,
      );
      emitAvailability({
        version: outcome.version,
        phase: "available",
        engine: "native",
        currentVersion: outcome.currentVersion,
        body: outcome.body,
        date: outcome.date,
        releaseUrl: getReleaseNotesUrl(outcome.version),
      });
      return;
    }
    if (outcome.kind === "legacy") {
      checkedVersion = outcome.version;
      useTerminalStore.getState().updateSettings({ general: { lastCheckAt: Date.now() } });
      console.debug(
        `[updater] channel=${channel} reason=${reason} engine=legacy available=${outcome.available} version=${outcome.version} checkedVersion=${checkedVersion}`,
      );
      if (!outcome.available) {
        emitAvailability({ version: null, phase: null });
        return;
      }
      emitAvailability({
        version: outcome.version,
        phase: "available",
        engine: "legacy",
        download: outcome.download,
      });
      return;
    }
    console.debug(`[updater] channel=${channel} reason=${reason} available=false version=none`);
    // Automatic failures stay silent (a staged offer survives); manual ones
    // must resolve the card's checking state.
    if (!automatic) {
      emitAvailability({ version: null, phase: null });
    }
  };

  const triggerCheck = (reason: CheckReason, automatic: boolean): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (inFlight) return inFlight;
    const task = (async (): Promise<void> => {
      if (automatic) {
        // Opt-out kills every automatic check but never manual ones — and
        // parks the timer instead of queuing no-op wakeups.
        if (!autoChecksEnabled()) {
          parkTimer();
          return;
        }
        const remaining = floorRemainingMs();
        if (remaining > 0) {
          scheduleNext(remaining);
          return;
        }
      }
      const outcome = await probeSeams(automatic);
      if (stopped) return;
      try {
        presentOutcome(outcome, reason, automatic);
      } catch {
        // A throwing bus listener must never kill the daily chain.
      }
      const resolved = outcome.kind !== "empty";
      if (resolved) {
        backoffMs = backoffBaseMs;
        if (automatic) scheduleNext(dailyIntervalMs);
      } else if (automatic) {
        // Only background failures step the ladder; manual retries never do.
        const delay = backoffMs;
        backoffMs = Math.min(backoffCapMs, backoffMs * 2);
        scheduleNext(delay);
      }
    })().catch(() => {});
    inFlight = task;
    const release = () => {
      if (inFlight === task) inFlight = null;
    };
    void task.then(release, release);
    return task;
  };

  const onManualCheck = () => {
    void triggerCheck("manual", false);
  };
  const onFocus = () => {
    void triggerCheck("focus", true);
  };
  const onOnline = () => {
    void triggerCheck("online", true);
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") void triggerCheck("resume", true);
  };

  window.addEventListener(MANUAL_UPDATE_CHECK_EVENT, onManualCheck);
  window.addEventListener("focus", onFocus);
  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisibilityChange);
  // Opted out at start: park immediately — no mount wakeup that would no-op.
  if (autoChecksEnabled()) {
    pendingTimer = schedule(() => {
      pendingTimer = null;
      void triggerCheck("mount", true);
    }, initialDelayMs);
  }

  return () => {
    stopped = true;
    if (pendingTimer !== null) {
      clearTimer(pendingTimer);
      pendingTimer = null;
    }
    window.removeEventListener(MANUAL_UPDATE_CHECK_EVENT, onManualCheck);
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
}
