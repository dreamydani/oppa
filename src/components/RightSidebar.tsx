import React, { useEffect, useState, useCallback } from "react";
import { useTerminalStore } from "../store/terminalStore";
import { readDir, FileEntry } from "../lib/fs/transport";
import {
  FolderIcon,
  FileIcon,
  PanelRightIcon,
} from "./icons/MinimalIcons";

const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 480;

interface FileExplorerProps {
  refreshKey?: number;
}

interface TreeNodeProps {
  entry: FileEntry;
  depth: number;
  expandedPaths: Set<string>;
  dirChildren: Record<string, FileEntry[]>;
  onToggleDir: (dirPath: string) => void;
}

function FileTreeNode({
  entry,
  depth,
  expandedPaths,
  dirChildren,
  onToggleDir,
}: TreeNodeProps): React.ReactElement {
  const isExpanded = expandedPaths.has(entry.path);
  const children = dirChildren[entry.path] ?? [];

  return (
    <div className="file-tree-node">
      <div
        className="file-tree-item"
        style={{ paddingLeft: `${depth * 14 + 10}px` }}
        onClick={() => {
          if (entry.is_dir) {
            onToggleDir(entry.path);
          }
        }}
        role="treeitem"
        aria-expanded={entry.is_dir ? isExpanded : undefined}
      >
        <span className="file-tree-icon">
          {entry.is_dir ? (
            <FolderIcon size={14} />
          ) : (
            <FileIcon size={14} />
          )}
        </span>
        <span className="file-tree-name" title={entry.name}>
          {entry.name}
        </span>
      </div>

      {entry.is_dir && isExpanded && (
        <div className="file-tree-children">
          {children.map((child) => (
            <FileTreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              expandedPaths={expandedPaths}
              dirChildren={dirChildren}
              onToggleDir={onToggleDir}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function RightSidebar({ refreshKey = 0 }: FileExplorerProps): React.ReactElement | null {
  const rightSidebarWidth = useTerminalStore((s) => s.rightSidebarWidth);
  const setRightSidebarWidth = useTerminalStore((s) => s.setRightSidebarWidth);
  const toggleRightSidebar = useTerminalStore((s) => s.toggleRightSidebar);
  const getActiveCwd = useTerminalStore((s) => s.getActiveCwd);
  const cwd = getActiveCwd();

  const [rootEntries, setRootEntries] = useState<FileEntry[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [dirChildren, setDirChildren] = useState<Record<string, FileEntry[]>>({});
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const loadRoot = useCallback(async (dirPath: string) => {
    setLoading(true);
    setError(null);
    try {
      const entries = await readDir(dirPath);
      setRootEntries(entries);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!cwd) {
      setRootEntries([]);
      setExpandedPaths(new Set());
      setDirChildren({});
      return;
    }
    void loadRoot(cwd);
  }, [cwd, refreshKey, loadRoot]);

  const handleToggleDir = useCallback(
    async (dirPath: string) => {
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(dirPath)) {
          next.delete(dirPath);
        } else {
          next.add(dirPath);
        }
        return next;
      });

      if (!dirChildren[dirPath]) {
        try {
          const subEntries = await readDir(dirPath);
          setDirChildren((prev) => ({ ...prev, [dirPath]: subEntries }));
        } catch {
          setDirChildren((prev) => ({ ...prev, [dirPath]: [] }));
        }
      }
    },
    [dirChildren]
  );

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = rightSidebarWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const delta = startX - moveEvent.clientX;
      const nextWidth = Math.max(
        MIN_SIDEBAR_WIDTH,
        Math.min(MAX_SIDEBAR_WIDTH, startWidth + delta)
      );
      setRightSidebarWidth(nextWidth);
    };

    const handleMouseUp = () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
  };

  return (
    <aside className="right-sidebar" style={{ width: rightSidebarWidth }}>
      <div
        className="resize-handle-left"
        onMouseDown={handleMouseDown}
        role="separator"
        aria-orientation="vertical"
      />
      <div className="right-sidebar-header">
        <div className="right-sidebar-title">
          <FolderIcon size={14} className="right-sidebar-header-icon" />
          <span>File Explorer</span>
        </div>
        <button
          type="button"
          className="right-sidebar-icon-btn"
          title="Collapse File Explorer"
          aria-label="Collapse File Explorer"
          onClick={toggleRightSidebar}
        >
          <PanelRightIcon size={14} />
        </button>
      </div>

      <div className="right-sidebar-content">
        {!cwd ? (
          <div className="empty-state">No active workspace directory</div>
        ) : loading && rootEntries.length === 0 ? (
          <div className="loading-state">Loading files...</div>
        ) : error ? (
          <div className="empty-state">{error}</div>
        ) : rootEntries.length === 0 ? (
          <div className="empty-state">Empty directory</div>
        ) : (
          <div className="file-tree" role="tree">
            {rootEntries.map((entry) => (
              <FileTreeNode
                key={entry.path}
                entry={entry}
                depth={0}
                expandedPaths={expandedPaths}
                dirChildren={dirChildren}
                onToggleDir={handleToggleDir}
              />
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
