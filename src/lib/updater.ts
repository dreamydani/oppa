import { invoke } from "@tauri-apps/api/core";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getChannel, resolveChannel } from "./channel";

export interface UpdateInfo {
  version: string;
  download: string;
  available: boolean;
}

/// Wire payload of the `can_upgrade_daemon` Tauri command (mirrors
/// `pty::commands::CanUpgradeDaemonPayload` snake_case keys as camelCase).
export interface CanUpgradeDaemonResult {
  safe: boolean;
  sessionCount: number;
  unknown: boolean;
}

/// Verdict of the upgrade-safety probe.
/// - `"idle"` — the daemon holds zero live sessions; safe to update.
/// - `"busy"` — sessions are running; updating will close them.
/// - `"unknown"` — couldn't verify (dev channel / error / transport). Callers
///   must NEVER treat this as "safe".
export type UpgradeSafety = "idle" | "busy" | "unknown";

/// `canUpgradeSafely()` verdict plus the live session count (0 when not
/// busy), so the banner can say "N sessions are still running" from the same
/// single IPC round trip.
export interface UpgradeSafetyProbe {
  status: UpgradeSafety;
  sessionCount: number;
}

// Frontend seam for Task 5's "Update now / Not now" banner.
//
// The dev build NEVER checks for updates (confirmed user requirement): this
// seam short-circuits to null on dev. An empty channel cache self-resolves
// instead of suppressing the check — callers may run before
// applyChannelIdentity finishes. Any backend failure (offline, 404, bad
// JSON) also resolves to null — the update check must never break the app.
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  // Callers may run before applyChannelIdentity finishes; a null cache
  // must not permanently suppress the check.
  const channel = getChannel() ?? (await resolveChannel().catch(() => null));
  if (channel !== "stable" && channel !== "rc") {
    return null;
  }
  try {
    return await invoke<UpdateInfo>("check_for_update");
  } catch {
    return null;
  }
}

// Frontend seam for Task 7's session-running warning. Gates on the channel
// exactly like checkForUpdate: dev / unresolved → "unknown" without any IPC.
// On stable it asks the NEW Rust command `can_upgrade_daemon` whether the
// daemon is idle; idle → "idle", busy → "busy" (+ count), error or an
// unknown payload → "unknown". Per the Task 6 carried note, Err/unknown is
// "can't verify, defer" — NEVER "safe".
export async function canUpgradeSafely(): Promise<UpgradeSafety> {
  return (await probeUpgradeSafety()).status;
}

/// Same probe as `canUpgradeSafely()` but with the live session count when
/// busy, from the same single IPC round trip.
export async function probeUpgradeSafety(): Promise<UpgradeSafetyProbe> {
  const channel = getChannel() ?? (await resolveChannel().catch(() => null));
  if (channel !== "stable" && channel !== "rc") {
    return { status: "unknown", sessionCount: 0 };
  }
  let result: CanUpgradeDaemonResult;
  try {
    result = await invoke<CanUpgradeDaemonResult>("can_upgrade_daemon");
  } catch {
    return { status: "unknown", sessionCount: 0 };
  }
  if (result.safe && !result.unknown) {
    return { status: "idle", sessionCount: 0 };
  }
  if (result.unknown) {
    return { status: "unknown", sessionCount: 0 };
  }
  return { status: "busy", sessionCount: result.sessionCount };
}

// ---- Native updater seam (Task 5) ----

/// Version info for an available native update (mapped from the plugin's
/// `Update` resource; the resource itself stays stashed in this module).
export interface NativeUpdateInfo {
  version: string;
  currentVersion: string;
  date?: string;
  body?: string;
}

/// Download progress sink: bytes downloaded so far, plus the total once the
/// plugin's `Started` event reports it.
export type NativeProgressCallback = (downloaded: number, total?: number) => void;

/// Outcome of `downloadNativeUpdate`: failures (incl. pre-H1 signature
/// errors) come back as values for T6's retry card, never throws.
export type NativeDownloadResult = { ok: true } | { ok: false; error: string };

/// Outcome of `installNativeUpdateAndRelaunch`: `busy` carries the live
/// session count; `error` carries the plugin failure message.
export type NativeInstallOutcome =
  | { proceeded: true }
  | { proceeded: false; reason: "busy"; sessionCount: number }
  | { proceeded: false; reason: "error"; error: string };

// The plugin `Update` from the last successful native check, plus whether it
// is already downloaded (so the two-phase T6 card never downloads twice).
let pendingNativeUpdate: Update | null = null;
let nativeUpdateDownloaded = false;

function nativeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Drops the staged native update, releasing the plugin resource when it has
// one. Test fakes may lack close(); released resources may reject.
async function releasePendingNativeUpdate(): Promise<void> {
  const displaced = pendingNativeUpdate;
  pendingNativeUpdate = null;
  nativeUpdateDownloaded = false;
  if (displaced) {
    try {
      await displaced.close?.();
    } catch {
      // Already released; the fresh state below is what matters.
    }
  }
}

// Native check is stable+rc: tauri.conf.json endpoints lists the stable
// Latest feed first plus the pinned rc feed (releases/download/rc/latest-rc.json).
// Dev/unresolved → null with no plugin calls. Stable ignores prerelease
// versions (a -rc tag from the rc feed must never offer to stable users);
// rc accepts stable promotions and rc builds. Rejections (offline, signature
// failure) stay fail-silent null — the retry card only appears after an
// explicit user action fails.
//
// `preservePendingOnEmpty` (scheduler automatic checks only): an empty/error
// outcome leaves a staged download alone instead of discarding it, so a
// failing background check can't strand a downloaded card with no pending.
export function isNativeVersionForChannel(version: string, channel: string): boolean {
  if (channel === "stable") {
    return !version.includes("-");
  }
  return true;
}

