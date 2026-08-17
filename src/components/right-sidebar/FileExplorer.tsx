import React, { useEffect, useState, useCallback } from "react";
import { Folder, FolderOpen, File, ChevronRight, ChevronDown } from "lucide-react";
import { useTerminalStore } from "../../store/terminalStore";
import { readDir, FileEntry } from "../../lib/fs/transport";

interface FileExplorerProps {
  refreshKey?: number;
}

interface TreeNodeProps {
  entry: FileEntry;
  depth: number;
  expandedPaths: Set<string>;
  dirChildren: Record<string, FileEntry[]>;
  activeEditorPath: string | null;
  onToggleDir: (dirPath: string) => void;
  onOpenFile: (filePath: string) => void;
}

function FileTreeNode({
  entry,
  depth,
  expandedPaths,
  dirChildren,
  activeEditorPath,
  onToggleDir,
  onOpenFile,
}: TreeNodeProps): React.ReactElement {
  const isExpanded = expandedPaths.has(entry.path);
  const isSelected = !entry.is_dir && activeEditorPath === entry.path;
  const children = dirChildren[entry.path] ?? [];

  return (
    <div className="file-tree-node">
      <div
        className={`file-tree-item ${isSelected ? "selected" : ""}`}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        onClick={() => {
          if (entry.is_dir) {
            onToggleDir(entry.path);
          } else {
            onOpenFile(entry.path);
          }
        }}
        role="treeitem"
        aria-expanded={entry.is_dir ? isExpanded : undefined}
      >
        <span className="file-tree-toggle">
          {entry.is_dir ? (
            isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />
          ) : null}
        </span>
        <span className="file-tree-icon">
          {entry.is_dir ? (
            isExpanded ? <FolderOpen size={14} /> : <Folder size={14} />
          ) : (
            <File size={14} />
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
              activeEditorPath={activeEditorPath}
              onToggleDir={onToggleDir}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileExplorer({ refreshKey = 0 }: FileExplorerProps): React.ReactElement {
  const activeCwd = useTerminalStore((s) => s.getActiveCwd());
  const sessions = useTerminalStore((s) => s.sessions);
  const activeEditorPath = useTerminalStore((s) => s.activeEditorPath);
  const openFileInEditor = useTerminalStore((s) => s.openFileInEditor);
  const setAppMode = useTerminalStore((s) => s.setAppMode);

  // Use active session cwd or fallback to any session cwd
  const cwd = activeCwd || Object.values(sessions).find((s) => Boolean(s?.cwd))?.cwd;

  const [rootEntries, setRootEntries] = useState<FileEntry[]>([]);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [dirChildren, setDirChildren] = useState<Record<string, FileEntry[]>>({});
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpenFile = useCallback(
    (filePath: string) => {
      void openFileInEditor(filePath);
      setAppMode("editor");
    },
    [openFileInEditor, setAppMode]
  );

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

  if (!cwd) {
    return <div className="empty-state">No active workspace directory</div>;
  }

  if (loading && rootEntries.length === 0) {
    return <div className="loading-state">Loading files...</div>;
  }

  if (error) {
    return <div className="empty-state">{error}</div>;
  }

  if (rootEntries.length === 0) {
    return <div className="empty-state">Empty directory</div>;
  }

  return (
    <div className="file-explorer">
      <div className="file-tree" role="tree">
        {rootEntries.map((entry) => (
          <FileTreeNode
            key={entry.path}
            entry={entry}
            depth={0}
            expandedPaths={expandedPaths}
            dirChildren={dirChildren}
            activeEditorPath={activeEditorPath}
            onToggleDir={handleToggleDir}
            onOpenFile={handleOpenFile}
          />
        ))}
      </div>
    </div>
  );
}
