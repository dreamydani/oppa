import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  FilePlus,
  FolderPlus,
  RefreshCw,
  FoldVertical,
} from "lucide-react";
import { useTerminalStore } from "../../store/terminalStore";
import {
  readDir,
  createFile,
  createDir,
  detectEditors,
  openWith,
  watchDir,
  unwatchDir,
  onFsChange,
  FileEntry,
  FsChangedPayload,
} from "../../lib/fs/transport";
import { FileContextMenu, FileContextMenuState } from "./FileContextMenu";
import { getFileVisual, getFolderColor, gitLetterClass, type GitLetter } from "./fileIcons";

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
  gitLetterByPath: Map<string, GitLetter>;
  dirtyDirs: Set<string>;
  renderNewNodeInput: (depth: number) => React.ReactNode;
  onToggleDir: (dirPath: string) => void;
  onOpenFile: (filePath: string) => void;
  onContextMenuRow: (e: React.MouseEvent, entry: FileEntry) => void;
}

// Children are lazy-loaded per expand, so total DOM is bounded by what the
// user opens; this caps any single directory (node_modules-scale listings)
// behind a "show more" toggle instead of virtualizing the whole tree.
const MAX_VISIBLE_CHILDREN = 200;

// Watcher events burst on bulk ops (git checkout, npm install); one refresh
// per burst keeps the tree live without thrashing readDir.
const FS_DEBOUNCE_MS = 200;

// Windows cwds use backslashes; keep new-child paths consistent with the parent
function joinChildPath(parentDir: string, name: string): string {
  const sep = parentDir.includes("\\") ? "\\" : "/";
  return /[\\/]$/.test(parentDir) ? `${parentDir}${name}` : `${parentDir}${sep}${name}`;
}

function parentDirOf(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx === -1 ? p : p.slice(0, idx) || p.slice(0, 1);
}

function baseNameOf(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx === -1 ? p : p.slice(idx + 1) || p;
}

