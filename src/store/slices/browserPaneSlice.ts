// Embedded browser pane state: app mode, URL history stack, device presets,
// and dev-server port detection from terminal output.

import type { TerminalState } from "../terminalStore";
import { triggerDebouncedSaveLayout } from "./layoutSaveScheduler";

type Set = (
  partial:
    | Partial<TerminalState>
    | ((state: TerminalState) => Partial<TerminalState>),
) => void;

export type AppMode = "terminal" | "browser" | "editor";
export type DevicePreset = "responsive" | "iphone" | "ipad" | "desktop";

export interface DetectedPort {
  port: number;
  url: string;
  title: string;
  timestamp: number;
}

export interface BrowserPaneSlice {
  activeAppMode: AppMode;
  browserUrl: string;
  browserHistory: string[];
  historyIndex: number;
  devicePreset: DevicePreset;
  detectedPorts: DetectedPort[];
  setAppMode: (mode: AppMode) => void;
  navigateBrowser: (url: string) => void;
  browserGoBack: () => void;
  browserGoForward: () => void;
  browserReload: () => void;
  setDevicePreset: (preset: DevicePreset) => void;
  addDetectedPort: (portInfo: { port: number; url: string; title?: string; timestamp?: number }) => void;
  clearDetectedPorts: () => void;
  scanOutputForPorts: (text: string) => void;
}

export function createBrowserPaneSlice(
  set: Set,
  get: () => TerminalState,
): BrowserPaneSlice {
  return {
    activeAppMode: "terminal",
    browserUrl: "",
    browserHistory: [],
    historyIndex: -1,
    devicePreset: "responsive",
    detectedPorts: [],

    setAppMode: (mode) => {
      set({ activeAppMode: mode });
      triggerDebouncedSaveLayout(get);
    },

    navigateBrowser: (url) => {
      const trimmed = url.trim();
      if (!trimmed) {
        set({ browserUrl: "", browserHistory: [], historyIndex: -1 });
        return;
      }
      set((state) => {
        const currentHistory = state.browserHistory.slice(0, state.historyIndex + 1);
        const newHistory = [...currentHistory, trimmed];
        return {
          browserUrl: trimmed,
          browserHistory: newHistory,
          historyIndex: newHistory.length - 1,
        };
      });
    },

    browserGoBack: () => {
      set((state) => {
        if (state.historyIndex <= 0) return state;
        const nextIndex = state.historyIndex - 1;
        return {
          historyIndex: nextIndex,
          browserUrl: state.browserHistory[nextIndex] ?? state.browserUrl,
        };
      });
    },

    browserGoForward: () => {
      set((state) => {
        if (state.historyIndex >= state.browserHistory.length - 1) return state;
        const nextIndex = state.historyIndex + 1;
        return {
          historyIndex: nextIndex,
          browserUrl: state.browserHistory[nextIndex] ?? state.browserUrl,
        };
      });
    },

    browserReload: () => {
      const { browserUrl } = get();
      if (browserUrl) {
        set({ browserUrl });
      }
    },

    setDevicePreset: (preset) => set({ devicePreset: preset }),

    addDetectedPort: (portInfo) => {
      set((state) => {
        const title = portInfo.title ?? `Port ${portInfo.port}`;
        const timestamp = portInfo.timestamp ?? Date.now();
        const entry: DetectedPort = {
          port: portInfo.port,
          url: portInfo.url,
          title,
          timestamp,
        };
        const existingIndex = state.detectedPorts.findIndex((p) => p.port === portInfo.port);
        if (existingIndex >= 0) {
          const updated = [...state.detectedPorts];
          updated[existingIndex] = entry;
          return { detectedPorts: updated };
        }
        return { detectedPorts: [...state.detectedPorts, entry] };
      });
    },

    clearDetectedPorts: () => set({ detectedPorts: [] }),

    scanOutputForPorts: (text) => {
      const portRegex = /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1):([0-9]{2,5})/gi;
      let match: RegExpExecArray | null;
      while ((match = portRegex.exec(text)) !== null) {
        const port = parseInt(match[1], 10);
        if (port > 0 && port <= 65535) {
          const url = `http://localhost:${port}`;
          get().addDetectedPort({ port, url, title: `Localhost :${port}`, timestamp: Date.now() });
        }
      }
    },
  };
}
