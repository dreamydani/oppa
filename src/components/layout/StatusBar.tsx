import React, { useEffect, useMemo, useState } from "react";
import { GitBranch, Folder, Terminal, Users, Download } from "lucide-react";
import { useTerminalStore } from "../../store/terminalStore";
import { focus } from "../../lib/pane-manager/layout";
import { findLeafPath } from "../../lib/pane-manager/layout";
import type { AgentStatusEntry } from "../../lib/pty/transport";
import { getGitStatus, GitStatusResult } from "../../lib/git/transport";
import { checkForNativeUpdate, checkForUpdate } from "../../lib/updater";
import {
  MANUAL_UPDATE_CHECK_EVENT,
  UPDATE_AVAILABILITY_EVENT,
  type UpdateAvailabilityDetail,
} from "../UpdateBanner";
import "./StatusBar.css";

// Attention order for the fleet aggregate click: what needs a human first.
const FLEET_ATTENTION: AgentStatusEntry["state"][] = ["blocked", "waiting", "working", "done"];

function FleetAggregate(): React.ReactElement | null {
  const sessions = useTerminalStore((s) => s.sessions);
  const statusBySessionId = useTerminalStore((s) => s.statusBySessionId);
  const tabs = useTerminalStore((s) => s.tabs);
  const selectTab = useTerminalStore((s) => s.selectTab);
  const markAgentStatusSeen = useTerminalStore((s) => s.markAgentStatusSeen);

  // Live hooked sessions only; the aggregate is about agents, not shells.
  const fleet = useMemo(() => {
    const counts: Record<AgentStatusEntry["state"], number> = {
      working: 0,
      blocked: 0,
      waiting: 0,
      done: 0,
    };
    const byState: Record<AgentStatusEntry["state"], string[]> = {
      working: [],
      blocked: [],
      waiting: [],
      done: [],
    };
    for (const session of Object.values(sessions)) {
      if (session.status === "exited") continue;
      const entry = statusBySessionId[session.id];
      if (!entry) continue;
      counts[entry.state] += 1;
      byState[entry.state].push(session.id);
    }
    return { counts, byState };
  }, [sessions, statusBySessionId]);

  const total = FLEET_ATTENTION.reduce((sum, state) => sum + fleet.counts[state], 0);
  if (total === 0) return null;

  const jumpToAttention = () => {
    for (const state of FLEET_ATTENTION) {
      const candidate = fleet.byState[state].find(
        (sessionId) => tabs.some((t) => findLeafPath(t.layout, sessionId) !== null),
      );
      if (!candidate) continue;
      markAgentStatusSeen(candidate);
      const tab = tabs.find((t) => findLeafPath(t.layout, candidate) !== null);
      if (tab) selectTab(tab.id);
      return;
    }
  };

  const label = (state: AgentStatusEntry["state"], n: number) =>
    n === 0 ? null : (
      <span className={`fleet-agg-count fleet-agg-${state}`} key={state}>
        {state} {n}
      </span>
    );

  return (
    <button
      type="button"
      className="status-bar-item fleet-aggregate"
      data-testid="fleet-aggregate"
      title="Jump to the agent that needs attention first"
      onClick={jumpToAttention}
    >
      <Users size={13} />
      {FLEET_ATTENTION.map((state) => label(state, fleet.counts[state]))}
    </button>
  );
}

// Update segment: dot + version, visible only while the update card holds an
// available/downloaded update. The card announces transitions via
// availability events; the mount check covers a segment mounted after the
// card already resolved. Click runs Check-now (the card owns the check).
function UpdateSegment(): React.ReactElement | null {
  const [updateVersion, setUpdateVersion] = useState<string | null>(null);
  const dismissedUpdateVersion = useTerminalStore((s) => s.settings.general.dismissedUpdateVersion);

  useEffect(() => {
    let cancelled = false;
    // Own silent check on mount (fail-silent like the card), gated on the
    // auto-check opt-out. Event sync below + manual click stay ungated.
    if (useTerminalStore.getState().settings.general.autoCheckUpdates !== false) {
      void checkForNativeUpdate()
        .then((native) => {
          if (cancelled) return;
          if (native) {
            setUpdateVersion(native.version);
            return;
          }
          return checkForUpdate().then((legacy) => {
            if (!cancelled && legacy?.available) setUpdateVersion(legacy.version);
          });
        })
        .catch(() => {});
    }
    const onAvailability = (event: Event) => {
      if (cancelled) return;
      setUpdateVersion((event as CustomEvent<UpdateAvailabilityDetail>).detail.version);
    };
    window.addEventListener(UPDATE_AVAILABILITY_EVENT, onAvailability);
    return () => {
      cancelled = true;
      window.removeEventListener(UPDATE_AVAILABILITY_EVENT, onAvailability);
    };
  }, []);

  if (!updateVersion || dismissedUpdateVersion === updateVersion) return null;
  return (
    <button
      type="button"
      className="status-bar-item update-segment"
      data-testid="update-segment"
      title={`Update to v${updateVersion} is ready — check now`}
      onClick={() => {
        window.dispatchEvent(new CustomEvent(MANUAL_UPDATE_CHECK_EVENT));
      }}
    >
      <span className="status-indicator-dot update-available" aria-hidden="true" />
      <Download size={13} />
      <span>{`v${updateVersion}`}</span>
    </button>
  );
}

