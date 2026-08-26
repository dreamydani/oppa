import React, { useEffect, useState, useCallback } from "react";
import { Folder, FolderOpen, File, ChevronRight, ChevronDown } from "lucide-react";
import { useTerminalStore } from "../../store/terminalStore";
import {
  readDir,
  createFile,
  createDir,
  detectEditors,
  openWith,
  FileEntry,
} from "../../lib/fs/transport";
import { FileContextMenu, FileContextMenuState } from "./FileContextMenu";

interface FileExplorerProps {
  refreshKey?: number;
}

interface TreeNodeProps {
  entry: FileEntry;
  depth: number;
  expandedPaths: Set<string>;
  dirChildren: Record<string, FileEntry[]>;
  activeEditorPath: string | null;
  selectedRowPath: string | null;
  creation: CreationState | null;
  renderNewNodeInput: (depth: number) => React.ReactNode;
  onToggleDir: (dirPath: string) => void;
  onOpenFile: (filePath: string) => void;
  onContextMenuRow: (e: React.MouseEvent, entry: FileEntry) => void;
}

// Children are lazy-loaded per expand, so total DOM is bounded by what the
// user opens; this caps any single directory (node_modules-scale listings)
// behind a "show more" toggle instead of virtualizing the whole tree.
const MAX_VISIBLE_CHILDREN = 200;

// Windows cwds use backslashes; keep new-child paths consistent with the parent
function joinChildPath(parentDir: string, name: string): string {
  const sep = parentDir.includes("\\") ? "\\" : "/";
  return /[\\/]$/.test(parentDir) ? `${parentDir}${name}` : `${parentDir}${sep}${name}`;
}

type CreationKind = "file" | "dir";

interface CreationState {
  parentDir: string;
  kind: CreationKind;
}

function FileTreeNode({
  entry,
  depth,
  expandedPaths,
  dirChildren,
  activeEditorPath,
  selectedRowPath,
  creation,
  renderNewNodeInput,
  onToggleDir,
  onOpenFile,
  onContextMenuRow,
}: TreeNodeProps): React.ReactElement {
  const isExpanded = expandedPaths.has(entry.path);
  const [revealAll, setRevealAll] = useState(false);
  // Editor selection applies to files only; right-click highlights any row
  const isSelected =
    (!entry.is_dir && activeEditorPath === entry.path) || selectedRowPath === entry.path;
  const children = dirChildren[entry.path] ?? [];
  const capped = entry.is_dir && !revealAll && children.length > MAX_VISIBLE_CHILDREN;
  const visibleChildren = capped
    ? children.slice(0, MAX_VISIBLE_CHILDREN)
    : children;

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
        onContextMenu={(e) => onContextMenuRow(e, entry)}
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
          {visibleChildren.map((child) => (
            <FileTreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              expandedPaths={expandedPaths}
              dirChildren={dirChildren}
              activeEditorPath={activeEditorPath}
              selectedRowPath={selectedRowPath}
              creation={creation}
              renderNewNodeInput={renderNewNodeInput}
              onToggleDir={onToggleDir}
              onOpenFile={onOpenFile}
              onContextMenuRow={onContextMenuRow}
            />
          ))}
          {capped && (
            <button
              type="button"
              className="file-tree-item file-tree-show-more"
              style={{ paddingLeft: `${(depth + 1) * 14 + 8}px` }}
              onClick={(e) => {
                e.stopPropagation();
                setRevealAll(true);
              }}
            >
              Show {children.length - MAX_VISIBLE_CHILDREN} more
            </button>
          )}
          {creation?.parentDir === entry.path ? renderNewNodeInput(depth + 1) : null}
        </div>
      )}
    </div>
  );
}

