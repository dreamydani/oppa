import React from "react";
import { SplitSquareHorizontal, SplitSquareVertical, X } from "lucide-react";
import { useTerminalStore } from "../store/terminalStore";

// Discoverable actions for the terminal core: split / close. The keyboard
// shortcuts (Ctrl+Shift+D/E, Ctrl+W) still work; the toolbar surfaces them
// with Orca-inspired dark theme styling and Lucide icons.
export function Toolbar(): React.ReactElement {
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
        <SplitSquareHorizontal size={14} />
        <span>Split ⇔</span>
      </button>
      <button
        type="button"
        title="Split vertical (Ctrl+Shift+E)"
        onClick={() => void splitPane("v")}
      >
        <SplitSquareVertical size={14} />
        <span>Split ⇕</span>
      </button>
      <button
        type="button"
        title="Close pane (Ctrl+W)"
        onClick={() => void closePane()}
      >
        <X size={14} />
      </button>
    </div>
  );
}
