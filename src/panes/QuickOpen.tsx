import { useEffect, useMemo, useRef, useState } from "react";

import { listFiles } from "../lib/bridge";
import { baseName, errorMessage } from "../lib/protocol";
import { score } from "../lib/quickopen-score";
import type { WirePath } from "../lib/protocol";

interface QuickOpenProps {
  root: WirePath | null;
  onOpen: (path: WirePath) => void;
  onClose: () => void;
}

/**
 * Open a file by typing part of its name. Re-reads the list on every opening rather than
 * caching: the agent and branch switches move files, and offering a dead one is worse.
 */
export function QuickOpen({ root, onOpen, onClose }: QuickOpenProps) {
  const [files, setFiles] = useState<WirePath[] | null>(null);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    let cancelled = false;
    listFiles()
      .then((next) => {
        if (!cancelled) setFiles(next);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [root]);

  const prefix = root ? `${root.replace(/\/$/, "")}/` : "";
  const results = useMemo(() => {
    if (!files) return [];
    const needle = query.trim().toLowerCase();
    const scored = files
      .map((path) => ({ path, score: score(path.slice(prefix.length).toLowerCase(), needle) }))
      .filter((row) => row.score > 0);
    scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
    return scored.slice(0, 40).map((row) => row.path);
  }, [files, query, prefix]);

  useEffect(() => {
    setHighlight(0);
  }, [query]);

  const choose = (path: WirePath | undefined) => {
    if (!path) return;
    onOpen(path);
    onClose();
  };

  return (
    // The backdrop closes on click, which is the one gesture every overlay must answer.
    <div className="quick-backdrop" onPointerDown={onClose}>
      <div className="quick-open" onPointerDown={(event) => event.stopPropagation()}>
        <input
          ref={inputRef}
          className="quick-input"
          value={query}
          spellCheck={false}
          placeholder={files ? "open a file" : "reading the project…"}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              setHighlight((at) =>
                results.length === 0 ? 0 : (at + step + results.length) % results.length,
              );
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(results[highlight]);
            }
          }}
        />

        {error && <p className="note is-error">{error}</p>}
        {!error && files && results.length === 0 && (
          <p className="note">
            {query.trim() ? "nothing matches" : `${files.length} files — start typing`}
          </p>
        )}

        <div className="quick-list" role="listbox">
          {results.map((path, index) => {
            const relative = path.slice(prefix.length);
            const name = baseName(path);
            const dir = relative.slice(0, relative.length - name.length);
            return (
              <button
                key={path}
                type="button"
                role="option"
                aria-selected={index === highlight}
                className={`quick-row${index === highlight ? " is-on" : ""}`}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => choose(path)}
              >
                <span className="quick-name">{name}</span>
                <span className="quick-dir">{dir}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
