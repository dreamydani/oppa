import { useState, useRef, useEffect, useCallback } from "react";
import { ChevronDown, X, GitBranch, Maximize2, Minimize2 } from "lucide-react";
import { useTerminalStore } from "../store/terminalStore";
import type { SessionInfo } from "../store/terminalStore";
import type { Path } from "../lib/pane-manager/layout";
import type { RepoRecord } from "../lib/pty/transport";
import { focus as focusLeaf } from "../lib/pane-manager/layout";
import {
  usePaneDragStore,
  findDropTargetUnderPointer,
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

function IconGlobe() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6" />
      <line x1="2" y1="8" x2="14" y2="8" />
      <path d="M8 2a9.4 9.4 0 0 0 0 12 9.4 9.4 0 0 0 0-12z" />
    </svg>
  );
}

function IconSplitRight() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor">
      <rect x="2" y="2.75" width="12" height="10.5" rx="2" strokeWidth="1.5" />
      <rect x="8.5" y="4.25" width="4" height="7.5" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function IconSplitDown() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor">
      <rect x="2" y="2.75" width="12" height="10.5" rx="2" strokeWidth="1.5" />
      <rect x="4.25" y="8.5" width="7.5" height="4" rx="1" fill="currentColor" stroke="none" />
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
  const openFleetSheet = useTerminalStore((s) => s.openFleetSheet);
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
  // Direction of the open split chooser popover ("h" right / "v" down), if any.
  const [splitChooserDir, setSplitChooserDir] = useState<"h" | "v" | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const switcherBtnRef = useRef<HTMLButtonElement>(null);
  const switcherPanelRef = useRef<HTMLDivElement>(null);
  const splitChooserPanelRef = useRef<HTMLDivElement>(null);
  const splitRightCaretRef = useRef<HTMLButtonElement>(null);
  const splitDownCaretRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  const startRename = useCallback(() => {
    setEditTitle(session?.title || "oppa");
    setIsEditing(true);
  }, [session?.title]);

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
        setEditTitle(session?.title || "oppa");
        setIsEditing(false);
      }
    },
    [handleSave, session?.title]
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

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!hasExceededThreshold) {
          if (Math.hypot(dx, dy) >= 5) {
            hasExceededThreshold = true;
            setIsDraggingLocal(true);
            usePaneDragStore.getState().startDrag(id);
            const target = findDropTargetUnderPointer(ev.clientX, ev.clientY, id);
            if (target) {
              usePaneDragStore.getState().updateDropTarget(target.targetId, target.zone);
            } else {
              usePaneDragStore.getState().updateDropTarget(null, null);
            }
          }
        } else {
          const target = findDropTargetUnderPointer(ev.clientX, ev.clientY, id);
          if (target) {
            usePaneDragStore.getState().updateDropTarget(target.targetId, target.zone);
          } else {
            usePaneDragStore.getState().updateDropTarget(null, null);
          }
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

  // Split chooser: same close contract as the switcher (outside mousedown + Esc).
  useEffect(() => {
    if (!splitChooserDir) return;
    const chooserCaretRef =
      splitChooserDir === "h" ? splitRightCaretRef : splitDownCaretRef;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        splitChooserPanelRef.current &&
        !splitChooserPanelRef.current.contains(target) &&
        chooserCaretRef.current &&
        !chooserCaretRef.current.contains(target)
      ) {
        setSplitChooserDir(null);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSplitChooserDir(null);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [splitChooserDir]);

  const toggleSplitChooser = useCallback((dir: "h" | "v") => {
    setSplitChooserDir((prev) => (prev === dir ? null : dir));
  }, []);

  const splitSameDirectory = useCallback(
    (dir: "h" | "v") => {
      setSplitChooserDir(null);
      void splitPane(dir, path);
    },
    [path, splitPane],
  );

  // New branch…: seed the fleet sheet from this pane's owning repo; when the
  // cwd maps to no registered repo the sheet opens unprefilled and the user
  // picks there.
  const splitNewBranch = useCallback(() => {
    setSplitChooserDir(null);
    const repo = resolveRepoForCwd(session?.cwd, repos);
    if (repo) {
      openFleetSheet({ repoPath: repo.path, count: 1 });
    } else {
      openFleetSheet();
    }
  }, [openFleetSheet, repos, session?.cwd]);

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
          onClick={() => setIsMenuOpen((prev) => !prev)}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <IconMore />
        </button>

        {isMenuOpen && (
          <div
            ref={menuRef}
            className="terminal-pane-header-menu"
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
              onClick={() => {
                setIsMenuOpen(false);
                void splitPane("h", path);
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              Split Right
            </button>
            <button
              className="terminal-pane-header-menu-item"
              onClick={() => {
                setIsMenuOpen(false);
                void splitPane("v", path);
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              Split Down
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
          className="terminal-pane-header-btn"
          title="Open in Browser"
          aria-label="Open in Browser"
          onClick={handleOpenInBrowser}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <IconGlobe />
        </button>

        <span className="terminal-pane-header-split-group">
          <button
            className="terminal-pane-header-btn"
            title="Split Down"
            aria-label="Split Down"
            onClick={() => void splitPane("v", path)}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <IconSplitDown />
          </button>
          <button
            ref={splitDownCaretRef}
            type="button"
            className="terminal-pane-header-btn terminal-pane-header-split-caret"
            title="Split Down Options"
            aria-label="Split Down Options"
            aria-expanded={splitChooserDir === "v"}
            aria-haspopup="menu"
            onClick={() => toggleSplitChooser("v")}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <ChevronDown size={9} strokeWidth={2.6} />
          </button>
          {splitChooserDir === "v" && (
            <SplitChooserPopover
              panelRef={splitChooserPanelRef}
              onSameDirectory={() => splitSameDirectory("v")}
              onNewBranch={splitNewBranch}
            />
          )}
        </span>

        <span className="terminal-pane-header-split-group">
          <button
            className="terminal-pane-header-btn"
            title="Split Right"
            aria-label="Split Right"
            onClick={() => void splitPane("h", path)}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <IconSplitRight />
          </button>
          <button
            ref={splitRightCaretRef}
            type="button"
            className="terminal-pane-header-btn terminal-pane-header-split-caret"
            title="Split Right Options"
            aria-label="Split Right Options"
            aria-expanded={splitChooserDir === "h"}
            aria-haspopup="menu"
            onClick={() => toggleSplitChooser("h")}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <ChevronDown size={9} strokeWidth={2.6} />
          </button>
          {splitChooserDir === "h" && (
            <SplitChooserPopover
              panelRef={splitChooserPanelRef}
              onSameDirectory={() => splitSameDirectory("h")}
              onNewBranch={splitNewBranch}
            />
          )}
        </span>

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

function SplitChooserPopover({
  panelRef,
  onSameDirectory,
  onNewBranch,
}: {
  panelRef: React.RefObject<HTMLDivElement | null>;
  onSameDirectory: () => void;
  onNewBranch: () => void;
}) {
  return (
    <div
      ref={panelRef}
      className="terminal-pane-header-menu terminal-pane-header-split-popover"
      role="menu"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        role="menuitem"
        className="terminal-pane-header-menu-item"
        onClick={onSameDirectory}
        onPointerDown={(e) => e.stopPropagation()}
      >
        Same directory
      </button>
      <button
        type="button"
        role="menuitem"
        className="terminal-pane-header-menu-item"
        onClick={onNewBranch}
        onPointerDown={(e) => e.stopPropagation()}
      >
        New branch…
      </button>
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
  const selectTab = useTerminalStore((s) => s.selectTab);

  return (
    <div
      ref={panelRef}
      className="terminal-pane-header-switcher-panel"
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="terminal-pane-header-switcher-list">
        {tabs
          .filter((tab) => !tab.isWizard)
          .map((tab) => (
            <SwitcherRow
              key={tab.id}
              isActive={tab.id === activeTabId}
              session={sessions[focusLeaf(tab.layout, tab.focusedPath)]}
              worktrees={worktrees}
              workingBySessionId={workingBySessionId}
              onSelect={() => {
                selectTab(tab.id);
                onClose();
              }}
            />
          ))}
      </div>
    </div>
  );
}

interface SwitcherRowProps {
  isActive: boolean;
  session: SessionInfo | undefined;
  worktrees: { record: { id: string; branch: string } }[];
  workingBySessionId: Record<string, boolean>;
  onSelect: () => void;
}

function SwitcherRow({
  isActive,
  session,
  worktrees,
  workingBySessionId,
  onSelect,
}: SwitcherRowProps) {
  // Pure frontend join: focused session's worktreeId → registry branch chip.
  const branch = session?.worktreeId
    ? worktrees.find((w) => w.record.id === session.worktreeId)?.record.branch
    : undefined;
  const isWorking = session ? (workingBySessionId[session.id] ?? false) : false;

  return (
    <button
      type="button"
      className={`terminal-pane-header-switcher-row${isActive ? " active" : ""}`}
      onClick={onSelect}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span
        className={`terminal-pane-header-working-dot${isWorking ? " working" : ""}`}
        aria-hidden="true"
      />
      <span className="terminal-pane-header-switcher-title">
        {sessionDisplayTitle(session)}
      </span>
      {branch && <span className="terminal-pane-header-switcher-branch">{branch}</span>}
    </button>
  );
}