function normalizeSlash(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
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
  gitLetterByPath,
  dirtyDirs,
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

  const gitLetter = !entry.is_dir ? gitLetterByPath.get(normalizeSlash(entry.path)) : undefined;
  const folderDirty = entry.is_dir && dirtyDirs.has(normalizeSlash(entry.path));

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
            isExpanded ? (
              <FolderOpen size={14} style={{ color: getFolderColor(entry.name) }} />
            ) : (
              <Folder size={14} style={{ color: getFolderColor(entry.name) }} />
            )
          ) : (
            (() => {
              const { Icon, color } = getFileVisual(entry.name);
              return <Icon size={14} style={{ color }} />;
            })()
          )}
        </span>
        <span
          className={`file-tree-name${gitLetter ? ` explorer-git-${gitLetter.toLowerCase()}` : ""}`}
          title={entry.name}
        >
          {entry.name}
        </span>
        {gitLetter && (
          <span className={`git-badge ${gitLetterClass(gitLetter)} explorer-git-badge`}>
            {gitLetter}
          </span>
        )}
        {folderDirty && <span className="explorer-dirty-dot" aria-hidden="true" />}
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
              gitLetterByPath={gitLetterByPath}
              dirtyDirs={dirtyDirs}
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
        {(() => {
          const { Icon, color } =
            kind === "file" ? getFileVisual(value || "new") : { Icon: Folder, color: getFolderColor(value || "new") };
          return <Icon size={14} style={{ color }} />;
        })()}
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
  const gitStatus = useTerminalStore((s) => s.gitStatus);
  const refreshGitStatus = useTerminalStore((s) => s.refreshGitStatus);

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

  // Tracks native watchers so collapse/cwd-switch releases handles.
  const watchedRef = useRef<Set<string>>(new Set());
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingDirsRef = useRef<Set<string>>(new Set());
  const stateRef = useRef({ cwd, expandedPaths, refreshGitStatus });
  stateRef.current = { cwd, expandedPaths, refreshGitStatus };

  useEffect(() => {
    void detectEditors().then(setEditors).catch(() => {});
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

  const safeWatch = useCallback(async (dir: string) => {
    if (watchedRef.current.has(dir)) return;
    try {
      await watchDir(dir);
      watchedRef.current.add(dir);
    } catch {}
  }, []);

  const safeUnwatch = useCallback(async (dir: string) => {
    if (!watchedRef.current.has(dir)) return;
    try {
      await unwatchDir(dir);
    } catch {}
    watchedRef.current.delete(dir);
  }, []);

  // Watch root; releases the old root on cwd switch/unmount.
  useEffect(() => {
    if (!cwd) return;
    void safeWatch(cwd);
    const root = cwd;
    return () => {
      void safeUnwatch(root);
    };
  }, [cwd, safeWatch, safeUnwatch]);

  // Watch every expanded dir; unwatch on collapse.
  useEffect(() => {
    for (const dir of expandedPaths) void safeWatch(dir);
    for (const watched of [...watchedRef.current]) {
      if (watched !== cwd && !expandedPaths.has(watched)) void safeUnwatch(watched);
    }
  }, [expandedPaths, cwd, safeWatch, safeUnwatch]);

  const flushPendingDirs = useCallback(async () => {
    const dirs = [...pendingDirsRef.current];
    pendingDirsRef.current.clear();
    if (dirs.length === 0) return;
    const { cwd: liveCwd, expandedPaths: liveExpanded, refreshGitStatus: liveGit } =
      stateRef.current;
    await Promise.all(
      dirs.map(async (dir) => {
        if (dir !== liveCwd && !liveExpanded.has(dir)) return;
        try {
          const entries = await readDir(dir);
          if (dir === liveCwd) setRootEntries(entries);
          else setDirChildren((prev) => ({ ...prev, [dir]: entries }));
        } catch {}
      })
    );
    // New untracked files never fire git-changed; piggyback the fs burst.
    if (liveCwd) void liveGit(liveCwd).catch(() => {});
  }, []);

  const queueFsRefresh = useCallback(
    (payload: FsChangedPayload) => {
      const { cwd: liveCwd } = stateRef.current;
      if (!liveCwd) return;
      const dir = payload.dir || liveCwd;
      pendingDirsRef.current.add(dir);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => void flushPendingDirs(), FS_DEBOUNCE_MS);
    },
    [flushPendingDirs]
  );

  // Live watcher subscription; tolerates the vitest mock lacking it.
  useEffect(() => {
    let dispose: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const maybeListen = onFsChange as unknown as
          | ((cb: (p: FsChangedPayload) => void) => Promise<unknown>)
          | undefined;
        if (typeof maybeListen !== "function") return;
        const unlisten = (await maybeListen(queueFsRefresh)) as unknown;
        if (cancelled) {
          if (typeof unlisten === "function") (unlisten as () => void)();
          return;
        }
        if (typeof unlisten === "function") dispose = unlisten as () => void;
      } catch {}
    })();
    return () => {
      cancelled = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      try {
        dispose?.();
      } catch {}
    };
  }, [queueFsRefresh]);

  // Focus return catches external editors that wrote while we were hidden.
  useEffect(() => {
    const onFocus = () => void flushPendingDirs();
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        const { cwd: liveCwd, expandedPaths: liveExpanded } = stateRef.current;
        if (liveCwd) pendingDirsRef.current.add(liveCwd);
        for (const dir of liveExpanded) pendingDirsRef.current.add(dir);
        void flushPendingDirs();
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [flushPendingDirs]);

  // Repo-relative sc_status paths joined onto cwd for O(1) row lookup.
  const { gitLetterByPath, dirtyDirs } = useMemo(() => {
    const letters = new Map<string, GitLetter>();
    const dirty = new Set<string>();
    if (!cwd || !gitStatus) return { gitLetterByPath: letters, dirtyDirs: dirty };
    const root = normalizeSlash(cwd);
    for (const entry of gitStatus.entries) {
      const rel = entry.path.replace(/\\/g, "/").replace(/^\/+/, "");
      const abs = `${root}/${rel}`;
      let letter: GitLetter;
      switch (entry.area) {
        case "untracked":
          letter = "U";
          break;
        case "conflict":
          letter = "C";
          break;
        case "staged":
          letter = "A";
          break;
        default:
          letter = "M";
      }
      letters.set(abs, letter);
      // Propagate dirtiness to every ancestor folder for the gutter dot.
      const parts = rel.split("/").filter(Boolean);
      parts.pop();
      let acc = root;
      dirty.add(acc);
      for (const part of parts) {
        acc = `${acc}/${part}`;
        dirty.add(acc);
      }
    }
    return { gitLetterByPath: letters, dirtyDirs: dirty };
  }, [cwd, gitStatus]);

  const handleToggleDir = useCallback(
    async (dirPath: string) => {
      const collapsing = expandedPaths.has(dirPath);
      setExpandedPaths((prev) => {
        const next = new Set(prev);
        if (next.has(dirPath)) {
          next.delete(dirPath);
        } else {
          next.add(dirPath);
        }
        return next;
      });

      if (collapsing) {
        void safeUnwatch(dirPath);
        return;
      }
      // Always re-read on expand so reopened folders never serve stale cache.
      try {
        const subEntries = await readDir(dirPath);
        setDirChildren((prev) => ({ ...prev, [dirPath]: subEntries }));
      } catch {
        setDirChildren((prev) => ({ ...prev, [dirPath]: [] }));
      }
      void safeWatch(dirPath);
    },
    [expandedPaths, safeUnwatch, safeWatch]
  );

  const handleCollapseAll = useCallback(() => {
    for (const watched of [...watchedRef.current]) {
      if (watched !== cwd) void safeUnwatch(watched);
    }
    setExpandedPaths(new Set());
  }, [cwd, safeUnwatch]);

  const handleRefreshAll = useCallback(async () => {
    if (!cwd) return;
    try {
      setRootEntries(await readDir(cwd));
    } catch {}
    await Promise.all(
      [...expandedPaths].map(async (dir) => {
        try {
          const entries = await readDir(dir);
          setDirChildren((prev) => ({ ...prev, [dir]: entries }));
        } catch {}
      })
    );
    void refreshGitStatus(cwd).catch(() => {});
  }, [cwd, expandedPaths, refreshGitStatus]);

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
      try {
        const subEntries = await readDir(dirPath);
        setDirChildren((prev) => ({ ...prev, [dirPath]: subEntries }));
      } catch {
        setDirChildren((prev) => ({ ...prev, [dirPath]: [] }));
      }
      void safeWatch(dirPath);
    },
    [safeWatch]
  );

  const findEntry = useCallback(
    (path: string | null): FileEntry | null => {
      if (!path) return null;
      const rootHit = rootEntries.find((e) => e.path === path) ?? null;
      if (rootHit) return rootHit;
      for (const list of Object.values(dirChildren)) {
        const hit = list.find((e) => e.path === path);
        if (hit) return hit;
      }
      return null;
    },
    [rootEntries, dirChildren]
  );

  // VSCode target rule: selected folder itself, selected file's parent,
  // else the open editor's parent, else the workspace root.
  const resolveTargetDir = useCallback((): string | null => {
    if (!cwd) return null;
    const selected = findEntry(selectedRowPath);
    if (selected) {
      if (selected.is_dir) return selected.path;
      return parentDirOf(selected.path);
    }
    if (activeEditorPath) return parentDirOf(activeEditorPath);
    return cwd;
  }, [cwd, selectedRowPath, activeEditorPath, findEntry]);

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
    if (creation.kind === "file") handleOpenFile(targetPath);
    else void safeWatch(targetPath);
  }, [creation, creationName, dirChildren, cwd, rootEntries, refreshDir, handleOpenFile, safeWatch]);

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

  if (rootEntries.length === 0 && !creation) {
    return <div className="empty-state">Empty directory</div>;
  }

  return (
    <div className="file-explorer" onContextMenu={handleContextMenuBlank}>
      <div className="explorer-header" role="toolbar" aria-label="Explorer actions">
        <span className="explorer-header-title" title={cwd}>
          {baseNameOf(cwd)}
        </span>
        <span className="explorer-header-actions">
          <button
            type="button"
            className="explorer-header-btn"
            title="New File"
            aria-label="New File"
            onClick={() => {
              const target = resolveTargetDir();
              if (target) beginCreation("file", target);
            }}
          >
            <FilePlus size={14} />
          </button>
          <button
            type="button"
            className="explorer-header-btn"
            title="New Folder"
            aria-label="New Folder"
            onClick={() => {
              const target = resolveTargetDir();
              if (target) beginCreation("dir", target);
            }}
          >
            <FolderPlus size={14} />
          </button>
          <button
            type="button"
            className="explorer-header-btn"
            title="Refresh Explorer"
            aria-label="Refresh Explorer"
            onClick={() => void handleRefreshAll()}
          >
            <RefreshCw size={13} />
          </button>
          <button
            type="button"
            className="explorer-header-btn"
            title="Collapse All"
            aria-label="Collapse All"
            onClick={handleCollapseAll}
          >
            <FoldVertical size={14} />
          </button>
        </span>
      </div>
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
            gitLetterByPath={gitLetterByPath}
            dirtyDirs={dirtyDirs}
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
