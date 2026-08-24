import React, { useEffect, useRef, useState } from "react";
import {
  FilePlus,
  FolderPlus,
  BookOpen,
  ExternalLink,
  Monitor,
  ClipboardCopy,
  ChevronRight,
} from "lucide-react";
import type { FileEntry, EditorApp } from "../../lib/fs/transport";

export interface FileContextMenuState {
  x: number;
  y: number;
  // null = blank area below the tree
  entry: FileEntry | null;
}

interface FileContextMenuProps {
  state: FileContextMenuState | null;
  rootPath: string;
  editors: EditorApp[];
  onClose: () => void;
  onNewFile: (parentDir: string) => void;
  onNewFolder: (parentDir: string) => void;
  onOpenInEditor: (path: string) => void;
  onOpenWith: (path: string, app?: string) => void;
  onCopyPath: (path: string) => void;
}

const MENU_WIDTH = 210;

// VS Code-style icon+label menu; keeps all positioning/closing logic here so
// FileExplorer only supplies actions.
export function FileContextMenu({
  state,
  rootPath,
  editors,
  onClose,
  onNewFile,
  onNewFolder,
  onOpenInEditor,
  onOpenWith,
  onCopyPath,
}: FileContextMenuProps): React.ReactElement | null {
  const menuRef = useRef<HTMLDivElement>(null);
  const [openVia, setOpenVia] = useState(false);

  useEffect(() => {
    setOpenVia(false);
    if (!state) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [state, onClose]);

  if (!state) return null;

  const target = state.entry;
  const creationParent = target?.is_dir ? target.path : rootPath;

  interface MenuItemSpec {
    label: string;
    icon: React.ReactNode;
    action?: () => void;
    submenu?: boolean;
  }

  const items: MenuItemSpec[] = [
    ...(target === null || target.is_dir
      ? [
          {
            label: "New File",
            icon: <FilePlus size={14} />,
            action: () => onNewFile(creationParent),
          },
          {
            label: "New Folder",
            icon: <FolderPlus size={14} />,
            action: () => onNewFolder(creationParent),
          },
        ]
      : [
          {
            label: "Open in Editor",
            icon: <BookOpen size={14} />,
            action: () => onOpenInEditor(target.path),
          },
          {
            label: "Open via",
            icon: (
              <span className="file-context-menu-label-with-chevron">
                <ExternalLink size={14} />
              </span>
            ),
            submenu: true,
          },
        ]),
    ...(target !== null
      ? [
          {
            label: "Copy as Path",
            icon: <ClipboardCopy size={14} />,
            action: () => onCopyPath(target.path),
          },
        ]
      : []),
  ];

  const clampedX = Math.max(0, Math.min(state.x, window.innerWidth - MENU_WIDTH - 8));
  const clampedY = Math.max(0, Math.min(state.y, window.innerHeight - 180));

  return (
    <div
      ref={menuRef}
      className="file-context-menu"
      role="menu"
      style={{ left: clampedX, top: clampedY }}
    >
      {items.map((item) =>
        item.submenu ? (
          <div key={item.label} className="file-context-menu-submenu-anchor">
            <button
              type="button"
              role="menuitem"
              aria-haspopup="true"
              aria-expanded={openVia}
              className="file-context-menu-item"
              onClick={() => setOpenVia((v) => !v)}
              onMouseEnter={() => setOpenVia(true)}
            >
              <span className="file-context-menu-icon">{item.icon}</span>
              <span className="file-context-menu-text">{item.label}</span>
              <ChevronRight size={12} className="file-context-menu-chevron" />
            </button>
            {openVia && (
              <div className="file-context-submenu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="file-context-menu-item"
                  onClick={() => {
                    onOpenWith(target!.path);
                    onClose();
                  }}
                >
                  <span className="file-context-menu-icon">
                    <Monitor size={14} />
                  </span>
                  <span className="file-context-menu-text">System Default</span>
                </button>
                {editors.map((app) => (
                  <button
                    key={app.command}
                    type="button"
                    role="menuitem"
                    className="file-context-menu-item"
                    onClick={() => {
                      onOpenWith(target!.path, app.command);
                      onClose();
                    }}
                  >
                    <span className="file-context-menu-icon">
                      <ExternalLink size={14} />
                    </span>
                    <span className="file-context-menu-text">{app.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className="file-context-menu-item"
            onClick={() => {
              item.action?.();
              onClose();
            }}
          >
            <span className="file-context-menu-icon">{item.icon}</span>
            <span className="file-context-menu-text">{item.label}</span>
          </button>
        ),
      )}
    </div>
  );
}
