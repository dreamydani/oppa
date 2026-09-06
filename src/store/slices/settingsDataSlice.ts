// The settings document itself plus its persistence. Chrome state (which
// pane is open) lives in appChromeSlice; this is the loaded AppSettings
// value and the actions that mutate + debounce-save it.

import {
  saveSettings as transportSaveSettings,
  loadSettings as transportLoadSettings,
} from "../../lib/settings/transport";
import type { AppSettings } from "../../lib/settings/types";
import { DEFAULT_APP_SETTINGS } from "../../lib/settings/types";
import type { TerminalState } from "../terminalStore";

type Set = (
  partial:
    | Partial<TerminalState>
    | ((state: TerminalState) => Partial<TerminalState>),
) => void;

let settingsSaveTimer: ReturnType<typeof setTimeout> | null = null;

export interface SettingsDataSlice {
  settings: AppSettings;
  updateSettings: (
    partial:
      | Partial<AppSettings>
      | { general?: Partial<AppSettings["general"]>; appearance?: Partial<AppSettings["appearance"]> },
  ) => void;
  updateAppearanceSettings: (partial: Partial<AppSettings["appearance"]>) => void;
  resolveDefaultCwd: () => string | undefined;
  loadSettingsData: () => Promise<void>;
  flushSettings: () => Promise<void>;
}

function persistSettingsSoon(get: () => TerminalState) {
  if (settingsSaveTimer) {
    clearTimeout(settingsSaveTimer);
  }
  settingsSaveTimer = setTimeout(() => {
    void transportSaveSettings(get().settings).catch(() => {});
  }, 100);
}

export function createSettingsDataSlice(
  set: Set,
  get: () => TerminalState,
): SettingsDataSlice {
  return {
    settings: DEFAULT_APP_SETTINGS,

    updateSettings: (partial) => {
      const current = get().settings;
      const updated: AppSettings = {
        ...current,
        ...partial,
        general: {
          ...current.general,
          ...(partial.general || {}),
        },
        appearance: {
          ...current.appearance,
          ...(partial.appearance || {}),
        },
      };
      set({ settings: updated });
      persistSettingsSoon(get);
    },

    updateAppearanceSettings: (partial) => {
      const current = get().settings;
      const updated: AppSettings = {
        ...current,
        appearance: {
          ...current.appearance,
          ...partial,
        },
      };
      set({ settings: updated });
      persistSettingsSoon(get);
    },

    resolveDefaultCwd: () => {
      const { settings } = get();
      const { defaultCwdMode, customDefaultCwd } = settings.general;
      if (defaultCwdMode === "last_active") {
        return get().getActiveCwd() || undefined;
      }
      if (defaultCwdMode === "custom") {
        return customDefaultCwd.trim() || undefined;
      }
      return undefined;
    },

    loadSettingsData: async () => {
      try {
        const loaded = await transportLoadSettings();
        if (loaded) {
          set({ settings: loaded });
        }
      } catch {
        // Keep default settings on error
      }
    },

    // Close-path flush: a pending debounced theme/zoom write must not die
    // with the window (beforeunload cannot await the timer).
    flushSettings: async () => {
      if (settingsSaveTimer) {
        clearTimeout(settingsSaveTimer);
        settingsSaveTimer = null;
      }
      try {
        await transportSaveSettings(get().settings);
      } catch {
        // Best-effort: a failed flush must not block quit.
      }
    },
  };
}
