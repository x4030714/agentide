import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { searchWorkspace } from "../lib/bridge";
import { IconChevron } from "../lib/icons";
import { useFocusTarget } from "../lib/keys";
import { errorMessage } from "../lib/protocol";
import { groupByFile, latest } from "../lib/workspace-search";
import type { FileGroup } from "../lib/workspace-search";
import type { SearchMatch, SearchOptions, SearchResults, WirePath } from "../lib/protocol";

/** How long after the last keystroke the walk starts. Typing a word is then one search over
 * the tree rather than five, and 200ms is still inside the time the answer takes to arrive. */
const DEBOUNCE_MS = 200;

interface SearchProps {
  root: string | null;
  /** Open the file and select the match. Same signature as go-to-definition's, so `App` hands
   * over `openAt` itself instead of a wrapper that drops the range. */
  onOpenAt: (
    path: WirePath,
    line?: number,
    column?: number,
    endLine?: number,
    endColumn?: number,
  ) => void;
}

/** What the body draws: a file header, then the hits under it that are not folded away. A flat
 * list because the keyboard walks the hits and nothing else, so each one needs its own index. */
type Row = { kind: "file"; group: FileGroup } | { kind: "hit"; match: SearchMatch; at: number };

/**
 * Text across the whole workspace. The Explorer answers "where is the file"; this answers
 * "where is the string", which is the question the other one cannot.
 *
 * Literal only, no regex — the walk, the cap and the columns are all Rust's, so nothing here
 * redoes offset arithmetic and gets a different answer than the editor. A hit carries the range
 * it matched, so opening one selects the text rather than leaving the cursor near it.
 */
