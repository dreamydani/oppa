import { useTerminalStore } from "../store/terminalStore";

// Discoverable actions for the terminal core: split / close. The keyboard
// shortcuts (Ctrl+Shift+D/E, Ctrl+W) still work; the toolbar just surfaces
// them so the v1 features are findable without reading the docs.
export function Toolbar() {
  const splitPane = useTerminalStore((s) => s.splitPane);
  const closePane = useTerminalStore((s) => s.closePane);

  return (
    <div className="toolbar">
      <span className="toolbar-title">oppa</span>
      <span className="toolbar-spacer" />
      <button
        type="button"
        title="Split horizontal (Ctrl+Shift+D)"
        onClick={() => void splitPane("h")}
      >
        Split ⇔
      </button>
      <button
        type="button"
        title="Split vertical (Ctrl+Shift+E)"
        onClick={() => void splitPane("v")}
      >
        Split ⇕
      </button>
      <button
        type="button"
        title="Close pane (Ctrl+W)"
        onClick={() => void closePane()}
      >
        ✕
      </button>
    </div>
  );
}