export async function checkForNativeUpdate(
  options: { preservePendingOnEmpty?: boolean } = {},
): Promise<NativeUpdateInfo | null> {
  const channel = getChannel() ?? (await resolveChannel().catch(() => null));
  if (channel !== "stable" && channel !== "rc") {
    return null;
  }
  try {
    const update = await check();
    if (!update) {
      if (!options.preservePendingOnEmpty) {
        await releasePendingNativeUpdate();
      }
      return null;
    }
    if (!isNativeVersionForChannel(update.version, channel)) {
      if (!options.preservePendingOnEmpty) {
        await releasePendingNativeUpdate();
      }
      return null;
    }
    const displaced = pendingNativeUpdate;
    const sameVersion =
      displaced !== null &&
      displaced.version === update.version &&
      displaced.currentVersion === update.currentVersion;
    pendingNativeUpdate = update;
    // A same-version re-check re-stages the plugin resource but must keep
    // the downloaded flag — the bytes are already on disk.
    if (!sameVersion) {
      nativeUpdateDownloaded = false;
    }
    if (displaced && displaced !== update) {
      // A newer check superseded the staged update: release the displaced
      // plugin resource instead of leaking it. Test fakes may lack close().
      try {
        await displaced.close?.();
      } catch {
        // Already released; the fresh update below is what matters.
      }
    }
    return {
      version: update.version,
      currentVersion: update.currentVersion,
      date: update.date,
      body: update.body,
    };
  } catch {
    if (!options.preservePendingOnEmpty) {
      await releasePendingNativeUpdate();
    }
    return null;
  }
}

// Downloads the pending update, forwarding plugin events as (bytes, total).
// Separate download()/install() (not downloadAndInstall()) so T6 can show a
// downloaded-awaiting-restart state between the two phases.
export async function downloadNativeUpdate(
  onProgress: NativeProgressCallback,
): Promise<NativeDownloadResult> {
  const pending = pendingNativeUpdate;
  if (!pending) {
    return { ok: false, error: "no native update pending" };
  }
  if (nativeUpdateDownloaded) {
    return { ok: true };
  }
  let downloadedBytes = 0;
  let totalBytes: number | undefined;
  const onEvent = (event: DownloadEvent) => {
    if (event.event === "Started") {
      downloadedBytes = 0;
      totalBytes = event.data.contentLength;
      onProgress(0, totalBytes);
    } else if (event.event === "Progress") {
      downloadedBytes += event.data.chunkLength;
      onProgress(downloadedBytes, totalBytes);
    }
    // Finished carries no bytes; the last Progress already reported the total.
  };
  try {
    await pending.download(onEvent);
  } catch (error) {
    return { ok: false, error: nativeErrorMessage(error) };
  }
  nativeUpdateDownloaded = true;
  return { ok: true };
}

// Orca-parity error taxonomy for the card: signature blocks offer no retry
// (the feed is untrusted), network/offline suggests re-check, install
// failures suggest retry, everything else is generic.
export type UpdateErrorKind = "signature" | "network" | "install" | "generic";

export function classifyUpdateError(
  message: string,
  origin: "download" | "install" | null,
): UpdateErrorKind {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("signature") ||
    normalized.includes("untrusted") ||
    normalized.includes("not signed") ||
    normalized.includes("verification failed")
  ) {
    return "signature";
  }
  if (
    normalized.includes("network") ||
    normalized.includes("offline") ||
    normalized.includes("failed to fetch") ||
    normalized.includes("timed out") ||
    normalized.includes("timeout") ||
    normalized.includes("unreachable") ||
    normalized.includes("err_")
  ) {
    return "network";
  }
  if (origin === "install") {
    return "install";
  }
  return "generic";
}

// Guarded install: the daemon-busy probe runs first and blocks without
// touching the plugin; idle/unknown proceed (unknown never claims safe —
// downloading itself cannot kill sessions, and the user chose to update).
// `onBeforeInstall` flushes layout + scrollbacks (Orca-style restore) before
// the plugin replaces files; flush failures never block the install.
export async function installNativeUpdateAndRelaunch(
  onProgress: NativeProgressCallback = () => {},
  options: { onBeforeInstall?: () => Promise<unknown> } = {},
): Promise<NativeInstallOutcome> {
  // probeUpgradeSafety swallows invoke rejections but not a malformed
  // resolved payload — a throwing probe must degrade to unknown, never reject.
  const probe = await probeUpgradeSafety().catch(() => ({
    status: "unknown" as const,
    sessionCount: 0,
  }));
  if (probe.status === "busy") {
    return { proceeded: false, reason: "busy", sessionCount: probe.sessionCount };
  }
  const pending = pendingNativeUpdate;
  if (!pending) {
    return { proceeded: false, reason: "error", error: "no native update pending" };
  }
  if (!nativeUpdateDownloaded) {
    const download = await downloadNativeUpdate(onProgress);
    if (!download.ok) {
      return { proceeded: false, reason: "error", error: download.error };
    }
  }
  if (options.onBeforeInstall) {
    try {
      await options.onBeforeInstall();
    } catch {
      // A failed save must not trap the update: the daemon checkpoints every
      // 3s and the installer still replaces files.
    }
  }
  try {
    await pending.install();
    await relaunch();
  } catch (error) {
    return { proceeded: false, reason: "error", error: nativeErrorMessage(error) };
  }
  return { proceeded: true };
}
