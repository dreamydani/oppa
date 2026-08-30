import { invoke } from "@tauri-apps/api/core";
import { getChannel } from "./channel";

export interface UpdateInfo {
  version: string;
  download: string;
  available: boolean;
}

// Frontend seam for Task 5's "Update now / Not now" banner.
//
// The dev build NEVER checks for updates (confirmed user requirement): this
// seam gates on the resolved build channel and short-circuits to null on dev
// or when the channel is still unresolved, exactly like the Rust side does.
// Any backend failure (offline, 404, bad JSON) also resolves to null — the
// update check must never break the app.
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (getChannel() !== "stable") {
    return null;
  }
  try {
    return await invoke<UpdateInfo>("check_for_update");
  } catch {
    return null;
  }
}
