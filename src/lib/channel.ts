import { invoke } from "@tauri-apps/api/core";

export type AppChannel = "dev" | "stable";

// The build channel, cached after the first `app_channel` resolution so later
// tasks (updater gating, banner) can branch on it without another IPC round
// trip. `null` until `resolveChannel` (or `applyChannelIdentity`) succeeds.
let cachedChannel: AppChannel | null = null;

export function getChannel(): AppChannel | null {
  return cachedChannel;
}

export async function resolveChannel(): Promise<AppChannel | null> {
  try {
    const raw = await invoke<string>("app_channel");
    const channel: AppChannel = raw === "dev" ? "dev" : "stable";
    cachedChannel = channel;
    return channel;
  } catch {
    // Non-Tauri / headless environments: never trust a stale cached channel
    // after a failed resolve — the renderer must not act on a channel this
    // build did not confirm.
    cachedChannel = null;
    return null;
  }
}

export function windowTitleForChannel(channel: AppChannel | null): string {
  return channel === "dev" ? "Developer OPPA" : "oppa";
}

// Boot helper: resolve the channel once and set the window title from it.
// The Tauri window title follows `document.title`. Stable keeps "oppa"
// exactly; dev shows "Developer OPPA" (the only visible difference).
export async function applyChannelIdentity(): Promise<AppChannel | null> {
  const channel = await resolveChannel();
  document.title = windowTitleForChannel(channel);
  return channel;
}
