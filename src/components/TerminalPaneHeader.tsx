import { useState, useRef, useEffect, useCallback } from "react";
import {
  MoreHorizontal,
  Maximize2,
  Minimize2,
  SplitSquareHorizontal,
  SplitSquareVertical,
  X,
} from "lucide-react";
import { useTerminalStore } from "../store/terminalStore";
import type { Path } from "../lib/pane-manager/layout";
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

  const isMaximized = maximizedSessionId === id;
  const displayTitle = session?.title || "oppa";

  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(displayTitle);
  const [isMenuOpen, setIsMenuOpen] = useState(false);

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
        {isEditing ? (
          <input
            ref={inputRef}
            className="terminal-pane-header-rename-input"
            value={editTitle}
            onChange={(e) => setEditTitle(e.target.value)}
            onBlur={handleSave}
            onKeyDown={handleKeyDown}
          />
        ) : (
          <span
            className="terminal-pane-header-title"
            title="Click to rename pane"
            onClick={startRename}
          >
            {displayTitle}
          </span>
        )}
      </div>

      <div className="terminal-pane-header-right">
        <button
          ref={moreBtnRef}
          className={`terminal-pane-header-btn ${isMenuOpen ? "active" : ""}`}
          title="More Options"
          aria-label="More Options"
          onClick={() => setIsMenuOpen((prev) => !prev)}
        >
          <MoreHorizontal size={14} />
        </button>

        {isMenuOpen && (
          <div ref={menuRef} className="terminal-pane-header-menu">
            <button
              className="terminal-pane-header-menu-item"
              onClick={() => {
                onClear?.();
                setIsMenuOpen(false);
              }}
            >
              Clear Scrollback
            </button>
            <button
              className="terminal-pane-header-menu-item"
              onClick={() => {
                setIsMenuOpen(false);
                startRename();
              }}
            >
              Rename Pane
            </button>
            <button
              className="terminal-pane-header-menu-item"
              onClick={() => {
                setIsMenuOpen(false);
                void splitPane("h", path);
              }}
            >
              Split Right
            </button>
            <button
              className="terminal-pane-header-menu-item"
              onClick={() => {
                setIsMenuOpen(false);
                void splitPane("v", path);
              }}
            >
              Split Down
            </button>
          </div>
        )}

        <button
          className="terminal-pane-header-btn"
          title={isMaximized ? "Restore Pane" : "Maximize Pane"}
          aria-label={isMaximized ? "Restore Pane" : "Maximize Pane"}
          onClick={() => toggleMaximizePane(id)}
        >
          {isMaximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>

        <button
          className="terminal-pane-header-btn"
          title="Split Right"
          aria-label="Split Right"
          onClick={() => void splitPane("h", path)}
        >
          <SplitSquareHorizontal size={14} />
        </button>

        <button
          className="terminal-pane-header-btn"
          title="Split Down"
          aria-label="Split Down"
          onClick={() => void splitPane("v", path)}
        >
          <SplitSquareVertical size={14} />
        </button>

        <button
          className="terminal-pane-header-btn close-btn"
          title="Close Pane"
          aria-label="Close Pane"
          onClick={() => void closePane(path)}
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}
