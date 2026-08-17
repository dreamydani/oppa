import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { PaneSplit } from "./components/PaneSplit";
import { Toolbar } from "./components/Toolbar";
import { useTerminalStore } from "./store/terminalStore";
import { confirmSaveComplete, onPtyCwd } from "./lib/pty/transport";
import "./App.css";

// Keyboard shortcuts (platform-checked per AGENTS.md: metaKey on Mac,
// ctrlKey elsewhere):
//   Cmd/Ctrl+Shift+D  split focused pane horizontally
//   Cmd/Ctrl+Shift+E  split focused pane vertically
//   Cmd/Ctrl+W        close focused pane
//   Cmd/Ctrl+arrows   move focus to a sibling pane
function App() {
  const splitPane = useTerminalStore((s) => s.splitPane);
  const closePane = useTerminalStore((s) => s.closePane);
  const moveFocus = useTerminalStore((s) => s.moveFocus);
  const saveLayout = useTerminalStore((s) => s.saveLayout);
  const loadLayout = useTerminalStore((s) => s.loadLayout);
  const ready = useTerminalStore((s) => s.ready);

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
    const isMac = navigator.platform.toUpperCase().includes("MAC");
    const modifier = (e: KeyboardEvent) => (isMac ? e.metaKey : e.ctrlKey);

    const onKeyDown = (e: KeyboardEvent) => {
      if (!modifier(e)) return;
      const key = e.key.toLowerCase();
      if (key === "d" && e.shiftKey) {
        e.preventDefault();
        void splitPane("h");
      } else if (key === "e" && e.shiftKey) {
        e.preventDefault();
        void splitPane("v");
      } else if (key === "w") {
        e.preventDefault();
        void closePane();
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
  }, [splitPane, closePane, moveFocus]);

  // Hold the pane grid until the startup restore has settled: rendering a
  // sessionless placeholder leaf before the restore would spawn a throwaway
  // shell that loadLayout then replaces (an orphaned pty).
  if (!ready) return null;
  return (
    <>
      <Toolbar />
      <PaneSplit />
    </>
  );
}

export default App;
