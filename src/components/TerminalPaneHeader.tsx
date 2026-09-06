import { useState, useRef, useEffect, useCallback } from "react";
import { ChevronDown, X, GitBranch, Maximize2, Minimize2 } from "lucide-react";
import { useTerminalStore } from "../store/terminalStore";
import type { SessionInfo } from "../store/terminalStore";
import type { Path } from "../lib/pane-manager/layout";
import type { DropZone } from "../lib/pane-manager/layout";
import type { RepoRecord, AgentProfile } from "../lib/worktree/transport";
import { agentProfiles } from "../lib/worktree/transport";
import { focus as focusLeaf } from "../lib/pane-manager/layout";
import { AgentStatusPill } from "./agent/AgentStatusPill";
import {
  usePaneDragStore,
  findDropTargetUnderPointer,
  createDropTargetCoalescer,
} from "../lib/pane-manager/dragState";
import "./TerminalPaneHeader.css";

export interface TerminalPaneHeaderProps {
  id: string;
  path?: Path;
  onClear?: () => void;
}

/* Bespoke Solid Vector Icons (16x16) */
function IconMore() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <circle cx="3.5" cy="8" r="1.5" />
      <circle cx="8" cy="8" r="1.5" />
      <circle cx="12.5" cy="8" r="1.5" />
    </svg>
  );
}

function IconPlus() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
      <line x1="8" y1="3.5" x2="8" y2="12.5" />
      <line x1="3.5" y1="8" x2="12.5" y2="8" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
      <line x1="4" y1="4" x2="12" y2="12" />
      <line x1="12" y1="4" x2="4" y2="12" />
    </svg>
  );
}

// Title shown for a session: seeded/extracted name when usable, else the cwd
// basename. Synthetic titles are raw ids ("s-…" or the bare session id).
// `fallbackCwd` lets callers override the cwd source.
export function sessionDisplayTitle(
  session: SessionInfo | undefined,
  fallbackCwd?: string,
): string {
  const title = session?.title;
  if (title && title !== session?.id && !title.startsWith("s-")) {
    return title;
  }
  const titleSourceCwd = fallbackCwd || session?.cwd;
  if (titleSourceCwd) {
    return (
      titleSourceCwd.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "terminal"
    );
  }
  return title || "terminal";
}

// Owning repo for a session cwd: longest registered repo path that prefixes
// it. Case-insensitive because drive-letter/shell casing varies on Windows.
export function resolveRepoForCwd(
  cwd: string | undefined,
  repos: RepoRecord[],
): RepoRecord | null {
  if (!cwd) return null;
  const normalizePath = (p: string) =>
    p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const cwdNorm = normalizePath(cwd);
  let best: RepoRecord | null = null;
  let bestLen = -1;
  for (const repo of repos) {
    const repoNorm = normalizePath(repo.path);
    const isPrefix = cwdNorm === repoNorm || cwdNorm.startsWith(`${repoNorm}/`);
    if (isPrefix && repoNorm.length > bestLen) {
      best = repo;
      bestLen = repoNorm.length;
    }
  }
  return best;
}

