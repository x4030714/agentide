import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

import { listDir } from "../lib/bridge";
import { formatSize } from "../lib/format";
import { IconChevron, IconFolder } from "../lib/icons";
import { errorMessage, parentOf } from "../lib/protocol";
import type { DirEntry, FsChangeKind, FsEvent, WirePath } from "../lib/protocol";

interface FileTreeProps {
  root: WirePath | null;
  activePath: WirePath | null;
  /** Latest batch from the workspace watcher; a new array per batch. */
  changes: FsEvent[];
  onOpenFile: (path: WirePath) => void;
  onOpenFolder: () => void;
}

interface Row {
  entry: DirEntry;
  depth: number;
}

/**
 * Lazily expanded directory tree. One `list_dir` call per expanded folder, and a reload
 * of the affected folders when the watcher reports a change -- never a poll.
 */
export function FileTree({
  root,
  activePath,
  changes,
  onOpenFile,
  onOpenFolder,
}: FileTreeProps) {
  const [children, setChildren] = useState<Record<WirePath, DirEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<WirePath>>(new Set());
  const [error, setError] = useState<string | null>(null);
  /**
   * What the watcher has seen touch each path since this workspace opened. Drives the
   * length column's role colour, so the tree carries the same meanings the syntax theme
   * does rather than only claiming to.
   */
  const [marks, setMarks] = useState<Record<WirePath, FsChangeKind>>({});
  // Mirrors the keys of `children` so the watcher effect can see what is loaded without
  // re-running every time a listing changes.
  const loaded = useRef(new Set<WirePath>());

  const loadDir = useCallback(async (path: WirePath) => {
    try {
      const listing = await listDir(path);
      loaded.current.add(path);
      setChildren((current) => ({ ...current, [path]: listing.entries }));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  const forget = useCallback((path: WirePath) => {
    loaded.current.delete(path);
    setChildren((current) => {
      const next = { ...current };
      delete next[path];
      return next;
    });
    setExpanded((current) => {
      if (!current.has(path)) return current;
      const next = new Set(current);
      next.delete(path);
      return next;
    });
  }, []);

  useEffect(() => {
    setChildren({});
    setExpanded(new Set());
    setError(null);
    setMarks({});
    loaded.current = new Set();
    if (root) void loadDir(root);
  }, [root, loadDir]);

  useEffect(() => {
    if (changes.length === 0) return;

    setMarks((current) => {
      const next = { ...current };
      for (const change of changes) {
        if (change.kind === "removed") delete next[change.path];
        // A file created in this session stays "created" even once it is edited.
        else if (next[change.path] !== "created") next[change.path] = change.kind;
      }
      return next;
    });

    const stale = new Set<WirePath>();
    for (const change of changes) {
      // A change to any path invalidates its parent's listing; a change reported on a
      // directory we have open invalidates that directory too.
      const parent = parentOf(change.path);
      if (parent && loaded.current.has(parent)) stale.add(parent);
      if (loaded.current.has(change.path)) {
        if (change.kind === "removed") forget(change.path);
        else stale.add(change.path);
      }
    }
    for (const dir of stale) void loadDir(dir);
  }, [changes, loadDir, forget]);

  function toggle(entry: DirEntry) {
    if (!entry.isDir) {
      onOpenFile(entry.path);
      return;
    }
    const isOpen = expanded.has(entry.path);
    setExpanded((current) => {
      const next = new Set(current);
      if (isOpen) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
    if (!isOpen && !loaded.current.has(entry.path)) void loadDir(entry.path);
  }

  const rows: Row[] = [];
  const collect = (dir: WirePath, depth: number) => {
    for (const entry of children[dir] ?? []) {
      rows.push({ entry, depth });
      if (entry.isDir && expanded.has(entry.path)) collect(entry.path, depth + 1);
    }
  };
  if (root) collect(root, 0);

  return (
    <div className="pane tree">
      <div className="pane-header">
        <span className="legend">Files</span>
        <button type="button" className="ghost-button" onClick={onOpenFolder}>
          <IconFolder />
          Open
        </button>
      </div>
      <div className="pane-body">
        {!root && <p className="note">no module loaded — open a folder to list it</p>}
        {error && <p className="note is-error">{error}</p>}
        {root && rows.length === 0 && !error && (
          <p className="note">no entries — every file here is gitignored</p>
        )}
        {rows.map(({ entry, depth }) => {
          const isActive = entry.path === activePath;
          return (
            <button
              type="button"
              key={entry.path}
              className={[
                "tree-row",
                entry.isDir ? "is-dir" : "is-file",
                isActive ? "is-active" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{ "--depth": depth } as CSSProperties}
              title={entry.path}
              aria-expanded={entry.isDir ? expanded.has(entry.path) : undefined}
              onClick={() => toggle(entry)}
            >
              <span className="tree-chevron">
                {entry.isDir && <IconChevron open={expanded.has(entry.path)} />}
              </span>
              <span className="tree-name">{entry.name}</span>
              {/* The length column a segment listing always carries. */}
              <span
                className={`measure${marks[entry.path] ? ` is-${marks[entry.path]}` : ""}`}
              >
                {formatSize(entry.size, entry.isDir)}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
