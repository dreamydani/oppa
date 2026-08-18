import React from "react";
import { LeftSidebar } from "../sidebar/LeftSidebar";
import { RightSidebar } from "../right-sidebar/RightSidebar";
import { Titlebar } from "./Titlebar";
import { StatusBar } from "./StatusBar";
import { TabBar } from "../TabBar";
import { Toolbar } from "../Toolbar";
import { PaneSplit } from "../PaneSplit";
import { WorkspaceSetupWizard } from "../wizard/WorkspaceSetupWizard";
import { ContextStudio } from "../context/ContextStudio";
import { useTerminalStore } from "../../store/terminalStore";
import "./AppShell.css";

export function AppShell(): React.ReactElement {
  const leftSidebarOpen = useTerminalStore((s) => s.leftSidebarOpen);
  const rightSidebarOpen = useTerminalStore((s) => s.rightSidebarOpen);
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const activeAppMode = useTerminalStore((s) => s.activeAppMode);

  const activeTab = tabs.find((t) => t.id === activeTabId);

  return (
    <div className="app-shell">
      <Titlebar />
      <div className="app-body">
        {leftSidebarOpen && activeAppMode !== "browser" && activeAppMode !== "context" && (
          <LeftSidebar />
        )}
        <main className="app-main">
          {activeAppMode === "context" ? (
            <ContextStudio />
          ) : activeTab?.isWizard ? (
            <>
              <TabBar />
              <div className="terminal-workbench">
                <WorkspaceSetupWizard tabId={activeTab.id} />
              </div>
            </>
          ) : (
            <>
              <TabBar />
              <Toolbar />
              <div className="terminal-workbench">
                <PaneSplit />
              </div>
            </>
          )}
        </main>
        {rightSidebarOpen && activeAppMode !== "browser" && activeAppMode !== "context" && (
          <RightSidebar />
        )}
      </div>
      <StatusBar />
    </div>
  );
}
