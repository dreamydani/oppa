import { invoke } from "@tauri-apps/api/core";
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
  if (channel !== "stable") {
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
  if (getChannel() !== "stable") {
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
