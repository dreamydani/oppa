import { invoke } from "@tauri-apps/api/core";
import { AppSettings, DEFAULT_APP_SETTINGS } from "./types";
import { TERMINAL_THEMES } from "../theme/terminalThemes";

// Legacy Rust-shaped keys (snake_case) map to the camelCase document shape.
// Frontend saves are camelCase; old files must not silently keep defaults.
const APPEARANCE_SNAKE_TO_CAMEL: Record<string, string> = {
  app_theme: "appTheme",
  app_font_family: "appFontFamily",
  ui_zoom: "uiZoom",
  sidebar_on_launch: "sidebarOnLaunch",
  show_status_bar: "showStatusBar",
  show_titlebar_logo: "showTitlebarLogo",
  theme_name: "themeName",
  font_family: "fontFamily",
  font_size: "fontSize",
  line_height: "lineHeight",
  cursor_style: "cursorStyle",
  cursor_blink: "cursorBlink",
  dim_inactive_panes: "dimInactivePanes",
};

function normalizeAppearance(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const [snake, camel] of Object.entries(APPEARANCE_SNAKE_TO_CAMEL)) {
    if (out[camel] === undefined && out[snake] !== undefined) {
      out[camel] = out[snake];
    }
    delete out[snake];
  }
  return out;
}

function resolveThemeName(id: unknown): string {
  if (typeof id !== "string" || id.length === 0) {
    return DEFAULT_APP_SETTINGS.appearance.themeName;
  }
  // Built-ins always stick; extension ids (e.g. "oppa.theme-pack:nord")
  // pass through so a pre-extension load never clobbers the choice.
  if (id in TERMINAL_THEMES || id.includes(":") || id.includes("/")) {
    return id;
  }
  return DEFAULT_APP_SETTINGS.appearance.themeName;
}

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
    const appearance = normalizeAppearance(parsed.appearance || {});
    return {
      general: {
        ...DEFAULT_APP_SETTINGS.general,
        ...(parsed.general || {}),
      },
      appearance: {
        ...DEFAULT_APP_SETTINGS.appearance,
        ...appearance,
        themeName: resolveThemeName(
          appearance.themeName ?? DEFAULT_APP_SETTINGS.appearance.themeName,
        ),
      },
    };
  } catch {
    return null;
  }
}
