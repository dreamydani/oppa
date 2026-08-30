import { useEffect, useRef, useState, lazy, Suspense } from "react";
import { listen } from "@tauri-apps/api/event";
import { PlusIcon } from "./components/icons/MinimalIcons";
import { TitleBar } from "./components/TitleBar";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useGlobalFailureSurface } from "./lib/errors/globalFailureSurface";
import { LeftSidebar } from "./components/LeftSidebar";
import { RightSidebar } from "./components/right-sidebar/RightSidebar";
import { PaneSplit } from "./components/PaneSplit";
import { StatusBar } from "./components/layout/StatusBar";
import { WorktreeCreateModal } from "./components/worktree/WorktreeCreateModal";
import { WorkspaceSetupWizard } from "./components/wizard/WorkspaceSetupWizard";
import { BrowserViewport } from "./components/browser/BrowserViewport";
// Lazy: the Monaco chunk (~MBs) should load only when the editor mode is
// actually opened; terminal-first sessions never pay for it.
const EditorViewport = lazy(() =>
  import("./components/editor/EditorViewport").then((m) => ({
    default: m.EditorViewport,
  })),
);
import { SettingsView } from "./components/settings/SettingsView";
import { UpdateBanner } from "./components/UpdateBanner";
import { useTerminalStore } from "./store/terminalStore";
import {
  handleExtensionCrash,
  useExtensionStore,
} from "./store/extensionStore";
import {
  ExtensionConsentModal,
  ExtensionToasts,
} from "./components/right-sidebar/ExtensionConsent";
import {
  onExtensionCrashed,
  onExtensionNotify,
} from "./lib/extensions/extensionTransport";
import { onPtyCwd } from "./lib/pty/transport";
import { confirmSaveComplete } from "./lib/layout/transport";
import { detectGpuTier } from "./lib/terminal/gpuTier";
import "./App.css";

// Detected once at module load; the root data-gpu-tier attribute gates
// chrome effects (glow, divider affordance) on medium/high tiers only.
const gpuTier = detectGpuTier();

export type ActiveMode = "terminal" | "editor" | "browser";

