import { create } from "zustand";
import {
  CONSENT_REQUIRED_PREFIX,
  getContributions,
  getExtensionFingerprint,
  grantExtensionConsent,
  listExtensions,
  setExtensionEnabled,
  type ExtensionCrash,
  type ExtensionListItem,
  type ExtensionNotification,
} from "../lib/extensions/extensionTransport";
import { syncExtensionThemes } from "../lib/theme/terminalThemes";

// Single source of truth for the extension system in the renderer. Components
// read contributions from here; only extensionTransport touches Tauri APIs.

export type ExtensionsStatus = "idle" | "loading" | "ready" | "unavailable";

export interface Toast {
  key: number;
  title: string;
  body: string;
}

interface ExtensionStoreState {
  status: ExtensionsStatus;
  extensions: ExtensionListItem[];
  /** Set once after a failed load so panels can explain instead of retry-looping. */
  loadError: string | null;
  /** Extension awaiting consent: { id, fingerprint, capabilities }. */
  pendingConsentId: string | null;
  toasts: Toast[];
  load: () => Promise<void>;
  toggleExtension: (id: string, enabled: boolean) => Promise<void>;
  /** Called after the user approves the consent dialog. */
  grantConsentAndEnable: (id: string) => Promise<void>;
  dismissConsent: () => void;
  pushToast: (notification: ExtensionNotification) => void;
  expireToast: (key: number) => void;
}

let nextToastKey = 1;

async function refreshContributions(): Promise<void> {
  const { themes } = await getContributions();
  syncExtensionThemes(themes);
}

function applyCrashes(
  extensions: ExtensionListItem[],
  crashes: Record<string, ExtensionCrash>,
): ExtensionListItem[] {
  if (Object.keys(crashes).length === 0) return extensions;
  return extensions.map((ext) =>
    crashes[ext.id] ? { ...ext, enabled: false, crash_error: crashes[ext.id].reason } : ext,
  );
}

export const useExtensionStore = create<ExtensionStoreState>((set, get) => ({
  status: "idle",
  extensions: [],
  loadError: null,
  pendingConsentId: null,
  toasts: [],

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
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith(CONSENT_REQUIRED_PREFIX)) {
        // Roll back the optimistic flip and open the consent dialog.
        set({ extensions: previous, pendingConsentId: id });
        return;
      }
      // Roll back so the switch never lies.
      set({ extensions: previous });
      throw error instanceof Error ? error : new Error(message);
    }
  },

  grantConsentAndEnable: async (id: string) => {
    const previous = get().extensions;
    const fingerprint = await getExtensionFingerprint(id);
    set({
      extensions: previous.map((ext) => (ext.id === id ? { ...ext, enabled: true } : ext)),
      pendingConsentId: null,
    });
    try {
      await grantExtensionConsent(id, fingerprint);
      await refreshContributions();
      // Reflect any backend-side adjustments (e.g. crash flags cleared).
      const fresh = await listExtensions();
      set({ extensions: fresh });
    } catch (error) {
      set({ extensions: previous });
      throw error instanceof Error ? error : new Error(String(error));
    }
  },

  dismissConsent: () => set({ pendingConsentId: null }),

  pushToast: (notification) => {
    const toast: Toast = { key: nextToastKey++, title: notification.title, body: notification.body };
    set({ toasts: [...get().toasts.slice(-3), toast] });
  },

  expireToast: (key) => set({ toasts: get().toasts.filter((t) => t.key !== key) }),
}));

/** Apply a crash event pushed from the backend pump onto current state. */
export function handleExtensionCrash(crash: ExtensionCrash): void {
  useExtensionStore.setState((state) => ({
    extensions: applyCrashes(state.extensions, { [crash.id]: crash }),
  }));
}
