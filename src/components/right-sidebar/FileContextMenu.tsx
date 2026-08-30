import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
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

export const CONTEXT_MENU_MARGIN = 8;
const SUBMENU_GAP = 2;
// Fallbacks for environments where layout measurement returns zero rects
const MENU_HEIGHT_ESTIMATE = 120;
const SUBMENU_WIDTH = 170;
const SUBMENU_HEIGHT_ESTIMATE = 100;

export interface MenuBoundsInput {
  clickX: number;
  clickY: number;
  menuW: number;
  menuH: number;
  submenuW: number;
  submenuH: number;
  viewportW: number;
  viewportH: number;
}

export interface MenuPosition {
  x: number;
  y: number;
  submenuSide: "left" | "right";
  submenuOffsetY: number;
}

/**
 * Where a menu should appear to grow *from*.
 *
 * The entrance scales up from a corner, and the corner has to be the one the
 * click actually landed on or the animation implies a cursor position the user
 * never had. computeMenuPosition clamps rather than flips, so "was it clamped"
 * is exactly the signal: a menu pushed left hugs its right edge, one pushed up
 * hugs its bottom.
 */
export function menuTransformOrigin(
  clickX: number,
  clickY: number,
  pos: Pick<MenuPosition, "x" | "y">,
): string {
  const x = pos.x < clickX ? "right" : "left";
  const y = pos.y < clickY ? "bottom" : "top";
  return `${y} ${x}`;
}

// Pure viewport math so flipping/clamping stays unit-testable without layout
export function computeMenuPosition(input: MenuBoundsInput): MenuPosition {
  const {
    clickX,
    clickY,
    menuW,
    menuH,
    submenuW,
    submenuH,
    viewportW,
    viewportH,
  } = input;
  const m = CONTEXT_MENU_MARGIN;

  const x = Math.max(0, Math.min(clickX, viewportW - menuW - m));
  const y = Math.max(
    0,
    clickY + menuH + m > viewportH ? viewportH - menuH - m : clickY,
  );

  // Prefer the natural right side; only flip left when the flip fully fits
  const rightSubmenuLeft = x + menuW + SUBMENU_GAP;
  const fitsRight = rightSubmenuLeft + submenuW + m <= viewportW;
  const leftSubmenuRight = x - SUBMENU_GAP;
  const fitsLeft = leftSubmenuRight - submenuW - m >= 0;
  const submenuSide = fitsRight || !fitsLeft ? "right" : "left";

  // Slide the submenu up just enough to keep its bottom inside the viewport
  let submenuOffsetY = 0;
  if (y + submenuH + m > viewportH) {
    submenuOffsetY = Math.max(viewportH - submenuH - m - y, -y);
  }

  return { x, y, submenuSide, submenuOffsetY };
}

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
  const [pos, setPos] = useState<MenuPosition | null>(null);

  // Re-measure whenever the menu or submenu opens so flipping uses real sizes
  const measure = useCallback(() => {
    if (!state || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const submenu = menuRef.current.querySelector<HTMLElement>(".file-context-submenu");
    const subRect = submenu?.getBoundingClientRect();
    setPos(
      computeMenuPosition({
        clickX: state.x,
        clickY: state.y,
        menuW: rect.width || MENU_WIDTH,
        menuH: rect.height || MENU_HEIGHT_ESTIMATE,
        submenuW: subRect?.width || SUBMENU_WIDTH,
        submenuH: subRect?.height || SUBMENU_HEIGHT_ESTIMATE,
        viewportW: window.innerWidth,
        viewportH: window.innerHeight,
      }),
    );
  }, [state]);

  useLayoutEffect(() => {
    setPos(null);
    measure();
  }, [measure]);

  useLayoutEffect(() => {
    if (openVia) measure();
  }, [openVia, measure]);

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
    const handleResize = () => onClose();
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", handleResize);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", handleResize);
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

  return (
    <div
      ref={menuRef}
      className="file-context-menu"
      role="menu"
      // Gated on the measurement: the node first renders `visibility: hidden`
      // while its size is measured, and an animation started there would be
      // partly spent before the menu is ever on screen. Setting the attribute
      // once the position lands is what kicks the entrance off.
      data-motion={pos ? "menu" : undefined}
      style={{
        left: pos?.x ?? state.x,
        top: pos?.y ?? state.y,
        visibility: pos ? "visible" : "hidden",
        transformOrigin: menuTransformOrigin(state.x, state.y, pos ?? state),
      }}
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
              <div
                className={`file-context-submenu${pos?.submenuSide === "left" ? " file-context-submenu--left" : ""}`}
                role="menu"
                // Fade, not scale: the inline translateY below is the
                // submenu's vertical alignment, and a transform-based
                // entrance would override it. See motion.css.
                data-motion="fade"
                style={{ transform: `translateY(${pos?.submenuOffsetY ?? 0}px)` }}
              >
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
