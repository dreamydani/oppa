import { useState, useRef, useEffect, useCallback } from "react";
import {
  MoreHorizontal,
  Maximize2,
  Minimize2,
  SplitSquareHorizontal,
  SplitSquareVertical,
  Globe,
  X,
} from "lucide-react";
import { useTerminalStore } from "../store/terminalStore";
import type { Path } from "../lib/pane-manager/layout";
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

export function TerminalPaneHeader({ id, path, onClear }: TerminalPaneHeaderProps) {
  const session = useTerminalStore((s) => s.sessions[id]);
  const renameSession = useTerminalStore((s) => s.renameSession);
  const maximizedSessionId = useTerminalStore((s) => s.maximizedSessionId);
  const toggleMaximizePane = useTerminalStore((s) => s.toggleMaximizePane);
  const splitPane = useTerminalStore((s) => s.splitPane);
  const closePane = useTerminalStore((s) => s.closePane);
  const focusPane = useTerminalStore((s) => s.focusPane);
  const movePane = useTerminalStore((s) => s.movePane);
  const setAppMode = useTerminalStore((s) => s.setAppMode);
  const navigateBrowser = useTerminalStore((s) => s.navigateBrowser);
  const detectedPorts = useTerminalStore((s) => s.detectedPorts);

  const isMaximized = maximizedSessionId === id;
  const displayTitle =
    session?.title && session.title !== session.id && !session.title.startsWith("s-")
      ? session.title
      : session?.cwd
        ? session.cwd.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "terminal"
        : session?.title || "terminal";

  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(displayTitle);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isDraggingLocal, setIsDraggingLocal] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);

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

  return (
    <div className="terminal-pane-header">
      <div className="terminal-pane-header-left">
        <span className="terminal-pane-dot" />
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
          <MoreHorizontal size={12} strokeWidth={1.5} />
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
          <Globe size={12} strokeWidth={1.5} />
        </button>

        <button
          className="terminal-pane-header-btn"
          title={isMaximized ? "Restore Pane" : "Maximize Pane"}
          aria-label={isMaximized ? "Restore Pane" : "Maximize Pane"}
          onClick={() => toggleMaximizePane(id)}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {isMaximized ? (
            <Minimize2 size={12} strokeWidth={1.5} />
          ) : (
            <Maximize2 size={12} strokeWidth={1.5} />
          )}
        </button>

        <button
          className="terminal-pane-header-btn"
          title="Split Right"
          aria-label="Split Right"
          onClick={() => void splitPane("h", path)}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <SplitSquareHorizontal size={12} strokeWidth={1.5} />
        </button>

        <button
          className="terminal-pane-header-btn"
          title="Split Down"
          aria-label="Split Down"
          onClick={() => void splitPane("v", path)}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <SplitSquareVertical size={12} strokeWidth={1.5} />
        </button>

        <button
          className="terminal-pane-header-btn close-btn"
          title="Close Pane"
          aria-label="Close Pane"
          onClick={() => void closePane(path)}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <X size={12} strokeWidth={1.5} />
        </button>
      </div>
    </div>
  );
}