function NewNodeInput({
  depth,
  kind,
  value,
  error,
  onChange,
  onKeyDown,
  onBlur,
}: {
  depth: number;
  kind: CreationKind;
  value: string;
  error: string | null;
  onChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onBlur: () => void;
}): React.ReactElement {
  return (
    <div className="file-tree-item file-tree-new-row" style={{ paddingLeft: `${depth * 14 + 8}px` }}>
      <span className="file-tree-icon">
        {kind === "file" ? <File size={14} /> : <Folder size={14} />}
      </span>
      <input
        autoFocus
        type="text"
        className="file-tree-new-input"
        aria-label={kind === "file" ? "New file name" : "New folder name"}
        placeholder={kind === "file" ? "File name" : "Folder name"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      />
      {error && <span className="file-create-error">{error}</span>}
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

  const [menu, setMenu] = useState<FileContextMenuState | null>(null);
  const [selectedRowPath, setSelectedRowPath] = useState<string | null>(null);
  const [editors, setEditors] = useState<Awaited<ReturnType<typeof detectEditors>>>([]);
  const [creation, setCreation] = useState<CreationState | null>(null);
  const [creationName, setCreationName] = useState("");
  const [creationError, setCreationError] = useState<string | null>(null);

  useEffect(() => {
    void detectEditors().then(setEditors);
  }, []);

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

  // Re-read a directory and refresh whichever cache holds it (root or nested)
  const refreshDir = useCallback(
    async (dirPath: string) => {
      let entries: FileEntry[] = [];
      try {
        entries = await readDir(dirPath);
      } catch {
        entries = [];
      }
      if (!cwd || dirPath === cwd) {
        setRootEntries(entries);
      } else {
        setDirChildren((prev) => ({ ...prev, [dirPath]: entries }));
      }
      setExpandedPaths((prev) => new Set(prev).add(dirPath));
    },
    [cwd]
  );

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

  const closeMenu = useCallback(() => {
    setMenu(null);
    setSelectedRowPath(null);
  }, []);

  const handleContextMenuBlank = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setCreation(null);
    setSelectedRowPath(null);
    setMenu({ x: e.clientX, y: e.clientY, entry: null });
  }, []);

  const handleContextMenuRow = useCallback((e: React.MouseEvent, entry: FileEntry) => {
    e.preventDefault();
    e.stopPropagation();
    setCreation(null);
    setSelectedRowPath(entry.path);
    setMenu({ x: e.clientX, y: e.clientY, entry });
  }, []);

  // Expand without toggling so creation inside a closed folder works predictably
  const ensureDirOpen = useCallback(
    async (dirPath: string) => {
      setExpandedPaths((prev) => new Set(prev).add(dirPath));
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

  const beginCreation = useCallback(
    (kind: CreationKind, parentDir: string) => {
      setMenu(null);
      if (parentDir !== cwd) {
        void ensureDirOpen(parentDir);
      }
      setCreation({ parentDir, kind });
      setCreationName("");
      setCreationError(null);
    },
    [cwd, ensureDirOpen]
  );

  const commitCreation = useCallback(async () => {
    if (!creation) return;
    const name = creationName.trim();
    if (!name) {
      setCreation(null);
      return;
    }

    const siblings = dirChildren[creation.parentDir] ??
      (creation.parentDir === cwd ? rootEntries : []);
    if (siblings.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
      setCreationError(`${name} already exists`);
      return;
    }

    const targetPath = joinChildPath(creation.parentDir, name);
    const ok =
      creation.kind === "file"
        ? await createFile(targetPath).then(() => true)
        : await createDir(targetPath);
    if (!ok) {
      setCreationError(`Could not create ${name}`);
      return;
    }

    setCreation(null);
    setSelectedRowPath(targetPath);
    await refreshDir(creation.parentDir);
  }, [creation, creationName, dirChildren, cwd, rootEntries, refreshDir]);

  const handleCreationKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void commitCreation();
      } else if (e.key === "Escape") {
        e.preventDefault();
        setCreation(null);
      }
    },
    [commitCreation]
  );

  const renderCreationRow = (depth: number): React.ReactElement | null =>
    creation ? (
      <NewNodeInput
        depth={depth}
        kind={creation.kind}
        value={creationName}
        error={creationError}
        onChange={setCreationName}
        onKeyDown={handleCreationKeyDown}
        onBlur={() => void commitCreation()}
      />
    ) : null;

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
    <div className="file-explorer" onContextMenu={handleContextMenuBlank}>
      <div className="file-tree" role="tree">
        {rootEntries.map((entry) => (
          <FileTreeNode
            key={entry.path}
            entry={entry}
            depth={0}
            expandedPaths={expandedPaths}
            dirChildren={dirChildren}
            activeEditorPath={activeEditorPath}
            selectedRowPath={selectedRowPath}
            creation={creation}
            renderNewNodeInput={renderCreationRow}
            onToggleDir={handleToggleDir}
            onOpenFile={handleOpenFile}
            onContextMenuRow={handleContextMenuRow}
          />
        ))}
        {/* Root-level creation row renders after existing entries */}
        {creation?.parentDir === cwd ? renderCreationRow(0) : null}
      </div>

      <FileContextMenu
        state={menu}
        rootPath={cwd}
        editors={editors}
        onClose={closeMenu}
        onNewFile={(parentDir) => beginCreation("file", parentDir)}
        onNewFolder={(parentDir) => beginCreation("dir", parentDir)}
        onOpenInEditor={handleOpenFile}
        onOpenWith={(path, app) => void openWith(path, app)}
        onCopyPath={(path) => void navigator.clipboard.writeText(path)}
      />
    </div>
  );
}
