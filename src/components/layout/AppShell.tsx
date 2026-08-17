import React from "react";
import { LeftSidebar } from "../sidebar/LeftSidebar";
import { RightSidebar } from "../right-sidebar/RightSidebar";
import { Titlebar } from "./Titlebar";
import { StatusBar } from "./StatusBar";
import { TabBar } from "../TabBar";
import { Toolbar } from "../Toolbar";
import { PaneSplit } from "../PaneSplit";
import { WorkspaceSetupWizard } from "../wizard/WorkspaceSetupWizard";
import { useTerminalStore } from "../../store/terminalStore";
import "./AppShell.css";

export function AppShell(): React.ReactElement {
  const leftSidebarOpen = useTerminalStore((s) => s.leftSidebarOpen);
  const rightSidebarOpen = useTerminalStore((s) => s.rightSidebarOpen);

  return (
    <div className="app-shell">
      <Titlebar />
      <div className="app-body">
        {leftSidebarOpen && <LeftSidebar />}
        <main className="app-main">
          <TabBar />
          <Toolbar />
          <div className="terminal-workbench">
            <PaneSplit />
          </div>
        </main>
        {rightSidebarOpen && <RightSidebar />}
      </div>
      <StatusBar />
      <WorkspaceSetupWizard />
    </div>
  );
}