// Keyboard shortcuts (platform-checked per AGENTS.md: metaKey on Mac,
// ctrlKey elsewhere):
//   Cmd/Ctrl+,        open settings (general)
//   Cmd/Ctrl+/ / F1   open keyboard shortcuts reference
//   Esc               close settings when open
//   Cmd/Ctrl+N        open the workspace setup wizard (new workspace tab)
//   Cmd/Ctrl+T        new single-terminal workspace
//   Cmd/Ctrl+W        close active tab / focused pane
//   Ctrl+Tab          cycle active tab forward (sequential or MRU)
//   Ctrl+Shift+Tab    cycle active tab backward (sequential or MRU)
//   Alt/Cmd+1..9      jump directly to tab index 0..8
//   Cmd/Ctrl+Shift+D  split focused pane horizontally
//   Cmd/Ctrl+Shift+E  split focused pane vertically
//   Cmd/Ctrl+arrows   move focus to a sibling pane
//   Alt+Shift+arrows  swap focused pane with adjacent pane
//   Cmd/Ctrl+B        toggle left sidebar
//   Cmd/Ctrl+Shift+B  toggle right sidebar
//   Cmd/Ctrl+Shift+X  open the Extensions panel
function App() {
  const splitPane = useTerminalStore((s) => s.splitPane);
  const closePane = useTerminalStore((s) => s.closePane);
  const moveFocus = useTerminalStore((s) => s.moveFocus);
  const swapFocusedPane = useTerminalStore((s) => s.swapFocusedPane);
  const createTab = useTerminalStore((s) => s.createTab);
  const createWizardTab = useTerminalStore((s) => s.createWizardTab);
  const toggleLeftSidebar = useTerminalStore((s) => s.toggleLeftSidebar);
  const toggleRightSidebar = useTerminalStore((s) => s.toggleRightSidebar);
  const saveLayout = useTerminalStore((s) => s.saveLayout);
  const loadLayout = useTerminalStore((s) => s.loadLayout);
  const ready = useTerminalStore((s) => s.ready);
  const activeAppMode = useTerminalStore((s) => s.activeAppMode);
  const isSettingsOpen = useTerminalStore((s) => s.isSettingsOpen);
  const openSettings = useTerminalStore((s) => s.openSettings);
  const closeSettings = useTerminalStore((s) => s.closeSettings);

  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const appearance = useTerminalStore((s) => s.settings.appearance);
  const showStatusBar = useTerminalStore((s) => s.settings.appearance.showStatusBar);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  // Suppress sidebar/panel transitions until shortly after startup so the
  // sidebarOnLaunch flip applies silently instead of animating on first paint.
  const [booted, setBooted] = useState(false);
  useEffect(() => {
    if (!ready || booted) return;
    const timer = window.setTimeout(() => setBooted(true), 300);
    return () => window.clearTimeout(timer);
  }, [ready, booted]);

  // Dynamically apply app theme, UI zoom scale, and font family to the root document.
  useEffect(() => {
    if (typeof document === "undefined") return;

    if (appearance.appFontFamily) {
      document.documentElement.style.setProperty("--font-sans", appearance.appFontFamily);
    }
    if (appearance.uiZoom) {
      document.documentElement.style.zoom = String(appearance.uiZoom);
    }

    if (appearance.appTheme === "system") {
      const mediaQuery =
        typeof window !== "undefined" && typeof window.matchMedia === "function"
          ? window.matchMedia("(prefers-color-scheme: dark)")
          : null;

      const updateSystemTheme = (e?: MediaQueryListEvent | { matches: boolean }) => {
        const isDark = typeof e?.matches === "boolean" ? e.matches : (mediaQuery ? mediaQuery.matches : false);
        document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
      };

      updateSystemTheme();

      if (mediaQuery) {
        if (typeof mediaQuery.addEventListener === "function") {
          mediaQuery.addEventListener("change", updateSystemTheme);
          return () => mediaQuery.removeEventListener("change", updateSystemTheme);
        } else if (typeof (mediaQuery as any).addListener === "function") {
          (mediaQuery as any).addListener(updateSystemTheme);
          return () => (mediaQuery as any).removeListener(updateSystemTheme);
        }
      }
    } else {
      document.documentElement.setAttribute("data-theme", appearance.appTheme);
    }
  }, [appearance.appTheme, appearance.uiZoom, appearance.appFontFamily]);

  // Restore persisted layout and apply startup behavior on initial mount.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const init = async () => {
      try {
        await loadLayout();
      } catch {
        // A corrupt save file must not brick startup: fall through to a fresh
        // pane (loadLayout still marks the store ready).
      }
      const currentSettings = useTerminalStore.getState().settings;
      if (currentSettings.appearance.sidebarOnLaunch === "collapsed") {
        useTerminalStore.setState({ leftSidebarOpen: false });
      } else if (currentSettings.appearance.sidebarOnLaunch === "open") {
        useTerminalStore.setState({ leftSidebarOpen: true });
      }
      if (currentSettings.general.startupBehavior === "workspace_launcher") {
        // The wizard is the launcher now; a launcher tab opens on boot.
        if (useTerminalStore.getState().tabs.length === 0) {
          useTerminalStore.getState().createWizardTab();
        }
      } else if (currentSettings.general.startupBehavior === "fresh_terminal") {
        if (useTerminalStore.getState().tabs.length === 0) {
          void useTerminalStore.getState().createTab();
        }
      }
      // Extensions load once at boot so contributions (themes) are available
      // to pickers without waiting for the Extensions panel to open.
      void useExtensionStore.getState().load();
    };
    void init();
  }, [loadLayout]);

  // Subscribe to live PTY CWD updates and keep session CWD in sync.
  useEffect(() => {
    const unlistenPromise = onPtyCwd((p) => {
      useTerminalStore.getState().updateSessionCwd(p.id, p.cwd);
    });
    return () => {
      // onPtyCwd may be a stub returning undefined in tests; tolerate it.
      void Promise.resolve(unlistenPromise).then((unlisten) =>
        unlisten?.(),
      );
    };
  }, []);

  // Extension host events: notifications become toasts; crashes update the
  // panel state. Both are fire-and-forget — failures never block the UI.
  useEffect(() => {
    const unlisteners = [
      onExtensionNotify((payload) =>
        useExtensionStore.getState().pushToast(payload),
      ),
      onExtensionCrashed((payload) => handleExtensionCrash(payload)),
    ];
    return () => {
      void Promise.all(unlisteners).then((fns) =>
        fns.forEach((fn) => fn?.()),
      );
    };
  }, []);

  // Persist the layout + session state on window close. Best-effort: a failed
  // save must not block the app from quitting.
  useEffect(() => {
    const onBeforeUnload = () => {
      void saveLayout().catch(() => {});
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [saveLayout]);

  // Close handshake: Rust intercepts the window close and emits
  // `app:before-close`; flush the save, signal completion, and let Rust exit.
  // This is what makes restore reliable — `beforeunload` cannot await the
  // async save invoke, so the exit path must wait for it on the Rust side.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen("app:before-close", async () => {
      try {
        await saveLayout();
        await confirmSaveComplete();
      } catch {
        // A failed save must not trap the app: Rust exits after its timeout
        // anyway.
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [saveLayout]);

  useEffect(() => {
    const isMac =
      typeof navigator !== "undefined" &&
      (navigator.platform.toUpperCase().includes("MAC") ||
        navigator.userAgent.includes("Mac"));
    const modifier = (e: KeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey);

    const onKeyDown = (e: KeyboardEvent) => {
      // Escape: close settings if open
      if (e.key === "Escape" || e.key === "Esc") {
        if (useTerminalStore.getState().isSettingsOpen) {
          e.preventDefault();
          closeSettings();
          return;
        }
      }

      // F1: open shortcuts settings
      if (e.key === "F1") {
        e.preventDefault();
        openSettings("shortcuts");
        return;
      }

      // Tab switching: Ctrl+Tab and Ctrl+Shift+Tab
      if (e.ctrlKey && (e.key === "Tab" || e.code === "Tab")) {
        e.preventDefault();
        const { tabs, activeTabId, selectTab, settings, tabFocusHistory } = useTerminalStore.getState();
        if (tabs.length > 0) {
          if (settings.general.tabSwitchMode === "mru") {
            const validHistory = tabFocusHistory.filter((id) => tabs.some((t) => t.id === id));
            for (const t of tabs) {
              if (!validHistory.includes(t.id)) {
                validHistory.push(t.id);
              }
            }
            if (validHistory.length > 1) {
              const currentIdx = validHistory.indexOf(activeTabId);
              const safeIdx = currentIdx >= 0 ? currentIdx : 0;
              const offset = e.shiftKey ? -1 : 1;
              const nextIdx = (safeIdx + offset + validHistory.length) % validHistory.length;
              selectTab(validHistory[nextIdx]);
            }
          } else {
            const currentIndex = tabs.findIndex((t) => t.id === activeTabId);
            const safeIndex = currentIndex >= 0 ? currentIndex : 0;
            const offset = e.shiftKey ? -1 : 1;
            const nextIndex = (safeIndex + offset + tabs.length) % tabs.length;
            selectTab(tabs[nextIndex].id);
          }
        }
        return;
      }

      // Direct tab index jump: Alt+1..9 / Cmd+1..9
      if ((e.altKey || e.metaKey) && e.key >= "1" && e.key <= "9") {
        const index = Number(e.key) - 1;
        const { tabs, selectTab } = useTerminalStore.getState();
        if (index >= 0 && index < tabs.length) {
          e.preventDefault();
          selectTab(tabs[index].id);
        }
        return;
      }

      // Directional pane swapping: Alt+Shift+Arrows
      if (e.altKey && e.shiftKey) {
        if (e.key === "ArrowUp") {
          e.preventDefault();
          swapFocusedPane("up");
          return;
        }
        if (e.key === "ArrowDown") {
          e.preventDefault();
          swapFocusedPane("down");
          return;
        }
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          swapFocusedPane("left");
          return;
        }
        if (e.key === "ArrowRight") {
          e.preventDefault();
          swapFocusedPane("right");
          return;
        }
      }

      if (!modifier(e) && !e.ctrlKey && !e.metaKey) return;
      const key = e.key.toLowerCase();
      if (key === "," && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        openSettings("general");
      } else if ((key === "/" || key === "?") && !e.altKey) {
        e.preventDefault();
        openSettings("shortcuts");
      } else if (key === "b" && e.shiftKey) {
        e.preventDefault();
        toggleRightSidebar();
      } else if (key === "x" && e.shiftKey) {
        // Ctrl/Cmd+Shift+X: open the Extensions panel (VS Code parity).
        e.preventDefault();
        const ui = useTerminalStore.getState();
        if (!ui.rightSidebarOpen) ui.toggleRightSidebar();
        ui.setRightSidebarTab("extensions");
      } else if (key === "b" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        toggleLeftSidebar();
      } else if (key === "n" && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        // The wizard is the launcher: Ctrl+N opens a setup workspace.
        useTerminalStore.getState().createWizardTab();
      } else if (key === "t" && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        void createTab();
      } else if (key === "w" && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        void closePane();
      } else if (key === "d" && e.shiftKey) {
        e.preventDefault();
        void splitPane("h");
      } else if (key === "e" && e.shiftKey) {
        e.preventDefault();
        void splitPane("v");
      } else if (key === "arrowleft") {
        e.preventDefault();
        moveFocus("left");
      } else if (key === "arrowright") {
        e.preventDefault();
        moveFocus("right");
      } else if (key === "arrowup") {
        e.preventDefault();
        moveFocus("up");
      } else if (key === "arrowdown") {
        e.preventDefault();
        moveFocus("down");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    splitPane,
    closePane,
    moveFocus,
    swapFocusedPane,
    createTab,
    toggleLeftSidebar,
    toggleRightSidebar,
    openSettings,
    closeSettings,
  ]);

  // Hold the pane grid until the startup restore has settled: rendering a
  // sessionless placeholder leaf before the restore would spawn a throwaway
  // shell that loadLayout then replaces (an orphaned pty).
  if (!ready) return null;
  return (
    <ErrorBoundary label="the app">
      <GlobalFailureBanner />
      <div className={`app-container${booted ? " app-booted" : ""}`} data-gpu-tier={gpuTier}>
        <TitleBar />
        {isSettingsOpen ? (
          <SettingsView />
        ) : (
          <div className="workspace-container">
          <div className="soft-edge-left" />
          <div className="soft-edge-right" />
          {activeAppMode !== "browser" && <LeftSidebar />}
          <main className="main-viewport">
            <div
              className="viewport-view terminal-viewport-view"
              style={{
                display: activeAppMode === "terminal" ? "flex" : "none",
                width: "100%",
                height: "100%",
              }}
            >
              {!activeTab ? (
                <div className="empty-workspace-view" data-testid="empty-workspace-view">
                  <div className="empty-workspace-card">
                    <div className="empty-workspace-icon">
                      <img src="/logo.png" alt="OPPA" className="empty-workspace-logo-img" />
                    </div>
                    <h2 className="empty-workspace-title">No Open Workspaces</h2>
                    <p className="empty-workspace-subtitle">
                      Configure an active project workspace with terminal layouts, shells, and agent personas.
                    </p>
                    <div className="empty-workspace-actions">
                      <button
                        type="button"
                        className="empty-action-btn primary"
                        onClick={() => createWizardTab()}
                        aria-label="New Workspace"
                      >
                        <PlusIcon size={15} />
                        <span>New Workspace</span>
                      </button>
                    </div>
                    <div className="empty-workspace-shortcut-hint">
                      Press <kbd>Ctrl+N</kbd> / <kbd>Cmd+N</kbd> for the Workspace Wizard
                    </div>
                  </div>
                </div>
              ) : activeTab.isWizard ? (
                <WorkspaceSetupWizard tabId={activeTab.id} />
              ) : (
                <PaneSplit />
              )}
            </div>
            <div
              className="viewport-view browser-viewport-view"
              style={{
                display: activeAppMode === "browser" ? "flex" : "none",
                width: "100%",
                height: "100%",
              }}
            >
              <BrowserViewport />
            </div>
            <div
              className="viewport-view editor-viewport-view"
              style={{
                display: activeAppMode === "editor" ? "flex" : "none",
                width: "100%",
                height: "100%",
              }}
            >
              <Suspense fallback={null}>
                {activeAppMode === "editor" && <EditorViewport />}
              </Suspense>
            </div>
          </main>
          {activeAppMode !== "browser" && <RightSidebar />}
        </div>
      )}
      {showStatusBar &&       <StatusBar />}
      <WorktreeCreateModal />
      {/* Extension consent + notification overlays are always mounted so they
          work from any mode/tab (the host pushes events app-wide). */}
      <ExtensionConsentModal />
      <ExtensionToasts />
      {/* Stable-startup update banner (checkForUpdate gates on channel; dev
          builds and offline runs render nothing). */}
      <UpdateBanner />
      </div>
    </ErrorBoundary>
  );
}

// Non-fatal surface for async failures boundaries cannot catch: fire-and-forget
// IPC rejections and window errors. Latest failure renders as a dismissible bar.
function GlobalFailureBanner() {
  const failure = useGlobalFailureSurface();
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!failure || dismissed === failure) return null;
  return (
    <div
      role="alert"
      style={{
        position: "fixed",
        bottom: 36,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        gap: 12,
        maxWidth: "80vw",
        padding: "8px 12px",
        borderRadius: 8,
        background: "var(--bg-secondary, #2a2a2a)",
        color: "var(--text-primary, #ddd)",
        border: "1px solid rgba(255, 120, 120, 0.35)",
        fontSize: 12,
        boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
      }}
    >
      <span style={{ wordBreak: "break-word" }}>Background error: {failure}</span>
      <button type="button" onClick={() => setDismissed(failure)}>
        Dismiss
      </button>
    </div>
  );
}

export default App;
