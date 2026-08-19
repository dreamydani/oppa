import { invoke } from "@tauri-apps/api/core";
import { AppSettings, DEFAULT_APP_SETTINGS } from "./types";

export async function saveSettings(settings: AppSettings): Promise<void> {
  try {
    await invoke("save_settings", {
      settingsJson: JSON.stringify(settings),
    });
  } catch {
    // Suppress IPC errors in transport layer
  }
}

export async function loadSettings(): Promise<AppSettings | null> {
  try {
    const raw = await invoke<string | null>("load_settings");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return {
      general: {
        ...DEFAULT_APP_SETTINGS.general,
        ...(parsed.general || {}),
      },
    };
  } catch {
    return null;
  }
}