export function SearchPane({ root, onOpenAt }: SearchProps) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<SearchOptions>({
    caseSensitive: false,
    wholeWord: false,
  });
  const [results, setResults] = useState<SearchResults | null>(null);
  /** The query the results on screen are for. Enter means two different things either side
   * of it -- run this now, or open the one that is highlighted. */
  const [answered, setAnswered] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [folded, setFolded] = useState<Set<WirePath>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stamps = useRef(latest());

  // Selected, not just focused: Ctrl+Shift+F on a search you have already run is almost
  // always the start of a different one.
  useFocusTarget("search", () => {
    inputRef.current?.focus();
    inputRef.current?.select();
  });

  const run = useCallback(async (text: string, opts: SearchOptions) => {
    const stamp = stamps.current.next();
    setRunning(true);
    try {
      const next = await searchWorkspace(text, opts);
      // A keystroke that landed while the walk was running has already started a newer
      // search; painting this answer would show results for a query no longer in the box.
      if (!stamps.current.isCurrent(stamp)) return;
      setResults(next);
      setAnswered(text);
      setError(null);
    } catch (err) {
      if (!stamps.current.isCurrent(stamp)) return;
      setResults(null);
      setError(errorMessage(err));
    } finally {
      if (stamps.current.isCurrent(stamp)) setRunning(false);
    }
  }, []);

  useEffect(() => {
    // Not trimmed: a trailing space is part of a literal search, and the one query that means
    // nothing -- the empty one -- is answered here rather than by a walk that finds everything.
    if (query === "") {
      setResults(null);
      setAnswered("");
      setError(null);
      return;
    }
    const timer = window.setTimeout(() => void run(query, options), DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, options, run]);

  const groups = useMemo(() => groupByFile(results?.matches ?? [], root ?? ""), [results, root]);

  const { rows, hits } = useMemo(() => {
    const rows: Row[] = [];
    const hits: SearchMatch[] = [];
    for (const group of groups) {
      rows.push({ kind: "file", group });
      if (folded.has(group.path)) continue;
      for (const match of group.matches) {
        rows.push({ kind: "hit", match, at: hits.length });
        hits.push(match);
      }
    }
    return { rows, hits };
  }, [groups, folded]);

  useEffect(() => {
    setHighlight(0);
  }, [results]);

  useEffect(() => {
    // Queried rather than kept as a ref per row: there can be two thousand rows and only
    // ever one of them is wanted. `nearest` so a row already on screen does not scroll.
    listRef.current
      ?.querySelector<HTMLElement>(".search-hit.is-on")
      ?.scrollIntoView({ block: "nearest" });
  }, [highlight]);

  const openHit = (match: SearchMatch | undefined) => {
    if (!match) return;
    onOpenAt(match.path, match.line, match.column, match.line, match.endColumn);
  };

  /** Both toggles behave the same, focus included: the box is where you were typing. */
  const flip = (change: Partial<SearchOptions>) => {
    setOptions((was) => ({ ...was, ...change }));
    inputRef.current?.focus();
  };

  /** Nothing on screen answers what is in the box yet -- either the debounce is still waiting
   * or the walk is. Both read the same way to the person: it is coming. */
  const pending = query !== "" && (running || answered !== query);

  const foldFile = (path: WirePath) =>
    setFolded((was) => {
      const next = new Set(was);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  if (!root) {
    return (
      <div className="pane search">
        <div className="pane-header">
          <span className="legend">Search</span>
        </div>
        <div className="pane-body">
          <p className="note">no workspace open</p>
        </div>
      </div>
    );
  }

  return (
    <div className="pane search">
      <div className="pane-header">
        <span className="legend">Search</span>
      </div>

      <div className="search-bar">
        <input
          ref={inputRef}
          className="search-input"
          type="search"
          value={query}
          placeholder="Find in files"
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query !== "") {
              // Empties it rather than leaving the pane, the way the conversation filter does.
              event.preventDefault();
              event.stopPropagation();
              setQuery("");
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setHighlight((at) =>
                hits.length === 0 ? 0 : (at + step + hits.length) % hits.length,
              );
            } else if (event.key === "Enter") {
              event.preventDefault();
              // Enter means "now" while the debounce is still waiting, and "open that one"
              // once the answer is on screen. The same key, because in each moment it is
              // the only thing left to want.
              if (answered !== query) void run(query, options);
              else openHit(hits[highlight]);
            }
          }}
        />
        <div className="search-toggles">
          <button
            type="button"
            className={`search-toggle${options.caseSensitive ? " is-on" : ""}`}
            aria-pressed={options.caseSensitive}
            title="Match case"
            onClick={() => flip({ caseSensitive: !options.caseSensitive })}
          >
            Aa
          </button>
          <button
            type="button"
            className={`search-toggle${options.wholeWord ? " is-on" : ""}`}
            aria-pressed={options.wholeWord}
            title="Whole word"
            onClick={() => flip({ wholeWord: !options.wholeWord })}
          >
            ab
          </button>
        </div>
      </div>

      <div className="pane-body" ref={listRef}>
        {error && <p className="note is-error">{error}</p>}
        {!error && query === "" && <p className="note">type to search the workspace</p>}
        {!error && pending && <p className="note">searching…</p>}
        {!error && !pending && results && results.matches.length === 0 && (
          <p className="note">
            nothing matches “{answered}” — {results.searched} file
            {results.searched === 1 ? "" : "s"} searched
          </p>
        )}
        {!error && !pending && results && results.matches.length > 0 && (
          <p className="note">
            {results.matches.length} result{results.matches.length === 1 ? "" : "s"} in{" "}
            {results.files} file{results.files === 1 ? "" : "s"}
            {/* Said rather than hidden: a capped answer looks exactly like a complete one. */}
            {results.truncated && " — the first of more; narrow the search"}
          </p>
        )}

        {rows.map((row) =>
          row.kind === "file" ? (
            <button
              key={row.group.path}
              type="button"
              className="search-file"
              aria-expanded={!folded.has(row.group.path)}
              title={row.group.path}
              onClick={() => foldFile(row.group.path)}
            >
              <IconChevron open={!folded.has(row.group.path)} />
              <span className="search-path">{row.group.relative}</span>
              <span className="measure">{row.group.matches.length}</span>
            </button>
          ) : (
            <button
              key={`${row.match.path}:${row.match.line}:${row.match.column}`}
              type="button"
              className={`search-hit${row.at === highlight ? " is-on" : ""}`}
              // The whole line, for when the row is too narrow to show it.
              title={`${row.match.before}${row.match.matched}${row.match.after}`}
              onMouseEnter={() => setHighlight(row.at)}
              onClick={() => openHit(row.match)}
            >
              <span className="search-line">{row.match.line}</span>
              <span className="search-text">
                {row.match.before}
                <mark>{row.match.matched}</mark>
                {row.match.after}
              </span>
            </button>
          ),
        )}
      </div>
    </div>
  );
}
