import type { ReactElement } from "react";
import { useTerminalStore } from "../store/terminalStore";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  PanelLeftIcon,
  PanelRightIcon,
  MinimizeIcon,
  MaximizeIcon,
  CloseIcon,
} from "./icons/MinimalIcons";

export function TitleBar(): ReactElement {
  const leftOpen = useTerminalStore((s) => s.leftSidebarOpen);
  const rightOpen = useTerminalStore((s) => s.rightSidebarOpen);
  const toggleLeft = useTerminalStore((s) => s.toggleLeftSidebar);
  const toggleRight = useTerminalStore((s) => s.toggleRightSidebar);
  const activeAppMode = useTerminalStore((s) => s.activeAppMode);
  const setAppMode = useTerminalStore((s) => s.setAppMode);

  const handleMinimize = () => {
    try {
      getCurrentWindow().minimize();
    } catch {
      // Ignored in non-Tauri / test environment
    }
  };

  const handleMaximize = () => {
    try {
      getCurrentWindow().toggleMaximize();
    } catch {
      // Ignored in non-Tauri / test environment
    }
  };

  const handleClose = () => {
    try {
      getCurrentWindow().close();
    } catch {
      // Ignored in non-Tauri / test environment
    }
  };

  return (
    <header className="title-bar" data-tauri-drag-region>
      <div className="title-bar-left">
        <button
          type="button"
          className={`title-bar-icon-btn ${leftOpen ? "active" : ""}`}
          onClick={toggleLeft}
          title="Toggle Left Sidebar"
          aria-label="Toggle Left Sidebar"
        >
          <PanelLeftIcon />
        </button>
        <span className="app-brand-title">oppa</span>
      </div>

      <div className="title-bar-center" data-tauri-drag-region>
        <div className="mode-switcher-pill" data-tauri-drag-region="false">
          <button
            type="button"
            className={`mode-tab ${activeAppMode === "browser" ? "active" : ""}`}
            onClick={() => setAppMode("browser")}
            title="Browser"
            aria-label="Browser"
            aria-pressed={activeAppMode === "browser"}
          >
            browser
          </button>
          <button
            type="button"
            className={`mode-tab ${activeAppMode === "terminal" ? "active" : ""}`}
            onClick={() => setAppMode("terminal")}
            title="Terminal"
            aria-label="Terminal"
            aria-pressed={activeAppMode === "terminal"}
          >
            terminal
          </button>
          <button
            type="button"
            className="mode-tab disabled"
            title="Editor (Coming soon)"
            aria-label="Editor (Coming soon)"
            disabled
          >
            editor
          </button>
        </div>
      </div>

      <div className="title-bar-right">
        <button
          type="button"
          className={`title-bar-icon-btn ${rightOpen ? "active" : ""}`}
          onClick={toggleRight}
          title="Toggle Right Sidebar"
          aria-label="Toggle Right Sidebar"
        >
          <PanelRightIcon />
        </button>
        <div className="window-controls">
          <button
            type="button"
            className="window-control-btn window-minimize"
            onClick={handleMinimize}
            title="Minimize"
            aria-label="Minimize Window"
          >
            <MinimizeIcon />
          </button>
          <button
            type="button"
            className="window-control-btn window-maximize"
            onClick={handleMaximize}
            title="Maximize"
            aria-label="Maximize Window"
          >
            <MaximizeIcon />
          </button>
          <button
            type="button"
            className="window-control-btn window-close"
            onClick={handleClose}
            title="Close"
            aria-label="Close Window"
          >
            <CloseIcon />
          </button>
        </div>
      </div>
    </header>
  );
}
