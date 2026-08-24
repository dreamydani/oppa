import { create } from "zustand";
import {
  getContributions,
  listExtensions,
  setExtensionEnabled,
  type ExtensionListItem,
} from "../lib/extensions/extensionTransport";
import { syncExtensionThemes } from "../lib/theme/terminalThemes";

// Single source of truth for the extension system in the renderer. Components
// read contributions from here; only extensionTransport touches Tauri APIs.

export type ExtensionsStatus = "idle" | "loading" | "ready" | "unavailable";

interface ExtensionStoreState {
  status: ExtensionsStatus;
  extensions: ExtensionListItem[];
  /** Set once after a failed load so panels can explain instead of retry-looping. */
  loadError: string | null;
  load: () => Promise<void>;
  toggleExtension: (id: string, enabled: boolean) => Promise<void>;
}

async function refreshContributions(): Promise<void> {
  const { themes } = await getContributions();
  syncExtensionThemes(themes);
}

export const useExtensionStore = create<ExtensionStoreState>((set, get) => ({
  status: "idle",
  extensions: [],
  loadError: null,

  load: async () => {
    if (get().status === "loading") return;
    set({ status: "loading", loadError: null });
    try {
      const extensions = await listExtensions();
      await refreshContributions();
      set({ status: "ready", extensions });
    } catch (error) {
      set({
        status: "unavailable",
        loadError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  toggleExtension: async (id: string, enabled: boolean) => {
    // Optimistic flip; the backend persists and re-derives contributions.
    const previous = get().extensions;
    set({
      extensions: previous.map((ext) => (ext.id === id ? { ...ext, enabled } : ext)),
    });
    try {
      await setExtensionEnabled(id, enabled);
      await refreshContributions();
    } catch (error) {
      // Roll back so the switch never lies.
      set({ extensions: previous });
      throw error instanceof Error ? error : new Error(String(error));
    }
  },
}));
