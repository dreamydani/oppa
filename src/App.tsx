import { useEffect } from "react";
import { PaneSplit } from "./components/PaneSplit";
import { useTerminalStore } from "./store/terminalStore";
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

  return <PaneSplit />;
}

export default App;
