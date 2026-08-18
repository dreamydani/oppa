import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { Sparkles } from "lucide-react";
import { PlusIcon, TerminalIcon } from "./components/icons/MinimalIcons";
import { TitleBar } from "./components/TitleBar";
import { LeftSidebar } from "./components/LeftSidebar";
import { RightSidebar } from "./components/right-sidebar/RightSidebar";
import { PaneSplit } from "./components/PaneSplit";
import { StatusBar } from "./components/layout/StatusBar";
import { WorkspaceLauncherModal } from "./components/modal/WorkspaceLauncherModal";
import { WorkspaceSetupWizard } from "./components/wizard/WorkspaceSetupWizard";
import { BrowserViewport } from "./components/browser/BrowserViewport";
import { EditorViewport } from "./components/editor/EditorViewport";
import { ContextStudio } from "./components/context/ContextStudio";
import { useTerminalStore } from "./store/terminalStore";
import { confirmSaveComplete, onPtyCwd } from "./lib/pty/transport";
import "./App.css";

// Keyboard shortcuts (platform-checked per AGENTS.md: metaKey on Mac,
// ctrlKey elsewhere):
//   Cmd/Ctrl+N        open / toggle workspace launcher modal
//   Cmd/Ctrl+T        create new tab
//   Cmd/Ctrl+W        close active tab / focused pane
//   Ctrl+Tab          cycle active tab forward
//   Ctrl+Shift+Tab    cycle active tab backward
//   Alt/Cmd+1..9      jump directly to tab index 0..8
//   Cmd/Ctrl+Shift+D  split focused pane horizontally
//   Cmd/Ctrl+Shift+E  split focused pane vertically
//   Cmd/Ctrl+arrows   move focus to a sibling pane
//   Alt+Shift+arrows  swap focused pane with adjacent pane
//   Cmd/Ctrl+B        toggle left sidebar
//   Cmd/Ctrl+Shift+B  toggle right sidebar
function App() {
  const splitPane = useTerminalStore((s) => s.splitPane);
  const closePane = useTerminalStore((s) => s.closePane);
  const moveFocus = useTerminalStore((s) => s.moveFocus);
  const swapFocusedPane = useTerminalStore((s) => s.swapFocusedPane);
  const createTab = useTerminalStore((s) => s.createTab);
  const createWizardTab = useTerminalStore((s) => s.createWizardTab);
  const leftSidebarOpen = useTerminalStore((s) => s.leftSidebarOpen);
  const rightSidebarOpen = useTerminalStore((s) => s.rightSidebarOpen);
  const toggleLeftSidebar = useTerminalStore((s) => s.toggleLeftSidebar);
  const toggleRightSidebar = useTerminalStore((s) => s.toggleRightSidebar);
  const saveLayout = useTerminalStore((s) => s.saveLayout);
  const loadLayout = useTerminalStore((s) => s.loadLayout);
  const ready = useTerminalStore((s) => s.ready);
  const activeAppMode = useTerminalStore((s) => s.activeAppMode);

  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  // Restore the persisted layout once on startup (StrictMode double-invokes
  // effects in dev; a ref guarantees the restore runs exactly once).
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    void loadLayout().catch(() => {
      // A corrupt save file must not brick startup: fall through to a fresh
      // pane (loadLayout still marks the store ready).
    });
  }, [loadLayout]);

  // Subscribe to live PTY CWD updates and keep session CWD in sync.
  useEffect(() => {
    const unlistenPromise = onPtyCwd((p) => {
      useTerminalStore.getState().updateSessionCwd(p.id, p.cwd);
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
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
      // Tab switching: Ctrl+Tab and Ctrl+Shift+Tab
      if (e.ctrlKey && (e.key === "Tab" || e.code === "Tab")) {
        e.preventDefault();
        const { tabs, activeTabId, selectTab } = useTerminalStore.getState();
        if (tabs.length > 0) {
          const currentIndex = tabs.findIndex((t) => t.id === activeTabId);
          const safeIndex = currentIndex >= 0 ? currentIndex : 0;
          const offset = e.shiftKey ? -1 : 1;
          const nextIndex = (safeIndex + offset + tabs.length) % tabs.length;
          selectTab(tabs[nextIndex].id);
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
      if (key === "b" && e.shiftKey) {
        e.preventDefault();
        toggleRightSidebar();
      } else if (key === "b" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        toggleLeftSidebar();
      } else if (key === "n" && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        useTerminalStore.getState().toggleWorkspaceLauncher();
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
  }, [splitPane, closePane, moveFocus, swapFocusedPane, createTab, toggleLeftSidebar, toggleRightSidebar]);

  // Hold the pane grid until the startup restore has settled: rendering a
  // sessionless placeholder leaf before the restore would spawn a throwaway
  // shell that loadLayout then replaces (an orphaned pty).
  if (!ready) return null;
  return (
    <div className="app-container">
      <TitleBar />
      <div className="workspace-container">
        <div className="soft-edge-left" />
        <div className="soft-edge-right" />
        {leftSidebarOpen && activeAppMode !== "browser" && activeAppMode !== "context" && (
          <LeftSidebar />
        )}
        <main className="main-viewport">
          {!activeTab ? (
            <div className="empty-workspace-view" data-testid="empty-workspace-view">
              <div className="empty-workspace-card">
                <div className="empty-workspace-icon">
                  <TerminalIcon size={28} />
                </div>
                <h2 className="empty-workspace-title">No Open Workspaces</h2>
                <p className="empty-workspace-subtitle">
                  Create a new terminal session, configure a project workspace with the setup wizard, or press <kbd>Ctrl+N</kbd> to launch.
                </p>
                <div className="empty-workspace-actions">
                  <button
                    type="button"
                    className="empty-action-btn primary"
                    onClick={() => void createTab()}
                  >
                    <PlusIcon size={14} /> New Terminal
                  </button>
                  <button
                    type="button"
                    className="empty-action-btn secondary"
                    onClick={() => createWizardTab()}
                  >
                    <Sparkles size={14} /> Setup Wizard
                  </button>
                </div>
                <div className="empty-workspace-shortcut-hint">
                  Press <kbd>Ctrl+N</kbd> / <kbd>Cmd+N</kbd> for Workspace Launcher
                </div>
              </div>
            </div>
          ) : activeTab.isWizard ? (
            <WorkspaceSetupWizard tabId={activeTab.id} />
          ) : (
            <>
              <div
                className="viewport-view terminal-viewport-view"
                style={{
                  display: activeAppMode === "terminal" ? "flex" : "none",
                  width: "100%",
                  height: "100%",
                }}
              >
                <PaneSplit />
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
                <EditorViewport />
              </div>
              <div
                className="viewport-view context-viewport-view"
                style={{
                  display: activeAppMode === "context" ? "flex" : "none",
                  width: "100%",
                  height: "100%",
                }}
              >
                <ContextStudio />
              </div>
            </>
          )}
        </main>
        {rightSidebarOpen && activeAppMode !== "browser" && activeAppMode !== "context" && (
          <RightSidebar />
        )}
      </div>
      <StatusBar />
      <WorkspaceLauncherModal />
    </div>
  );
}

export default App;
