import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  Search,
  TerminalSquare,
  Folder,
  GitBranch,
  FolderGit2,
} from "lucide-react";
import { useTerminalStore } from "../../store/terminalStore";
import "./WorkspaceLauncherModal.css";

interface LauncherItem {
  id: string;
  category: "ACTIONS" | "RECENT PROJECTS";
  title: string;
  subtitle?: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  shortcut?: string;
  onSelect: () => void | Promise<void>;
}

export function WorkspaceLauncherModal(): React.ReactElement | null {
  const isOpen = useTerminalStore((s) => s.isWorkspaceLauncherOpen);
  const closeLauncher = useTerminalStore((s) => s.closeWorkspaceLauncher);
  const createTab = useTerminalStore((s) => s.createTab);

  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const isMac = typeof navigator !== "undefined" && /(Mac|iPhone|iPod|iPad)/i.test(navigator.userAgent);
  const modKey = isMac ? "⌘" : "Ctrl+";

  const allItems: LauncherItem[] = useMemo(() => [
    {
      id: "action-new-empty",
      category: "ACTIONS",
      title: "New Empty Workspace",
      subtitle: "Start a fresh terminal session",
      icon: TerminalSquare,
      shortcut: "↵",
      onSelect: () => {
        void createTab();
        closeLauncher();
      },
    },
    {
      id: "action-open-folder",
      category: "ACTIONS",
      title: "Open Local Project Folder...",
      subtitle: "Select a folder from your filesystem",
      icon: Folder,
      shortcut: `${modKey}O`,
      onSelect: () => {
        void createTab();
        closeLauncher();
      },
    },
    {
      id: "action-clone-repo",
      category: "ACTIONS",
      title: "Clone Git Repository...",
      subtitle: "Clone from GitHub, GitLab, or URL",
      icon: GitBranch,
      shortcut: `${modKey}G`,
      onSelect: () => {
        void createTab();
        closeLauncher();
      },
    },
    {
      id: "recent-oppa",
      category: "RECENT PROJECTS",
      title: "oppa",
      subtitle: "D:/oppa/oppa",
      icon: FolderGit2,
      onSelect: () => {
        void createTab();
        closeLauncher();
      },
    },
    {
      id: "recent-frontend-core",
      category: "RECENT PROJECTS",
      title: "frontend-core",
      subtitle: "~/dev/frontend-core",
      icon: Folder,
      onSelect: () => {
        void createTab();
        closeLauncher();
      },
    },
    {
      id: "recent-terminal-engine",
      category: "RECENT PROJECTS",
      title: "terminal-engine",
      subtitle: "~/projects/terminal-engine",
      icon: Folder,
      onSelect: () => {
        void createTab();
        closeLauncher();
      },
    },
  ], [createTab, closeLauncher, modKey]);

  const filteredItems = useMemo(() => {
    if (!query.trim()) return allItems;
    const q = query.toLowerCase();
    return allItems.filter(
      (item) =>
        item.title.toLowerCase().includes(q) ||
        (item.subtitle && item.subtitle.toLowerCase().includes(q))
    );
  }, [allItems, query]);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [isOpen]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeLauncher();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, closeLauncher]);

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filteredItems.length > 0) {
        setSelectedIndex((prev) => (prev + 1) % filteredItems.length);
      }
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filteredItems.length > 0) {
        setSelectedIndex((prev) => (prev - 1 + filteredItems.length) % filteredItems.length);
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      const selected = filteredItems[selectedIndex];
      if (selected) {
        selected.onSelect();
      }
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="launcher-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeLauncher();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Workspace and Project Selector"
    >
      <div className="launcher-card">
        <div className="launcher-search-row">
          <Search size={16} className="launcher-search-icon" />
          <input
            ref={inputRef}
            type="text"
            className="launcher-search-input"
            placeholder="Search or select workspace, project, or command..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleInputKeyDown}
          />
          <kbd className="launcher-esc-badge" onClick={closeLauncher}>
            ESC
          </kbd>
        </div>

        <div className="launcher-list" role="listbox">
          {filteredItems.length === 0 ? (
            <div className="launcher-empty">No matching workspaces or actions</div>
          ) : (
            filteredItems.map((item, idx) => {
              const isSelected = idx === selectedIndex;
              const Icon = item.icon;
              const prevItem = filteredItems[idx - 1];
              const showCategory = !prevItem || prevItem.category !== item.category;

              return (
                <React.Fragment key={item.id}>
                  {showCategory && (
                    <div className="launcher-category-header">{item.category}</div>
                  )}
                  <div
                    role="option"
                    aria-selected={isSelected}
                    className={`launcher-item ${isSelected ? "selected" : ""}`}
                    onClick={() => item.onSelect()}
                    onMouseEnter={() => setSelectedIndex(idx)}
                  >
                    <div className="launcher-item-left">
                      <div className="launcher-item-icon">
                        <Icon size={16} />
                      </div>
                      <div className="launcher-item-info">
                        <span className="launcher-item-title">{item.title}</span>
                        {item.subtitle && (
                          <span className="launcher-item-subtitle">{item.subtitle}</span>
                        )}
                      </div>
                    </div>
                    {item.shortcut && (
                      <kbd className="launcher-item-shortcut">{item.shortcut}</kbd>
                    )}
                  </div>
                </React.Fragment>
              );
            })
          )}
        </div>

        <div className="launcher-footer">
          <span className="launcher-footer-hint">
            <kbd>↑</kbd> <kbd>↓</kbd> to navigate
          </span>
          <span className="launcher-footer-hint">
            <kbd>↵</kbd> to select
          </span>
          <span className="launcher-footer-hint">
            <kbd>ESC</kbd> to close
          </span>
        </div>
      </div>
    </div>
  );
}