export function StatusBar(): React.ReactElement {
  const cwd = useTerminalStore((s) => s.getActiveCwd());
  const sessions = useTerminalStore((s) => s.sessions);
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const detectedPorts = useTerminalStore((s) => s.detectedPorts);
  const setAppMode = useTerminalStore((s) => s.setAppMode);
  const navigateBrowser = useTerminalStore((s) => s.navigateBrowser);

  const [gitStatus, setGitStatus] = useState<GitStatusResult | null>(null);

  useEffect(() => {
    let isMounted = true;
    if (!cwd) {
      setGitStatus(null);
      return;
    }

    void getGitStatus(cwd)
      .then((res) => {
        if (isMounted) {
          setGitStatus(res);
        }
      })
      .catch(() => {
        if (isMounted) {
          setGitStatus(null);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [cwd]);

  // Derive active session info
  const activeTab = tabs.find((t) => t.id === activeTabId) || tabs[0];
  let activeSessionId = "";
  if (activeTab) {
    try {
      activeSessionId = focus(activeTab.layout, activeTab.focusedPath || []);
    } catch {
      // Layout traversal fallback
    }
  }
  const activeSession = activeSessionId ? sessions[activeSessionId] : undefined;
  const cols = activeSession?.cols ?? 80;
  const rows = activeSession?.rows ?? 24;
  const sessionStatus = activeSession?.status || "ready";

  const getCwdDisplay = () => {
    if (!cwd) return "No directory";
    const parts = cwd.split(/[/\\]/).filter(Boolean);
    return parts[parts.length - 1] || cwd;
  };

  return (
    <footer className="status-bar">
      <div className="status-bar-section status-bar-section-left">
        <div className={`status-bar-item ${gitStatus?.is_git ? "git-item" : ""}`}>
          <GitBranch size={13} />
          {gitStatus?.is_git ? (
            <>
              <span className="status-bar-git-branch">{gitStatus.branch || "HEAD"}</span>
              {(gitStatus.ahead > 0 || gitStatus.behind > 0) && (
                <span className="status-bar-git-sync">
                  {gitStatus.ahead > 0 && `↑${gitStatus.ahead}`}
                  {gitStatus.behind > 0 && ` ↓${gitStatus.behind}`}
                </span>
              )}
            </>
          ) : (
            <span>no git</span>
          )}
        </div>

        <div className="status-bar-item" title={cwd || "No active directory"}>
          <Folder size={13} />
          <span className="status-bar-cwd">{getCwdDisplay()}</span>
        </div>

        {detectedPorts.map((port) => (
          <button
            key={port.port}
            type="button"
            className="status-bar-item localhost-badge"
            title={`Open ${port.url} in Browser`}
            onClick={() => {
              navigateBrowser(port.url);
              setAppMode("browser");
            }}
          >
            <span className="localhost-bolt">⚡</span>
            <span>{`localhost:${port.port}`}</span>
          </button>
        ))}

        <FleetAggregate />
      </div>

      <div className="status-bar-section status-bar-section-right">
        <UpdateSegment />
        <div className="status-bar-item" title="Terminal Dimensions">
          <Terminal size={13} />
          <span>{`${cols}x${rows}`}</span>
        </div>

        <div className="status-bar-item" title={`Status: ${sessionStatus}`}>
          <span className={`status-indicator-dot ${sessionStatus}`} />
          <span>{sessionStatus === "running" ? "Ready" : sessionStatus}</span>
        </div>
      </div>
    </footer>
  );
}