export function TerminalPaneHeader({ id, path, onClear }: TerminalPaneHeaderProps) {
  const session = useTerminalStore((s) => s.sessions[id]);
  const worktrees = useTerminalStore((s) => s.worktrees);
  const renameSession = useTerminalStore((s) => s.renameSession);
  const dismissSessionRestoredBanner = useTerminalStore((s) => s.dismissSessionRestoredBanner);
  const maximizedSessionId = useTerminalStore((s) => s.maximizedSessionId);
  const toggleMaximizePane = useTerminalStore((s) => s.toggleMaximizePane);
  const splitPane = useTerminalStore((s) => s.splitPane);
  const splitPaneWithCommand = useTerminalStore((s) => s.splitPaneWithCommand);
  const openWorktreeCreate = useTerminalStore((s) => s.openWorktreeCreate);
  const repos = useTerminalStore((s) => s.repos);
  const closePane = useTerminalStore((s) => s.closePane);
  const focusPane = useTerminalStore((s) => s.focusPane);
  const movePane = useTerminalStore((s) => s.movePane);
  const setAppMode = useTerminalStore((s) => s.setAppMode);
  const navigateBrowser = useTerminalStore((s) => s.navigateBrowser);
  const detectedPorts = useTerminalStore((s) => s.detectedPorts);

  const isMaximized = maximizedSessionId === id;
  const displayTitle = sessionDisplayTitle(session);
  const worktreeEntry = session?.worktreeId
    ? worktrees.find((w) => w.record.id === session.worktreeId)
    : undefined;
  const branchName = worktreeEntry?.record.branch || session?.worktreeId;

  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(displayTitle);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isSwitcherOpen, setIsSwitcherOpen] = useState(false);
  const [isDraggingLocal, setIsDraggingLocal] = useState(false);
  // New-terminal plus menu (plain splits + agent catalog + custom cmd).
  const [isPlusOpen, setIsPlusOpen] = useState(false);
  const [isMissingOpen, setIsMissingOpen] = useState(false);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [customCommand, setCustomCommand] = useState("");

  // Detected CLIs list directly; undetected ones hide behind the expander.
  // `available === undefined` (stale daemon) fail-opens into the main list
  // so the menu never blanks against an old backend.
  const visibleProfiles = profiles.filter((p) => p.id !== "generic" && p.available !== false);
  const missingProfiles = profiles.filter((p) => p.id !== "generic" && p.available === false);

  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const switcherBtnRef = useRef<HTMLButtonElement>(null);
  const switcherPanelRef = useRef<HTMLDivElement>(null);
  const plusPanelRef = useRef<HTMLDivElement>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  const startRename = useCallback(() => {
    // WHY displayTitle: the stored title may be the raw s- id; never leak it into the input.
    setEditTitle(displayTitle);
    setIsEditing(true);
  }, [displayTitle]);

  const handleSave = useCallback(() => {
    const next = editTitle.trim();
    if (next && next !== session?.title) {
      renameSession(id, next);
    }
    setIsEditing(false);
  }, [editTitle, id, renameSession, session?.title]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSave();
      } else if (e.key === "Escape") {
        e.preventDefault();
        setEditTitle(displayTitle);
        setIsEditing(false);
      }
    },
    [handleSave, displayTitle]
  );

  const handleOpenInBrowser = useCallback(() => {
    if (detectedPorts.length > 0) {
      const targetUrl = detectedPorts[detectedPorts.length - 1].url;
      navigateBrowser(targetUrl);
    }
    setAppMode("browser");
  }, [detectedPorts, navigateBrowser, setAppMode]);

  // Pointer drag on empty header middle area
  const handleDragPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();

      const dragZoneEl = e.currentTarget;
      const pointerId = e.pointerId;
      const startX = e.clientX;
      const startY = e.clientY;
      let hasExceededThreshold = false;

      try {
        dragZoneEl.setPointerCapture(pointerId);
      } catch {}

      // Drop-target detection is rAF-throttled: pointermove can fire many
      // times per frame, and each detection queries every leaf's rect.
      const updateDropTarget = (target: { targetId: string; zone: DropZone } | null) => {
        usePaneDragStore.getState().updateDropTarget(target?.targetId ?? null, target?.zone ?? null);
      };
      const targetCoalescer = createDropTargetCoalescer(
        (clientX, clientY) => findDropTargetUnderPointer(clientX, clientY, id),
        updateDropTarget,
      );

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!hasExceededThreshold) {
          if (Math.hypot(dx, dy) >= 5) {
            hasExceededThreshold = true;
            setIsDraggingLocal(true);
            usePaneDragStore.getState().startDrag(id);
            targetCoalescer.flushNow();
          }
        } else {
          targetCoalescer.push(ev.clientX, ev.clientY);
        }
      };

      const cleanup = () => {
        try {
          dragZoneEl.releasePointerCapture(pointerId);
        } catch {}
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        setIsDraggingLocal(false);
      };

      const onUp = (ev: PointerEvent) => {
        cleanup();
        if (hasExceededThreshold) {
          targetCoalescer.flushNow();
          const target = findDropTargetUnderPointer(ev.clientX, ev.clientY, id);
          if (target) {
            movePane(id, target.targetId, target.zone);
          }
          usePaneDragStore.getState().endDrag();
        } else {
          if (path) {
            focusPane(path);
          }
        }
      };

      const onCancel = () => {
        cleanup();
        usePaneDragStore.getState().endDrag();
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
    },
    [focusPane, id, movePane, path]
  );

  // Close dropdown menu on outside clicks
  useEffect(() => {
    if (!isMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        menuRef.current &&
        !menuRef.current.contains(target) &&
        moreBtnRef.current &&
        !moreBtnRef.current.contains(target)
      ) {
        setIsMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isMenuOpen]);

  // Terminal switcher: same close contract as the More menu, plus Escape.
  useEffect(() => {
    if (!isSwitcherOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        switcherPanelRef.current &&
        !switcherPanelRef.current.contains(target) &&
        switcherBtnRef.current &&
        !switcherBtnRef.current.contains(target)
      ) {
        setIsSwitcherOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsSwitcherOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isSwitcherOpen]);

  // Plus menu: same close contract as the switcher (outside mousedown + Esc).
  useEffect(() => {
    if (!isPlusOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        plusPanelRef.current &&
        !plusPanelRef.current.contains(target) &&
        plusBtnRef.current &&
        !plusBtnRef.current.contains(target)
      ) {
        setIsPlusOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsPlusOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isPlusOpen]);

  // Agent catalog loads lazily: the plus menu is its only consumer, and an
  // IPC miss (e.g. web dev) degrades to plain splits + custom command.
  useEffect(() => {
    if (!isPlusOpen) return;
    let cancelled = false;
    setIsMissingOpen(false);
    void agentProfiles()
      .then((list) => {
        if (!cancelled) setProfiles(list);
      })
      .catch(() => {
        if (!cancelled) setProfiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isPlusOpen]);

  const launchAgent = useCallback(
    (profile: AgentProfile) => {
      setIsPlusOpen(false);
      void splitPaneWithCommand("h", path, profile.command ?? profile.id, profile.displayName);
    },
    [path, splitPaneWithCommand],
  );

  const runCustomCommand = useCallback(() => {
    const cmd = customCommand.trim();
    if (!cmd) return;
    setCustomCommand("");
    setIsPlusOpen(false);
    void splitPaneWithCommand("h", path, cmd, undefined);
  }, [customCommand, path, splitPaneWithCommand]);

  // New branch…: opens the worktree create modal prefilled with this pane's
  // owning repo when resolvable.
  const splitNewBranch = useCallback(() => {
    setIsMenuOpen(false);
    const repo = resolveRepoForCwd(session?.cwd, repos);
    openWorktreeCreate(repo ? { repoPath: repo.path } : undefined);
  }, [openWorktreeCreate, repos, session?.cwd]);

  return (
    <div className="terminal-pane-header">
      <div className="terminal-pane-header-left">
        {isEditing ? (
          <input
            ref={inputRef}
            className="terminal-pane-header-rename-input"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
            onPointerDown={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            className="terminal-pane-header-title terminal-pane-title"
            title="Click to rename pane"
            onClick={startRename}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {displayTitle}
          </span>
        )}
        <button
          ref={switcherBtnRef}
          type="button"
          className={`terminal-pane-header-btn terminal-pane-header-switcher-btn${isSwitcherOpen ? " active" : ""}`}
          title="Switch Terminal"
          aria-label="Switch Terminal"
          aria-expanded={isSwitcherOpen}
          onClick={() => setIsSwitcherOpen((prev) => !prev)}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <ChevronDown size={12} strokeWidth={2.4} />
        </button>
        {branchName && (
          <div
            className="terminal-pane-header-branch-badge"
            title={`Worktree branch: ${branchName}`}
          >
            <GitBranch size={11} className="terminal-pane-header-branch-icon" />
            <span className="terminal-pane-header-branch-name">{branchName}</span>
          </div>
        )}
        {session?.isRestored && (
          <div
            className={`terminal-restored-badge${session?.resumeKind === "agent-resume" ? " terminal-restored-badge--resumed" : ""}`}
            role="status"
            aria-label="Session restored"
            title="Session restored from disk checkpoint. Press any key or click to dismiss."
            onClick={(e) => {
              e.stopPropagation();
              dismissSessionRestoredBanner(id);
            }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <span className="restored-dot" />
            <span className="restored-text">
              {session?.resumeKind === "agent-resume"
                ? "Agent resumed"
                : session?.resumeKind === "command-relaunch"
                  ? "Command relaunched"
                  : "Session restored"}
            </span>
            <button
              type="button"
              className="restored-dismiss-btn"
              aria-label="Dismiss restored banner"
              onClick={(e) => {
                e.stopPropagation();
                dismissSessionRestoredBanner(id);
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <X size={10} />
            </button>
          </div>
        )}
      </div>

      <div
        className={`pane-header-drag-zone${isDraggingLocal ? " dragging" : ""}`}
        onPointerDown={handleDragPointerDown}
      />

      <div className="terminal-pane-header-right">
        <button
          ref={moreBtnRef}
          className={`terminal-pane-header-btn ${isMenuOpen ? "active" : ""}`}
          title="More Options"
          aria-label="More Options"
          onClick={() => {
            setIsPlusOpen(false);
            setIsMenuOpen((prev) => !prev);
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <IconMore />
        </button>

        {isMenuOpen && (
          <div
            ref={menuRef}
            className="terminal-pane-header-menu"
            data-motion="menu"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              className="terminal-pane-header-menu-item"
              onClick={() => {
                onClear?.();
                setIsMenuOpen(false);
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              Clear Scrollback
            </button>
            <button
              className="terminal-pane-header-menu-item"
              onClick={() => {
                setIsMenuOpen(false);
                startRename();
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              Rename Pane
            </button>
            <button
              className="terminal-pane-header-menu-item"
              onClick={splitNewBranch}
              onPointerDown={(e) => e.stopPropagation()}
            >
              New branch…
            </button>
            <button
              className="terminal-pane-header-menu-item"
              onClick={() => {
                setIsMenuOpen(false);
                handleOpenInBrowser();
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              Open in Browser
            </button>
          </div>
        )}

        <button
          ref={plusBtnRef}
          type="button"
          className={`terminal-pane-header-btn${isPlusOpen ? " active" : ""}`}
          title="New Terminal"
          aria-label="New Terminal"
          aria-expanded={isPlusOpen}
          aria-haspopup="menu"
          onClick={() => {
            setIsMenuOpen(false);
            setIsPlusOpen((prev) => !prev);
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <IconPlus />
        </button>
        {isPlusOpen && (
          <div
            ref={plusPanelRef}
            className="terminal-pane-header-menu terminal-pane-header-plus-popover"
            role="menu"
            data-motion="menu"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              role="menuitem"
              className="terminal-pane-header-menu-item"
              onClick={() => {
                setIsPlusOpen(false);
                void splitPane("h", path);
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              Split Right
            </button>
            <button
              type="button"
              role="menuitem"
              className="terminal-pane-header-menu-item"
              onClick={() => {
                setIsPlusOpen(false);
                void splitPane("v", path);
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              Split Down
            </button>
              <div className="terminal-pane-header-menu-separator" role="separator" />
              {visibleProfiles.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="menuitem"
                  className="terminal-pane-header-menu-item"
                  onClick={() => launchAgent(p)}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <span className="terminal-pane-header-menu-label">{p.displayName}</span>
                  <span className="terminal-pane-header-menu-subtext">
                    {p.command ?? p.id}
                  </span>
                </button>
              ))}
              {missingProfiles.length > 0 && (
                <>
                  <div className="terminal-pane-header-menu-separator" role="separator" />
                  <button
                    type="button"
                    className="terminal-pane-header-menu-item"
                    aria-expanded={isMissingOpen}
                    onClick={() => setIsMissingOpen((prev) => !prev)}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <span className="terminal-pane-header-menu-label">
                      Not detected ({missingProfiles.length})
                    </span>
                    <ChevronDown size={10} strokeWidth={2.4} />
                  </button>
                  {isMissingOpen &&
                    missingProfiles.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        role="menuitem"
                        className="terminal-pane-header-menu-item terminal-pane-header-menu-item--missing"
                        onClick={() => launchAgent(p)}
                        onPointerDown={(e) => e.stopPropagation()}
                      >
                        <span className="terminal-pane-header-menu-label">{p.displayName}</span>
                        <span className="terminal-pane-header-menu-subtext">not installed</span>
                      </button>
                    ))}
                </>
              )}
              <div className="terminal-pane-header-menu-separator" role="separator" />
            <input
              aria-label="Custom command"
              className="terminal-pane-header-custom-input"
              placeholder="Custom command…"
              value={customCommand}
              onChange={(e) => setCustomCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  runCustomCommand();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  setIsPlusOpen(false);
                }
              }}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )}

        <button
          className={`terminal-pane-header-btn${isMaximized ? " active" : ""}`}
          title={isMaximized ? "Restore Grid" : "Solo / Maximize Pane"}
          aria-label={isMaximized ? "Restore Grid" : "Solo / Maximize Pane"}
          onClick={() => toggleMaximizePane(id)}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {isMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>

        <button
          className="terminal-pane-header-btn close-btn"
          title="Close Pane"
          aria-label="Close Pane"
          onClick={() => void closePane(path)}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <IconClose />
        </button>
      </div>

      {isSwitcherOpen && (
        <TerminalSwitcherMenu onClose={() => setIsSwitcherOpen(false)} panelRef={switcherPanelRef} />
      )}
    </div>
  );
}

function TerminalSwitcherMenu({
  onClose,
  panelRef,
}: {
  onClose: () => void;
  panelRef: React.RefObject<HTMLDivElement | null>;
}) {
  const tabs = useTerminalStore((s) => s.tabs);
  const sessions = useTerminalStore((s) => s.sessions);
  const worktrees = useTerminalStore((s) => s.worktrees);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const workingBySessionId = useTerminalStore((s) => s.workingBySessionId);
  const statusBySessionId = useTerminalStore((s) => s.statusBySessionId);
  const unreadBySessionId = useTerminalStore((s) => s.unreadBySessionId);
  const markAgentStatusSeen = useTerminalStore((s) => s.markAgentStatusSeen);
  const selectTab = useTerminalStore((s) => s.selectTab);

  return (
    <div
      ref={panelRef}
      className="terminal-pane-header-switcher-panel"
      data-motion="menu"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="terminal-pane-header-switcher-list">
        {tabs
          .filter((tab) => !tab.isWizard)
          .map((tab) => {
            const sessionId = focusLeaf(tab.layout, tab.focusedPath);
            return (
              <SwitcherRow
                key={tab.id}
                isActive={tab.id === activeTabId}
                session={sessions[sessionId]}
                worktrees={worktrees}
                workingBySessionId={workingBySessionId}
                agentEntry={statusBySessionId[sessionId]}
                unread={unreadBySessionId[sessionId] ?? false}
                onSelect={() => {
                  selectTab(tab.id);
                  markAgentStatusSeen(sessionId);
                  onClose();
                }}
              />
            );
          })}
      </div>
    </div>
  );
}

interface SwitcherRowProps {
  isActive: boolean;
  session: SessionInfo | undefined;
  worktrees: { record: { id: string; branch: string } }[];
  workingBySessionId: Record<string, boolean>;
  agentEntry?: import("../lib/pty/transport").AgentStatusEntry;
  unread?: boolean;
  onSelect: () => void;
}

function SwitcherRow({
  isActive,
  session,
  worktrees,
  workingBySessionId,
  agentEntry,
  unread,
  onSelect,
}: SwitcherRowProps) {
  // Pure frontend join: focused session's worktreeId → registry branch chip.
  const branch = session?.worktreeId
    ? worktrees.find((w) => w.record.id === session.worktreeId)?.record.branch
    : undefined;
  const isWorking = session ? (workingBySessionId[session.id] ?? false) : false;
  // Hook truth replaces the binary dot; hookless shells keep the legacy dot.
  const pill = agentEntry ? (
    <AgentStatusPill entry={agentEntry} unread={unread} />
  ) : null;

  return (
    <button
      type="button"
      className={`terminal-pane-header-switcher-row${isActive ? " active" : ""}`}
      onClick={onSelect}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {pill ?? (
        <span
          className={`terminal-pane-header-working-dot${isWorking ? " working" : ""}`}
          aria-hidden="true"
        />
      )}
      <span className="terminal-pane-header-switcher-title">
        {sessionDisplayTitle(session)}
      </span>
      {branch && <span className="terminal-pane-header-switcher-branch">{branch}</span>}
    </button>
  );
}
