import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { flushSync } from "react-dom";

import { listDir } from "../lib/bridge";
import { formatSize } from "../lib/format";
import { IconChevron, IconFolder } from "../lib/icons";
import { useFocusTarget } from "../lib/keys";
import { errorMessage, parentOf } from "../lib/protocol";
import type { DirEntry, FsChangeKind, FsEvent, WirePath } from "../lib/protocol";
import { offsetToReveal, rowWindow } from "../lib/row-window";

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

/** Everything the windowing needs from layout, all of it read from the DOM. */
interface Metrics {
  /** Row pitch in px, or 0 while unknown -- see `readRowHeight`. */
  row: number;
  /** Padding above the first row, so a scroll position converts to a list offset. */
  pad: number;
  /** Visible height of the scroll container. */
  viewport: number;
}

/**
 * Row pitch from a rendered row, else from `--row`. A constant here would survive a density
 * change and misplace every row below the fold. Zero means "draw the whole list".
 */
function readRowHeight(body: HTMLElement): number {
  const rendered = body.querySelector<HTMLElement>(".tree-row");
  const measured = rendered?.getBoundingClientRect().height ?? 0;
  if (measured > 0) return measured;
  const declared = Number.parseFloat(getComputedStyle(body).getPropertyValue("--row"));
  return declared > 0 ? declared : 0;
}

/**
 * Lazily expanded tree: one `list_dir` per open folder, reloaded on watcher events, never
 * polled. Only visible rows render -- a Desktop is thousands of entries.
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
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [metrics, setMetrics] = useState<Metrics>({ row: 0, pad: 0, viewport: 0 });

  /**
   * Every visible row in order, derived so nothing can disagree. Memoised: scrolling re-renders,
   * and rebuilding ten thousand rows per frame is the cost windowing exists to remove.
   */
  const rows = useMemo(() => {
    const out: Row[] = [];
    const collect = (dir: WirePath, depth: number) => {
      for (const entry of children[dir] ?? []) {
        out.push({ entry, depth });
        if (entry.isDir && expanded.has(entry.path)) collect(entry.path, depth + 1);
      }
    };
    if (root) collect(root, 0);
    return out;
  }, [root, children, expanded]);

  // Where the selection sits, which is all that scrolling to it needs: a row outside the
  // drawn slice has no element to measure.
  const activeIndex = useMemo(
    () => (activePath ? rows.findIndex((row) => row.entry.path === activePath) : -1),
    [rows, activePath],
  );

  const hasRows = rows.length > 0;

  /**
   * Layout measured, not assumed. Re-runs once a real row exists, and the observer catches
   * resizes.
   */
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const measure = () => {
      // A hidden sidebar measures zero, and a zero viewport means "draw everything" -- ten
      // thousand rows behind a pane nobody is looking at. Keep the last real measurement.
      if (body.clientHeight === 0) return;
      const next: Metrics = {
        row: readRowHeight(body),
        pad: Math.max(0, Number.parseFloat(getComputedStyle(body).paddingTop) || 0),
        viewport: body.clientHeight,
      };
      setMetrics((current) =>
        current.row === next.row &&
        current.pad === next.pad &&
        current.viewport === next.viewport
          ? current
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [hasRows]);

  /** Scroll row `index` into view, updating state in the same pass so the drawn slice follows. */
  const revealRow = useCallback(
    (index: number) => {
      const body = bodyRef.current;
      if (!body) return;
      const next = offsetToReveal(
        Math.max(0, body.scrollTop - metrics.pad),
        body.clientHeight,
        metrics.row,
        index,
      );
      if (next === null) return;
      body.scrollTop = metrics.pad + next;
      setScrollTop(body.scrollTop);
    },
    [metrics.pad, metrics.row],
  );

  /**
   * A selection made elsewhere scrolls into view, by index because an undrawn row has no element.
   * Only `activePath` changes scroll; chasing a row that merely moved would yank the list.
   */
  const revealed = useRef<WirePath | null>(null);
  useLayoutEffect(() => {
    if (!activePath || activeIndex < 0 || revealed.current === activePath) return;
    revealed.current = activePath;
    revealRow(activeIndex);
  }, [activePath, activeIndex, revealRow]);

  /**
   * Ctrl+1 focuses the selected row. `flushSync` is load-bearing: an undrawn row cannot be
   * focused, and without the flush `querySelector` finds nothing and focus lands on the top row.
   */
  useFocusTarget("tree", () => {
    flushSync(() => revealRow(activeIndex));
    const pane = document.querySelector(".pane.tree");
    const target =
      pane?.querySelector<HTMLElement>(".tree-row.is-active") ??
      pane?.querySelector<HTMLElement>(".tree-row");
    target?.focus();
  });
  /** What the watcher has touched since the workspace opened; colours the length column. */
  const [marks, setMarks] = useState<Record<WirePath, FsChangeKind>>({});
  // Mirrors the keys of `children` so the watcher effect need not re-run on every listing.
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
    setScrollTop(0);
    loaded.current = new Set();
    revealed.current = null;
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

  const view = rowWindow(
    Math.max(0, scrollTop - metrics.pad),
    metrics.viewport,
    metrics.row,
    rows.length,
  );

  return (
    <div className="pane tree">
      <div className="pane-header">
        {/* Named for the view the rail selects, not for what it lists: the header is the
            sidebar's title now, and two words for one view is one too many. */}
        <span className="legend">Explorer</span>
        <button type="button" className="ghost-button" onClick={onOpenFolder}>
          <IconFolder />
          Open
        </button>
      </div>
      <div
        className="pane-body"
        ref={bodyRef}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        {!root && <p className="note">no module loaded — open a folder to list it</p>}
        {error && <p className="note is-error">{error}</p>}
        {root && rows.length === 0 && !error && (
          // `list_dir` returns what survived the ignore filter, so an empty result
          // cannot tell the two apart. Naming both beats asserting the wrong one.
          <p className="note">no entries — the folder is empty, or all of it is ignored</p>
        )}
        {/**
         * The canvas holds the full listing height so the scrollbar measures the folder; the
         * window moves by transform, never layout. Keyed by path, or focus would jump files.
         */}
        <div
          className="tree-canvas"
          style={metrics.row > 0 ? { height: rows.length * metrics.row } : undefined}
        >
          <div
            className="tree-window"
            style={{ transform: `translateY(${view.start * metrics.row}px)` }}
          >
            {rows.slice(view.start, view.end).map(({ entry, depth }) => {
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
      </div>
    </div>
  );
}
